/**
 * LTX file decoding: page block, page index, checksum verification, and
 * reconstruction of a full SQLite database image.
 */
import { CHECKSUM_FLAG, Crc64, foldPageChecksum } from './crc64.js';
import type { LtxHeader, LtxPage, LtxTrailer } from './format.js';
import {
	HEADER_FLAG_NO_CHECKSUM,
	HEADER_SIZE,
	isSnapshot,
	lockPgno,
	PAGE_HEADER_SIZE,
	readHeader,
	readPageHeader,
	TRAILER_SIZE,
	writePageHeader,
} from './format.js';
import { decodeLz4Frame } from './lz4.js';
import { readUvarint } from './varint.js';

export interface DecodedLtx {
	header: LtxHeader;
	trailer: LtxTrailer;
	pages: LtxPage[];
	/** Rolling post-apply checksum computed over the decoded pages. */
	computedPostApplyChecksum: bigint;
}

export interface DecodeOptions {
	/**
	 * Verify the trailer's file checksum. On by default; disable only when
	 * decoding a file you are still assembling.
	 */
	verifyChecksums?: boolean;
}

/** Decodes a complete LTX file. */
export function decodeLtx(
	source: Uint8Array,
	options: DecodeOptions = {}
): DecodedLtx {
	const verifyChecksums = options.verifyChecksums ?? true;
	const header = readHeader(source);

	if (source.length < HEADER_SIZE + PAGE_HEADER_SIZE + 8 + TRAILER_SIZE) {
		throw new Error('LTX file is truncated');
	}

	const view = new DataView(
		source.buffer,
		source.byteOffset,
		source.byteLength
	);
	const trailerOffset = source.length - TRAILER_SIZE;
	const trailer: LtxTrailer = {
		postApplyChecksum: view.getBigUint64(trailerOffset, false),
		fileChecksum: view.getBigUint64(trailerOffset + 8, false),
	};

	// Walk the page block. Each entry is a page header followed by one
	// independent LZ4 frame; a pgno of 0 terminates the block.
	const pages: LtxPage[] = [];
	const rawPageEntries: Array<{ pgno: number; offset: number }> = [];
	let cursor = HEADER_SIZE;
	let rolling = CHECKSUM_FLAG;
	const lock = lockPgno(header.pageSize);
	const trackChecksums = (header.flags & HEADER_FLAG_NO_CHECKSUM) === 0;

	for (;;) {
		const entryOffset = cursor;
		const pageHeader = readPageHeader(source, cursor);
		cursor += PAGE_HEADER_SIZE;
		if (pageHeader.pgno === 0) {
			if (pageHeader.flags !== 0) {
				throw new Error('LTX page block terminator has non-zero flags');
			}
			break;
		}
		if (pageHeader.flags !== 0) {
			throw new Error(
				`LTX page ${pageHeader.pgno} has unsupported flags`
			);
		}

		const frame = decodeLz4Frame(source, cursor);
		cursor = frame.offset;
		if (frame.data.length !== header.pageSize) {
			throw new Error(
				`LTX page ${pageHeader.pgno} decompressed to ${frame.data.length} ` +
					`bytes, expected ${header.pageSize}`
			);
		}

		pages.push({ pgno: pageHeader.pgno, data: frame.data });
		rawPageEntries.push({ pgno: pageHeader.pgno, offset: entryOffset });
		if (pageHeader.pgno !== lock) {
			rolling = foldPageChecksum(rolling, pageHeader.pgno, frame.data);
		}
	}

	const pageBlockEnd = cursor;
	verifyPageIndex(source, pageBlockEnd, rawPageEntries);

	if (verifyChecksums) {
		const computed = computeFileChecksum(source, header, pages, trailer);
		if (computed !== trailer.fileChecksum) {
			throw new Error(
				`LTX file checksum mismatch: computed ${computed.toString(16)}, ` +
					`stored ${trailer.fileChecksum.toString(16)}`
			);
		}
		if (trackChecksums && isSnapshot(header)) {
			if (rolling !== trailer.postApplyChecksum) {
				throw new Error(
					`LTX post-apply checksum mismatch: computed ` +
						`${rolling.toString(16)}, stored ` +
						`${trailer.postApplyChecksum.toString(16)}`
				);
			}
		}
	}

	return {
		header,
		trailer,
		pages,
		computedPostApplyChecksum: rolling,
	};
}

/**
 * Reconstructs the full database image a snapshot describes.
 *
 * Emits pages `1..=commit` in order, zero-filling the lock page, exactly as
 * `Decoder.DecodeDatabaseTo` does in superfly/ltx.
 */
