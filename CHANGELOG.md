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
  `litestream restore`, and a golden-file suite that checks files written by
  Litestream against this decoder.

[unreleased]: https://github.com/luismulinari/ltx-format/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/luismulinari/ltx-format/releases/tag/v0.1.0
