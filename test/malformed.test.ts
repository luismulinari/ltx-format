/**
 * Malformed-input tests.
 *
 * The decoder is fed untrusted bytes, so every structural invariant it relies
 * on needs a test that violates it. A crash, a hang, or a silent accept here is
 * a security bug, not a cosmetic one.
 */
import { describe, expect, it } from 'vitest';
import { decodeLtx } from '../src/decode.js';
import { encodeLtx } from '../src/encode.js';
import { HEADER_SIZE, PAGE_HEADER_SIZE } from '../src/format.js';
import { decodeLz4Frame, encodeLz4Frame } from '../src/lz4.js';

const PAGE_SIZE = 512;

/** A single-page snapshot, plus the offsets a test may want to corrupt. */
function sample() {
	const data = new Uint8Array(PAGE_SIZE).fill(0x5a);
	const bytes = encodeLtx({
		pageSize: PAGE_SIZE,
		commit: 1,
		minTXID: 1n,
		maxTXID: 1n,
		pages: [{ pgno: 1, data }],
	});
	const frameLength = encodeLz4Frame(data).length;
	return {
		bytes,
		firstPageHeader: HEADER_SIZE,
		terminator: HEADER_SIZE + PAGE_HEADER_SIZE + frameLength,
		indexSizeField: bytes.length - 16 - 8,
	};
}

describe('malformed LTX input', () => {
	it('rejects a page carrying unsupported flags', () => {
		const { bytes, firstPageHeader } = sample();
		bytes[firstPageHeader + 5] = 1;
		expect(() => decodeLtx(bytes)).toThrow(/unsupported flags/);
	});

	it('rejects a block terminator carrying flags', () => {
		const { bytes, terminator } = sample();
		bytes[terminator + 5] = 1;
		expect(() => decodeLtx(bytes)).toThrow(/terminator has non-zero flags/);
	});

	it('rejects a page index that does not start where the block ends', () => {
		const { bytes, indexSizeField } = sample();
		new DataView(bytes.buffer).setBigUint64(indexSizeField, 99n, false);
		expect(() => decodeLtx(bytes)).toThrow(/page index starts at/);
	});

	it('rejects a page index that disagrees with the page block', () => {
		const { bytes, indexSizeField } = sample();
		// The index is (pgno, offset, size); rewrite the page number.
		const indexLength = Number(
			new DataView(bytes.buffer).getBigUint64(indexSizeField, false)
		);
		bytes[indexSizeField - indexLength] = 9;
		expect(() => decodeLtx(bytes)).toThrow(/page index/);
	});

	it('rejects a page index whose offset disagrees with the block', () => {
		const { bytes, indexSizeField } = sample();
		const indexLength = Number(
			new DataView(bytes.buffer).getBigUint64(indexSizeField, false)
		);
		// The index entry is (pgno, offset, size) as uvarints. For this file
		// the offset is 100, which fits in one byte, so it can be rewritten
		// without changing the index length.
		const offsetByte = indexSizeField - indexLength + 1;
		expect(bytes[offsetByte]).toBe(HEADER_SIZE);
		bytes[offsetByte] = HEADER_SIZE - 1;
		expect(() => decodeLtx(bytes)).toThrow(/does not match block offset/);
	});

	it('rejects a page that decompresses to the wrong size', () => {
		const { bytes } = sample();
		// Claim a larger page size than the frames actually hold.
		new DataView(bytes.buffer).setUint32(8, PAGE_SIZE * 2, false);
		expect(() => decodeLtx(bytes)).toThrow(/decompressed to/);
	});

	it('rejects a page whose stored block length was tampered with', () => {
		const { bytes, firstPageHeader } = sample();
		// The block header sits 7 bytes into the frame, which follows the page
		// header. Shrinking it makes the rest of the page parse as garbage.
		const blockHeader = firstPageHeader + PAGE_HEADER_SIZE + 7;
		new DataView(bytes.buffer).setUint32(
			blockHeader,
			(0x80000000 | 8) >>> 0,
			true
		);
		expect(() => decodeLtx(bytes)).toThrow();
	});

	it('does not accept a header whose page size is not a power of two', () => {
		const { bytes } = sample();
		new DataView(bytes.buffer).setUint32(8, 1000, false);
		expect(() => decodeLtx(bytes)).toThrow(/page size/);
	});
});

/** Assembles an LZ4 frame byte by byte so tests can make it invalid. */
function frame(parts: {
	flg: number;
	bd: number;
	extraHeaderBytes?: number;
	blocks: Array<{ header: number; body: number[]; checksum?: boolean }>;
	contentChecksum?: boolean;
}): Uint8Array {
	const out: number[] = [0x04, 0x22, 0x4d, 0x18]; // magic, little-endian
	out.push(parts.flg, parts.bd);
	for (let i = 0; i < (parts.extraHeaderBytes ?? 0); i++) out.push(0);
	out.push(0); // header checksum byte, which the reader skips
	for (const block of parts.blocks) {
		out.push(
			block.header & 0xff,
			(block.header >>> 8) & 0xff,
			(block.header >>> 16) & 0xff,
			(block.header >>> 24) & 0xff
		);
		out.push(...block.body);
		if (block.checksum) out.push(0, 0, 0, 0);
	}
	out.push(0, 0, 0, 0); // EndMark
	if (parts.contentChecksum) out.push(0, 0, 0, 0);
	return new Uint8Array(out);
}

