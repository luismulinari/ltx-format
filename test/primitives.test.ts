/**
 * Tests for the building blocks the LTX codec is assembled from.
 *
 * These deliberately assert *properties* (round-trips, involutions, framing
 * invariants) rather than hard-coded digests: the digests themselves are
 * pinned by the golden-file tests, which compare against output from the
 * reference Go implementation instead of against our own arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
	CHECKSUM_FLAG,
	Crc64,
	checksumPage,
	crc64,
	foldPageChecksum,
} from '../src/crc64.js';
import type { LtxHeader } from '../src/format.js';
import {
	formatFilename,
	formatTxid,
	isValidPageSize,
	lockPgno,
	parseTxid,
	readHeader,
	writeHeader,
} from '../src/format.js';
import { decodeLz4Frame, encodeLz4Frame } from '../src/lz4.js';
import { readUvarint, uvarintSize, writeUvarint } from '../src/varint.js';
import { xxhash32 } from '../src/xxhash32.js';

describe('uvarint', () => {
	it('matches the canonical LEB128 encoding', () => {
		const encode = (value: number) => {
			const out: number[] = [];
			writeUvarint(out, value);
			return out;
		};
		expect(encode(0)).toEqual([0x00]);
		expect(encode(1)).toEqual([0x01]);
		expect(encode(127)).toEqual([0x7f]);
		expect(encode(128)).toEqual([0x80, 0x01]);
		expect(encode(300)).toEqual([0xac, 0x02]);
	});

	it('round-trips across the full safe-integer range', () => {
		const values = [
			0,
			1,
			127,
			128,
			255,
			300,
			16383,
			16384,
			2 ** 21,
			2 ** 32 - 1,
			2 ** 40,
			Number.MAX_SAFE_INTEGER,
		];
		for (const value of values) {
			const out: number[] = [];
			const written = writeUvarint(out, value);
			expect(written).toBe(uvarintSize(value));
			expect(out.length).toBe(written);

			const read = readUvarint(new Uint8Array(out), 0);
			expect(read.value).toBe(value);
			expect(read.offset).toBe(written);
		}
	});

	it('rejects values it cannot represent exactly', () => {
		expect(() => writeUvarint([], -1)).toThrow();
		expect(() => writeUvarint([], 1.5)).toThrow();
		expect(() => writeUvarint([], Number.MAX_SAFE_INTEGER + 2)).toThrow();
	});

	it('rejects a truncated encoding', () => {
		// A continuation bit with nothing following it.
		expect(() => readUvarint(new Uint8Array([0x80]), 0)).toThrow(
			/Truncated/
		);
	});
});

describe('crc64', () => {
	it('is chainable: two updates equal one over the concatenation', () => {
		const a = new Uint8Array([1, 2, 3, 4, 5]);
		const b = new Uint8Array([6, 7, 8]);
		const joined = new Uint8Array([...a, ...b]);

		const split = new Crc64().update(a).update(b).sum64();
		expect(split).toBe(crc64(joined));
	});

	it('starts at zero and stays inside 64 bits', () => {
		expect(new Crc64().sum64()).toBe(0n);
		const sum = crc64(new Uint8Array(1024).fill(0xff));
		expect(sum).toBeGreaterThanOrEqual(0n);
		expect(sum).toBeLessThan(1n << 64n);
	});

	it('always sets the flag bit on a page checksum', () => {
		const checksum = checksumPage(7, new Uint8Array(512).fill(3));
		expect(checksum & CHECKSUM_FLAG).toBe(CHECKSUM_FLAG);
	});

	it('separates page numbers from page content', () => {
		const data = new Uint8Array(512).fill(3);
		expect(checksumPage(7, data)).not.toBe(checksumPage(8, data));
	});

	it('folds pages in an order-independent, self-inverting way', () => {
		const p1 = new Uint8Array(512).fill(1);
		const p2 = new Uint8Array(512).fill(2);

		const forward = foldPageChecksum(
			foldPageChecksum(CHECKSUM_FLAG, 1, p1),
			2,
			p2
		);
		const backward = foldPageChecksum(
			foldPageChecksum(CHECKSUM_FLAG, 2, p2),
			1,
			p1
		);
		expect(forward).toBe(backward);

		// Folding the same page twice cancels it out again.
		expect(foldPageChecksum(forward, 2, p2)).toBe(
			foldPageChecksum(CHECKSUM_FLAG, 1, p1)
		);
	});
});

describe('xxhash32', () => {
	it('returns an unsigned 32-bit value', () => {
		for (const length of [0, 1, 4, 15, 16, 17, 64, 1000]) {
			const hash = xxhash32(new Uint8Array(length).fill(0xa5));
			expect(Number.isInteger(hash)).toBe(true);
			expect(hash).toBeGreaterThanOrEqual(0);
			expect(hash).toBeLessThanOrEqual(0xffffffff);
		}
	});

	it('is sensitive to input and to seed', () => {
		const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const other = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]);
		expect(xxhash32(data)).toBe(xxhash32(data));
		expect(xxhash32(data)).not.toBe(xxhash32(other));
		expect(xxhash32(data)).not.toBe(xxhash32(data, 1));
	});
});

describe('lz4 frames', () => {
	it('round-trips payloads of every shape', () => {
		for (const length of [0, 1, 512, 4096, 65536, 65537, 200000]) {
			const data = new Uint8Array(length);
			for (let i = 0; i < length; i++) data[i] = (i * 31) & 0xff;

			const frame = encodeLz4Frame(data);
			const decoded = decodeLz4Frame(frame);
			expect(decoded.offset).toBe(frame.length);
			expect(Buffer.from(decoded.data).equals(Buffer.from(data))).toBe(
				true
			);
		}
	});

	it('decodes a frame embedded at an offset', () => {
		const data = new Uint8Array(512).fill(0x5a);
		const frame = encodeLz4Frame(data);
		const embedded = new Uint8Array(8 + frame.length);
		embedded.set(frame, 8);

		const decoded = decodeLz4Frame(embedded, 8);
		expect(decoded.offset).toBe(embedded.length);
		expect(Buffer.from(decoded.data).equals(Buffer.from(data))).toBe(true);
	});

	it('rejects bytes that are not a frame', () => {
		expect(() => decodeLz4Frame(new Uint8Array(64))).toThrow(/LZ4 frame/);
	});
});

describe('format helpers', () => {
	it('formats and parses transaction ids', () => {
		expect(formatTxid(1n)).toBe('0000000000000001');
		expect(formatTxid(0xdeadbeefn)).toBe('00000000deadbeef');
		expect(parseTxid('00000000deadbeef')).toBe(0xdeadbeefn);
		expect(formatFilename(1n, 2n)).toBe(
			'0000000000000001-0000000000000002.ltx'
		);
	});

	it('rejects malformed transaction ids', () => {
		expect(() => parseTxid('1')).toThrow();
		expect(() => parseTxid('zzzzzzzzzzzzzzzz')).toThrow();
	});

	it('accepts exactly the page sizes SQLite allows', () => {
		for (const size of [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]) {
			expect(isValidPageSize(size)).toBe(true);
		}
		for (const size of [0, 256, 3000, 65537, 131072, 4096.5]) {
			expect(isValidPageSize(size)).toBe(false);
		}
	});

	it('places the lock page where SQLite does', () => {
		// PENDING_BYTE is 0x40000000, so the lock page is the one containing it.
		expect(lockPgno(4096)).toBe(262145);
		expect(lockPgno(1024)).toBe(1048577);
		expect(lockPgno(0)).toBe(0);
	});

	it('round-trips a header through write and read', () => {
		const header: LtxHeader = {
			flags: 0,
			pageSize: 4096,
			commit: 12,
			minTXID: 1n,
			maxTXID: 3n,
			timestamp: 1_700_000_000_000n,
			preApplyChecksum: 0n,
			walOffset: 32n,
			walSize: 4096n,
			walSalt1: 0x11223344,
			walSalt2: 0x55667788,
			nodeID: 9n,
		};
		expect(readHeader(writeHeader(header))).toEqual(header);
	});

	it('rejects headers that break the format invariants', () => {
		const base: LtxHeader = {
			flags: 0,
			pageSize: 4096,
			commit: 1,
			minTXID: 2n,
			maxTXID: 1n,
			timestamp: 0n,
			preApplyChecksum: 1n << 63n,
			walOffset: 0n,
			walSize: 0n,
			walSalt1: 0,
			walSalt2: 0,
			nodeID: 0n,
		};
		expect(() => writeHeader(base)).toThrow(/greater than maxTXID/);
		expect(() =>
			writeHeader({ ...base, minTXID: 0n, maxTXID: 0n })
		).toThrow(/non-zero/);
		expect(() =>
			writeHeader({ ...base, minTXID: 1n, maxTXID: 1n })
		).toThrow(/zero pre-apply checksum/);
		expect(() => writeHeader({ ...base, flags: 0xff })).toThrow(/flags/);
	});
});
