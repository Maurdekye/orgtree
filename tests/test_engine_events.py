import os
import sys
import unittest
from types import SimpleNamespace


os.environ.setdefault("ORGTREE_DATA", os.path.join(os.path.dirname(__file__), ".data"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

from orgtree import supervisor  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
