# Python removal

Phase 1 (4.6.1, 2026-11-15) removes retired 3.x Python code and legacy tests.
The Rust engine and desktop behavior stay unchanged. The retained Python tools,
CI runtime provisioning and live fixtures remain for a later port.

The 44 legacy SQL migrations now live in
`tools/rig/fixtures/pg_migrations_32/`. The 3.2 rig reads the `app/` and `org/`
subdirectories there; the 3.1 rig still reads migrations from its historical
`v3.1.0` tag. Packaging maps the relocated fixtures to their existing installed
paths, preserving the payload apart from deleted dead Python.

Keep the receipt tool's package closure (`engine/backend/orgtree/__init__.py`,
`workevidence.py`, `workfields.py`) until the receipt tool is ported. The two
live Python repository tests also need `tests/import_provenance.py`; their
package entry point retains `tests/__init__.py`, `hub_isolation.py` and
`child_python.py` unchanged. The empty `tools/test-startup.py` runner remains
for phase 2; CI runs the live Node startup test instead.

The five JS/TS source-text guards now read the live Rust sources. Legacy
Python launcher branches in desktop code and the synthetic `launch.py` files
that tests generate remain for the later port. The 3.x process-name strings in
the installer/boot scripts, `pg-custodian.exe` checks, and non-Python files
under `engine/native/` remain unchanged.

Historical preserved agent-guidance entries and their titles in
`docs/agents/coverage.json` still describe the original 3.x source. Their
preservation metadata is historical evidence, not instructions to run deleted
Python tests. Current Rust source verification uses
`python tools/source-audits.py --rust-only`.

[decided: user 2026-11-15; coordinator import-closure and CI-unhook rulings
2026-11-15; verified: phase-1 source inventory and reader audit]
