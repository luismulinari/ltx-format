/**
 * Encoder tests: round-trips, page-size coverage, and input validation.
 *
 * The test that actually proves byte-compatibility with Litestream shells out
 * to the real binary and lives in `litestream.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { decodeLtx } from '../src/decode.js';
import { encodeLtx } from '../src/encode.js';
import type { LtxPage } from '../src/format.js';
import { lockPgno } from '../src/format.js';

describe('encodeLtx', () => {
	it('round-trips a snapshot through the decoder', () => {
		const pageSize = 512;
		const pages: LtxPage[] = [1, 2, 3].map((pgno) => ({
			pgno,
			data: new Uint8Array(pageSize).fill(pgno),
		}));

		const encoded = encodeLtx({
			pageSize,
			commit: 3,
			minTXID: 1n,
			maxTXID: 1n,
			pages,
		});
		const decoded = decodeLtx(encoded);

		expect(decoded.header.pageSize).toBe(pageSize);
		expect(decoded.header.commit).toBe(3);
		expect(decoded.pages.map((p) => p.pgno)).toEqual([1, 2, 3]);
		for (const page of decoded.pages) {
			expect(page.data.every((b) => b === page.pgno)).toBe(true);
		}
	});

	it('round-trips with checksum tracking enabled', () => {
		const pageSize = 1024;
		const pages: LtxPage[] = [
			{ pgno: 1, data: new Uint8Array(pageSize).fill(7) },
			{ pgno: 2, data: new Uint8Array(pageSize).fill(9) },
		];
		const encoded = encodeLtx({
			pageSize,
			commit: 2,
			minTXID: 1n,
			maxTXID: 1n,
			pages,
			trackChecksums: true,
		});

		const decoded = decodeLtx(encoded);
		expect(decoded.header.flags).toBe(0);
		expect(decoded.trailer.postApplyChecksum).toBe(
			decoded.computedPostApplyChecksum
		);
	});

	it('sorts pages into ascending order', () => {
		const pageSize = 512;
		const encoded = encodeLtx({
			pageSize,
			commit: 3,
			minTXID: 4n,
			maxTXID: 4n,
			pages: [
				{ pgno: 3, data: new Uint8Array(pageSize).fill(3) },
				{ pgno: 1, data: new Uint8Array(pageSize).fill(1) },
			],
		});
		expect(decodeLtx(encoded).pages.map((p) => p.pgno)).toEqual([1, 3]);
	});

	it('is deterministic: the same input yields the same bytes', () => {
		const options = {
			pageSize: 512,
			commit: 2,
			minTXID: 1n,
			maxTXID: 1n,
			pages: [
				{ pgno: 1, data: new Uint8Array(512).fill(0x11) },
				{ pgno: 2, data: new Uint8Array(512).fill(0x22) },
			],
		};
		expect(Buffer.from(encodeLtx(options))).toEqual(
			Buffer.from(encodeLtx(options))
		);
	});

	it.each([512, 1024, 4096, 8192, 65536])(
		'round-trips at page size %i',
		(pageSize) => {
			const pages: LtxPage[] = [
				{ pgno: 1, data: new Uint8Array(pageSize).fill(0xab) },
				{ pgno: 2, data: new Uint8Array(pageSize).fill(0xcd) },
			];
			const decoded = decodeLtx(
				encodeLtx({
					pageSize,
					commit: 2,
					minTXID: 1n,
					maxTXID: 1n,
					pages,
				})
			);
			expect(decoded.pages[0].data.length).toBe(pageSize);
			expect(decoded.pages[1].data[0]).toBe(0xcd);
		}
	);

	it('round-trips randomised page sets', () => {
		// Deterministic PRNG so a failure is reproducible.
		let seed = 0x2545f491;
		const random = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 0x100000000;
		};

		for (let iteration = 0; iteration < 25; iteration++) {
			const pageSize = [512, 1024, 4096][Math.floor(random() * 3)];
			const pageCount = 1 + Math.floor(random() * 12);
			const pgnos = new Set<number>();
			while (pgnos.size < pageCount) {
				pgnos.add(1 + Math.floor(random() * 40));
			}
			const pages: LtxPage[] = [...pgnos].map((pgno) => {
				const data = new Uint8Array(pageSize);
				for (let i = 0; i < pageSize; i++) {
					data[i] = Math.floor(random() * 256);
				}
				return { pgno, data };
			});
			const commit = Math.max(...pgnos);

			const decoded = decodeLtx(
				encodeLtx({
					pageSize,
					commit,
					minTXID: 1n,
					maxTXID: 1n,
					pages,
				})
			);

			const sorted = [...pages].sort((a, b) => a.pgno - b.pgno);
			expect(decoded.pages.length).toBe(sorted.length);
			for (let i = 0; i < sorted.length; i++) {
				expect(decoded.pages[i].pgno).toBe(sorted[i].pgno);
				expect(
					Buffer.from(decoded.pages[i].data).equals(
						Buffer.from(sorted[i].data)
					)
				).toBe(true);
			}
		}
	});

	it('rejects a page whose size disagrees with the header', () => {
		expect(() =>
			encodeLtx({
				pageSize: 4096,
				commit: 1,
				minTXID: 1n,
				maxTXID: 1n,
				pages: [{ pgno: 1, data: new Uint8Array(512) }],
			})
		).toThrow(/expected 4096/);
	});

	it('rejects the lock page', () => {
		const pageSize = 4096;
		expect(() =>
			encodeLtx({
				pageSize,
				commit: lockPgno(pageSize),
				minTXID: 1n,
				maxTXID: 1n,
				pages: [
					{
						pgno: lockPgno(pageSize),
						data: new Uint8Array(pageSize),
					},
				],
			})
		).toThrow(/lock page/);
	});

	it('rejects a page size SQLite would never use', () => {
		expect(() =>
			encodeLtx({
				pageSize: 3000,
				commit: 1,
				minTXID: 1n,
				maxTXID: 1n,
				pages: [{ pgno: 1, data: new Uint8Array(3000) }],
			})
		).toThrow(/page size/);
	});

	it('requires a pre-apply checksum on tracked incrementals', () => {
		expect(() =>
			encodeLtx({
				pageSize: 512,
				commit: 1,
				minTXID: 2n,
				maxTXID: 2n,
				pages: [{ pgno: 1, data: new Uint8Array(512) }],
				trackChecksums: true,
				postApplyChecksum: 1n << 63n,
			})
		).toThrow(/preApplyChecksum/);
	});

	it('requires an explicit post-apply checksum on tracked incrementals', () => {
		expect(() =>
			encodeLtx({
				pageSize: 512,
				commit: 1,
				minTXID: 2n,
				maxTXID: 2n,
				pages: [{ pgno: 1, data: new Uint8Array(512) }],
				trackChecksums: true,
				preApplyChecksum: 1n << 63n,
			})
		).toThrow(/postApplyChecksum/);
	});
});
