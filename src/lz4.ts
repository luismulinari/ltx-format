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
	let cursor = offset;
	/** Guards every read, since `source` is untrusted input. */
	function needBytes(bytes: number, what: string) {
		if (cursor + bytes > source.length) {
			throw new Error(`Truncated LZ4 frame: ${what}`);
		}
	}

	needBytes(7, 'no room for a frame descriptor');
	if (view.getUint32(cursor, true) !== MAGIC) {
		throw new Error(`Not an LZ4 frame at offset ${offset}`);
	}
	cursor += 4;

	const flg = source[cursor++];
	const bd = source[cursor++];
	if ((flg & 0xc0) !== 0x40) {
		throw new Error('Unsupported LZ4 frame version');
	}
	if (flg & FLG_CONTENT_SIZE) cursor += 8;
	if (flg & FLG_DICT_ID) cursor += 4;
	// Header checksum byte.
	cursor++;
	needBytes(0, 'frame descriptor runs past its end');

	const hasBlockChecksum = Boolean(flg & FLG_BLOCK_CHECKSUM);
	const hasContentChecksum = Boolean(flg & FLG_CONTENT_CHECKSUM);
	const blockMaxSize = blockMaxSizeFor(bd);

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		needBytes(4, 'no room for a block header');
		const blockHeader = view.getUint32(cursor, true);
		cursor += 4;
		if (blockHeader === 0) break;

		const isUncompressed = (blockHeader & UNCOMPRESSED_BLOCK_FLAG) !== 0;
		const blockSize = blockHeader & 0x7fffffff;
		if (blockSize > blockMaxSize) {
			throw new Error(
				`LZ4 block of ${blockSize} bytes exceeds the frame's ${blockMaxSize}-byte maximum`
			);
		}
		needBytes(
			blockSize + (hasBlockChecksum ? 4 : 0),
			'block runs past its end'
		);
		const block = source.subarray(cursor, cursor + blockSize);
		cursor += blockSize;
		if (hasBlockChecksum) cursor += 4;

		const chunk = isUncompressed
			? block
			: decompressLz4Block(block, blockMaxSize);
		chunks.push(chunk);
		total += chunk.length;
	}
	if (hasContentChecksum) {
		needBytes(4, 'no room for the content checksum');
		cursor += 4;
	}

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
 * Matches may overlap their own output, so that copy is byte-at-a-time.
 *
 * Every length in a block is attacker-controlled, so each one is checked
 * against both the remaining input and the output capacity before it is used.
 * Writing past a `Uint8Array` is silently discarded rather than throwing, so
 * without these checks a truncated block would decode to plausible-looking
 * garbage instead of an error.
 */
function decompressLz4Block(block: Uint8Array, maxSize: number): Uint8Array {
	const out = new Uint8Array(maxSize);
	let input = 0;
	let output = 0;

	/** Reads a length extension: a run of 255s ended by any other byte. */
	function readLengthExtension(base: number): number {
		let length = base;
		for (;;) {
			if (input >= block.length) {
				throw new Error('Truncated LZ4 block: unterminated length');
			}
			const extension = block[input++];
			length += extension;
			if (extension !== 255) return length;
		}
	}

	while (input < block.length) {
		const token = block[input++];

		let literalLength = token >> 4;
		if (literalLength === 15) {
			literalLength = readLengthExtension(literalLength);
		}
		if (input + literalLength > block.length) {
			throw new Error('Truncated LZ4 block: literals run past its end');
		}
		if (output + literalLength > out.length) {
			throw new Error('LZ4 block decompresses past its maximum size');
		}
		out.set(block.subarray(input, input + literalLength), output);
		input += literalLength;
		output += literalLength;

		// The final sequence ends after its literals, with no match.
		if (input >= block.length) break;

		if (input + 2 > block.length) {
			throw new Error(
				'Truncated LZ4 block: match offset runs past its end'
			);
		}
		const matchOffset = block[input] | (block[input + 1] << 8);
		input += 2;
		if (matchOffset === 0) {
			throw new Error('Invalid LZ4 match offset 0');
		}
		if (matchOffset > output) {
			throw new Error('LZ4 match offset points before the block');
		}

		let matchLength = token & 0x0f;
		if (matchLength === 15) {
			matchLength = readLengthExtension(matchLength);
		}
		matchLength += 4;
		if (output + matchLength > out.length) {
			throw new Error('LZ4 block decompresses past its maximum size');
		}

		let matchPosition = output - matchOffset;
		for (let i = 0; i < matchLength; i++) {
			out[output++] = out[matchPosition++];
		}
	}

	return out.subarray(0, output);
}
