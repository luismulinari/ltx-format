# LTX golden fixtures

Produced by the real **Litestream v0.5.11** binary, so the decoder is tested
against an independent oracle rather than against itself.

| File                                    | What it is                                     |
| --------------------------------------- | ---------------------------------------------- |
| `0000000000000001-0000000000000001.ltx` | Snapshot (`minTXID == 1`) of a 4-page database |
| `0000000000000002-0000000000000002.ltx` | Incremental: one insert plus one update        |
| `expected-txid1.db`                     | `litestream restore` output at TXID 1          |
| `expected-txid2.db`                     | `litestream restore` output at TXID 2          |

The `expected-*.db` files are committed so the decoder's image-reconstruction
tests are a pure oracle comparison that needs no litestream installation. The
_encoder_ differential test does shell out to litestream and is skipped when
the binary is absent.

Both LTX files carry `HeaderFlagNoChecksum` (flags == 2) and a zero
`preApplyChecksum`, because that is what Litestream v0.5.11 actually emits.
Do not "fix" the validation to require a pre-apply checksum unconditionally —
it would reject files the reference implementation produces.

## Regenerating

```sh
# Requires litestream v0.5.x on PATH.
W=$(mktemp -d)
sqlite3 "$W/src.sqlite" "PRAGMA page_size=4096;
  CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
  INSERT INTO t (v) VALUES ('alpha'),('beta'),('gamma');"
litestream replicate -once "$W/src.sqlite" "file://$W/replica"
litestream restore -o "$W/expected-txid1.sqlite" "file://$W/replica"

sqlite3 "$W/src.sqlite" "INSERT INTO t (v) VALUES ('delta');
  UPDATE t SET v='ALPHA' WHERE id=1;"
litestream replicate -once "$W/src.sqlite" "file://$W/replica"
litestream restore -o "$W/expected-txid2.sqlite" "file://$W/replica"
```

Then copy `$W/replica/ltx/0/*.ltx` and the two restored databases here,
renaming the latter to `expected-txid{1,2}.db`.
