# Mail-hub migration: V2 hub → the orgtree-mailhub product

What happens, exactly once, when an installation that ran the superseded V2
embedded hub starts an Orgtree that hosts the pinned orgtree-mailhub product
instead — and where every boundary sits: what migrates automatically, what is
deliberately not carried, what stays behind as the rollback surface, and what
old peers experience.

## What migrates automatically (deterministic, tested)

All of it runs inside `engine/mailhub_runtime.py`, before the hub first
serves; every step is covered by `tests/test_mailhub_runtime.py` and was
additionally rehearsed against a read-only snapshot of a real V2 store.

1. **Hosting settings** — `desktop-hub.json` maps onto the hub's own model
   into `mailhub-hosting.json`: the port carries over (a dynamic-port
   setting becomes the standard 7370, noted), a loopback bind carries over,
   and a plain (no-TLS) network bind carries over with the operator-page
   warning. The mapping and its notes are written into the new file's
   `migrated` record and shown once in App settings → Mail hub.
2. **The message store** — messages (all delivery states, timestamps and
   ids intact) and attachment rows copy into a fresh store created by the
   hub's OWN schema code, in one transaction, validated by count, recorded
   durably in the destination's `meta` table and in
   `mailhub/migration-report.json`. Re-running is a no-op.
3. **Attachment blobs** — whatever the V2 hub still held (it deleted blobs
   at custody ACK, so only unfetched ones remain). A blob the V2 hub already
   deleted stays deleted; the hub's own `410 blob expired` answer covers it.
4. **Organization identities** — nothing to migrate: every org already
   holds its self-issued secret in its own document (V2 minted them even
   though its wire protocol ignored them), and the address derives from the
   secret. Orgs re-register themselves with the new hub automatically and
   keep their exact addresses. Stale local-hub addresses in org documents
   (dynamic-port artifacts) are rewritten to the engine's real hub address
   by the adapter seam, and the client's own reconciliation re-earns
   registration.
5. **Retention** — the integrated hub defaults to KEEP FOREVER (user ruling
   2026-09-15), so migrated history is not swept. The standalone product's
   own default remains 30 days. Retention is configurable in App settings →
   Mail hub.

## What is deliberately NOT carried

- **Roster rows without fingerprints.** The V2 hub trusted bare addresses
  (`X-Org-Address`, no secret), so its fingerprint-less roster rows are
  unclaimable under owned-address authentication. They are skipped and
  listed in the migration report. This loses nothing: a row is remade the
  moment its owner re-registers, and queued mail for a slug delivers as
  soon as that slug re-registers. Rows that DO carry fingerprints (imported
  from V1 originally) copy as-is and their owners keep their addresses
  without re-registering.
- **TLS-based public hosting.** The V1-model hub does not terminate TLS.
  A V2 configuration that exposed the hub with TLS is NOT silently
  downgraded to plaintext exposure: hosting resets to this-computer-only
  and the settings panel says so. Re-enable network exposure deliberately,
  with a reverse proxy in front if you need encryption.
- **`advertise_host`.** No equivalent: peers connect to the address they
  were given. A non-default value is noted in the migration record.
- **The dynamic-port + readiness.json discovery dance.** The hub now has a
  fixed configured port (default 7370), like every other service.

## Compatibility with old peers

A peer still running the V2 (address-only) client cannot authenticate
against the owned-address hub: its calls answer 401 until it upgrades.
Upgraded peers reconnect with no action — their secrets already exist, the
401 self-heal re-registers, and first-write-wins re-mints identical
addresses. Until a remote machine upgrades, mail to and from it queues
(outbound spools locally and retries forever; that is the client's normal
offline behavior, visible per-hub in Connections).

## Rollback boundary

Nothing the migration reads is ever modified:

- `<data>/hub/` — the complete V2 hub store (database and blobs) stays
  exactly as the last V2 run left it.
- `desktop-hub.json` — the V2 hosting configuration stays in place.

Rolling back to a pre-replacement build therefore finds its own store and
its own settings untouched. Mail that arrived AFTER the switch lives only in
the new store (`<data>/mailhub/`) — a rollback keeps it on disk but the old
build will not read that directory.

## If migration fails

The hub refuses to serve a half-migrated store: the partial destination is
removed, the sources remain untouched, the engine still boots, and App
settings → Mail hub (plus the tray status line) show the recorded error.
Fix the cause and restart; the migration re-runs from the beginning.
