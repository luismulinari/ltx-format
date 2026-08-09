# Contributing

## Getting set up

```sh
npm install
npm run verify
```

`verify` runs the whole gate: lint, typecheck, tests, build, and the published-
package checks (`publint` and `attw`). CI runs exactly the same thing, so a
green `verify` locally means a green CI.

To run the differential test against the real Litestream binary you also need
`litestream` v0.5.x and `sqlite3` on `PATH`:

```sh
# macOS
brew install litestream sqlite

# Linux
curl -fsSL -o /tmp/ls.tar.gz \
  https://github.com/benbjohnson/litestream/releases/download/v0.5.11/litestream-0.5.11-linux-x86_64.tar.gz
sudo tar -C /usr/local/bin -xzf /tmp/ls.tar.gz litestream
```

Without it, that suite skips itself and everything else still runs.

## How the tests are layered

Each layer exists because the one below it cannot catch the same class of bug:

| Suite                  | Proves                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `primitives.test.ts`   | The building blocks hold their invariants.                       |
| `encode.test.ts`       | The codec round-trips and rejects bad input.                     |
| `decode.test.ts`       | We read files the reference implementation wrote (golden files). |
| `litestream.test.ts`   | The reference implementation reads files *we* wrote.             |

A round-trip test only proves the library agrees with itself. Anything that
touches the byte layout or a checksum needs to be covered by the golden or
differential suites, not just the round-trip one.

The golden fixtures and how to regenerate them are documented in
[`test/fixtures/README.md`](./test/fixtures/README.md).

## Style

Formatting and linting are handled by [Biome](https://biomejs.dev); run
`npm run format` to fix. Please keep comments about *why* rather than *what* —
this is a format implementation, and the non-obvious parts are the places where
the format itself is surprising.

## Releasing

1. Bump the version in `package.json` and add a `CHANGELOG.md` entry.
2. Merge to `main`.
3. Publish a GitHub Release tagged `v<version>`.

The release workflow verifies the tag matches `package.json`, runs the full
gate, and publishes to npm through trusted publishing (OIDC) — there is no npm
token to manage or rotate.
