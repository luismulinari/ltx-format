/**
 * xxHash32, needed by the LZ4 frame format for the frame-descriptor checksum
 * and the optional content checksum.
 *
 * Only the one-shot form is required: frame descriptors are a handful of bytes
 * and content checksums are verified over an already-assembled block.
 */

const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

export function xxhash32(input: Uint8Array, seed = 0): number {
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const length = input.length;
	let index = 0;
	let h32: number;

	if (length >= 16) {
		const limit = length - 16;
		let v1 = (seed + PRIME1 + PRIME2) | 0;
		let v2 = (seed + PRIME2) | 0;
		let v3 = (seed + 0) | 0;
		let v4 = (seed - PRIME1) | 0;

		do {
			v1 = round(v1, view.getUint32(index, true));
			v2 = round(v2, view.getUint32(index + 4, true));
			v3 = round(v3, view.getUint32(index + 8, true));
			v4 = round(v4, view.getUint32(index + 12, true));
			index += 16;
		} while (index <= limit);

		h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
	} else {
		h32 = (seed + PRIME5) | 0;
	}

	h32 = (h32 + length) | 0;

	while (index + 4 <= length) {
		h32 =
			imul(
				rotl((h32 + imul(view.getUint32(index, true), PRIME3)) | 0, 17),
				PRIME4
			) | 0;
		index += 4;
	}

	while (index < length) {
		h32 =
			imul(rotl((h32 + imul(input[index], PRIME5)) | 0, 11), PRIME1) | 0;
		index++;
	}

	h32 = (h32 ^ (h32 >>> 15)) | 0;
	h32 = imul(h32, PRIME2) | 0;
	h32 = (h32 ^ (h32 >>> 13)) | 0;
	h32 = imul(h32, PRIME3) | 0;
	h32 = (h32 ^ (h32 >>> 16)) | 0;

	return h32 >>> 0;
}

function round(acc: number, value: number): number {
	return imul(rotl((acc + imul(value, PRIME2)) | 0, 13), PRIME1) | 0;
}

function rotl(value: number, bits: number): number {
	return (value << bits) | (value >>> (32 - bits)) | 0;
}

function imul(a: number, b: number): number {
	return Math.imul(a, b);
}
