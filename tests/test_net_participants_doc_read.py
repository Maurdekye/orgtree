"""scale (hot-paths-off-full-org-reads-child-env-net-polle): `net._participants`
runs on every store.REVISION change (every save) for every org, and it used to
`store.load_org` each one. It now reads only its net settings
(`store.read_doc_sections`).

  * SAME ANSWER: over a mix of orgs (plain, a kiosk org, one with a stale
    per-hub state cell and an orphaned spool key, one with no net identity
    yet), the result equals the fallback path's (read_doc_sections -> None,
    i.e. the old whole-document load), including the self-heal writes.
  * NO WHOLE-ORG READ on the row path: `store.load_org`,
    `store.load_org_snapshot` and `orgtx.org_read` are patched to fail.
  * store.read_doc_sections: returns stored values for present keys only,
    refuses node/log/split sections, and is None on no row answer.

Run:  python tools/run-python-verification.py tests/test_net_participants_doc_read.py
"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-netpart-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT',
            'ORGTREE_LOCAL_HUB_ADDRESS'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import net, orgtx, store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402


def tearDownModule() -> None:
    root.cleanup()


def boom(*a, **k):
    raise AssertionError('_participants read the whole org')


def fallback(*a, **k):
    return None


class Participants(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for s in ('np-a', 'np-b', 'np-c', 'np-kiosk'):
            org = store.create_org(s)
            org.hire(USER, None, 'haiku', 1, 'top')
            if s == 'np-kiosk':
                org.d['kiosk'] = {'enabled': True, 'token': 't', 'credits': 1}
            store.save_org(org)
        net._participants()          # first pass mints identities / hub lists

    def plant(self) -> None:
        """A stale per-hub state cell and an orphaned spool key on np-b —
        both self-heal writes run on the next pass."""
        org = store.load_org('np-b')
        org.d.setdefault('net_state', {})['gone-hub'] = {'address': 'http://x',
                                                         'registered_at': 'z'}
        # the WHOLE spool, so both arms start from the same state
        org.d['net_spool'] = {'gone-hub': [{'to': 'q', 'body': 'b'}]}
        store.save_org(org)

    def test_same_answer_as_the_whole_document_path(self) -> None:
        self.plant()
        with patch.object(store, 'read_doc_sections', fallback):
            old = net._participants()
        self.plant()
        with patch.object(store, 'load_org', boom), \
                patch.object(store, 'load_org_snapshot', boom), \
                patch.object(orgtx, 'org_read', boom):
            new = net._participants()
        self.assertEqual(json.dumps(new, sort_keys=True), json.dumps(old, sort_keys=True))
        self.assertIn('np-a', new)
        self.assertNotIn('np-kiosk', new)
        # the self-heal writes happened on the new path too
        d = store.load_org('np-b').d
        self.assertNotIn('gone-hub', d.get('net_state') or {})
        self.assertNotIn('gone-hub', d.get('net_spool') or {})

    def test_an_org_with_no_identity_is_minted_on_the_row_path(self) -> None:
        org = store.create_org('np-new')
        org.hire(USER, None, 'haiku', 1, 'top')
        org.d.pop('net_identity', None)
        org.d.pop('net_hubs', None)
        store.save_org(org)
        with patch.object(store, 'load_org_snapshot', boom), \
                patch.object(orgtx, 'org_read', boom):
            out = net._participants()
        self.assertIn('np-new', out)
        self.assertTrue(store.load_org('np-new').d.get('net_identity', {}).get('secret'))


class NetSection(unittest.TestCase):
    """net._net_section: the spool / seen-ring / hub-of reads take one doc
    row, with the same value the whole-document read gives."""

    @classmethod
    def setUpClass(cls) -> None:
        org = store.create_org('ns-a')
        org.hire(USER, None, 'haiku', 1, 'top')
        org.d['net_spool'] = {'hub-1': [{'to': 'q', 'body': 'b',
                                         'last_err': 'e1'}]}
        org.d['net_state'] = {'hub-1': {'seen_ids': ['m1', 'm2']},
                              'hub-2': {'seen_ids': ['m3']}}
        store.save_org(org)

    def test_same_value_as_the_whole_document_read(self) -> None:
        d = orgtx.org_read('ns-a').d
        with patch.object(orgtx, 'org_read', boom), \
                patch.object(store, 'load_org', boom):
            for key in ('net_spool', 'net_state', 'net_absent'):
                self.assertEqual(net._net_section('ns-a', key), d.get(key), key)

    def test_no_row_answer_falls_back_to_org_read(self) -> None:
        with patch.object(store, 'read_doc_sections', fallback):
            self.assertEqual(net._net_section('ns-a', 'net_state'),
                             orgtx.org_read('ns-a').d.get('net_state'))

    def test_callers_take_no_whole_org_read(self) -> None:
        with patch.object(orgtx, 'org_read', boom), \
                patch.object(store, 'load_org', boom):
            self.assertEqual(net._read_hub_of('ns-a', 'm3'), 'hub-2')
            self.assertIsNone(net._read_hub_of('ns-a', 'nope'))
            # steady state: the spool already carries this error -> no write
            net._stamp_skip('ns-a', 'hub-1', 'e1')


class ReadDocSections(unittest.TestCase):
    def test_stored_values_for_present_keys_only(self) -> None:
        org = store.load_org('np-a')
        got = store.read_doc_sections('np-a', ['name', 'net_hubs', 'no_such_key'])
        self.assertEqual(got.get('net_hubs'), org.d.get('net_hubs'))
        self.assertNotIn('no_such_key', got)

    def test_refuses_non_doc_sections(self) -> None:
        for k in ('nodes', 'events', 'mail_log', 'mail'):
            with self.assertRaises(ValueError, msg=k):
                store.read_doc_sections('np-a', [k])


if __name__ == '__main__':
    unittest.main()
