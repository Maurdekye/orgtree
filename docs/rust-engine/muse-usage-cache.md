# Muse usage across restarts

Muse reports usage during/after a turn or as its own dated cached metadata;
Orgtree cannot independently obtain a new measurement. Keep each account's
last good reading in `ot.kv` at `muse_usage:<account>`, including
`muse_usage:muse/primary`. Other providers' usage caches remain memory-only.
`ot.usage_history` retains historical series, not the full current readout.

Coordinator-opus approved this contract on 2026-10-15 11:47Z for
`keep-the-last-muse-usage-reading-across-restarts`:

- Persist only normalized windows (kind/group/percent/reset/model provenance/
  display label) and the original observation date. Never save raw MSP
  metadata, tokens, credentials, paths, email, or authentication evidence.
- Restore after accounts load, before provider discovery and turn recovery.
  Restore only native Muse and currently registered Muse subscriptions. A
  restored reading supplies no positive authentication observation. Its age
  remains real even when older than this machine's uptime; stale readings
  remain stale in the cached query and turn board.
- Newer Muse observations replace older ones. Null/undated/windowless reports
  leave the last good reading alone. Existing signed-out handling remains.
- A read projection clears percent, active and severity on passed-reset Muse
  windows. Keep original observation/reset times and durable last-good data;
  never invent zero. Cards show `reset; awaiting reading` with no bar/badge,
  the board uses that state, and the cached query exposes unknown values.
  Other providers keep their current passed-reset behavior.
- Account removal deletes its durable key in the same transaction as the
  account and clears the removed profile's memory cache. Persistence takes
  KEY SHARE on the exact current account row, pairing with removal's FOR
  UPDATE so an outstanding observation cannot recreate its durable key.
  No transaction contains provider work. No new refresh or auth behavior.

## Verification packet and current limits

Base `0582efd`, baseline tests committed first at `a9a0f0c`. Rig-sol-b measured
the permitted `b77512f` baseline with test-only overlay `ca98438`: rebuilt fake
CLI succeeded; full process proof executed 11 checks (3 pass/8 fail), including
two contained engine restarts. Seven failures prove absent persistence/reset
state; the cached-tool failure was early native-lane visibility, not a stale
reading assertion. Preserve the original red receipts. The fixture now waits
for post-restart fake Muse discovery before its cached tool query.

Candidate proof: `tools/rig/proofs/muse-usage-restart.mjs` (same 11 assertions),
plus `cargo test --offline --locked -j2 -p orgtree-engine --bin orgtree-engine
usage:: -- --nocapture` from `engine/rs`. Three added unit tests cover safe
projection, invalid dates, 300-day restoration without auth, timestamp ordering,
expired-window unknown values and the unaffected Claude projection. Renderer
suite `museusagecache` covers expired Muse wording/no bar, non-Muse wording and
future-reset controls; run with `museusagerefresh`, `usagecredits` and root
typecheck using `usagerefresh-check.mjs`, output/dependencies in the rig's scope.
Its baseline overlay at `0582efd` should give one expected renderer failure
and two passing controls. All candidate executable checks await rig-sol-b;
source edits and syntax checks alone are not a pass. No live Muse/provider
probe, app build, install, restart of the installed app, or push is authorized.
