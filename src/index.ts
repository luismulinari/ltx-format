/**
 * ltx-format — a reader and writer for the LTX (Lite Transaction) file format,
 * version 3, as produced and consumed by Litestream v0.5.
 *
 * The package is pure: it performs no I/O and knows nothing about SQLite,
 * object storage, or any particular runtime. Give it pages, get bytes back.
 *
 * @packageDocumentation
 */

export {
	CHECKSUM_FLAG,
	Crc64,
	checksumPage,
	crc64,
	foldPageChecksum,
} from './crc64.js';
export type { DecodedLtx, DecodeOptions } from './decode.js';
export {
	applyLtxToImage,
	decodeLtx,
	decodeToSnapshotImage,
} from './decode.js';
export type { EncodeLtxOptions } from './encode.js';
export { encodeLtx } from './encode.js';
export type { LtxHeader, LtxPage, LtxTrailer } from './format.js';
export {
	formatFilename,
	formatTxid,
	HEADER_FLAG_NO_CHECKSUM,
	HEADER_SIZE,
	isSnapshot,
	isValidPageSize,
	lockPgno,
	MAGIC,
	PAGE_HEADER_SIZE,
	PENDING_BYTE,
	parseTxid,
	readHeader,
	TRAILER_SIZE,
	VERSION,
	writeHeader,
} from './format.js';

export { decodeLz4Frame, encodeLz4Frame } from './lz4.js';
export { readUvarint, uvarintSize, writeUvarint } from './varint.js';
export { xxhash32 } from './xxhash32.js';
