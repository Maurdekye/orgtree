# Backend codec foundation

This crate is the first building block of the later Rust backend. The Rust
backend cannot guess its value rules from the Python code by reading it; it
needs exact, tested codecs. This crate provides pure codecs for four
boundaries, each tested against vectors that the current Python backend
produces itself:

- a JSON reader that keeps member order and exact number text, and never
  merges an absent member with a `null` one;
- exact credit amounts on the 0.01 grid, plus exact reproductions of the
  current Python float rounding and seat rule;
- identity and name namespaces: agent and organization keys, the `@user`,
  `@system` and `@extern` sentinels, org-scoped keys, and title-prefix
  derivation for work names;
- the payload half of the engine-local agent credential.

**Not authoritative.** The crate has no listener, storage, clock, entropy,
signing key, process control or domain write. It does not rebuild the Python
`Org` object, assume a PostgreSQL schema or touch live data. Passing its tests
is not evidence that any query, command, receipt, runtime or migration phase
has been ported, and it does not satisfy or bypass any P01–P10 or native
conversion gate. Its one dependency is the reviewed `../work-name-codec`
crate, which it reuses for the new-format work name rather than repeating it.

## Terms

- **Strict** (profile or decoder): accepts only input that both current
  source and the v6 architecture support without doubt. Everything Strict
  JSON accepts, Python's `json.loads` also accepts with the same meaning.
- **Legacy** (characterization): reproduces what the current Python code
  does, including its quirks, so a later port can see them instead of
  inheriting them by accident. A legacy function is not a recommendation.
- **Parity domain**: the input range where a legacy reproduction is exact.
  Outside it, functions return `OutsideParityDomain` with a reason, never a
  guess.

## Source inventory

All anchors refer to `engine/backend/orgtree/` at private v3 `a107f7d`.

| Behavior | Source | Rust |
|---|---|---|
| Credit grid: `CREDIT_PLACES = 2`, `_q(x) = round(x, 2)` on every total and mutated grant | ledger.py `_q`, `committed`, `free` | `credits::Credits` (exact `i64` hundredths), `py_round2`, `py_float_repr` |
| Seat rule `floor(p + 1e-9)` at or above 1, `max(0.10, round(p, 2))` below | openrouter.py `seat_for` | `credits::py_seat_for` |
| Hire grant check `grant < 0 or grant != int(grant)`, then `int(grant)` is stored | ledger.py `Org.hire`, `_new_node` | `credits::legacy_hire_grant` |
| USER pool is unlimited (`free(USER)` is `math.inf`) | ledger.py `free` | `credits::Capacity::Unlimited` |
| Absent generation is 0; `null` raises `TypeError` | api.py `_agent_identity`: `int(caller.get("generation", 0))` | `presence::legacy_api_generation`, strict `node_generation` |
| Generation must be `type(g) is int` and `>= 0` to be written | agentauth.py `child_env` | `presence::node_generation`, `credential::encode_payload` |
| Credential payload `json.dumps([slug, nid, generation, seat_id], separators=(',', ':'))`, URL-safe base64, no padding; an empty `seat_id` is refused (P04a-2: the seat binds the credential to the immutable principal) | agentauth.py `child_env`, `verify` | `credential::encode_payload`, `decode_payload_canonical`, `decode_payload_legacy` |
| Actor kinds `@user`, `@system`, `@extern`; agent names are unrestricted slugs | ledger.py `USER`, `SYSTEM`, `EXTERN` | `identity::Actor` |
| Node ids and org slugs come from `slugify` (hire adds `-2`, `-3`…) | ledger.py `slugify`, `_new_node`, `Org.create` | `identity::py_slugify`, `AgentKey`, `OrgKey` |
| Work title prefix: lowercase, collapse, cut to 48, fall back to `item` | ledger.py `Org._work_slugify` | `identity::py_work_slugify` |
| Exact case-sensitive work lookup; `^w[0-9a-f]{8}$` only adds guidance after a miss | ledger.py `_work_find`, `_WORK_OLD_ID` | `identity::py_is_retired_work_id_shape` |

The binding v6 decisions it follows are in `data-arch-astra/architecture-review-v6`,
approved at the design stage by arch-review-astra: exact credit values rather
than float tolerance, and versioned language-neutral codecs (SCHEMA-CATALOG);
org-scoped keys, and legacy identities mapped explicitly rather than assumed
unique (SCHEMA-CATALOG); the always-suffixed work name with a 48-character
prefix and a 76-character total (DATA-PLACEMENT); and canonical amount/ID parity
under P04 (MIGRATION-AND-QUALIFICATION). New-format work names are not minted
by current source yet, so those vectors cite the v6 format as their source.

## Parity vectors

`oracle/generate_vectors.py` builds `vectors/backend-codec-vectors.json` by
calling the backend's own `ledger._q`, `openrouter.seat_for`, `ledger.slugify`,
`Org._work_slugify`, `Org._WORK_OLD_ID`, `Org.hire` (on a synthetic in-memory
organization), `agentauth.child_env` and `agentauth.verify`, plus `json.loads`.
The API door's generation expression cannot be called on its own, so the
oracle refuses to run if that exact source text is no longer present. The
oracle records SHA-256 hashes of the four source files it reads.

