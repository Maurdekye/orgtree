# Imported freeze recovery

## Cause and repair

Source and historical read-only log evidence, 2026-10-07: the imported 3.x record
had a human-readable `until` and a numeric `until_ts`. The original Rust schedule
accepted only RFC 3339 `until`, returned immediately, and never reached the
auto-resume check. Missing verbose method traces alone did not prove missing
startup recovery.

Commits `8cc8a77` and `da10249` already repair this on local `rust-engine`.
`runtime::freeze::deadline` accepts canonical `until`, a version-matched legacy
`wake` promise, or numeric `until_ts`. Both importers call `normalize`; existing
rows work without migration. `wake_at` adds the limit reset's 60-second grace.
`recover` reads frozen agents in bounded pages. Scheduled tasks retry transient
errors or disabled auto-resume every 30 seconds and compare the exact original
record before releasing it. `Actor::on_wake` logs why a frozen wake is blocked,
including its due state and the effective auto-resume setting, without verbose
logging.

## 3.x comparison

Reference: `origin/dev`, `engine/backend/orgtree/supervisor.py`,
`start_auto_resume_loop`, `_auto_resume_org`, and `auto_resume_ready`.
Subscription-limit probes require auto-resume, and wake one minute after reset.
Pure connection retries bypass the toggle. The Python scheduler also has
metered-route exceptions, account fallback and shared probe admission; this
verification concerns subscription freezes with an explicit reset, not blanket
parity of those separate policies. No provider usage is fabricated or probed.

## Verification

Scratch matrix and build results will be recorded here before hand-in.
