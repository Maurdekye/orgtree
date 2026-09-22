# Work-name wire codec

This dependency-free library implements the isolated P01 work-name format. It
has no runtime, storage, entropy, title normalization, or lookup side effects.

`encode_name(prefix, trusted_uuid)` takes a **pre-normalized** 1..48-byte ASCII
prefix (`[a-z0-9]+(-[a-z0-9]+)*`) and 16 network-order UUIDv4 bytes. It produces
`prefix--token`, at most 76 bytes. `encode_token` encodes all 128 UUID bits with
lowercase, unpadded RFC 4648 base32 (26 characters; 122 random bits in UUIDv4).
`decode_name` and `decode_token` strictly check length, lowercase alphabet, zero
padding bits, UUID version/variant, and identical re-encoding. Invalid inputs
return typed errors; complete lookup names are never normalized.

Title derivation stays with the caller. At base
`286396ebc6db13aed7bc0ebcfc873a703828296b`,
`engine/backend/orgtree/ledger.py`'s `_work_slugify` lowercases
`str(title or "")`, replaces each `[^a-z0-9]+` run with `-`, strips edge hyphens,
takes the first 48 characters, strips edge hyphens again, and falls back to
`item`. This crate does not expose a second Unicode or Python coercion contract.
An empty supplied prefix is an error, not a request to derive a title.

The complete name is the exact public lookup key. The prefix has no identity
weight, but changing it does not create an alias. Token helpers are wire
primitives, not lookup entry points. Syntax checks cannot establish whether an
item exists or whether a caller is permitted to create it. Pass UUID bytes in
network order, never Windows GUID `bytes_le` order. Swapped bytes sometimes still
form a valid but different UUIDv4; no format parser can infer that caller error.

`preflight_legacy_names(names, limits)` takes the caller's complete frozen
active/archived/deleted legacy corpus as borrowed UTF-8 strings. The caller must
set maximum entry count, bytes per name, and total bytes; no production limit is
chosen here. Rust's `str` type excludes invalid UTF-8. Empty strings, arbitrary
Unicode, control characters, and duplicates are otherwise preserved. Invalid
new-format syntax does not invalidate an imported legacy name.

Preflight reports every conflicting entry's index and unchanged string. A
conflict is any nonempty normalized prefix plus `--` and exactly 26 `a-z2-7`
characters, even with invalid padding, version, or variant. The conservative
prefix check also includes prefixes longer than 48 bytes. All input bounds are
checked before scanning name contents or allocating the report. Allocation
failure is explicit. An error is incomplete preflight, never permission to
activate. `namespace_is_disjoint()` applies only to the supplied corpus and this
one gate; completeness and other migration gates remain the caller's concern.
There is no fixed corpus storage, renaming, lookup, or cutover implementation.

The shared fixtures are `docs/state-system/work-name-codec-vectors.json` at the
repository root. Schema version 1 includes complete canonical names, UUID
network-byte equivalents, distinct same-prefix IDs, exact-key distinctions,
invalid alphabet/length/padding/version/variant cases, mixed-endian GUID cases,
and conservative legacy collisions. Its UTF-8 strings must be preserved exactly.
For mixed-endian cases, `different-valid-uuid` means a different valid identity,
not something a decoder can reject based only on syntax.

Run tests offline, directing artifacts outside the checkout:

```powershell
$env:CARGO_TARGET_DIR = '<own scratch>/cargo-target'
cargo test --offline --manifest-path engine/native/work-name-codec/Cargo.toml
```

The unit/integration suite covers all 122 variable identity bits, exact bounds,
all wrong versions/variants on encoding, padding aliases, namespace anomalies,
and borrowed conflict preservation. Delivery evidence additionally compiles
Rust assertions generated from the shared JSON using an independent Python
standard-library `base64`/`uuid` oracle, and records sensitive padding, version,
and namespace mutation controls. Python is a test oracle only; the library has
no Python or other third-party dependency.

This stage does not provide OS entropy, uniqueness constraints or collision
retries, creation routes, original-key receipts, database migration, retained
identity storage, deletion semantics, or native integration. P02/P03/P04 and
native runtime gates remain separate. Deterministic codec acceptance is not
proof of identity generation or lifetime uniqueness.