It must run on the engine runtime (CPython 3.13.15, Unicode 15.1.0); system
Python has different Unicode data and is refused. All inputs are synthetic
and seeded, so regeneration is deterministic.

```powershell
E:/Libraries/Desktop/orgtree/engine/runtime/python.exe engine/native/backend-codec/oracle/generate_vectors.py --check
python tools/run-python-verification.py --python E:/Libraries/Desktop/orgtree/engine/runtime/python.exe tests/test_backend_codec_vectors.py
```

`tests/test_backend_codec_vectors.py` regenerates the vectors inside the
isolated Python runner and compares them byte for byte. It also replaces
`_q`, `seat_for`, `slugify` and `verify` one at a time and checks that the
vectors change, and that a missing source anchor stops the oracle.

## Rust checks

Run offline, with build output outside the checkout:

```powershell
$env:CARGO_TARGET_DIR = '<own scratch>/cargo-target'
cargo test --offline --manifest-path engine/native/backend-codec/Cargo.toml
cargo run --offline --manifest-path engine/native/backend-codec/Cargo.toml --bin codec-vectors
```

- `tests/vectors.rs` runs all 15 vector sections against the reference code.
- `tests/controls.rs` holds 16 negative controls. Each swaps one real
  decision for a known-faulty one and requires the unchanged vectors to fail,
  and to fail only in the sections that exercise that decision:

  | Control | Faulty decision |
  |---|---|
  | C01 | Round by multiplying the float by 100 |
  | C02 | Round sub-0.01 input instead of refusing it |
  | C03 | Read a present `null` as absent |
  | C04 | Strict generation reads `null` as absent |
  | C05 | Legacy generation applies the default to `null` |
  | C06 | Strict JSON accepts duplicates and NaN |
  | C07 | Lowercase ASCII only (slug, work prefix, table) |
  | C08 | Agent `user` taken as USER; unknown `@` string taken as an agent |
  | C09 | Retired-id shape without Python's `$`-before-newline rule |
  | C10 | Seat rule without the `1e-9` guard |
  | C11 | Canonical credential ignores unused base64 bits |
  | C12 | Credential JSON written as raw UTF-8 |
  | C13 | Work-name prefix not cut to 48 |
  | C14 | Boolean grants refused |
  | C15 | Credential payload without the seat (three fields) |
  | C16 | Canonical credential accepts a seatless or empty-seat payload |

  These show sensitivity to these particular defects only.
- `tests/properties.rs` covers every grid value in ±3,000.00 plus 200,000
  sampled values up to the parity bound, overflow and bounds, JSON
  presence/order/duplicate/depth/size rules, namespaces, and 500 credential
  round trips. It also checks that the library source contains no network,
  process, file, environment, clock, thread or `unsafe` use, and that the
  crate has no dependency besides `../work-name-codec`.
- `src/bin/codec-vectors.rs` is the local test driver. It reads one vectors
  file (by default the committed one), prints a JSON report and opens no
  socket.

## Unresolved cases

These are recorded in `UNRESOLVED` (`src/lib.rs`) and are not decided here:

| ID | Question |
|---|---|
| U-JSON-1 | Python accepts unpaired surrogate escapes; Rust strings cannot hold them, so both profiles refuse them. |
| U-JSON-2 | Current doors accept duplicate names (last value wins) and NaN/Infinity. No ruling says whether new doors refuse them. |
| U-JSON-3 | `json.loads(bytes)` detects UTF-16/32 and uses surrogatepass; only UTF-8 text is read here. |
| U-AMT-1 | Python rounds sub-0.01 amounts; v6 wants exact values. Refuse or round at a future door is not ruled. |
| U-AMT-2 | Python credit floats can be `-0.0`; the exact type has no signed zero. |
| U-AMT-3 | No wire lexeme for exact credits is fixed; Python writes `4` or `4.0` depending on history. |
| U-AMT-4 | Hire accepts `true` and `3.0` as grants (stored as `int(grant)`); NaN and +Infinity raise instead of the product refusal. |
| U-GEN-1 | Absent generation reads as 0 but `null` raises; booleans and fractions are coerced. |
| U-ID-1 | `verify` accepts a negative generation that `child_env` never writes. |
| U-ID-2 | `verify` decodes base64 non-strictly; only alphabet-only payloads are reproduced. |
| U-ID-3 | Imported legacy ids and names need not be slug fixed points; legacy import preflight is separate work. |
| U-NAME-1 | Prefix derivation is pinned to Python 3.13.15 Unicode 15.1.0 lowercase data. |

## Limits

The vectors are synthetic and cover selected inputs, not every value. The
credential module checks payload text only; signatures, keys and
authentication stay in Python. The `ScopedKey` type expresses v6's org
scoping for callers, but no storage or lookup uses it yet. Absence of a
mismatch here says nothing about wire-level HTTP/MCP behavior, which the
separate wire conformance suite covers.
