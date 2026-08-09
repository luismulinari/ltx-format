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
