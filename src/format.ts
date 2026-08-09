/**
 * LTX (Lite Transaction) file format, version 3 — constants and structs.
 *
 * Byte layout per the reference implementation, superfly/ltx v0.5.1. See
 * `docs/format.md` for the full specification. All multi-byte integers are
 * big-endian.
 *
 * ```
 * +----------------------+
 * | Header   (100 bytes) |
 * +----------------------+
 * | PageHeader(6) + LZ4-frame(page data)   × N
 * +----------------------+
 * | Empty PageHeader (6) |  pgno == 0 terminates the page block
 * +----------------------+
 * | Page index           |  uvarint tuples + terminator + u64 size
 * +----------------------+
 * | Trailer  (16 bytes)  |
 * +----------------------+
 * ```
 */

export const MAGIC = 0x4c545831; // "LTX1"
export const VERSION = 3;
export const HEADER_SIZE = 100;
export const PAGE_HEADER_SIZE = 6;
export const TRAILER_SIZE = 16;

/** Checksums are not tracked for this file. The only valid header flag. */
export const HEADER_FLAG_NO_CHECKSUM = 1 << 1;
export const HEADER_FLAG_MASK = HEADER_FLAG_NO_CHECKSUM;

/** SQLite's PENDING_BYTE offset; the lock page derives from it. */
export const PENDING_BYTE = 0x40000000;

export interface LtxHeader {
	flags: number;
	pageSize: number;
	/** Database size, in pages, after this transaction is applied. */
	commit: number;
	minTXID: bigint;
	maxTXID: bigint;
	/** Milliseconds since the Unix epoch. */
	timestamp: bigint;
	/** Zero on snapshots (`minTXID === 1n`). */
	preApplyChecksum: bigint;
	/** Zero when the source was a rollback journal rather than a WAL. */
	walOffset: bigint;
	walSize: bigint;
	walSalt1: number;
	walSalt2: number;
	nodeID: bigint;
}

export interface LtxTrailer {
	postApplyChecksum: bigint;
	fileChecksum: bigint;
}

/** A single page carried by an LTX file. */
export interface LtxPage {
	pgno: number;
	data: Uint8Array;
}

/** `true` when this file is a full snapshot rather than an incremental. */
export function isSnapshot(header: LtxHeader): boolean {
	return header.minTXID === 1n;
}

/**
 * Page number of SQLite's lock page for a given page size.
 *
 * The lock page never carries real content; it is excluded from checksums and
 * zero-filled when a database image is reconstructed.
 */
export function lockPgno(pageSize: number): number {
	if (pageSize === 0) return 0;
	return Math.floor(PENDING_BYTE / pageSize) + 1;
}

/** SQLite page sizes are powers of two from 512 to 65536 inclusive. */
export function isValidPageSize(size: number): boolean {
	return (
		Number.isInteger(size) &&
		size >= 512 &&
		size <= 65536 &&
		(size & (size - 1)) === 0
	);
}

/** LTX filename convention: `<minTXID>-<maxTXID>.ltx`, 16 hex digits each. */
export function formatFilename(minTXID: bigint, maxTXID: bigint): string {
	return `${formatTxid(minTXID)}-${formatTxid(maxTXID)}.ltx`;
}

/** Formats a TXID as a zero-padded 16-character lowercase hex string. */
export function formatTxid(txid: bigint): string {
	return txid.toString(16).padStart(16, '0');
}

/** Parses a TXID from its canonical 16-character lowercase hex form. */
export function parseTxid(text: string): bigint {
	if (text.length !== 16 || !/^[0-9a-fA-F]{16}$/.test(text)) {
		throw new Error(
			`Invalid transaction id format: ${JSON.stringify(text)}`
		);
	}
	return BigInt(`0x${text}`);
}

export function readHeader(data: Uint8Array): LtxHeader {
	if (data.length < HEADER_SIZE) {
		throw new Error('LTX file is shorter than its header');
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (view.getUint32(0, false) !== MAGIC) {
		throw new Error('Not an LTX file: bad magic');
	}
	const header: LtxHeader = {
		flags: view.getUint32(4, false),
		pageSize: view.getUint32(8, false),
		commit: view.getUint32(12, false),
		minTXID: view.getBigUint64(16, false),
		maxTXID: view.getBigUint64(24, false),
		timestamp: view.getBigInt64(32, false),
		preApplyChecksum: view.getBigUint64(40, false),
		walOffset: view.getBigInt64(48, false),
		walSize: view.getBigInt64(56, false),
		walSalt1: view.getUint32(64, false),
		walSalt2: view.getUint32(68, false),
		nodeID: view.getBigUint64(72, false),
	};
	validateHeader(header);
	return header;
}

export function writeHeader(header: LtxHeader): Uint8Array {
	validateHeader(header);
	const bytes = new Uint8Array(HEADER_SIZE);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, MAGIC, false);
	view.setUint32(4, header.flags, false);
	view.setUint32(8, header.pageSize, false);
	view.setUint32(12, header.commit, false);
	view.setBigUint64(16, header.minTXID, false);
	view.setBigUint64(24, header.maxTXID, false);
	view.setBigInt64(32, header.timestamp, false);
	view.setBigUint64(40, header.preApplyChecksum, false);
	view.setBigInt64(48, header.walOffset, false);
	view.setBigInt64(56, header.walSize, false);
	view.setUint32(64, header.walSalt1, false);
	view.setUint32(68, header.walSalt2, false);
	view.setBigUint64(72, header.nodeID, false);
	// Bytes 80..100 are reserved and stay zero.
	return bytes;
}

function validateHeader(header: LtxHeader) {
	if (!isValidPageSize(header.pageSize)) {
		throw new Error(`Invalid LTX page size: ${header.pageSize}`);
	}
	if ((header.flags & ~HEADER_FLAG_MASK) !== 0) {
		throw new Error(`Invalid LTX header flags: ${header.flags}`);
	}
	if (header.minTXID > header.maxTXID) {
		throw new Error('LTX minTXID is greater than maxTXID');
	}
	if (header.minTXID === 0n) {
		throw new Error('LTX minTXID must be non-zero');
	}
	if (isSnapshot(header) && header.preApplyChecksum !== 0n) {
		throw new Error('LTX snapshot must have a zero pre-apply checksum');
	}
	/*
	 * The pre-apply checksum only carries meaning when checksums are tracked.
	 * Litestream v0.5.11 sets HeaderFlagNoChecksum and writes zero here even on
	 * incrementals, so requiring a value unconditionally would reject files the
	 * reference implementation produces.
	 */
	const tracksChecksums = (header.flags & HEADER_FLAG_NO_CHECKSUM) === 0;
	if (
		tracksChecksums &&
		!isSnapshot(header) &&
		header.preApplyChecksum === 0n
	) {
		throw new Error('LTX non-snapshot requires a pre-apply checksum');
	}
}

export function readPageHeader(
	data: Uint8Array,
	offset: number
): { pgno: number; flags: number } {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return {
		pgno: view.getUint32(offset, false),
		flags: view.getUint16(offset + 4, false),
	};
}

export function writePageHeader(pgno: number, flags = 0): Uint8Array {
	const bytes = new Uint8Array(PAGE_HEADER_SIZE);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, pgno, false);
	view.setUint16(4, flags, false);
	return bytes;
}
