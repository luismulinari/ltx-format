# ltx-format

[![npm](https://img.shields.io/npm/v/ltx-format.svg)](https://www.npmjs.com/package/ltx-format)
[![CI](https://github.com/luismulinari/ltx-format/actions/workflows/ci.yml/badge.svg)](https://github.com/luismulinari/ltx-format/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ltx-format.svg)](./LICENSE)

A TypeScript reader and writer for the **LTX** (Lite Transaction) file format,
version 3 — the replica format used by [Litestream](https://litestream.io)
v0.5 and [LiteFS](https://fly.io/docs/litefs/).

An LTX file describes one SQLite transaction as the set of pages it changed.
That makes it a general-purpose container: anything that knows which pages a
transaction touched can produce one, without going through a WAL and without
linking SQLite.

This package is **pure**. It performs no I/O and has no knowledge of SQLite,
object storage, or any particular runtime — you hand it pages and get bytes
back. It has **zero runtime dependencies** and works in Node.js, Deno, Bun,
browsers, and WebAssembly hosts.

## Install

```sh
npm install ltx-format
```

The package is ESM-only and requires Node.js 22 or newer.

## Usage

### Writing a snapshot

A snapshot (`minTXID === 1n`) carries every page of the database, so it can be
restored standalone.

```ts
import { encodeLtx, formatFilename } from 'ltx-format';

const pageSize = 4096;
const file = encodeLtx({
	pageSize,
	commit: 12, // database size, in pages, after this transaction
	minTXID: 1n,
	maxTXID: 1n,
	pages: [
		{ pgno: 1, data: page1 }, // each `data` is exactly `pageSize` bytes
		{ pgno: 2, data: page2 },
		// ...
	],
});

// Litestream looks for files named by their transaction range.
await writeFile(formatFilename(1n, 1n), file); // 0000000000000001-...ltx
```

### Writing an incremental

An incremental (`minTXID > 1n`) carries only the pages the transaction dirtied.

```ts
const file = encodeLtx({
	pageSize,
	commit: 14,
	minTXID: 2n,
	maxTXID: 2n,
	pages: dirtyPages,
});
```

### Reading

```ts
import { applyLtxToImage, decodeLtx, decodeToSnapshotImage } from 'ltx-format';

const snapshot = decodeLtx(await readFile('0000000000000001-0000000000000001.ltx'));

// Rebuild the full database image a snapshot describes.
let image = decodeToSnapshotImage(snapshot);

// Then replay incrementals on top of it, in transaction order.
for (const path of incrementals) {
	image = applyLtxToImage(image, decodeLtx(await readFile(path)));
}

await writeFile('restored.db', image);
```

`decodeLtx` verifies the file checksum and cross-checks the page index against
the page block, throwing on any mismatch. Pass `{ verifyChecksums: false }` to
skip checksum verification when you are inspecting a file you are still
assembling.

## Checksums

LTX defines a rolling *post-apply checksum* over the whole database, which lets
a reader detect a replica that has diverged from its source. Tracking it costs
a CRC-64 over every page of the database on every transaction, and **Litestream
v0.5.11 does not do it** — it sets `HeaderFlagNoChecksum` and writes zeros.

This library follows Litestream by default. Opt in with `trackChecksums: true`:

```ts
const file = encodeLtx({
	pageSize,
	commit,
	minTXID: 5n,
	maxTXID: 5n,
	pages: dirtyPages,
	trackChecksums: true,
	preApplyChecksum: previous.trailer.postApplyChecksum,
	postApplyChecksum: rolling, // you maintain this across transactions
});
```

For a snapshot the post-apply checksum is computed for you, since a snapshot
contains every page. For an incremental it depends on pages the file does not
carry, so you have to supply it — typically by folding each changed page into
the value you carried forward:

```ts
import { CHECKSUM_FLAG, foldPageChecksum } from 'ltx-format';

let rolling = CHECKSUM_FLAG; // the empty-database value
for (const page of dirtyPages) {
	rolling = foldPageChecksum(rolling, page.pgno, oldPageData); // remove
	rolling = foldPageChecksum(rolling, page.pgno, page.data); // re-add
}
```

`foldPageChecksum` is an XOR fold, so it is its own inverse and independent of
page order.

## API

### Codec

| Export                            | Purpose                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `encodeLtx(options)`              | Encode one LTX file. Returns `Uint8Array`.                     |
| `decodeLtx(bytes, options?)`      | Decode and verify a file. Returns `DecodedLtx`.                |
| `decodeToSnapshotImage(decoded)`  | Rebuild the full database image a snapshot describes.          |
| `applyLtxToImage(image, decoded)` | Apply an incremental onto an image, truncating past `commit`.  |

### Format primitives

| Export                                    | Purpose                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `readHeader(bytes)` / `writeHeader(h)`     | The 100-byte header, with validation.              |
| `formatFilename(min, max)`                 | `<minTXID>-<maxTXID>.ltx`, 16 hex digits each.     |
| `formatTxid(txid)` / `parseTxid(text)`     | Canonical zero-padded lowercase hex TXIDs.         |
| `isSnapshot(header)`                       | `true` when `minTXID === 1n`.                      |
| `isValidPageSize(size)`                    | Powers of two from 512 to 65536.                   |
| `lockPgno(pageSize)`                       | SQLite's lock page for a page size.                |
| `MAGIC`, `VERSION`, `HEADER_SIZE`, …       | Format constants.                                  |

### Building blocks

Exported because they are independently useful, and because a codec you cannot
poke at is a codec you cannot debug.

| Export                                          | Purpose                                     |
| ----------------------------------------------- | ------------------------------------------- |
| `Crc64`, `crc64`, `checksumPage`, `foldPageChecksum` | CRC-64/ISO, matching Go's `hash/crc64`. |
| `encodeLz4Frame` / `decodeLz4Frame`             | Minimal LZ4 frame writer and reader.        |
| `writeUvarint` / `readUvarint` / `uvarintSize`  | LEB128 varints, matching Go's `binary`.     |
| `xxhash32`                                      | xxHash32, as the LZ4 frame format needs.    |

All types (`LtxHeader`, `LtxPage`, `LtxTrailer`, `DecodedLtx`, `DecodeOptions`,
`EncodeLtxOptions`) are exported too.

## Compatibility

Byte-compatible with **Litestream v0.5.11** / superfly `ltx` **v0.5.1**. Files
written here are readable by `litestream restore`, and that is enforced by a
differential test that shells out to the real binary rather than asserted in
prose. See [`docs/format.md`](./docs/format.md) for the byte layout.

Two deliberate choices are worth knowing about:

- **The writer emits stored (uncompressed) LZ4 blocks.** That is fully legal per
  the frame specification and keeps a compressor off the critical path. The
  *reader* handles compressed blocks, because Litestream writes them.
- **Timestamps default to `0`**, so encoding is deterministic: the same pages
  produce the same bytes. Pass `timestamp` if you want a real one.

## Development

```sh
npm install
npm run verify   # lint, typecheck, test, build, package checks
```

Individual steps: `npm run lint`, `npm run typecheck`, `npm test`,
`npm run test:coverage`, `npm run build`, `npm run check:package`.

The differential test needs `litestream` v0.5.x and `sqlite3` on `PATH`. It
skips itself when litestream is absent, so a clean checkout still passes — CI
installs it so the check is never silently lost.

## Prior art

The format is defined by [superfly/ltx](https://github.com/superfly/ltx)
(Apache-2.0); the checksum construction and on-disk layout here follow that
implementation so the two interoperate. The LZ4 code implements the published
[frame format specification](https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md)
and contains no code from the reference LZ4 implementation.

## License

[Apache-2.0](./LICENSE)