export function decodeToSnapshotImage(decoded: DecodedLtx): Uint8Array {
	const { header, pages } = decoded;
	const byPgno = new Map<number, Uint8Array>();
	for (const page of pages) {
		byPgno.set(page.pgno, page.data);
	}

	const lock = lockPgno(header.pageSize);
	const image = new Uint8Array(header.commit * header.pageSize);
	for (let pgno = 1; pgno <= header.commit; pgno++) {
		if (pgno === lock) continue; // Left zero-filled.
		const data = byPgno.get(pgno);
		if (!data) {
			throw new Error(
				`Cannot rebuild image: page ${pgno} missing from snapshot`
			);
		}
		image.set(data, (pgno - 1) * header.pageSize);
	}
	return image;
}

/**
 * Applies an incremental LTX onto an existing database image, returning the
 * new image. Pages beyond `commit` are truncated away.
 */
export function applyLtxToImage(
	image: Uint8Array,
	decoded: DecodedLtx
): Uint8Array {
	const { header, pages } = decoded;
	const next = new Uint8Array(header.commit * header.pageSize);
	next.set(image.subarray(0, Math.min(image.length, next.length)));
	for (const page of pages) {
		if (page.pgno > header.commit) continue;
		next.set(page.data, (page.pgno - 1) * header.pageSize);
	}
	return next;
}

/**
 * Recomputes the trailer's file checksum.
 *
 * The feed is deliberately built from *decompressed* page data: a decoder
 * cannot simply hash the raw file bytes, because the on-disk pages are LZ4
 * frames. Getting this wrong yields files that look structurally valid and
 * fail verification in the reference implementation.
 */
export function computeFileChecksum(
	source: Uint8Array,
	header: LtxHeader,
	pages: LtxPage[],
	trailer: LtxTrailer
): bigint {
	const hasher = new Crc64();
	hasher.update(source.subarray(0, HEADER_SIZE));
	for (const page of pages) {
		hasher.update(writePageHeader(page.pgno));
		hasher.update(page.data);
	}
	hasher.update(writePageHeader(0));

	// The page index region, including its trailing u64 size field.
	const sizeFieldOffset = source.length - TRAILER_SIZE - 8;
	const view = new DataView(
		source.buffer,
		source.byteOffset,
		source.byteLength
	);
	const indexLength = Number(view.getBigUint64(sizeFieldOffset, false));
	const indexStart = sizeFieldOffset - indexLength;
	hasher.update(source.subarray(indexStart, sizeFieldOffset + 8));

	const postApply = new Uint8Array(8);
	new DataView(postApply.buffer).setBigUint64(
		0,
		trailer.postApplyChecksum,
		false
	);
	hasher.update(postApply);

	// Reference `header` so the signature stays honest about its inputs even
	// though the bytes come from `source`.
	void header;
	return CHECKSUM_FLAG | hasher.sum64();
}

/**
 * Cross-checks the page index against the page block that precedes it.
 *
 * The index is redundant with the block — it exists so a reader can seek
 * directly to a page — so a mismatch means the file is malformed.
 */
function verifyPageIndex(
	source: Uint8Array,
	pageBlockEnd: number,
	entries: Array<{ pgno: number; offset: number }>
) {
	const view = new DataView(
		source.buffer,
		source.byteOffset,
		source.byteLength
	);
	const sizeFieldOffset = source.length - TRAILER_SIZE - 8;
	const indexLength = Number(view.getBigUint64(sizeFieldOffset, false));
	const indexStart = sizeFieldOffset - indexLength;
	if (indexStart !== pageBlockEnd) {
		throw new Error(
			`LTX page index starts at ${indexStart}, expected ${pageBlockEnd}`
		);
	}

	const expected = [...entries].sort((a, b) => a.pgno - b.pgno);
	let cursor = indexStart;
	let seen = 0;
	for (;;) {
		const pgnoRead = readUvarint(source, cursor);
		cursor = pgnoRead.offset;
		if (pgnoRead.value === 0) break;
		const offsetRead = readUvarint(source, cursor);
		cursor = offsetRead.offset;
		const sizeRead = readUvarint(source, cursor);
		cursor = sizeRead.offset;

		const entry = expected[seen++];
		if (!entry || entry.pgno !== pgnoRead.value) {
			throw new Error(
				`LTX page index disagrees with the page block at position ${seen - 1}`
			);
		}
		if (entry.offset !== offsetRead.value) {
			throw new Error(
				`LTX page index offset ${offsetRead.value} for page ` +
					`${pgnoRead.value} does not match block offset ${entry.offset}`
			);
		}
	}
	if (seen !== expected.length) {
		throw new Error(
			`LTX page index lists ${seen} pages, page block has ${expected.length}`
		);
	}
	if (cursor !== sizeFieldOffset) {
		throw new Error('LTX page index length does not match its size field');
	}
}
