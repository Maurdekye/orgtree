"""S8-6 tripwire: with the door ON, no agent path reaches `store.write_org`.

Ruling (decision 2 on s8-6-retire-store-write-org-once-its-last-caller):
`store.write_org` stays, as the SQLite-only path (the door is off there by
default). With the door on it must be dead code. This module fails the
moment a new or changed path with the door on enters it.

Two checks, because each covers what the other cannot:

  · STATIC — every call of `write_org` in the backend package, by enclosing
    function. A new caller anywhere (a helper a door body calls, a new
    module) fails here before anyone has to think of driving it.
  · DYNAMIC — through the real `api.agent_call` (throwaway SQLite root,
    ORGTREE_PGDOOR=1), every agent verb in the catalogue is called with
    `write_org` made to explode. Most calls then fail validation (422) —
    that is fine; the only thing measured is whether the call ENTERED
    `write_org`. Plus the two door-off-only branches: the legacy seat_id
    mint and the op-epoch preflight.

Every agent verb is now on the door (ws3b S3 moved cheap_compact and
switch_model, ws3a PG-3a moved staff's rehire mode), so NO verb may reach it:
the expected set is empty, and a new entry needs a ruling on the item first.
"""
import ast
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='writeorg-tripwire-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
_BACKEND = Path(__file__).resolve().parents[1] / 'engine/backend'
sys.path.insert(0, str(_BACKEND))
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}

#: verb (or verb:mode) -> the stream converting it off the legacy cycle
#: verbs allowed to reach write_org with the door on: none, since S3 and PG-3a
PENDING: dict[str, str] = {}

#: never driven: process-level side effects (restart/relaunch the backend).
#: Each must be ROUTED on the door, which the test asserts instead.
NOT_DRIVEN = frozenset({
    'orgtree_self_restart', 'orgtree_self_update', 'orgtree_self_relaunch',
    'orgtree_prime_relaunch', 'orgtree_prime_restart',
})

#: args that keep a verb away from machine-level state on a refusal path
ARGS = {
    'orgtree_account_mark': {'action': 'no-such-action'},
}

#: the only functions allowed to call write_org, with the number of calls
#: (each one sits behind a door-off guard; the dynamic test proves it)
STATIC_SITES = {('api.py', '_agent_identity'): 1, ('api.py', 'agent_call'): 2}


class _Entered(Exception):
    pass


def _explode(slug):
    raise _Entered(slug)


def write_org_calls():
    """{(file, enclosing function): count} for every call of `write_org`
    (as `store.write_org(...)` or a bare `write_org(...)`) in the package."""
    out = {}
    for path in sorted((_BACKEND / 'orgtree').glob('*.py')):
        if path.name == 'store.py':
            continue            # the definition and its own internals
        tree = ast.parse(path.read_text(encoding='utf-8'))

        def walk(node, fn):
            for child in ast.iter_child_nodes(node):
                name = fn
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    name = child.name
                if isinstance(child, ast.Call):
                    f = child.func
                    if (isinstance(f, ast.Attribute) and f.attr == 'write_org') \
                            or (isinstance(f, ast.Name) and f.id == 'write_org'):
                        key = (path.name, fn or '<module>')
                        out[key] = out.get(key, 0) + 1
                walk(child, name)
        walk(tree, None)
    return out


class Static(unittest.TestCase):
    def test_write_org_has_only_the_known_callers(self):
        self.assertEqual(write_org_calls(), STATIC_SITES)


class Dynamic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.slug = 'wotrip'
        org = store.create_org(cls.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)

    @classmethod
    def tearDownClass(cls):
        store._POOL.close_all(cls.slug)

    def setUp(self):
        self.assertTrue(pgdoor.enabled(), 'the door must be on for this test')
        self.p = [patch.object(store, 'write_org', _explode),
                  patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, '_tier_discovery_payload', lambda: {})]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def entered(self, tool, args=None, node='worker'):
        try:
            api.agent_call(api.AgentCall(org=self.slug, node=node, tool=tool,
                                         args=dict(args or {})), REQUEST)
        except _Entered:
            return True
        except (HTTPException, ledger.LedgerError, ValueError, KeyError,
                TypeError, LookupError):
            pass
        return False

    def test_no_verb_reaches_write_org_with_the_door_on(self):
        verbs = sorted(api._profile_tool_names() - NOT_DRIVEN)
        self.assertGreater(len(verbs), 40)       # the catalogue really loaded
        hit = {v for v in verbs if self.entered(v, ARGS.get(v))}
        if self.entered('orgtree_staff', {'node': 'boss'}):
            hit.add('orgtree_staff:rehire')
        self.assertEqual(sorted(hit - set(PENDING)), [],
                         'these reach store.write_org with the door on')

    def test_the_control_fires(self):
        # negative control: the door off sends a plain verb into the cycle,
        # so the sentinel provably catches an entry
        with patch.dict(os.environ, {'ORGTREE_PGDOOR': '0'}):
            self.assertTrue(self.entered('orgtree_status', {'state': 'idle'}))

    def test_not_driven_verbs_are_routed(self):
        for v in NOT_DRIVEN:
            with self.subTest(v):
                self.assertTrue(pgdoor.routed(v, {}), v)

    def test_legacy_seat_mint_stays_off_write_org(self):
        # the loader backfills seat_id, so a legacy seat is simulated: the
        # identity read gets a private load whose caller has none
        def seatless(slug):
            org = store.load_org(slug)
            org.node('worker').pop('seat_id', None)
            return org
        with patch.object(store, 'cached_org', seatless):
            self.assertFalse(self.entered('orgtree_send_file', {'path': 'nope'}))

    def test_op_epoch_preflight_stays_off_write_org(self):
        self.assertFalse(self.entered(api.OP_EPOCH))


if __name__ == '__main__':
    unittest.main()
