/**
 * Unsigned LEB128 varints, matching Go's `encoding/binary` `PutUvarint` /
 * `Uvarint`, which the LTX page index uses.
 *
 * Values are emitted seven bits at a time, least significant group first, with
 * the high bit of each byte marking continuation.
 */

/** Appends `value` to `out` as a uvarint. Returns the number of bytes written. */
export function writeUvarint(out: number[], value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Cannot encode ${value} as a uvarint`);
	}
	let remaining = value;
	let written = 0;
	while (remaining >= 0x80) {
		out.push((remaining & 0x7f) | 0x80);
		// `>>> 7` would truncate above 2^32; divide to stay exact to 2^53.
		remaining = Math.floor(remaining / 128);
		written++;
	}
	out.push(remaining);
	return written + 1;
}

/** Reads a uvarint at `offset`, returning the value and the new offset. */
export function readUvarint(
	data: Uint8Array,
	offset: number
): { value: number; offset: number } {
	let value = 0;
	let shift = 1;
	let cursor = offset;
	for (;;) {
		if (cursor >= data.length) {
			throw new Error('Truncated uvarint');
		}
		const byte = data[cursor++];
		value += (byte & 0x7f) * shift;
		if ((byte & 0x80) === 0) break;
		shift *= 128;
		if (!Number.isSafeInteger(value)) {
			throw new Error('Uvarint exceeds the safe integer range');
		}
	}
	return { value, offset: cursor };
}

/** Byte length `value` occupies as a uvarint, without allocating. */
export function uvarintSize(value: number): number {
	let size = 1;
	let remaining = value;
	while (remaining >= 0x80) {
		remaining = Math.floor(remaining / 128);
		size++;
	}
	return size;
}
