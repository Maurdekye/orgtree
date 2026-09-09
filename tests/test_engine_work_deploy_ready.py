"""Regression coverage for the `deploy_ready` docket status (work stage):
completed implementation awaiting deployment/publication, active and
actionable, never `blocked`, never auto-archived like `done`."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

# ORGTREE_DATA must be set, in system Temp, OUTSIDE both live roots, BEFORE
# anything that imports `store` — `store.DATA_ROOT` binds at import time.
# `load_app()` also puts THIS WORKTREE's engine/backend on sys.path ahead of
# any installed copy, so `from orgtree import ...` below resolves to the
# source under test rather than a live installation.
_root = tempfile.TemporaryDirectory(prefix='v2-deploy-ready-')
data = Path(_root.name) / 'data'; data.mkdir()
home = Path(_root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='test-token')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine.launch import load_app  # noqa: E402  (import after env is set)
load_app()
from orgtree import ledger, mcptool  # noqa: E402  (import after env is set)

REPO_ROOT = Path(__file__).resolve().parent.parent


def tearDownModule():
    _root.cleanup()


def _org_with_owner(name: str) -> tuple[ledger.Org, str]:
    org = ledger.Org.create(name)
    hired = org.hire(ledger.USER, None, 'haiku', 0, 'worker')
    return org, str(hired['node'] if isinstance(hired, dict) and 'node' in hired
                    else 'worker')


class DeployReadyLedgerTests(unittest.TestCase):
    def test_agent_can_assert_deploy_ready_and_it_counts_active(self):
        org, owner = _org_with_owner('deploy-ready-assert')
        created = org.work_create(owner, 'Ship the thing', 'objective text',
                                  owner=owner)
        slug = created['slug']
        org.work_update(owner, slug, ['implemented and reviewed'],
                        ['get it deployed'], status='deploy_ready')
        served = org.work_list(owner)['items'][0]
        self.assertEqual(served['status'], 'deploy_ready')
        counts = org.work_counts()
        self.assertEqual(counts['active'], 1)
        self.assertEqual(counts['backlogged'], 0)

    def test_deploy_ready_is_not_blocked_and_not_done(self):
        org, owner = _org_with_owner('deploy-ready-distinct')
        created = org.work_create(owner, 'Ship it', 'objective', owner=owner)
        slug = created['slug']
        org.work_update(owner, slug, ['done'], ['deploy'], status='deploy_ready')
        item = org._work_active()[0]
        self.assertNotIn(item['status'], org.WORK_CLOSED)
        self.assertNotEqual(org._work_status(item), 'blocked')

    def test_deploy_ready_does_not_auto_archive_like_done(self):
        # POSITIVE CONTROL: a same-aged `done` item at the identical
        # timestamp DOES archive at far_future — proving now_ts is actually
        # driving the archive check here, and the deploy_ready assertion
        # below isn't passing merely because nothing in this test can fail.
        org, owner = _org_with_owner('deploy-ready-noarchive')
        ready = org.work_create(owner, 'Ship it', 'objective', owner=owner)
        finished = org.work_create(owner, 'Already shipped', 'objective',
                                   owner=owner)
        org.work_update(owner, ready['slug'], ['done'], ['deploy'],
                        status='deploy_ready')
        org.work_update(owner, finished['slug'], ['done'], [])
        org.work_accept(ledger.USER, finished['slug'])
        far_future = time.time() + 7200  # strictly over the 1h archive age
        served = org.work_list(owner, include_archived=True, now_ts=far_future)
        slugs_active = {v['slug'] for v in served['items']}
        slugs_archived = {v['slug'] for v in served['archived']}
        self.assertIn(ready['slug'], slugs_active)
        self.assertNotIn(ready['slug'], slugs_archived)
        # CONTROL: the same-aged done item archives — the harness can detect
        # archival, so deploy_ready staying out of `archived` above is real
        self.assertIn(finished['slug'], slugs_archived)
        self.assertNotIn(finished['slug'], slugs_active)

    def test_deploy_ready_is_nudged_unlike_blocked(self):
        org, owner = _org_with_owner('deploy-ready-nudge')
        ready = org.work_create(owner, 'Ready to ship', 'objective', owner=owner)
        blocked = org.work_create(owner, 'Stuck on something', 'objective',
                                  owner=owner)
        org.work_update(owner, ready['slug'], ['done'], ['deploy'],
                        status='deploy_ready')
        org.work_update(owner, blocked['slug'], ['tried'], ['waiting'],
                        status='blocked', blocked_reason='waiting on X')
        reminders = {r['slug'] for r in org.work_idle_reminder_items(owner)}
        self.assertIn(ready['slug'], reminders)
        self.assertNotIn(blocked['slug'], reminders)
        # an owner whose ONLY active item is deploy_ready still has actionable
        # work — unlike an owner whose every item is blocked
        org2, owner2 = _org_with_owner('deploy-ready-only')
        solo = org2.work_create(owner2, 'Ready to ship', 'objective', owner=owner2)
        org2.work_update(owner2, solo['slug'], ['done'], ['deploy'],
                         status='deploy_ready')
        self.assertFalse(org2.work_blocked_only(owner2))

    def test_new_item_can_start_at_deploy_ready(self):
        org, owner = _org_with_owner('deploy-ready-create')
        org.work_create(owner, 'Already finished elsewhere', 'objective',
                        owner=owner, status='deploy_ready')
        served = org.work_list(owner)['items'][0]
        self.assertEqual(served['status'], 'deploy_ready')

    def test_reopen_into_deploy_ready(self):
        org, owner = _org_with_owner('deploy-ready-reopen')
        created = org.work_create(owner, 'Ship it', 'objective', owner=owner)
        slug = created['slug']
        org.work_update(owner, slug, ['cancelled'], [], status='dropped',
                        dropped_reason='no longer needed')
        org.work_update(owner, slug, ['resumed'], ['deploy'],
                        status='deploy_ready', reopen=True)
        served = org.work_list(owner)['items'][0]
        self.assertEqual(served['status'], 'deploy_ready')

    def test_invalid_status_still_rejected_and_message_names_deploy_ready(self):
        org, owner = _org_with_owner('deploy-ready-invalid')
        created = org.work_create(owner, 'Ship it', 'objective', owner=owner)
        with self.assertRaises(ledger.LedgerError) as ctx:
            org.work_update(owner, created['slug'], ['x'], ['y'],
                            status='not_a_real_status')
        self.assertIn('deploy_ready', str(ctx.exception))


class DeployReadyToolSchemaTests(unittest.TestCase):
    def test_orgtree_work_tool_describes_deploy_ready(self):
        tool = next(t for t in mcptool.available_tools()
                   if t['name'] == 'orgtree_work')
        self.assertIn('deploy_ready', tool['description'])
        self.assertIn('deploy_ready',
                      tool['inputSchema']['properties']['status']['description'])

    def test_orgtree_staff_tool_describes_deploy_ready(self):
        tool = next(t for t in mcptool.available_tools()
                   if t['name'] == 'orgtree_staff')
        self.assertIn('deploy_ready',
                      tool['inputSchema']['properties']['status']['description'])


class GeneratedEventsInSyncTests(unittest.TestCase):
    """`apps/desktop/renderer/src/generated/events.ts` and `.schema.json` are
    committed generated artifacts (no `tools/gen_events.py` regenerates them
    in this checkout) — this guards against silent drift from the one
    declarative source, `events_table.py`, the same drift this feature's own
    `deploy_ready` addition had to be checked for by hand."""
    def test_events_ts_matches_source(self):
        from orgtree import events
        expected = events.emit_typescript()
        actual = (REPO_ROOT / 'apps/desktop/renderer/src/generated/events.ts'
                 ).read_bytes().decode('utf-8')
        self.assertEqual(actual.replace('\r\n', '\n'), expected.replace('\r\n', '\n'))

    def test_events_schema_json_matches_source(self):
        from orgtree import events
        expected = json.dumps(events.emit_json_schema(), indent=2,
                              ensure_ascii=False) + '\n'
        actual = (REPO_ROOT / 'apps/desktop/renderer/src/generated/events.schema.json'
                 ).read_bytes().decode('utf-8')
        self.assertEqual(actual.replace('\r\n', '\n'), expected.replace('\r\n', '\n'))


# `store.STORE_BACKEND` binds from ORGTREE_STORE at import time, exactly like
# DATA_ROOT — so testing BOTH backends needs two separate processes, not two
# test methods sharing this one. Each child creates an org, sets an item to
# deploy_ready, saves, then RE-IMPORTS store fresh via a second process-local
# load_org call and reads the status back — a real disk round trip, not a
# same-process cache hit.
_BACKEND_ENGINE = str(REPO_ROOT / 'engine' / 'backend')
_ROUNDTRIP_SCRIPT = """
import sys
sys.path.insert(0, {engine_path!r})
from orgtree import ledger, store

