/**
 * Decoder tests against golden LTX files produced by the real
 * `litestream` v0.5.11 binary.
 *
 * The fixtures are committed so this suite is an oracle test that runs
 * anywhere, with no litestream installation required. See
 * `test/fixtures/README.md` for how they were generated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	applyLtxToImage,
	decodeLtx,
	decodeToSnapshotImage,
} from '../src/decode.js';
import { HEADER_FLAG_NO_CHECKSUM, isSnapshot } from '../src/format.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

const SNAPSHOT = '0000000000000001-0000000000000001.ltx';
const INCREMENTAL = '0000000000000002-0000000000000002.ltx';

describe('decodeLtx against litestream goldens', () => {
	it('decodes the snapshot header', () => {
		const { header } = decodeLtx(fixture(SNAPSHOT));

		expect(header.pageSize).toBe(4096);
		expect(header.minTXID).toBe(1n);
		expect(header.maxTXID).toBe(1n);
		expect(isSnapshot(header)).toBe(true);
		expect(header.preApplyChecksum).toBe(0n);
		// Litestream v0.5.11 disables rolling checksum tracking.
		expect(header.flags & HEADER_FLAG_NO_CHECKSUM).toBe(
			HEADER_FLAG_NO_CHECKSUM
		);
	});

	it('verifies the file checksum of every golden', () => {
		// decodeLtx throws on mismatch, so reaching the assertion is the result.
		expect(() => decodeLtx(fixture(SNAPSHOT))).not.toThrow();
		expect(() => decodeLtx(fixture(INCREMENTAL))).not.toThrow();
	});

	it('rejects a corrupted page payload', () => {
		const corrupted = fixture(SNAPSHOT);
		// Flip a byte inside the first page's compressed payload. This is
		// caught while decompressing, before any checksum is looked at.
		corrupted[200] ^= 0xff;
		expect(() => decodeLtx(corrupted)).toThrow(/Truncated LZ4 block/);
	});

	it('rejects tampering that only the file checksum can catch', () => {
		// Bytes 80..99 of the header are reserved and read by nothing, so a
		// flip here survives header validation, the page walk, and the index
		// cross-check. If this test fails, the file checksum gate is gone.
		const tampered = fixture(SNAPSHOT);
		tampered[90] ^= 0xff;
		expect(() => decodeLtx(tampered)).toThrow(/file checksum mismatch/);
	});

	it('rejects a tampered post-apply checksum', () => {
		const tampered = fixture(SNAPSHOT);
		tampered[tampered.length - 16] ^= 0xff;
		expect(() => decodeLtx(tampered)).toThrow(/file checksum mismatch/);
	});

	it('skips checksum verification when asked', () => {
		const corrupted = fixture(SNAPSHOT);
		corrupted[corrupted.length - 1] ^= 0xff; // Trailer file checksum.
		expect(() =>
			decodeLtx(corrupted, { verifyChecksums: false })
		).not.toThrow();
	});

	it('rebuilds the exact database image litestream restores', () => {
		const decoded = decodeLtx(fixture(SNAPSHOT));
		const image = decodeToSnapshotImage(decoded);
		const expected = fixture('expected-txid1.db');

		expect(image.length).toBe(expected.length);
		expect(Buffer.from(image).equals(Buffer.from(expected))).toBe(true);
	});

	it('applies a change to the highest page in the file', () => {
		// The goldens happen to leave page 4 byte-identical across the two
		// transactions, so an off-by-one that drops the last page still
		// produces the right image there. This does not let that slide.
		const snapshot = decodeLtx(fixture(SNAPSHOT));
		const image = decodeToSnapshotImage(snapshot);
		const { pageSize, commit } = snapshot.header;

		const replaced = new Uint8Array(pageSize).fill(0x5a);
		const updated = applyLtxToImage(image, {
			...snapshot,
			pages: [{ pgno: commit, data: replaced }],
		});

		const last = updated.subarray((commit - 1) * pageSize);
		expect(last.every((b) => b === 0x5a)).toBe(true);
	});

	it('applies an incremental on top of a snapshot', () => {
		const snapshot = decodeLtx(fixture(SNAPSHOT));
		const incremental = decodeLtx(fixture(INCREMENTAL));

		expect(isSnapshot(incremental.header)).toBe(false);
		expect(incremental.header.minTXID).toBe(2n);

		const image = applyLtxToImage(
			decodeToSnapshotImage(snapshot),
			incremental
		);
		const expected = fixture('expected-txid2.db');

		expect(image.length).toBe(expected.length);
		expect(Buffer.from(image).equals(Buffer.from(expected))).toBe(true);
	});

	it('decompresses real LZ4 frames written by pierrec/lz4', () => {
		const { header, pages } = decodeLtx(fixture(SNAPSHOT));
		expect(pages.length).toBeGreaterThan(0);
		for (const page of pages) {
			expect(page.data.length).toBe(header.pageSize);
		}
		// Page 1 of a SQLite database always starts with this magic string.
		const page1 = pages.find((p) => p.pgno === 1);
		expect(page1).toBeDefined();
		expect(
			Buffer.from(page1!.data.subarray(0, 15)).toString('latin1')
		).toBe('SQLite format 3');
	});

	it('rejects a file that is not LTX at all', () => {
		expect(() => decodeLtx(new Uint8Array(200))).toThrow(/bad magic/);
	});

	it('rejects a truncated file', () => {
		const truncated = fixture(SNAPSHOT).subarray(0, 110);
		expect(() => decodeLtx(truncated)).toThrow(/truncated/);
	});
});
