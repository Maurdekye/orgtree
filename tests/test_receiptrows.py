"""Receipt conversion refuses data loss before any storage marker is published."""
import copy
import dataclasses
import json
import unittest

from orgtree import receiptrows as rows


def receipt(owner, operation, token):
    return {"node": owner, "operation": operation, "identity": [None, 0, "session"],
            "outcome": "confirmed", "before": {token: "a" * 64},
            "extension": {"precise": 1.0, "flag": True, "note": "עברית"}}


class ReceiptCodec(unittest.TestCase):
    def setUp(self):
        self.value = {"z": {"op2": receipt("z", "op2", "shared"), "op1": receipt("z", "op1", "one")},
                      "empty": {}, "a": {"op2": receipt("a", "op2", "shared")}}
        self.converted = rows.split(json.dumps(self.value))

    def test_exact_round_trip_and_owner_operation_order(self):
        result = rows.assemble(self.converted)
        self.assertEqual(result, self.value)
        self.assertEqual(list(result), list(self.value))
        self.assertEqual(list(result["z"]), ["op2", "op1"])
        self.assertIs(type(result["z"]["op2"]["extension"]["precise"]), float)
        self.assertEqual(rows.verify(self.converted)["receipts"], 3)

    def test_absent_empty_and_empty_owner_distinct(self):
        values = [rows.split(None), rows.split("{}"), rows.split('{"empty":{}}')]
        self.assertEqual(len({v.checksum for v in values}), 3)
        for value in values:
            rows.verify(value)

    def test_lost_receipt_is_refused(self):
        with self.assertRaises(rows.Unsupported):
            rows.verify(dataclasses.replace(self.converted, receipts=self.converted.receipts[:-1]))

    def test_missing_owner_is_refused(self):
        with self.assertRaises(rows.Unsupported):
            rows.verify(dataclasses.replace(self.converted, owners=self.converted.owners[:-1]))

    def test_cross_owner_receipt_is_refused(self):
        first = self.converted.receipts[0]
        corrupt = ("a", *first[1:])
        with self.assertRaises(rows.Unsupported):
            rows.verify(dataclasses.replace(self.converted, receipts=(corrupt, *self.converted.receipts[1:])))

    def test_duplicate_row_is_refused(self):
        with self.assertRaises(rows.Unsupported):
            rows.verify(dataclasses.replace(self.converted, receipts=self.converted.receipts + self.converted.receipts[:1]))

    def test_carrier_lookup_keeps_owner_boundary(self):
        self.assertIn(("a", "shared", "op2"), self.converted.carriers)
        self.assertIn(("z", "shared", "op2"), self.converted.carriers)
        with self.assertRaises(rows.Unsupported):
            rows.verify(dataclasses.replace(self.converted, carriers=self.converted.carriers[:-1]))

    def test_unknown_shapes_refuse_without_mutation(self):
        bad = [None, [], {"z": None}, {"z": []}, {"": {}}, {"z": {"op": []}}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(rows.Unsupported):
                rows.split(json.dumps(value))
        for field, value in [("node", "another"), ("operation", "another"),
                             ("outcome", "unknown"), ("identity", []), ("before", []),
                             ("before", {"x": "not-a-digest"})]:
            source = copy.deepcopy(self.value); source["z"]["op2"][field] = value
            frozen = copy.deepcopy(source)
            with self.subTest(field=field, value=value), self.assertRaises(rows.Unsupported):
                rows.split(json.dumps(source))
            self.assertEqual(source, frozen)

    def test_ambiguous_json_is_refused(self):
        for text in ['{"a":{},"a":{}}', '{"a":NaN}', '{"a":Infinity}', 'broken']:
            with self.subTest(text=text), self.assertRaises(rows.Unsupported):
                rows.split(text)

    def test_changed_extension_is_caught_by_checksum(self):
        owner, token, ordinal, text = self.converted.receipts[0]
        value = json.loads(text); value["extension"]["note"] = "changed"
        corrupt = (owner, token, ordinal, rows.dumps(value))
        with self.assertRaises(rows.Unsupported):
            rows.verify(dataclasses.replace(self.converted, receipts=(corrupt, *self.converted.receipts[1:])))


    def test_ordinal_gaps_after_authorized_deletion_preserve_order(self):
        gapped=dataclasses.replace(self.converted,
            owners=tuple((owner,ordinal*10+2) for owner,ordinal in self.converted.owners),
            receipts=tuple((owner,token,ordinal*10+2,text) for owner,token,ordinal,text in self.converted.receipts))
        self.assertEqual(rows.assemble(gapped),self.value)
        self.assertEqual(rows.verify(gapped),rows.verify(self.converted))


if __name__ == "__main__":
    unittest.main()
