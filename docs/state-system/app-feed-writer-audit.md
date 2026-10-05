# App feed writer and restore inventory

Source inventory, 2026-10-05; implementation of the
[step-6 addendum, section 5](pg-step6-record-feed.md).

All eleven Python functions that write `orgtree.orgs` are in
`orgdb/lifecycle.py`: `_claim_in`, `_step`, `_release`, `take_over`,
`_insert_row`, `set_legacy_source`, `_mark_unavailable`, `note_retry_failure`,
`_cancel_create`, `_set_state` and `_resume_purge`. They write registry rows
without explicitly reading, locking or updating `registry_revision` and
without forcing deferred constraints. Migration `0005_app_feed.sql` owns the
single revision update. Its deferred flush only updates that singleton,
records its transaction-local revision and sends `app_rev`; it acquires no
source-row locks afterward. Each registry statement re-defers the flush.

`tests/test_app_feed_lock_order.py` inventories those writers and refuses new
Python revision writers/lockers. `tests/test_app_feed_pg.py` measures two
concurrent writers with a real barrier: independent source rows remain
writable while the revision singleton is held, and commits serialize on the
singleton. Its temporary trigger measures the interval from the actual
revision update to a post-commit read, an upper bound on revision-lock hold
time. Measurements belong to verification receipts, not a machine-specific
latency threshold in source.

No current product tool restores or replaces the new app database. The
custodian's `backup.rs::restore` restores only its fixed `APP_DB = "orgtree"`
(the legacy database), refuses product roots and changes the legacy
`public.store_incarnation`. `tools/rehearse-orgdb.py` restores legacy inputs
into disposable databases before conversion. `tools/restore-org.py` and
`orgdb/lifecycle.py::restore` restore individual org databases, not the app
database. `orgdb/names.py` deliberately distinguishes `orgtree` from
`orgtree_app`.

Any future tool that restores or replaces the app database must change
`app_identity.incarnation` while holding the data-root owner lock with the
engine stopped. A fresh app migration initializes both UUIDs. An identity
change observed during one engine epoch closes app-feed clients and refuses
further copies; a replacement becomes readable under a new host epoch.
The existing legacy restore command is not an app-database restore command.
