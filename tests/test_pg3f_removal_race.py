"""PG-3f: account removal cannot strand a binding made while it runs (lead
decision 32), proven with forced interleavings (tests/racekit.py) on PG-0's
in-process fake over a throwaway SQLite root.

The binder here is a converted account rebind: ONE org_tx on the seat that
validates the account (`registry.validate_selection`) while holding the seat,
then writes the binding — what `supervisor.assign_account` does on PG-3e-B.

  * a binder that STARTS while the removal runs is refused by the registry's
    removing mark, and the removal completes (without the mark the binder
    succeeds and the removal can only give up);
  * a binder that validated BEFORE the mark and still holds its seat is
    WAITED FOR by the removal's final re-read (proven from the lock manager's
    wait-for table), which then sees its binding and keeps the account —
    instead of removing the row under it.

Run:  python tools/run-python-verification.py tests/test_pg3f_removal_race.py
"""

import os
from pathlib import Path
import sys
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-pg3f-race-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_TEST_HOOKS='1',
                  ORGTREE_STEER_HOOK='0')
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import account_removal, orgtx, registry, store  # noqa: E402
import racekit  # noqa: E402

# converted racers: the row locks, not DOC_LOCK, must order them
if hasattr(orgtx, 'TRANSITION_FENCE'):
    orgtx.TRANSITION_FENCE = False

_n = 0


def _node(account=None, state='live'):
    node = {'state': state, 'parent': None, 'generation': 1, 'model': 'opus',
            'grant': 50, 'free': 50, 'session_id': 'sid-0', 'scope': {}}
    if account:
        node['account'] = account
    return node


def _org(nodes) -> str:
    global _n
    _n += 1
    org = store.create_org(f'pg3f-race-{_n}')
    slug = org.d['slug']
    for nid, node in nodes.items():
        org.d['nodes'][nid] = node
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _account() -> str:
    global _n
    _n += 1
    row = registry.create_account(
        'claude', 't', {'kind': 'managed', 'path': str(Path(_temp.name) / f'acct-{_n}')})
    return str(row['id'])


def _bind(race, slug: str, nid: str, aid: str) -> None:
    with orgtx.org_tx(slug, nodes=[nid]) as tx:
        registry.validate_selection(slug, 'opus', aid)
        race.mark('validated')
        tx.d['nodes'][nid]['account'] = aid


class RemovalRace(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        # only this test's orgs: the removal reads the whole fleet
        for name in os.listdir(store._orgs_dir()):   # pyright: ignore[reportPrivateUsage]
            if name.endswith(store.db_ext()):
                try:
                    os.unlink(os.path.join(store._orgs_dir(), name))   # pyright: ignore[reportPrivateUsage]
                except OSError:
                    pass
        self.aid = _account()
        self.a = _org({'root': _node(), 'old': _node(self.aid, 'archived')})
        self.b = _org({'root': _node()})

    def _remove(self):
        return account_removal.remove_account_rebinding_agents(self.aid, actor='USER')

    def test_a_binder_that_starts_during_the_removal_is_refused(self) -> None:
        with racekit.Race(pair='converted') as race:
            r = race.actor('R', self._remove)
            b = race.actor('B', _bind, race, self.b, 'root', self.aid, may_raise=True)
            gr = race.hold(r, 'after_lock')          # R: migrating, account marked
            race.start(r)
            race.reached(gr)
            race.start(b)
            race.join(b)
            race.release(gr)
            race.join(r)
            race.expect_order('R.after_lock', 'B.raised', 'R.after_commit', 'R.done')
        self.assertIsInstance(b.error, registry.BindingRefused, b.error_tb)
        self.assertIn('being removed', str(b.error))
        self.assertEqual(r.result['removed'], self.aid)
        self.assertNotIn('account', store.load_org(self.b).d['nodes']['root'])
        with self.assertRaises(registry.UnknownAccount):
            registry.get_account(self.aid)
        # the mark is gone with the removal: nothing is left refusing
        self.assertNotIn(self.aid, registry._removing)   # pyright: ignore[reportPrivateUsage]

    def test_a_binder_that_validated_first_is_waited_for_not_stranded(self) -> None:
        with racekit.Race(pair='converted') as race:
            b = race.actor('B', _bind, race, self.b, 'root', self.aid)
            r = race.actor('R', self._remove, may_raise=True)
            gb = race.hold(b, 'validated')           # B holds its seat, validated
            race.start(b)
            race.reached(gb)
            race.start(r)
            race.blocked(r)                          # R's final re-read waits for B
            race.release(gb)
            race.join(b, r)
            race.expect_order('B.validated', 'R.blocked', 'B.after_commit', 'R.raised')
        self.assertIsInstance(r.error, account_removal.RemovalIncomplete, r.error_tb)
        self.assertIn(self.b, str(r.error))
        # the account is KEPT, so B's binding names a row that still exists
        self.assertEqual(registry.get_account(self.aid)['id'], self.aid)
        self.assertEqual(store.load_org(self.b).d['nodes']['root']['account'], self.aid)
        # what had been migrated stays migrated
        self.assertNotIn('account', store.load_org(self.a).d['nodes']['old'])
        self.assertNotIn(self.aid, registry._removing)   # pyright: ignore[reportPrivateUsage]

    def test_a_failed_removal_unmarks_the_account(self) -> None:
        # a refusal must not leave the account unbindable
        doc = registry.load(strict=True)
        doc['aliases']['primary'] = self.aid
        registry.save(doc)
        try:
            with self.assertRaises(account_removal.RemovalRefused):
                self._remove()
        finally:
            doc = registry.load(strict=True)
            doc['aliases'].pop('primary', None)
            registry.save(doc)
        self.assertNotIn(self.aid, registry._removing)   # pyright: ignore[reportPrivateUsage]
        registry.validate_selection(self.b, 'opus', self.aid)   # bindable again


if __name__ == '__main__':
    unittest.main()
