# Operation-receipt compatibility codec

This dependency-light library reproduces the pure decision rules of the legacy
operation receipts in `engine/backend/orgtree/opreceipts.py`, so that a later
Rust command/receipt stage can keep answering legacy keys exactly. It is
**non-authoritative preparatory work**. It is not wired into the service, takes
no receipt or runtime authority, and is not the R02 command-receipt port or any
part of a finished Rust backend.

## What it reproduces

| Python | Rust |
|---|---|
| `KEY_RE` / `parse_key` | `key::parse_key` |
| `_canonical` | `canonical::canonical` |
| `fingerprint` (codec `legacy-1`) | `fingerprint::fingerprint` |
| `find`, `fp_node`, `matches`, `classify` | `admission::{find, fp_node, matches, classify}` |
| `watermark`, `schema_ahead` | `admission::{watermark, schema_ahead}` |
| `admit` | `admission::admit` |
| `append` (counter, trim and watermark) | `eviction::plan_append` |

Details that are easy to get wrong, and are pinned by the vectors:

- The key grammar is `^(\d{13,14})-([0-9a-f]{24})$` with Python `re` string
  semantics. `\d` matches every Unicode decimal digit, and `int()` converts
  those digits. `$` also matches just before one final newline.
- The fingerprint is the full SHA-256 of the UTF-8 text of
  `json.dumps({"tool", "node", "generation", "args"}, sort_keys=True,
  separators=(",", ":"), ensure_ascii=False)`. Keys sort in code point order.
  Integers keep their exact digits, floats use Python `repr`, and the
  non-finite values are `NaN`/`Infinity`/`-Infinity`. `repr` gives the
  shortest digits that round-trip and breaks an exact tie between two of them
  toward the even last digit (`1e15 + 0.25` is `1000000000000000.2`); Rust's
  own shortest formatting can take the odd one, so ties are corrected.
- `find` returns the newest row with the same key and node. Generation is not
  a matcher. `matches` fingerprints at the row's own `fp_node` and generation.
- `admit` keeps Python's branch order: malformed key, stale epoch (with the
  found row's state), key more than 60000 ms ahead, key more than 900000 ms
  old, an existing row (conflict, fenced, foreign generation, replay), newer
  schema, a mint time below the eviction watermark, admit.
- `append` trims a log longer than 500 rows to 400. It sets
  `from_ms = max(old, largest evicted mint + 1)`.
- Stored values keep Python coercions: `int(x or 0)` (with Unicode digits,
  whitespace and underscores), truthiness and `str(x or y or "")`. In
  `int(str)` only non-ASCII characters are mapped (spaces to a space,
  decimal digits to ASCII digits); the ASCII separators U+001C..U+001F are
  `str.isspace()` but make `int()` raise `ValueError`.
- Integers are exact at any width, as Python's are (`src/pyint.rs`). A
  generation, clock reading, watermark, sequence counter, eviction count or
  mint time beyond `i64` is compared, added and fingerprinted exactly, and
  `int(float)` keeps every digit of the float's value.
- Python's exceptions on huge integers are reproduced: `ValueError` when
  `json.dumps` or the `foreign_generation` detail text must print an
  integer longer than 4300 digits, and `OverflowError` when the refusal
  detail divides a key age too large for a float (`age / 1000`). An integer
  argument longer than 4300 digits cannot occur: `json.loads` and the JSON
  reader both refuse it.

The results are the decision, reason, row index, row state and mint time. The
human-readable `detail` text is not reproduced, but the exceptions raised
while formatting it are.

## Inputs and parity domain

The caller supplies the org document as decoded by the backend-codec JSON
reader (`Profile::PythonLegacy`), plus `now_ms` and the custody proof
`epoch_ok`. The crate has no clock and no epoch of its own. Arguments are
taken **after** the API's own normalization. Raw request normalization
(pydantic, `_op_unwrap`, action spelling) is out of scope.

`PyOutcome::Raises` reports a Python exception for the same input
(`ValueError`, `TypeError`, `OverflowError`). `PyOutcome::OutsideParityDomain`
means Python has an answer this crate does not reproduce:

- `str()` of a list or dict;
- a receipt section that is not a list, or rows or meta that are not objects;
- lone surrogates. Python cannot UTF-8 encode them, and the JSON reader refuses them first.

## Unresolved (not decided here)

`UNRESOLVED` in `src/lib.rs` lists them:

- **U-RCPT-1:** no v3-native codec version is defined; only `legacy-1` exists.
- **U-RCPT-2:** cutover might import retained receipts or rely on epoch rotation; this is not decided.
- **U-RCPT-3:** the input domain is normalized arguments.
- **U-RCPT-4:** lone surrogates and non-JSON values are outside the parity domain.
- **U-RCPT-5:** malformed legacy documents are outside the parity domain.
- **U-RCPT-6:** the detail text is not reproduced; the exceptions its formatting raises are.

## Explicitly excluded

- Custody epochs and the in-process witness.
- The COVERAGE table and the public lookup API.
- Receipt row and result construction.
- `mint_key` (clock and entropy).
- `rekey_nodes`.
- Any SQL or PostgreSQL mapping.
- Storage, listeners, providers and effects.

PostgreSQL execution remains separately gated on archive and run authority, a
client-dependency decision and reviewed DDL/type mapping.

## SHA-256

`src/sha256.rs` is an in-crate FIPS 180-4 implementation. No reviewed SHA-256
crate is available to this offline build. It is used only as the identity
digest of a fingerprint, never as a MAC, key or password hash. It is checked
against the FIPS examples (including one million `a`), padding-boundary
lengths and Python `hashlib`. It is an explicit independent-review focus.

## Verification

```powershell
$env:CARGO_TARGET_DIR = '<own scratch>/cargo-target'
cargo test --offline --manifest-path engine/native/op-receipt-codec/Cargo.toml
cargo clippy --offline --all-targets --manifest-path engine/native/op-receipt-codec/Cargo.toml -- -D warnings
cargo run --offline -q --manifest-path engine/native/op-receipt-codec/Cargo.toml --bin receipt-vectors
engine/runtime/python.exe engine/native/op-receipt-codec/oracle/generate_vectors.py --check
engine/runtime/python.exe tools/run-python-verification.py --repo-root . --python engine/runtime/python.exe tests/test_op_receipt_codec_vectors.py
```

- **Oracle:** `oracle/generate_vectors.py` runs only on the engine CPython 3.13. It calls the real `opreceipts` functions and anchors the module's sha256 plus the exact rule text.
- **Rust controls:** `tests/controls.rs` changes one rule at a time (27 controls) and requires the vectors to fail only in the sections that exercise it.
- **Python drift test:** `tests/test_op_receipt_codec_vectors.py` patches horizon, skew, separators, ceiling and the key parser, and requires the regenerated vectors to change.
