# Disruptive probes

Tests in this folder are allowed to do things an ordinary test run must never
do on somebody's desktop: open a console window, show a dialog, raise a UAC
prompt, or execute a compiled installer.

They are unreachable from `npm test`. The default glob is `tests/*.test.mjs`,
which does not recurse into this folder. They also gate themselves on
`ORGTREE_DISRUPTIVE_PROBES=1` through `./gate.mjs`, so a future change to the
glob does not silently re-arm them.

To run them, on a machine you are willing to have interrupted:

    ORGTREE_DISRUPTIVE_PROBES=1 npm run test:disruptive

A probe that is gated out reports as SKIPPED and prints why. It never reports as
passed, and its acceptance evidence is recorded as `not_exercised` — an
unmeasured control and a satisfied one are different claims.

`tests/disruptive-policy.test.mjs` enforces the boundary: it fails if a file the
default glob can reach contains a disruptive primitive. That guard is headless
and carries a firing positive control for every pattern it looks for.
