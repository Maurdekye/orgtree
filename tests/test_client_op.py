"""client_op — the composer's pre-send name for a mail submission.

THE DEFECT THIS PINS (user report 2026-09-13: "agent messages are not doubled
anymore, but my own user messages still double up"). A desk send paints an
optimistic bubble, then POSTs; its only identity link to the durable copy —
the mail id — arrives WITH the response. The server announces the stored mail
before it answers the sender, so a poll routinely shows the typed pending row
while the POST is still in flight, and the unbound bubble cannot recognize it:
the one submission renders twice for the whole round trip. The fix lets the
composer mint the submission's own name BEFORE sending (`client_op`); the
server stores it on the mail entry, and every projection the desk reads —
pending rows, mail segment rows — carries it, so the very first payload
showing the durable copy identifies it to the sender. Identity, never body:
two identical texts from two submissions carry two different names.

Sections drive the REAL doors: ledger.post_mail, api.node_chat,
supervisor._mail_segments (the composer whose rows become turn envelopes and
steered_log segments), events.wire_segments, and api.node_message end-to-end
with only the turn spawn stubbed.

    python -B tests/test_client_op.py
"""
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

# THIS CHECKOUT'S code, not whatever PYTHONPATH points at: the desktop-managed
# environment prepends the live checkout, which silently shadows a worktree's
# `engine`/`orgtree` and makes every new-surface test fail as "unexpected
# keyword". First on sys.path wins.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / 'engine' / 'backend'))
sys.path.insert(0, str(_ROOT))

# ORGTREE_DATA BEFORE the first orgtree import: store.DATA_ROOT binds at
# import time; the assert below is the proof.
fx = tempfile.TemporaryDirectory(prefix='client-op-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'client-op-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app          # noqa: E402
load_app()
from orgtree import store, ledger, events, supervisor as sup  # noqa: E402
from orgtree import api                                       # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'
assert Path(api.__file__).resolve().is_relative_to(_ROOT), \
    'another checkout shadowed this one — the suite would test the wrong code'

slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


class ClientOp(unittest.TestCase):
    def setUp(self):
        slug = 'cop-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        store.save_org(self.org)
        self.slug = slug

    def entry(self, mid):
        org = store.load_org(self.slug)
        return next(m for m in (org.d.get('mail') or {}).get('agent', [])
                    if m.get('id') == mid)

    def test_post_mail_stores_the_submissions_name_verbatim(self):
        r = self.org.post_mail(ledger.USER, 'agent', 'hello there', typed=True,
                               client_op='op-abc123')
        store.save_org(self.org)
        self.assertEqual(self.entry(r['id']).get('client_op'), 'op-abc123')
        # …and the full-body archive copy carries it too
        org = store.load_org(self.slug)
        logged = next(m for m in org.d['mail_log']['agent'] if m['id'] == r['id'])
        self.assertEqual(logged.get('client_op'), 'op-abc123')

    def test_a_send_without_a_name_stores_none(self):
        r = self.org.post_mail(ledger.USER, 'agent', 'unnamed', typed=True)
        store.save_org(self.org)
        self.assertNotIn('client_op', self.entry(r['id']))

    def test_a_system_leaf_send_carries_it_too(self):
        # the reply routes post with ev=<minted leaf> and an empty body — the
        # same post_mail door the target branch of node_message uses
        ev = events.mint('reply.document', ledger.actor_of(ledger.USER),
                         {'kind': 'document', 'org': self.slug, 'id': 'd1',
                          'title': 'T', 'node': 'agent'},
                         body='the reply body')
        r = self.org.post_mail(ledger.USER, 'agent', '', ev=ev,
                               client_op='op-reply-1')
        store.save_org(self.org)
        self.assertEqual(self.entry(r['id']).get('client_op'), 'op-reply-1')

    def test_node_chat_pending_rows_carry_it(self):
        self.org.post_mail(ledger.USER, 'agent', 'queued msg', typed=True,
                           client_op='op-pending-7')
        store.save_org(self.org)
        out = api.node_chat(self.slug, 'agent', request=None, last=10)
        row = next(m for m in out['pending_mail'] if m.get('client_op'))
        self.assertEqual(row['client_op'], 'op-pending-7')
        self.assertEqual(row['body'], 'queued msg')

    def test_the_envelope_composer_and_wire_projection_keep_it(self):
        r = self.org.post_mail(ledger.USER, 'agent', 'enveloped msg', typed=True,
                               client_op='op-seg-9')
        store.save_org(self.org)
        segs = sup._mail_segments([self.entry(r['id'])])
        rows = [row for s in segs if s.get('kind') == 'mail' for row in s['rows']]
        self.assertEqual(rows[0].get('client_op'), 'op-seg-9',
                         'journal_row must keep the name the composer read')
        for public in (False, True):
            wire = events.wire_segments(segs, public=public)
            wrows = [row for s in wire if s.get('kind') == 'mail' for row in s['rows']]
            self.assertEqual(wrows[0].get('client_op'), 'op-seg-9',
                             f'wire projection (public={public}) must keep it')

    def test_node_message_end_to_end_and_the_length_refusal(self):
        sent = {'accepted': True, 'queued': 0}
        with patch.object(sup, 'send_message', return_value=dict(sent)), \
             patch.object(sup, 'delivery_note', return_value=''):
            out = api.node_message(self.slug, 'agent',
                                   api.Message(text='over the wire',
                                               client_op='op-http-1'),
                                   request=None)
            self.assertTrue(out.get('id'))
            self.assertEqual(self.entry(out['id']).get('client_op'), 'op-http-1')
            # bounded and REFUSED, never truncated: a silently cut name would
            # never match the bubble carrying the full one
            with self.assertRaises(api.HTTPException) as ctx:
                api.node_message(self.slug, 'agent',
                                 api.Message(text='too long',
                                             client_op='x' * 129),
                                 request=None)
            self.assertEqual(ctx.exception.status_code, 422)
            self.assertIn('128', str(ctx.exception.detail))
            # …and the whole refusal happened before anything was written
            org = store.load_org(self.slug)
            bodies = [m['body'] for m in (org.d.get('mail') or {}).get('agent', [])]
            self.assertNotIn('too long', bodies)


if __name__ == '__main__':
    unittest.main(verbosity=2)
