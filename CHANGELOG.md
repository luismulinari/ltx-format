# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

Initial release.

### Added

- `encodeLtx` / `decodeLtx` for LTX v3 files, byte-compatible with Litestream
  v0.5.11 and superfly `ltx` v0.5.1.
- `decodeToSnapshotImage` and `applyLtxToImage` to rebuild a SQLite database
  image from a snapshot plus a chain of incrementals.
- Optional rolling checksum tracking (`trackChecksums`), off by default to
  match what Litestream v0.5.11 emits.
- Exported building blocks: CRC-64/ISO, LZ4 frame reader/writer, LEB128
  varints, and xxHash32.
- A differential test suite that checks files written here against the real
  `litestream restore`, a golden-file suite that checks files written by
  Litestream against this decoder, and a malformed-input suite covering the
  decoder's structural invariants.
- Full parity with `Header.Validate()` and `Encoder.EncodePage()` in ltx
  v0.5.1: snapshot completeness, the `commit` bound on page numbers, the
  pre-apply checksum rules, and the WAL provenance invariants are all
  enforced, so a file this library writes is one the reference implementation
  reads.

[unreleased]: https://github.com/luismulinari/ltx-format/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/luismulinari/ltx-format/releases/tag/v0.1.0