const STORED = 0x80000000;

describe('malformed LZ4 frames', () => {
	it('rejects an unsupported frame version', () => {
		expect(() =>
			decodeLz4Frame(frame({ flg: 0x00, bd: 0x40, blocks: [] }))
		).toThrow(/version/);
	});

	it('rejects an unsupported block maximum size', () => {
		expect(() =>
			decodeLz4Frame(frame({ flg: 0x60, bd: 0x00, blocks: [] }))
		).toThrow(/block maximum size/);
	});

	// 4 is the only id Litestream writes; the rest exist in the spec.
	it.each([5, 6, 7])('accepts block maximum size id %i', (id) => {
		const decoded = decodeLz4Frame(
			frame({
				flg: 0x60,
				bd: id << 4,
				blocks: [{ header: (STORED | 2) >>> 0, body: [1, 2] }],
			})
		);
		expect([...decoded.data]).toEqual([1, 2]);
	});

	it('skips the optional content size, dictionary id, and checksums', () => {
		// Litestream writes a content checksum; none of these are verified here,
		// because the LTX file checksum already covers the page contents.
		const decoded = decodeLz4Frame(
			frame({
				flg: 0x60 | 0x08 | 0x01 | 0x10 | 0x04, // size, dictID, block+content checksums
				bd: 0x40,
				extraHeaderBytes: 12,
				blocks: [
					{
						header: (STORED | 3) >>> 0,
						body: [7, 8, 9],
						checksum: true,
					},
				],
				contentChecksum: true,
			})
		);
		expect([...decoded.data]).toEqual([7, 8, 9]);
	});

	/** Encodes a length as a token nibble plus LZ4's 255-run extension bytes. */
	function lengthExtension(length: number): number[] {
		const bytes: number[] = [];
		let remaining = length - 15;
		while (remaining >= 255) {
			bytes.push(255);
			remaining -= 255;
		}
		bytes.push(remaining);
		return bytes;
	}

	it('rejects a block claiming more literals than it holds', () => {
		// Claim 70 KiB of literals but supply 100 bytes. Writing past a
		// Uint8Array is silently dropped, so without an explicit bounds check
		// this decoded to exactly 65536 bytes of garbage — and at a 64 KiB
		// page size that is a legal page length, so nothing downstream would
		// have caught it either.
		const body = [0xf0, ...lengthExtension(70000)];
		for (let i = 0; i < 100; i++) body.push(0x41);

		expect(() =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: body.length, body }],
				})
			)
		).toThrow(/literals run past its end/);
	});

	it('rejects a match that would overrun the output buffer', () => {
		// One literal, then a run-length match far longer than the 64 KiB the
		// frame's block maximum allows the output to be.
		const body = [0x1f, 0x41, 0x01, 0x00, ...lengthExtension(70000)];

		expect(() =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: body.length, body }],
				})
			)
		).toThrow(/past its maximum size/);
	});

	it('rejects literals that overrun the output buffer after a long match', () => {
		// Inflate the output to just under 64 KiB with a run-length match, then
		// append literals that are present in the block but do not fit. This is
		// the only path that reaches the literal *output* bounds check, since a
		// block can never hold more literals than the output can take on its own.
		const body = [0x1f, 0x41, 0x01, 0x00, ...lengthExtension(65500)];
		body.push(0xf0, ...lengthExtension(100));
		for (let i = 0; i < 100; i++) body.push(0x42);

		expect(() =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: body.length, body }],
				})
			)
		).toThrow(/past its maximum size/);
	});

	it('rejects a block larger than the frame allows', () => {
		expect(() =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: (STORED | 100000) >>> 0, body: [1, 2] }],
				})
			)
		).toThrow(/exceeds the frame/);
	});

	it('rejects a frame that ends mid-block', () => {
		expect(() =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: (STORED | 999) >>> 0, body: [1, 2, 3] }],
				})
			)
		).toThrow(/Truncated LZ4 frame/);
	});

	it('rejects a match reaching back before the block', () => {
		// One literal, then a match 300 bytes back with only 1 byte emitted.
		expect(() =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: 4, body: [0x10, 0x41, 0x2c, 0x01] }],
				})
			)
		).toThrow(/before the block/);
	});

	it('rejects a back-reference with a zero offset', () => {
		// A compressed block: one literal, then a match pointing nowhere.
		const decoded = () =>
			decodeLz4Frame(
				frame({
					flg: 0x60,
					bd: 0x40,
					blocks: [{ header: 4, body: [0x10, 0x41, 0x00, 0x00] }],
				})
			);
		expect(decoded).toThrow(/match offset 0/);
	});
});
