/**
 * LTX file encoding.
 *
 * Produces files byte-compatible with Litestream v0.5.11, so a replica written
 * here can be read by `litestream restore`. That compatibility is enforced by a
 * differential test rather than assumed.
 */
import { CHECKSUM_FLAG, Crc64, foldPageChecksum } from './crc64.js';
import type { LtxHeader, LtxPage } from './format.js';
import {
	HEADER_FLAG_NO_CHECKSUM,
	isValidPageSize,
	lockPgno,
	PAGE_HEADER_SIZE,
	writeHeader,
	writePageHeader,
} from './format.js';
import { encodeLz4Frame } from './lz4.js';
import { writeUvarint } from './varint.js';

export interface EncodeLtxOptions {
	pageSize: number;
	/** Database size, in pages, after this transaction is applied. */
	commit: number;
	minTXID: bigint;
	maxTXID: bigint;
	pages: LtxPage[];
	/**
	 * Required for incrementals (`minTXID > 1n`) unless checksum tracking is
	 * disabled. Must be the post-apply checksum of the preceding transaction.
	 */
	preApplyChecksum?: bigint;
	/**
	 * Post-apply checksum to store. Computed automatically for snapshots; for
	 * incrementals it depends on pages this file does not carry, so the caller
	 * must supply it when checksum tracking is enabled.
	 */
	postApplyChecksum?: bigint;
	/**
	 * Whether to track rolling checksums. Defaults to `false`, matching what
	 * Litestream v0.5.11 emits (it sets `HeaderFlagNoChecksum`).
	 */
	trackChecksums?: boolean;
	/** Milliseconds since the Unix epoch. Defaults to 0 for reproducibility. */
	timestamp?: bigint;
	nodeID?: bigint;
	/** WAL provenance. All zero when the source was a rollback journal. */
	walOffset?: bigint;
	walSize?: bigint;
	walSalt1?: number;
	walSalt2?: number;
}

/** Encodes one LTX file. */
export function encodeLtx(options: EncodeLtxOptions): Uint8Array {
	const {
		pageSize,
		commit,
		minTXID,
		maxTXID,
		trackChecksums = false,
		timestamp = 0n,
		nodeID = 0n,
		walOffset = 0n,
		walSize = 0n,
		walSalt1 = 0,
		walSalt2 = 0,
	} = options;

	if (!isValidPageSize(pageSize)) {
		throw new Error(`Invalid LTX page size: ${pageSize}`);
	}

	// Pages must appear in ascending order: the index requires it, and keeping
	// the block in the same order makes block and index offsets agree.
	const pages = [...options.pages].sort((a, b) => a.pgno - b.pgno);
	const isSnapshotFile = minTXID === 1n;
	assertPagesAreValid(pages, pageSize, commit, isSnapshotFile);

	const header: LtxHeader = {
		flags: trackChecksums ? 0 : HEADER_FLAG_NO_CHECKSUM,
		pageSize,
		commit,
		minTXID,
		maxTXID,
		timestamp,
		preApplyChecksum: isSnapshotFile
			? 0n
			: (options.preApplyChecksum ?? 0n),
		walOffset,
		walSize,
		walSalt1,
		walSalt2,
		nodeID,
	};
	if (trackChecksums && !isSnapshotFile && header.preApplyChecksum === 0n) {
		// `writeHeader` would reject this, but the message here is actionable.
		throw new Error(
			'encodeLtx: incremental files require a non-zero preApplyChecksum ' +
				'when checksum tracking is enabled'
		);
	}
	if (!trackChecksums && header.preApplyChecksum !== 0n) {
		throw new Error(
			'encodeLtx: preApplyChecksum is not allowed unless trackChecksums ' +
				'is enabled — the reference implementation rejects such files'
		);
	}
	const headerBytes = writeHeader(header);

	// Page block: each page is a 6-byte header plus one independent LZ4 frame.
	const frames = pages.map((page) => encodeLz4Frame(page.data));
	const index: Array<{ pgno: number; offset: number; size: number }> = [];
	let cursor = headerBytes.length;
	for (let i = 0; i < pages.length; i++) {
		index.push({
			pgno: pages[i].pgno,
			offset: cursor,
			size: PAGE_HEADER_SIZE + frames[i].length,
		});
		cursor += PAGE_HEADER_SIZE + frames[i].length;
	}
	// The terminating empty page header.
	cursor += PAGE_HEADER_SIZE;

	const indexBytes = encodePageIndex(index);
	const postApplyChecksum = resolvePostApplyChecksum(
		options,
		pages,
		pageSize,
		trackChecksums,
		isSnapshotFile
	);

	const fileChecksum = computeFileChecksumForEncode(
		headerBytes,
		pages,
		indexBytes,
		postApplyChecksum
	);

	return assemble(
		headerBytes,
		pages,
		frames,
		indexBytes,
		postApplyChecksum,
		fileChecksum
	);
}

