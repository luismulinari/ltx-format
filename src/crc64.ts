/**
 * CRC-64/ISO, matching Go's `hash/crc64` with `crc64.MakeTable(crc64.ISO)`.
 *
 * LTX stores this checksum in page headers and the file trailer, so the
 * implementation has to agree with Go's byte-for-byte. Go's digest is
 * reflected, initialised to 0, and inverts the running value before and after
 * each update.
 *
 * The state is carried as two 32-bit halves rather than a BigInt: a BigInt
 * round-trip per byte makes checksumming a multi-megabyte database roughly two
 * orders of magnitude slower, and page checksums sit on the hot path of every
 * captured transaction.
 */

/** CRC-64/ISO polynomial (reflected), high half. `0xD800000000000000`. */
const POLY_HI = 0xd8000000;
const POLY_LO = 0x00000000;

/** Flag bit set on every stored LTX checksum, so a valid checksum is never 0. */
export const CHECKSUM_FLAG = 1n << 63n;

const TABLE_HI = new Uint32Array(256);
const TABLE_LO = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
	let hi = 0;
	let lo = i;
	for (let bit = 0; bit < 8; bit++) {
		const lsb = lo & 1;
		// Logical shift right by one across the 64-bit pair.
		lo = ((lo >>> 1) | (hi << 31)) >>> 0;
		hi = hi >>> 1;
		if (lsb) {
			hi = (hi ^ POLY_HI) >>> 0;
			lo = (lo ^ POLY_LO) >>> 0;
		}
	}
	TABLE_HI[i] = hi;
	TABLE_LO[i] = lo;
}

/**
 * Streaming CRC-64/ISO hasher.
 *
 * Mirrors Go's digest semantics: `update` inverts, processes, and inverts
 * again, so partial sums can be chained across calls.
 */
export class Crc64 {
	#hi = 0;
	#lo = 0;

	update(data: Uint8Array): this {
		// Invert, process, invert — Go's `hash/crc64` update contract.
		let hi = ~this.#hi >>> 0;
		let lo = ~this.#lo >>> 0;
		for (let i = 0; i < data.length; i++) {
			const index = ((lo ^ data[i]) & 0xff) >>> 0;
			const shiftedLo = ((lo >>> 8) | (hi << 24)) >>> 0;
			const shiftedHi = hi >>> 8;
			hi = (shiftedHi ^ TABLE_HI[index]) >>> 0;
			lo = (shiftedLo ^ TABLE_LO[index]) >>> 0;
		}
		this.#hi = ~hi >>> 0;
		this.#lo = ~lo >>> 0;
		return this;
	}

	sum64(): bigint {
		return (
			((BigInt(this.#hi) << 32n) | BigInt(this.#lo)) & 0xffffffffffffffffn
		);
	}
}

/** Convenience wrapper computing a one-shot CRC-64/ISO over `data`. */
export function crc64(data: Uint8Array): bigint {
	return new Crc64().update(data).sum64();
}

/**
 * Per-page checksum: `ChecksumFlag | CRC64(BE_u32(pgno) ++ data)`.
 *
 * Ported from `ChecksumPage` in ltx v0.5.1 checksum.go:106-116.
 */
export function checksumPage(pgno: number, data: Uint8Array): bigint {
	const prefix = new Uint8Array(4);
	new DataView(prefix.buffer).setUint32(0, pgno, false);
	const hasher = new Crc64();
	hasher.update(prefix);
	hasher.update(data);
	return CHECKSUM_FLAG | hasher.sum64();
}

/**
 * Folds a page into a rolling post-apply database checksum.
 *
 * The rolling value starts at {@link CHECKSUM_FLAG} and XORs in each non-lock
 * page, re-setting the flag each time so the result is never zero.
 */
export function foldPageChecksum(
	rolling: bigint,
	pgno: number,
	data: Uint8Array
) {
	return (
		(CHECKSUM_FLAG | (rolling ^ checksumPage(pgno, data))) &
		0xffffffffffffffffn
	);
}