org = store.create_org('deploy-ready-roundtrip')
owner = org.hire(ledger.USER, None, 'haiku', 0, 'worker')['node']
created = org.work_create(owner, 'Ship it', 'objective', owner=owner)
org.work_update(owner, created['slug'], ['done'], ['deploy'], status='deploy_ready')
store.save_org(org)

reloaded = store.load_org('deploy-ready-roundtrip')
served = reloaded.work_list(owner)['items'][0]
assert served['status'] == 'deploy_ready', \
    f"status was {{served['status']!r}} after {{sys.argv[1]}} reload, not deploy_ready"
print('ROUNDTRIP_OK', served['status'])
"""


class DeployReadyStorageRoundtripTests(unittest.TestCase):
    def _roundtrip(self, backend: str) -> None:
        with tempfile.TemporaryDirectory(prefix=f'v2-deploy-ready-{backend}-') as root:
            child_data = Path(root) / 'data'; child_data.mkdir()
            child_home = Path(root) / 'home'; child_home.mkdir()
            env = dict(os.environ)
            env.update(ORGTREE_DATA=str(child_data), HOME=str(child_home),
                      USERPROFILE=str(child_home), ORGTREE_STORE=backend)
            script = _ROUNDTRIP_SCRIPT.format(engine_path=_BACKEND_ENGINE)
            result = subprocess.run(
                [sys.executable, '-c', script, backend],
                env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0,
                             f"{backend} roundtrip failed:\nSTDOUT: {result.stdout}"
                             f"\nSTDERR: {result.stderr}")
            self.assertIn('ROUNDTRIP_OK deploy_ready', result.stdout)

    def test_sqlite_roundtrip_preserves_deploy_ready(self):
        self._roundtrip('sqlite')

    def test_json_roundtrip_preserves_deploy_ready(self):
        self._roundtrip('json')


if __name__ == '__main__':
    unittest.main()
