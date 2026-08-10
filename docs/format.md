# The LTX file format, version 3

This is the byte layout `ltx-format` reads and writes, as implemented by
[superfly/ltx](https://github.com/superfly/ltx) v0.5.1 and emitted by
[Litestream](https://litestream.io) v0.5.11. It is written down here because
the reference is Go source rather than a specification document, and because
several details are easy to get subtly wrong in a way that still produces a
file that looks valid.

**All multi-byte integers are big-endian.**

```
+--------------------------------------+
| Header                     100 bytes |
+--------------------------------------+
| PageHeader (6) + LZ4 frame(page)  × N|
+--------------------------------------+
| Empty PageHeader             6 bytes |  pgno == 0 terminates the block
+--------------------------------------+
| Page index                  variable |  uvarint tuples + terminator + u64 len
+--------------------------------------+
| Trailer                     16 bytes |
+--------------------------------------+
```

## Header

| Offset | Size | Field               | Notes                                            |
| -----: | ---: | ------------------- | ------------------------------------------------ |
|      0 |    4 | `magic`             | `LTX1` (`0x4c545831`)                            |
|      4 |    4 | `flags`             | see below                                        |
|      8 |    4 | `pageSize`          | power of two, 512 – 65536                        |
|     12 |    4 | `commit`            | database size **in pages** after the transaction |
|     16 |    8 | `minTXID`           | first transaction in this file, ≥ 1              |
|     24 |    8 | `maxTXID`           | last transaction in this file, ≥ `minTXID`       |
|     32 |    8 | `timestamp`         | signed; milliseconds since the Unix epoch        |
|     40 |    8 | `preApplyChecksum`  | zero on snapshots                                |
|     48 |    8 | `walOffset`         | signed; zero when the source was a journal       |
|     56 |    8 | `walSize`           | signed; zero when the source was a journal       |
|     64 |    4 | `walSalt1`          | zero when the source was a journal               |
|     68 |    4 | `walSalt2`          | zero when the source was a journal               |
|     72 |    8 | `nodeID`            | zero unless the writer is part of a cluster      |
|     80 |   20 | reserved            | must be zero                                     |

There is no version field: the magic and this layout *are* version 3.

### Flags

| Value  | Name                  | Meaning                                    |
| ------ | --------------------- | ------------------------------------------ |
| `1<<1` | `HeaderFlagNoChecksum`| rolling checksums are not tracked          |

No other bit may be set. Litestream v0.5.11 always sets `HeaderFlagNoChecksum`
and writes a zero `preApplyChecksum`, including on incrementals — a reader that
insists on a non-zero pre-apply checksum for incrementals will reject files the
reference implementation produces.

### Snapshots

A file with `minTXID == 1` is a *snapshot*: it carries every page of the
database and can be restored on its own. Its `preApplyChecksum` must be zero,
and its pages must run `1..commit` with no gaps other than the lock page — a
sparse snapshot is rejected by the reference decoder with "nonsequential page
numbers in snapshot transaction".

Anything else is an *incremental*, which carries only the pages its transaction
range dirtied and may be as sparse as it likes, as long as the page numbers
ascend and none exceeds `commit`.

A file with `commit == 0` is a *deletion*: it records that the database is
gone, carries no pages, and must have a `postApplyChecksum` of exactly
`ChecksumFlag`.

### Pre-apply checksum rules

These three cases are exhaustive, and getting them wrong produces files the
reference implementation rejects:

| File                              | `preApplyChecksum`                     |
| --------------------------------- | -------------------------------------- |
| Snapshot                          | must be zero                           |
| Incremental, `NoChecksum` set      | must be zero — a value is *not allowed* |
| Incremental, checksums tracked     | must be non-zero, with bit 63 set      |

### WAL provenance

`walOffset` and `walSize` are signed and must not be negative. A non-zero
`walSalt1`/`walSalt2` requires a non-zero `walOffset`, and a non-zero `walSize`
requires one too. All four are zero when the transaction came from a rollback
journal rather than a WAL.

## Page block

Pages appear in **ascending page-number order**, each as:

| Size | Field  | Notes                       |
| ---: | ------ | --------------------------- |
|    4 | `pgno` | page number, ≥ 1            |
|    2 | `flags`| must be zero                |
|    … | data   | one independent LZ4 frame   |

Each page's data is its own complete LZ4 frame, so a reader can decompress any
page without touching the others. Decompressed, every frame is exactly
`pageSize` bytes.

A page header with `pgno == 0` and `flags == 0` terminates the block.

### The lock page

SQLite reserves the page containing `PENDING_BYTE` (`0x40000000`) — page
`floor(0x40000000 / pageSize) + 1`, so 262145 at a 4 KiB page size. It never
carries content. LTX files must not include it, it is excluded from checksums,
and it is zero-filled when a database image is reconstructed.

## Page index

The index is redundant with the page block; it exists so a reader can seek
directly to a page. It is a sequence of uvarint triples in ascending `pgno`
order, using the same LEB128 encoding as Go's `encoding/binary`:

```
(pgno, offset, size)*   offset is from the start of the file, and points at the
0                       page header; size covers the 6-byte page header plus
<u64 length>            the LZ4 frame
```

The terminating `0` ends the elements. The trailing `u64` is the length in
bytes of the elements **and** the terminator, but not of the length field
itself — so the index region starts at `fileLength - 16 - 8 - length` and that
offset must equal the end of the page block.

## Trailer

| Offset from end | Size | Field                |
| --------------: | ---: | -------------------- |
|             −16 |    8 | `postApplyChecksum`  |
|              −8 |    8 | `fileChecksum`       |

## Checksums

Both checksums are **CRC-64/ISO**, matching Go's
`crc64.MakeTable(crc64.ISO)` — reflected, initialised to zero, inverted before
and after each update. This is *not* CRC-64/XZ or CRC-64/ECMA; using the wrong
polynomial produces files that look structurally perfect and fail verification.

Every stored checksum has bit 63 set (`ChecksumFlag`), so a valid checksum is
never zero and a zero field unambiguously means "absent".

### Page checksum

```
checksum(pgno, data) = ChecksumFlag | CRC64(BE_u32(pgno) ++ data)
```

### Post-apply checksum

A rolling checksum over the whole database *after* the transaction is applied.
It starts at `ChecksumFlag` for an empty database and XOR-folds in every
non-lock page:

```
rolling = ChecksumFlag | (rolling ^ checksum(pgno, data))
```

Because it is an XOR fold it is order-independent and self-inverse: folding a
page in twice removes it again, which is how an incremental writer updates the
value without reading the whole database.

### File checksum

A CRC-64 over the canonical feed below, then `ChecksumFlag |`:

1. the 100-byte header
2. for each page, in file order: its 6-byte page header, then its
   **decompressed** data
3. the terminating page header (six zero bytes)
4. the whole page index region, *including* its trailing `u64` length field
5. the 8-byte `postApplyChecksum`, big-endian

Step 2 is the trap: the feed uses decompressed page content, not the LZ4 bytes
that are actually on disk. A decoder cannot simply hash the file it read.

## Filenames

```
<minTXID>-<maxTXID>.ltx
```

with each TXID formatted as 16 zero-padded lowercase hex digits, so lexical
order matches transaction order. Litestream looks for these under
`<replica>/ltx/<level>/`, with level `0` holding the un-compacted files.
