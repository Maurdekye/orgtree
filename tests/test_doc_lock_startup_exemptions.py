"""S8 (FENCE-OFF-PLAN): proofs for the startup-only DOC_LOCK users.

The fence-off gate exempts DOC_LOCK users that provably run BEFORE the
engine serves any request. The tripwire is armed at the end of the startup
handler, so "exempt" means "ran with the tripwire still off". These pin the
ordering, so a later edit that moves one of them after serving begins (or
arms the tripwire earlier) fails here instead of silently reclassifying it:

  * store.migrate_pending (inside store.claim_data_root) is main()'s FIRST
    act: no uvicorn server exists yet when it runs;
  * registry_migration.run_startup_migration and run_apikey_cutover run in
    the startup handler with the tripwire still off (raise mode would trip
    on their DOC_LOCK otherwise), and the tripwire is armed before the
    background recovery starts — so recovery (reconcile included) is NOT
    exempt and is counted.

NOT exempt, and not claimed: store._ensure_migrated takes DOC_LOCK lazily,
per org, at request time (a `.json` restored after startup) on the SQLite
backend only; it returns at once on PostgreSQL.

Run:  python tools/run-python-verification.py tests/test_doc_lock_startup_exemptions.py
"""

import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-tw-startup-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')
os.environ.pop('ORGTREE_DOC_LOCK_TRIPWIRE', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, registry_migration, startup, store, supervisor  # noqa: E402


class _Stop(Exception):
    pass


def tearDownModule() -> None:
    store.arm_doc_lock_tripwire('off')
    _temp.cleanup()


class StartupExemptions(unittest.TestCase):
    def tearDown(self) -> None:
        store.arm_doc_lock_tripwire('off')

    def test_registry_migrations_run_before_the_tripwire_arms(self) -> None:
        seen: list[tuple[str, str]] = []

        def migration(name: str):
            def run() -> None:
                seen.append((name, store.doc_lock_tripwire_report()['mode']))
                with store.DOC_LOCK:            # what the real ones take
                    pass
            return run

        def recovery_start(_repair) -> None:
            seen.append(('recovery', store.doc_lock_tripwire_report()['mode']))

        saved = (store.on_save, supervisor.notify, supervisor.stream, supervisor.mail_spark)
        try:
            with patch.dict(os.environ, {'ORGTREE_DOC_LOCK_TRIPWIRE': 'raise'}), \
                    patch.object(api, '_deployment_preflight', lambda: None), \
                    patch.object(registry_migration, 'run_startup_migration',
                                 migration('startup_migration')), \
                    patch.object(registry_migration, 'run_apikey_cutover',
                                 migration('apikey_cutover')), \
                    patch.object(startup.recovery, 'start', recovery_start):
                asyncio.run(api._wire_notify())
        finally:
            store.on_save, supervisor.notify, supervisor.stream, supervisor.mail_spark = saved
        self.assertEqual(seen, [('startup_migration', 'off'), ('apikey_cutover', 'off'),
                                ('recovery', 'raise')])
        rep = store.doc_lock_tripwire_report()
        self.assertEqual((rep['mode'], rep['total']), ('raise', 0))

    def test_lifespan_reports_ready_only_after_migrations_and_arming(self) -> None:
        # S9 (plan decision 44 (3)): "before serving". uvicorn accepts no
        # connection until the app's lifespan answers startup.complete, and
        # the admin server serves `api.app` itself (the public and bridge
        # gateways swallow lifespan precisely so it runs once, here). So drive
        # api.app's real ASGI lifespan and pin where startup.complete lands.
        seen: list[str] = []

        def migration(name: str):
            return lambda: seen.append(name)

        real_arm = store.arm_doc_lock_tripwire_from_env

        def arm() -> str:
            seen.append('tripwire_armed')
            return real_arm()

        async def lifespan() -> None:
            inbox: asyncio.Queue = asyncio.Queue()
            await inbox.put({'type': 'lifespan.startup'})

            async def send(msg) -> None:
                seen.append(msg['type'])
                if msg['type'] == 'lifespan.startup.complete':
                    await inbox.put({'type': 'lifespan.shutdown'})

            await api.app({'type': 'lifespan', 'asgi': {'version': '3.0'}, 'state': {}},
                          inbox.get, send)

        saved = (store.on_save, supervisor.notify, supervisor.stream, supervisor.mail_spark)
        try:
            with patch.object(api, '_deployment_preflight', lambda: None), \
                    patch.object(registry_migration, 'run_startup_migration',
                                 migration('startup_migration')), \
                    patch.object(registry_migration, 'run_apikey_cutover',
                                 migration('apikey_cutover')), \
                    patch.object(store, 'arm_doc_lock_tripwire_from_env', arm), \
                    patch.object(startup.recovery, 'start', lambda _r: None):
                asyncio.run(lifespan())
        finally:
            store.on_save, supervisor.notify, supervisor.stream, supervisor.mail_spark = saved
        self.assertEqual(seen[:4], ['startup_migration', 'apikey_cutover',
                                    'tripwire_armed', 'lifespan.startup.complete'], seen)
        # and the admin listener serves the app whose lifespan that is (source pin)
        import inspect
        # (9ea99e8 added **LOCAL_UVICORN_OPTIONS after PORT: the local websocket skips deflate)
        self.assertIn('uvicorn.Config(app, host=host, port=PORT,', inspect.getsource(api.main))

    def test_migrate_pending_runs_before_any_server_exists(self) -> None:
        import uvicorn
        events: list[str] = []

        def claim() -> None:
            events.append('claim_data_root')
            raise _Stop()                        # stop main() right after it

        def server(*_a, **_k):
            events.append('server')
            raise _Stop()
        with patch.object(store, 'claim_data_root', claim), \
                patch.object(uvicorn, 'Server', server), \
                patch.object(uvicorn, 'run', server):
            with self.assertRaises(_Stop):
                api.main()
        self.assertEqual(events, ['claim_data_root'])
        # and migrate_pending is claim_data_root's (SQLite startup migration)
        import inspect
        self.assertIn('migrate_pending()', inspect.getsource(store.claim_data_root))


if __name__ == '__main__':
    unittest.main()
