"""Sender feedback when a message targets a node that cannot read it.

THE DEFECT THIS PINS (docket: notify-senders-about-unavailable-node-targets).
A send to a HALTED, a RETIRED or a NONEXISTENT node used to be reported to the
sender three different degrees of badly, and none of them let the sender act:

  * halted   — answered, but the sentence said "mail is preserved unread" and
               never said the message was durably QUEUED, so "preserved" read
               as an internal detail rather than a delivery outcome.
  * retired  — answered with NOTHING. `delivery` is composed at the drive loop
               and an archived node is deliberately never driven, so the whole
               reply was `{"delivered": "x", "deferred": true}` — the same
               shape a successful send wears, told apart by one bare boolean.
  * invalid  — answered with `no such node: 'x'`, which reads as a naming
               complaint, not as "nothing was stored and nobody will ever
               read this".

The three outcomes are GENUINELY DIFFERENT and the point of this suite is that
they stay different. Halted and retired are ACCEPTED-BUT-DEFERRED: the mail is
durable in the recipient's mailbox and one named event (an unhalt, a rehire)
would produce a reader. Invalid and unrecoverable are REFUSALS: nothing is
stored at all. A suite that only asserted "the sender was warned" would pass
with all three collapsed into one vague sentence, so every case below asserts
the DISTINGUISHING claim and §8 asserts the three never converge.

And the common case must stay quiet: §1 pins that ordinary mail to a live
agent gains no warning and no unavailability wording.

    python -B tests/test_unavailable_target_notice.py
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
# `engine`/`orgtree`. First on sys.path wins.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / 'engine' / 'backend'))
sys.path.insert(0, str(_ROOT))

# ORGTREE_DATA BEFORE the first orgtree import: store.DATA_ROOT binds at
# import time; the assert below is the proof.
fx = tempfile.TemporaryDirectory(prefix='unavail-target-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'unavailable-target-suite'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                             # noqa: E402
load_app()
from orgtree import store, ledger, halt, supervisor as sup     # noqa: E402
from orgtree import api                                        # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'
assert Path(api.__file__).resolve().is_relative_to(_ROOT), \
    'another checkout shadowed this one — the suite would test the wrong code'

slugs = []


def tearDownModule():
    for s in slugs:
        try:
            store._POOL.close_all(s)
        except Exception:                                        # noqa: BLE001
            pass


class _ReqState:
    agent_identity = None
    bridge_slug = None


class _Req:
    """The only two attributes `agent_identity` reads off a Request."""
    def __init__(self):
        self.state = _ReqState()


class UnavailableTarget(unittest.TestCase):
    def setUp(self):
        slug = 'unav-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.slug = slug
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'boss')
        for name in ('alive', 'gone', 'stopped', 'broken', 'stranger'):
            org.hire(ledger.USER, 'boss', 'haiku', 0, name)
        store.save_org(org)
        org = store.load_org(slug)
        org.retire(ledger.USER, 'gone')
        org.mark_unrecoverable('broken', 'probe')
        store.save_org(org)
        # no real provider process may start, and no desktop notification may
        # fire, for any send in this file
        self.patches = [patch.object(sup, '_start_turn_worker'),
                        patch.object(sup, 'notify')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    # ---- helpers --------------------------------------------------------
    def call(self, node, tool, args):
        body = api.AgentCall(org=self.slug, node=node, tool=tool, args=args)
        return api.agent_call(body, _Req())

    def refusal(self, node, tool, args):
        """The refusal text of a send that must not be accepted."""
        with self.assertRaises(api.HTTPException) as cm:
            self.call(node, tool, args)
        return str(cm.exception.detail)

    def send(self, to, body='hello', node='boss', tool='orgtree_message'):
        return self.call(node, tool, {'to': to, 'body': body})

    def mailbox(self, nid):
        return [m for m in (store.load_org(self.slug).d.get('mail') or {}).get(nid, [])]

    def bodies_anywhere(self):
        box = store.load_org(self.slug).d.get('mail') or {}
        return [m.get('body') for ms in box.values() for m in ms]

    # ---- §1 the common case stays silent --------------------------------
    def test_live_recipient_gains_no_unavailability_wording(self):
        r = self.send('alive')
        self.assertFalse(r.get('deferred'))
        self.assertEqual(r.get('recipient_state'), 'live')
        self.assertEqual(r.get('warnings'), [])
        note = r['delivery']
        for shout in ('NOT DELIVERED', 'QUEUED, NOT READ', 'rehire',
                      'unhalt', 'undelivered'):
            self.assertNotIn(shout, note, f'live mail must not mention {shout!r}')
        # …and it still says what really happened to it (D-236 is untouched)
        self.assertIn('alive', note)
        self.assertEqual(len(self.mailbox('alive')), 1)

    # ---- §2 halted: accepted, durable, and it names the ONE release ------
    def test_halted_recipient_is_told_queued_and_deferred_until_unhalt(self):
        halt.halt(self.slug, 'stopped')
        r = self.send('stopped', 'for a halted node')
        note = r['delivery']
        # the sender is told it was ACCEPTED, not refused …
        self.assertIn('QUEUED', note)
        self.assertIn('not a failed one', note)
        # … which event releases it …
        self.assertIn('orgtree_unhalt', note)
        self.assertIn('halted', note)
        self.assertIn('stopped', note)
        # … and it must not be described as a rehire case
        self.assertNotIn('rehire', note)
        # the durability claim is TRUE: the mail really is in the mailbox
        self.assertIn('for a halted node',
                      [m['body'] for m in self.mailbox('stopped')])

    def test_halted_notice_says_notice_not_message(self):
        halt.halt(self.slug, 'stopped')
        r = self.send('stopped', 'fyi', tool='orgtree_send_notice')
        self.assertIn('notice', r['delivery'])
        self.assertIn('orgtree_unhalt', r['delivery'])

    # ---- §3 retired: queued FOR a rehire, promising nothing -------------
    def test_retired_recipient_gets_a_delivery_sentence_at_all(self):
        r = self.send('gone', 'for a retired node')
        self.assertTrue(r.get('deferred'))
        self.assertEqual(r.get('recipient_state'), 'archived')
        # THE REGRESSION GUARD: this field did not exist on this branch
        note = r['delivery']
        self.assertIn('retired', note)
        self.assertIn('gone', note)
        self.assertIn('QUEUED', note)
        self.assertIn('rehire', note)
        # the promise stays CONDITIONAL — nothing schedules a rehire
        self.assertIn('Nothing schedules a rehire', note)
        self.assertIn('undelivered', note)
        self.assertNotIn('unhalt', note)
        self.assertIn('for a retired node',
                      [m['body'] for m in self.mailbox('gone')])

    def test_retired_recipient_is_not_driven(self):
        """The note must not be bought by waking an archived node."""
        with patch.object(sup, 'send_message') as sm:
            r = self.send('gone')
        self.assertIn('rehire', r['delivery'])
        for c in sm.call_args_list:
            self.assertNotEqual(c.args[1] if len(c.args) > 1 else None, 'gone',
                                'an archived node must never be driven')

    def test_retired_notice_says_a_rehire_alone_will_not_deliver_it(self):
        r = self.send('gone', 'fyi', tool='orgtree_send_notice')
        note = r['delivery']
        self.assertIn('notice', note)
        self.assertIn('rehire ALONE still will not deliver it', note)
        # the message form makes the STRONGER claim; the two must not be equal
        self.assertNotEqual(note, self.send('gone', 'x')['delivery'])

    # ---- §4 invalid: a refusal, and nothing anywhere ---------------------
    def test_invalid_target_reports_a_failed_send_and_stores_nothing(self):
        text = self.refusal('boss', 'orgtree_message',
                            {'to': 'nobody-by-that-name', 'body': 'lost'})
        self.assertIn('NOT DELIVERED', text)
        self.assertIn('NOTHING WAS QUEUED', text)
        self.assertIn('failed send, not a deferred one', text)
        self.assertIn('nobody-by-that-name', text)
        # no rehire/unhalt promise may appear — there is no reader to wait for
        self.assertNotIn('rehire ', text)
        self.assertNotIn('orgtree_unhalt', text)
        # and the refusal really did store nothing, in ANY mailbox
        self.assertNotIn('lost', self.bodies_anywhere())

    def test_invalid_target_refusal_does_not_enumerate_the_org(self):
        """Naming the target is required; listing the roster is a leak."""
        text = self.refusal('boss', 'orgtree_message',
                            {'to': 'nobody-by-that-name', 'body': 'lost'})
        for member in ('alive', 'gone', 'stopped', 'broken', 'stranger'):
            self.assertNotIn(member, text)

    def test_unrecoverable_target_is_a_refusal_not_a_deferral(self):
        text = self.refusal('boss', 'orgtree_message',
                            {'to': 'broken', 'body': 'lost'})
        self.assertIn('NOT DELIVERED', text)
        self.assertIn('NOTHING WAS QUEUED', text)
        self.assertIn('broken', text)
        self.assertNotIn('rehire', text)
        self.assertNotIn('lost', self.bodies_anywhere())

    # ---- §5 authorization is unchanged, and still refuses first ----------
    def test_unauthorized_target_keeps_its_route_refusal_and_stores_nothing(self):
        text = self.refusal('alive', 'orgtree_message',
                            {'to': 'stranger-child', 'body': 'lost'})
        # 'stranger-child' is no node at all, so this is the invalid path …
        self.assertIn('NOT DELIVERED', text)
        # … while a REAL node the sender may not address keeps §7.2 verbatim
        org = store.load_org(self.slug)
        org.hire(ledger.USER, 'stranger', 'haiku', 0, 'nephew')
        store.save_org(org)
        text = self.refusal('alive', 'orgtree_message',
                            {'to': 'nephew', 'body': 'lost'})
        self.assertIn('may not address', text)
        self.assertIn('§7.2', text)
        self.assertNotIn('QUEUED', text)
        self.assertNotIn('lost', self.bodies_anywhere())

    def test_an_unavailable_target_is_still_authorization_checked_first(self):
        """A retired node the sender may not address refuses as a route
        problem — the deferral note must never become a way to learn that an
        unreachable name is a real archived agent."""
        org = store.load_org(self.slug)
        org.hire(ledger.USER, 'stranger', 'haiku', 0, 'niece')
        store.save_org(org)
        org = store.load_org(self.slug)
        org.retire(ledger.USER, 'niece')
        store.save_org(org)
        text = self.refusal('alive', 'orgtree_message',
                            {'to': 'niece', 'body': 'lost'})
        self.assertIn('may not address', text)
        self.assertNotIn('QUEUED', text)
        self.assertNotIn('archived', text)

    # ---- §6 lifecycle races ---------------------------------------------
    def test_retiring_between_store_and_drive_reports_the_retirement(self):
        """post_mail sees a LIVE node; the node retires before the drive. The
        carrier — not the stale post_mail answer — is what the sender is told."""
        org = store.load_org(self.slug)
        r = org.post_mail('boss', 'alive', 'racing')
        store.save_org(org)
        self.assertFalse(r['deferred'])                 # live at store time
        org = store.load_org(self.slug)
        org.retire(ledger.USER, 'alive')
        store.save_org(org)
        carrier = sup.send_message(self.slug, 'alive', '(orgtree) mail',
                                   mail_ping=True, sender='boss')
        note = sup.delivery_note(self.slug, 'alive', carrier)
        self.assertIn('retired', note)
        self.assertIn('rehire', note)
        self.assertIn('QUEUED', note)
        # and the durability claim survived the transition
        self.assertIn('racing', [m['body'] for m in self.mailbox('alive')])

    def test_rehiring_after_a_deferred_send_keeps_the_mail(self):
        """The other direction: the sender was told 'queued for a rehire', and
        the rehire really does find the mail still there."""
        r = self.send('gone', 'kept across a rehire')
        self.assertIn('rehire', r['delivery'])
        org = store.load_org(self.slug)
        org.rehire(ledger.USER, 'gone')
        store.save_org(org)
        self.assertEqual(store.load_org(self.slug).node('gone')['state'], 'live')
        self.assertIn('kept across a rehire',
                      [m['body'] for m in self.mailbox('gone')])

    def test_halting_between_store_and_drive_reports_the_halt(self):
        org = store.load_org(self.slug)
        org.post_mail('boss', 'alive', 'racing a halt')
        store.save_org(org)
        halt.halt(self.slug, 'alive')
        carrier = sup.send_message(self.slug, 'alive', '(orgtree) mail',
                                   mail_ping=True, sender='boss')
        note = sup.delivery_note(self.slug, 'alive', carrier)
        self.assertIn('orgtree_unhalt', note)
        self.assertNotIn('rehire', note)
        self.assertIn('racing a halt', [m['body'] for m in self.mailbox('alive')])

    # ---- §7 the user is a sender too ------------------------------------
    def test_user_mail_to_a_retired_node_gets_the_same_sentence(self):
        body = api.Message(text='from the user')
        out = api.node_message(self.slug, 'gone', body, _Req())
        self.assertTrue(out['deferred'])
        self.assertIn('rehire', out['delivery'])
        self.assertIn('QUEUED', out['delivery'])

    # ---- §8 the three outcomes never converge ---------------------------
    def test_halted_retired_and_invalid_stay_three_distinct_answers(self):
        halt.halt(self.slug, 'stopped')
        halted = self.send('stopped', 'a')['delivery']
        retired = self.send('gone', 'b')['delivery']
        invalid = self.refusal('boss', 'orgtree_message',
                               {'to': 'no-such-agent', 'body': 'c'})
        self.assertEqual(len({halted, retired, invalid}), 3)
        # each names the release its own state actually has, and no other's
        self.assertIn('unhalt', halted)
        self.assertNotIn('unhalt', retired)
        self.assertNotIn('unhalt', invalid)
        self.assertIn('rehire', retired)
        self.assertNotIn('rehire', halted)
        # only the refusal claims nothing was stored
        self.assertIn('NOTHING WAS QUEUED', invalid)
        self.assertNotIn('NOTHING WAS QUEUED', halted)
        self.assertNotIn('NOTHING WAS QUEUED', retired)


if __name__ == '__main__':
    unittest.main(verbosity=2)
