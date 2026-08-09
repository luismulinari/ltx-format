/**
 * Differential test against the real `litestream` binary.
 *
 * This is the test that actually proves byte-compatibility: everything else in
 * the suite only proves this library agrees with itself. It is skipped when
 * litestream is not installed, so a plain `npm test` still passes on a clean
 * machine — CI installs it so the check is never silently lost.
 *
 * See `test/fixtures/README.md` for how the fixtures were generated.
 */
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeLtx, decodeToSnapshotImage } from '../src/decode.js';
import { encodeLtx } from '../src/encode.js';
import type { LtxPage } from '../src/format.js';
import { formatFilename, lockPgno } from '../src/format.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Locates a usable litestream binary, or null when none is installed. */
function findLitestream(): string | null {
	const candidates = [
		join(homedir(), '.local', 'bin', 'litestream'),
		'/usr/local/bin/litestream',
		'/opt/homebrew/bin/litestream',
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	try {
		return execFileSync('which', ['litestream']).toString().trim() || null;
	} catch {
		return null;
	}
}

const LITESTREAM = findLitestream();

/** Splits a database image into LTX pages, skipping the lock page. */
function splitIntoPages(image: Uint8Array, pageSize: number): LtxPage[] {
	const lock = lockPgno(pageSize);
	const pages: LtxPage[] = [];
	for (let pgno = 1; pgno * pageSize <= image.length; pgno++) {
		if (pgno === lock) continue;
		pages.push({
			pgno,
			data: image.subarray((pgno - 1) * pageSize, pgno * pageSize),
		});
	}
	return pages;
}

describe.skipIf(!LITESTREAM)(
	'encodeLtx differential against the real litestream binary',
	() => {
		let workDir: string;

		beforeEach(() => {
			workDir = mkdtempSync(join(tmpdir(), 'ltx-diff-'));
		});

		afterEach(() => {
			rmSync(workDir, { recursive: true, force: true });
		});

		/** Lays out a one-file replica and runs `litestream restore` over it. */
		function restore(encoded: Uint8Array): Uint8Array {
			const ltxDir = join(workDir, 'replica', 'ltx', '0');
			mkdirSync(ltxDir, { recursive: true });
			writeFileSync(join(ltxDir, formatFilename(1n, 1n)), encoded);

			const restored = join(workDir, 'restored.db');
			execFileSync(
				LITESTREAM as string,
				[
					'restore',
					'-o',
					restored,
					`file://${join(workDir, 'replica')}`,
				],
				{ stdio: 'pipe' }
			);
			return new Uint8Array(readFileSync(restored));
		}

		it('writes a replica that litestream restores byte-identically', () => {
			const source = new Uint8Array(
				readFileSync(join(FIXTURES, 'expected-txid1.db'))
			);
			const pageSize = 4096;

			const output = restore(
				encodeLtx({
					pageSize,
					commit: source.length / pageSize,
					minTXID: 1n,
					maxTXID: 1n,
					pages: splitIntoPages(source, pageSize),
				})
			);

			expect(output.length).toBe(source.length);
			expect(Buffer.from(output).equals(Buffer.from(source))).toBe(true);
		});

		it('produces a database sqlite3 can actually open', () => {
			const source = new Uint8Array(
				readFileSync(join(FIXTURES, 'expected-txid2.db'))
			);
			const pageSize = 4096;

			restore(
				encodeLtx({
					pageSize,
					commit: source.length / pageSize,
					minTXID: 1n,
					maxTXID: 1n,
					pages: splitIntoPages(source, pageSize),
				})
			);

			const rows = execFileSync('sqlite3', [
				join(workDir, 'restored.db'),
				'SELECT group_concat(v) FROM t;',
			])
				.toString()
				.trim();
			expect(rows).toBe('ALPHA,beta,gamma,delta');
		});

		it('round-trips our own encoding of a decoded golden', () => {
			// Decode a litestream golden, re-encode it, and confirm litestream
			// still restores the same image from our version.
			const decoded = decodeLtx(
				new Uint8Array(
					readFileSync(
						join(FIXTURES, '0000000000000001-0000000000000001.ltx')
					)
				)
			);
			const output = restore(
				encodeLtx({
					pageSize: decoded.header.pageSize,
					commit: decoded.header.commit,
					minTXID: decoded.header.minTXID,
					maxTXID: decoded.header.maxTXID,
					pages: decoded.pages,
				})
			);

			const expected = decodeToSnapshotImage(decoded);
			expect(Buffer.from(output).equals(Buffer.from(expected))).toBe(
				true
			);
		});
	}
);
