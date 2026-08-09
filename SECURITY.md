# Security policy

## Supported versions

The latest released minor version receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/luismulinari/ltx-format/security/advisories/new)
rather than opening a public issue.

## Threat model

This library parses untrusted binary input, so parsing bugs are in scope:
out-of-bounds reads, unbounded allocation, or infinite loops triggered by a
malformed LTX file all count as vulnerabilities. So does any path where
`decodeLtx` accepts a file whose stored checksum does not match its contents.

Note that a *valid* checksum only proves the file is internally consistent —
LTX carries no signature, so it says nothing about who wrote the file. Treat
authenticity as the transport's job.