function assertPagesAreValid(
	pages: LtxPage[],
	pageSize: number,
	commit: number,
	isSnapshotFile: boolean
) {
	if (commit < 1) {
		throw new Error('LTX commit must be at least one page');
	}
	const lock = lockPgno(pageSize);
	let previous = 0;
	for (const page of pages) {
		if (page.pgno === 0) {
			throw new Error('LTX page number must be non-zero');
		}
		if (page.pgno === previous) {
			throw new Error(`LTX page ${page.pgno} appears more than once`);
		}
		if (page.pgno === lock) {
			throw new Error(
				`LTX must not carry the lock page (${lock}) for page size ${pageSize}`
			);
		}
		if (page.pgno > commit) {
			throw new Error(
				`LTX page ${page.pgno} is past the commit size of ${commit} pages`
			);
		}
		if (page.data.length !== pageSize) {
			throw new Error(
				`LTX page ${page.pgno} is ${page.data.length} bytes, expected ${pageSize}`
			);
		}
		if (isSnapshotFile) {
			// A snapshot has to carry the whole database, so the page numbers
			// run 1..commit with only the lock page missing. A gap here writes
			// a file `litestream restore` rejects outright.
			const expected = nextSnapshotPgno(previous, lock);
			if (page.pgno !== expected) {
				throw new Error(
					`LTX snapshot must carry every page: expected page ${expected}, got ${page.pgno}`
				);
			}
		}
		previous = page.pgno;
	}
	if (isSnapshotFile) {
		const last = commit === lock ? commit - 1 : commit;
		if (previous !== last) {
			throw new Error(
				`LTX snapshot must carry every page: expected page ${last} last, got ${previous || 'none'}`
			);
		}
	}
}

/** The page number that must follow `previous` in a snapshot. */
function nextSnapshotPgno(previous: number, lock: number): number {
	if (previous === 0) return 1;
	// The lock page is never carried, so it is stepped over rather than emitted.
	return previous + 1 === lock ? previous + 2 : previous + 1;
}

/** Encodes the page index region, including its trailing u64 length field. */
function encodePageIndex(
	index: Array<{ pgno: number; offset: number; size: number }>
): Uint8Array {
	const body: number[] = [];
	for (const entry of index) {
		writeUvarint(body, entry.pgno);
		writeUvarint(body, entry.offset);
		writeUvarint(body, entry.size);
	}
	// Terminator.
	writeUvarint(body, 0);

	const bytes = new Uint8Array(body.length + 8);
	bytes.set(body, 0);
	// The size field covers the elements and terminator, but not itself.
	new DataView(bytes.buffer).setBigUint64(
		body.length,
		BigInt(body.length),
		false
	);
	return bytes;
}

function resolvePostApplyChecksum(
	options: EncodeLtxOptions,
	pages: LtxPage[],
	pageSize: number,
	trackChecksums: boolean,
	isSnapshotFile: boolean
): bigint {
	if (options.postApplyChecksum !== undefined) {
		return options.postApplyChecksum;
	}
	if (!trackChecksums) {
		return 0n;
	}
	if (!isSnapshotFile) {
		throw new Error(
			'encodeLtx: incremental files require an explicit postApplyChecksum ' +
				'when checksum tracking is enabled'
		);
	}
	const lock = lockPgno(pageSize);
	let rolling = CHECKSUM_FLAG;
	for (const page of pages) {
		if (page.pgno === lock) continue;
		rolling = foldPageChecksum(rolling, page.pgno, page.data);
	}
	return rolling;
}

/**
 * File checksum over the canonical feed.
 *
 * Page data is fed **decompressed**, so the hash is over logical content
 * rather than the LZ4 bytes on disk.
 */
function computeFileChecksumForEncode(
	headerBytes: Uint8Array,
	pages: LtxPage[],
	indexBytes: Uint8Array,
	postApplyChecksum: bigint
): bigint {
	const hasher = new Crc64();
	hasher.update(headerBytes);
	for (const page of pages) {
		hasher.update(writePageHeader(page.pgno));
		hasher.update(page.data);
	}
	hasher.update(writePageHeader(0));
	hasher.update(indexBytes);

	const postApply = new Uint8Array(8);
	new DataView(postApply.buffer).setBigUint64(0, postApplyChecksum, false);
	hasher.update(postApply);

	return CHECKSUM_FLAG | hasher.sum64();
}

function assemble(
	headerBytes: Uint8Array,
	pages: LtxPage[],
	frames: Uint8Array[],
	indexBytes: Uint8Array,
	postApplyChecksum: bigint,
	fileChecksum: bigint
): Uint8Array {
	let total = headerBytes.length;
	for (const frame of frames) {
		total += PAGE_HEADER_SIZE + frame.length;
	}
	total += PAGE_HEADER_SIZE + indexBytes.length + 16;

	const out = new Uint8Array(total);
	let cursor = 0;
	out.set(headerBytes, cursor);
	cursor += headerBytes.length;

	for (let i = 0; i < pages.length; i++) {
		out.set(writePageHeader(pages[i].pgno), cursor);
		cursor += PAGE_HEADER_SIZE;
		out.set(frames[i], cursor);
		cursor += frames[i].length;
	}

	out.set(writePageHeader(0), cursor);
	cursor += PAGE_HEADER_SIZE;
	out.set(indexBytes, cursor);
	cursor += indexBytes.length;

	const view = new DataView(out.buffer);
	view.setBigUint64(cursor, postApplyChecksum, false);
	view.setBigUint64(cursor + 8, fileChecksum, false);

	return out;
}
