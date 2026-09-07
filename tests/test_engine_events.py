import os
import sys
import unittest
import tempfile
from unittest.mock import patch
from types import SimpleNamespace


_data = tempfile.TemporaryDirectory(prefix="v2-events-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

from orgtree import supervisor, ledger  # noqa: E402


class EventIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.org = SimpleNamespace(
            d={"slug": "fixture"},
            node=lambda _nid: SimpleNamespace(get=lambda key: 3 if key == "generation" else None),
        )

    def test_identical_legacy_rows_do_not_alias(self) -> None:
        base = {"role": "assistant", "text": "same", "ts": None}
        first = supervisor._stable_event_id(self.org, "agent", {
            **base, "_source_id": "record:1"})
        second = supervisor._stable_event_id(self.org, "agent", {
            **base, "_source_id": "record:2"})
        self.assertNotEqual(first, second)

    def test_private_source_id_is_not_public(self) -> None:
        row = supervisor._public_row({"text": "x", "_source_id": "record:1"})
        self.assertNotIn("_source_id", row)

    def test_changed_record_cannot_resolve_saved_reference(self):
        row = {"role":"assistant", "text":"original", "_source_id":"record:3"}
        saved = supervisor._stable_event_id(self.org, "agent", row)
        self.assertEqual(saved, supervisor._stable_event_id(self.org, "agent", dict(row)))
        changed = supervisor._stable_event_id(self.org, "agent", {**row, "text":"different"})
        self.assertNotEqual(saved, changed)
        ref = {"org":"fixture", "agent":"agent", "generation":3, "eventId":saved}
        with patch.object(supervisor, 'read_chat', return_value={"messages":[{"event_id":saved,"text":"original"}]}):
            self.assertEqual(supervisor.resolve_chat_event(self.org, 'agent', ref)[1], 'original')
        with patch.object(supervisor, 'read_chat', return_value={"messages":[{"event_id":changed,"text":"different"}]}):
            with self.assertRaises(ledger.LedgerError):
                supervisor.resolve_chat_event(self.org, 'agent', ref)
        with patch.object(supervisor, 'read_chat', return_value={"messages":[]}):
            with self.assertRaises(ledger.LedgerError):
                supervisor.resolve_chat_event(self.org, 'agent', ref)

    def test_refusals_are_domain_errors(self):
        valid = {"org":"fixture", "agent":"agent", "generation":3, "eventId":"missing"}
        for ref in (None, {}, {**valid,'org':'foreign'}, {**valid,'agent':'foreign'},
                    {**valid,'generation':None}, {**valid,'generation':0}, {**valid,'eventId':''}):
            with self.subTest(ref=ref), self.assertRaises(ledger.LedgerError):
                supervisor.resolve_chat_event(self.org, 'agent', ref)

    def test_empty_event_reply_preserves_generation_zero(self):
        org = ledger.Org.create('fixture')
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        ref = {"org":"fixture", "agent":"agent", "generation":0, "eventId":"event-one"}
        org.post_mail(ledger.USER, 'agent', 'reply', reply_to={
            'source_event_ref':ref, 'quoted_context':'', 'gist':''})
        stored = org.d['mail']['agent'][-1]['reply_to']
        self.assertEqual(stored['source_event_ref'], ref)
        self.assertEqual(stored['quoted_context'], '')


if __name__ == "__main__":
    unittest.main()
