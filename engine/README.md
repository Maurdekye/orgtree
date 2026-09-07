# Python engine boundary

The V2 engine launches the existing Orgtree API as a separate, loopback-only
process. The V1 domain, persistence and route semantics remain authoritative;
this boundary validates the dedicated V2 root and desktop credential before
loading them. See `../docs/engine-contract.md` and `launch.py`.

The desktop must provide explicit `ORGTREE_DATA`, `ORGTREE_V1_ROOT`, and
`ORGTREE_V2_TOKEN` values. The launcher refuses an implicit data root, removes
the token from the child environment before legacy imports, and emits one
bounded JSON readiness line. Bundle the dedicated Python runtime beneath
`engine/runtime` for distribution.
