/**
 * Minimal LZ4 frame reader/writer, scoped to what LTX needs.
 *
 * LTX stores each page as one independent LZ4 frame. Litestream writes those
 * frames with pierrec/lz4 v4 using 64 KiB blocks and a content checksum, so
 * the reader has to cope with compressed blocks and trailing checksums.
 *
 * The writer only emits *uncompressed* (stored) blocks. That is fully legal
 * per the frame specification and keeps a compressor off the critical path —
 * LTX files are already transient and the pages are usually written straight
 * to object storage. Real compression can be added later without changing the
 * reader or the file layout.
 *
 * @see https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md
 */
import { xxhash32 } from './xxhash32.js';

const MAGIC = 0x184d2204;
/** Block-maximum-size selector 4 == 64 KiB. */
const BLOCK_MAX_SIZE_ID = 4;
const BLOCK_MAX_SIZE = 64 * 1024;
/** Version 01 in bits 7-6, block independence in bit 5. */
const FLG_VERSION_AND_INDEPENDENCE = 0x60;
const FLG_CONTENT_CHECKSUM = 1 << 2;
const FLG_CONTENT_SIZE = 1 << 3;
const FLG_BLOCK_CHECKSUM = 1 << 4;
const FLG_DICT_ID = 1 << 0;
const UNCOMPRESSED_BLOCK_FLAG = 0x80000000;

/** Wraps `data` in a single LZ4 frame using stored (uncompressed) blocks. */
export function encodeLz4Frame(data: Uint8Array): Uint8Array {
	const blockCount = Math.max(1, Math.ceil(data.length / BLOCK_MAX_SIZE));
	const frameSize = 7 + blockCount * 4 + data.length + 4;
	const frame = new Uint8Array(frameSize);
	const view = new DataView(frame.buffer);

	view.setUint32(0, MAGIC, true);
	const flg = FLG_VERSION_AND_INDEPENDENCE;
	const bd = BLOCK_MAX_SIZE_ID << 4;
	frame[4] = flg;
	frame[5] = bd;
	frame[6] = (xxhash32(frame.subarray(4, 6)) >>> 8) & 0xff;

	let cursor = 7;
	for (let offset = 0; offset < data.length; offset += BLOCK_MAX_SIZE) {
		const chunk = data.subarray(
			offset,
			Math.min(offset + BLOCK_MAX_SIZE, data.length)
		);
		view.setUint32(
			cursor,
			(chunk.length | UNCOMPRESSED_BLOCK_FLAG) >>> 0,
			true
		);
		cursor += 4;
		frame.set(chunk, cursor);
		cursor += chunk.length;
	}
	if (data.length === 0) {
		// A zero-length payload still needs one empty stored block.
		view.setUint32(cursor, UNCOMPRESSED_BLOCK_FLAG >>> 0, true);
		cursor += 4;
	}

	// EndMark. No content checksum is emitted (C.Checksum is clear in FLG).
	view.setUint32(cursor, 0, true);
	cursor += 4;

	return frame.subarray(0, cursor);
}

/**
 * Decodes one LZ4 frame starting at `offset`.
 *
 * Returns the payload plus the offset just past the frame, so a caller walking
 * a page block can continue from there.
 */
export function decodeLz4Frame(
	source: Uint8Array,
	offset = 0
): { data: Uint8Array; offset: number } {
	const view = new DataView(
		source.buffer,
		source.byteOffset,
		source.byteLength
	);
	if (view.getUint32(offset, true) !== MAGIC) {
		throw new Error(`Not an LZ4 frame at offset ${offset}`);
	}
	let cursor = offset + 4;

	const flg = source[cursor++];
	const bd = source[cursor++];
	if ((flg & 0xc0) !== 0x40) {
		throw new Error('Unsupported LZ4 frame version');
	}
	if (flg & FLG_CONTENT_SIZE) cursor += 8;
	if (flg & FLG_DICT_ID) cursor += 4;
	// Header checksum byte.
	cursor++;

	const hasBlockChecksum = Boolean(flg & FLG_BLOCK_CHECKSUM);
	const hasContentChecksum = Boolean(flg & FLG_CONTENT_CHECKSUM);
	const blockMaxSize = blockMaxSizeFor(bd);

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const blockHeader = view.getUint32(cursor, true);
		cursor += 4;
		if (blockHeader === 0) break;

		const isUncompressed = (blockHeader & UNCOMPRESSED_BLOCK_FLAG) !== 0;
		const blockSize = blockHeader & 0x7fffffff;
		const block = source.subarray(cursor, cursor + blockSize);
		cursor += blockSize;
		if (hasBlockChecksum) cursor += 4;

		const chunk = isUncompressed
			? block
			: decompressLz4Block(block, blockMaxSize);
		chunks.push(chunk);
		total += chunk.length;
	}
	if (hasContentChecksum) cursor += 4;

	const data = new Uint8Array(total);
	let written = 0;
	for (const chunk of chunks) {
		data.set(chunk, written);
		written += chunk.length;
	}
	return { data, offset: cursor };
}

function blockMaxSizeFor(bd: number): number {
	switch ((bd >> 4) & 0x7) {
		case 4:
			return 64 * 1024;
		case 5:
			return 256 * 1024;
		case 6:
			return 1024 * 1024;
		case 7:
			return 4 * 1024 * 1024;
		default:
			throw new Error(`Unsupported LZ4 block maximum size: ${bd}`);
	}
}

/**
 * Decompresses one LZ4 block.
 *
 * The block format is a series of sequences: a token byte splitting into a
 * literal length and a match length, optional length-extension bytes, the
 * literals themselves, and a two-byte little-endian back-reference offset.
 * Matches may overlap their own output, so the copy is byte-at-a-time.
 */
function decompressLz4Block(block: Uint8Array, maxSize: number): Uint8Array {
	const out = new Uint8Array(maxSize);
	let input = 0;
	let output = 0;

	while (input < block.length) {
		const token = block[input++];

		let literalLength = token >> 4;
		if (literalLength === 15) {
			let extension = 0;
			do {
				extension = block[input++];
				literalLength += extension;
			} while (extension === 255);
		}

		for (let i = 0; i < literalLength; i++) {
			out[output++] = block[input++];
		}

		// The final sequence ends after its literals, with no match.
		if (input >= block.length) break;

		const matchOffset = block[input] | (block[input + 1] << 8);
		input += 2;
		if (matchOffset === 0) {
			throw new Error('Invalid LZ4 match offset 0');
		}

		let matchLength = token & 0x0f;
		if (matchLength === 15) {
			let extension = 0;
			do {
				extension = block[input++];
				matchLength += extension;
			} while (extension === 255);
		}
		matchLength += 4;

		let matchPosition = output - matchOffset;
		for (let i = 0; i < matchLength; i++) {
			out[output++] = out[matchPosition++];
		}
	}

	return out.subarray(0, output);
}
