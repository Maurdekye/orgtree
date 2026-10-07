# read_transcript result parity (F04)

The Rust tool previously formatted history as text lines and retained only a
tool's name, argument and error. It omitted busy and occupancy metadata, tool
results and cards. The 3.x contract is a structured result, verified in
`engine/backend/orgtree/api.py`'s `orgtree_read_transcript` branch.

The restored result contains:

- `node` and `access`: self or chart/downward disclosure, after the existing
  authorization checks. The signed-off removal of earlier-holder docket access
  remains; this change does not widen reading permissions.
- `busy`: the authorized agent row's `inflight_at IS NOT NULL`, also used by the
  chart; `occupancy` and `occupancy_estimated`: its persisted occupancy fields.
  This is a single bounded row read and starts no actor.
- `messages`: oldest first within the requested recent page, each containing
  `role`, `text` and `tools`. Only text is sliced to 1,200 Unicode characters,
  without whitespace collapse or an added ellipsis. Missing/null text is empty.
  The complete stored tools value survives, including results, cards, diffs and
  future fields; it is not reduced to a name/argument/error summary.
- An empty conversation still returns the metadata with `messages: []`.

`last` keeps the 3.x default 30, bounds 1–80, numeric string/float coercion and
invalid-number refusal. The tool description now advertises 30. The existing
history import and bounded conversation reader remain in use. Lazy tool input
storage is unchanged: this is the complete stored tools projection, not an
extra fetch of detached provider argument archives.

## Verification and limits

The scratch smoke extracts the actual Rust projection/argument helpers and the
actual 3.x Python return expression and `_arg_int` function with AST. It does
not import or run the Python engine. Fixtures compare exact JSON equality for
busy/idle, measured/estimated/null occupancy, empty history, null/missing text
and tools, multiline Unicode text sliced at 1,200 characters, and a long tool
result with file/presentation cards and arbitrary extra fields. Fourteen `last`
cases compare defaults, clamps, strings, floats, booleans and invalid values.

The isolated Rust smoke removes only the logging attributes and supplies an
error macro; engine `cargo check` verifies the real logging macro and types.
The projection smoke does not exercise a database, provider history import or
the authorization gate. Those integration paths are source-inspected and kept
in place. No live data or installed engine is touched. Scratch preparation is
`prepare-transcript-parity-smoke.py`, with a provenance guard; its disposable
crate is `transcript-parity-smoke/` and all Cargo output stays under
`E:\cargo-target\readme-sol`.
