"""Run with tools/run-python-verification.py; no live endpoint is accepted."""
from __future__ import annotations

import importlib
import json
import os
import time
import unittest
import uuid

import import_provenance  # noqa: F401 -- this checkout, including embedded Python


def operation_key():
    # Public protocol spelling; deliberately no import of opreceipts.mint_key.
    return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:24]}"


def find_node(value, node):
    if isinstance(value, dict):
        if value.get("id") == node and "children" in value:
            return value
        for child in value.values():
            found = find_node(child, node)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_node(child, node)
            if found is not None:
                return found
    return None


class WireContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        name = os.environ.get("ORGTREE_WIRE_FACTORY", "tests.wire_contract.python_target:create_target")
        module, function = name.split(":", 1)
        factory = getattr(importlib.import_module(module), function)
        cls.context = factory()
        cls.target = cls.context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)

    def json_response(self, response, status=200):
        self.assertEqual(response.status, status)
        self.assertEqual(response.headers["content-type"].split(";")[0], "application/json")
        return response.json()

    def call(self, tool, args=None, *, auth="caller", org="wire-actions", node="caller", **extra):
        return self.target.http("/api/agent", method="POST", auth=auth, org=org,
                                payload={"org": org, "node": node, "tool": tool,
                                         "args": args or {}, **extra})

    def test_http_authentication_and_live_identity_binding(self):
        for auth, detail in [
            ("none", "missing authentication; provide a desktop or live agent credential"),
            ("bad-operator", "invalid desktop token"),
            ("bad-agent", "agent credential is invalid or expired; reconnect the agent session"),
        ]:
            with self.subTest(auth=auth):
                self.assertEqual(self.json_response(self.call("orgtree_status", auth=auth), 401),
                                 {"detail": detail})
        # The forged identity is an EXISTING live seat at the SAME generation.
        # A missing-seat check cannot make this negative control pass.
        self.assertEqual(self.json_response(self.call("orgtree_status", node="peer"), 403),
                         {"detail": "agent credential identity mismatch"})
        self.assertEqual(self.json_response(self.call("orgtree_status", auth="old", node="old"), 403),
                         {"detail": "agent credential is stale: session generation changed; reconnect this session"})
        forged = self.target.http("/api/agent", method="POST", auth="caller", org="wire-actions",
                                  payload={"org": "wire-other", "node": "caller", "tool": "orgtree_status"})
        self.assertEqual(self.json_response(forged, 403), {"detail": "agent credential identity mismatch"})
        denied = self.target.http("/api/orgs/wire-gallery/documents", auth="caller", org="wire-gallery")
        self.assertEqual(self.json_response(denied, 401),
                         {"detail": "agent credential is invalid or expired; reconnect the agent session"})
        self.assertEqual(self.json_response(self.call("orgtree_status", {"status": "idle"})),
                         {"recorded": "idle"})

    def test_http_validation_and_refusal_shapes(self):
        payload = {"node": "caller", "tool": "orgtree_status"}
        missing = self.target.http("/api/agent", method="POST", payload=payload)
        self.assertEqual(self.json_response(missing, 422), {"detail": [
            {"type": "missing", "loc": ["body", "org"], "msg": "Field required", "input": payload}]})
        malformed = self.target.http("/api/agent", method="POST", raw=b"{")
        self.assertEqual(self.json_response(malformed, 422), {"detail": [
            {"type": "json_invalid", "loc": ["body", 1], "msg": "JSON decode error", "input": {},
             "ctx": {"error": "Expecting property name enclosed in double quotes"}}]})
        self.assertEqual(self.json_response(self.call("orgtree_status", {"summary": []}), 422),
                         {"detail": "summary must be text, not list"})
        self.assertEqual(self.json_response(self.call("wire_unknown"), 422),
                         {"detail": "unknown orgtree tool 'wire_unknown'"})

    def test_http_unhandled_error_is_json(self):
        path = "/api/orgs/wire-fault/documents"
        self.assertEqual(self.json_response(self.target.http(path), 500), {
            "detail": "OSError: synthetic fixture read failure",
            "error": {"type": "OSError", "message": "synthetic fixture read failure",
                      "path": path, "method": "GET", "unhandled": True}})
        # Failure does not kill the process or poison the next request.
        self.assertEqual(self.json_response(self.target.http("/api/orgs/wire-gallery/documents"))["total"], 5)

    def test_document_pagination_order_and_body_boundary(self):
        base = "/api/orgs/wire-gallery/documents"
        first = self.json_response(self.target.http(base + "?limit=2"))
        self.assertEqual(set(first), {"documents", "total", "offset", "located", "next_offset"})
        self.assertEqual({k: v for k, v in first.items() if k != "documents"},
                         {"total": 5, "offset": 0, "located": "", "next_offset": 2})
        second = self.json_response(self.target.http(base + "?limit=2&offset=2"))
        third = self.json_response(self.target.http(base + "?limit=2&offset=4"))
        self.assertEqual([d["id"] for page in [first, second, third] for d in page["documents"]],
                         ["d4", "d3", "d2", "d1", "d0"])
        self.assertEqual((second["next_offset"], third["next_offset"]), (4, None))
        for row in first["documents"]:
            self.assertNotIn("body", row)
            self.assertEqual(row["ref"], f"@doc:wire-gallery/{row['id']}")
        detail = self.json_response(self.target.http(base + "/d4"))
        self.assertEqual(detail, {"id": "d4", "node": "caller", "title": "Synthetic four",
                                 "body": "fixture-4", "at": "2026-01-01T00:00:04Z",
                                 "node_state": "live", "tier": None, "format": "markdown",
                                 "ref": "@doc:wire-gallery/d4"})
        locate = self.json_response(self.target.http(base + "?limit=2&locate=d1"))
        self.assertEqual((locate["offset"], locate["located"]), (2, "d1"))
        filtered = self.json_response(self.target.http(base + "?node=caller"))
        self.assertEqual([d["id"] for d in filtered["documents"]], ["d4", "d2", "d0"])
        self.assertEqual(filtered["total"], 3)
        empty = self.json_response(self.target.http(base + "?offset=99"))
        self.assertEqual(empty, {"documents": [], "total": 5, "offset": 99, "located": "", "next_offset": None})
        self.assertEqual(self.json_response(self.target.http(base + "?locate=absent"), 404),
                         {"detail": "The presented document is no longer available."})

    def test_receipt_replay_conflict_and_single_effect(self):
        args = {"title": "Receipt fixture", "body": "synthetic-receipt-body"}
        epoch = self.json_response(self.call("orgtree_op_epoch"))["epoch"]
        key = operation_key()
        wrapped = {"tool": "orgtree_present", "args": args, "op_key": key, "op_epoch": epoch}
        gallery = "/api/orgs/wire-actions/documents"
        before = self.json_response(self.target.http(gallery))["total"]
        original = self.json_response(self.call("orgtree_op_call", wrapped))
        replay = self.json_response(self.call("orgtree_op_call", wrapped))
        self.assertEqual(set(replay), {"replayed", "op_id", "at", "tool", "outcome", "receipt", "status"})
        self.assertIs(replay["replayed"], True)
        self.assertEqual((replay["tool"], replay["outcome"]), ("orgtree_present", "applied"))
        self.assertEqual(replay["status"], "This operation ALREADY APPLIED — nothing was done again. This is its receipt, not a fresh result: the original result was not kept, and the receipt covers the document transaction only.")
        receipt = replay["receipt"]
        self.assertEqual((receipt["id"], receipt["at"]), (replay["op_id"], replay["at"]))
        self.assertEqual((receipt["node"], receipt["gen"], receipt["key"], receipt["outcome"]),
                         ("caller", 0, key, "applied"))
        self.assertRegex(receipt["fp"], r"^[0-9a-f]{64}$")
        self.assertEqual(receipt["post_effects"]["observed"], "unknown")
        self.assertNotIn(args["body"], json.dumps(receipt))
        after = self.json_response(self.target.http(gallery))
        self.assertEqual(after["total"], before + 1)
        self.assertEqual(sum(d["id"] == original["presented"] for d in after["documents"]), 1)
        self.assertEqual(original["title"], args["title"])
        self.assertEqual(receipt["result"]["presented"], original["presented"])
        lookup = self.json_response(self.call("orgtree_op_lookup", {
            "op_key": key, "op_epoch": epoch, "for_tool": "orgtree_present", "for_args": args}))
        self.assertEqual(lookup["state"], "applied")
        self.assertEqual(lookup["receipt"], receipt)
        conflict = self.call("orgtree_op_call", {**wrapped, "args": {**args, "title": "Different"}})
        self.assertEqual(self.json_response(conflict, 409), {
            "detail": f"op_key conflict: this key already identifies orgtree_present at {receipt['at']}. Nothing was done. Use a fresh key."})
        self.assertEqual(self.json_response(self.target.http(gallery))["total"], before + 1)

    def test_lookup_fences_delayed_call_and_stale_epoch_stays_unknown(self):
        args = {"status": "idle", "summary": "fenced-status"}
        epoch = self.json_response(self.call("orgtree_op_epoch"))["epoch"]
        key = operation_key()
        lookup_args = {"op_key": key, "op_epoch": epoch, "for_tool": "orgtree_status", "for_args": args}
        absent = self.json_response(self.call("orgtree_op_lookup", lookup_args))
        self.assertEqual((absent["state"], absent["fenced"], absent["op_key"]), ("not_applied", True, key))
        repeated = self.json_response(self.call("orgtree_op_lookup", lookup_args))
        self.assertEqual((repeated["state"], repeated["fenced"]), ("not_applied", True))
        refused = self.json_response(self.call("orgtree_op_call", {
            "op_key": key, "op_epoch": epoch, "tool": "orgtree_status", "args": args}), 422)
        self.assertEqual(refused, {"detail": f"op_key refused (fenced): this key was fenced by a lookup at {repeated['at']} — it can no longer be admitted; issue a fresh key. Nothing was done, and whether the original call applied is UNKNOWN — do not treat this as a refusal of the operation itself."})
        stale = self.json_response(self.call("orgtree_op_lookup", {**lookup_args, "op_key": operation_key(),
                                                                              "op_epoch": "obsolete-epoch"}))
        self.assertEqual((stale["state"], stale["reason"], stale["fenced"]), ("unknown", "epoch_rotated", False))
        # A fresh independent intent is still admitted after a fence.
        self.assertEqual(self.json_response(self.call("orgtree_status", {"status": "idle"})), {"recorded": "idle"})

    def test_websocket_authentication_is_handshake_refusal(self):
        from websockets.exceptions import InvalidStatus
        for auth in ("none", "bad-operator", "caller"):
            with self.subTest(auth=auth), self.assertRaises(InvalidStatus) as raised:
                with self.target.websocket(auth=auth):
                    self.fail("unauthorized WebSocket connected")
            # An ASGI close before acceptance becomes HTTP 403 on the real wire.
            self.assertEqual(raised.exception.response.status_code, 403)

    def test_websocket_ordering_and_legacy_reconnect_snapshot(self):
        # Dedicated org: earlier tests cannot leave a pending coalesced frame.
        org = "wire-stream"

        def change(summary):
            self.assertEqual(self.json_response(self.call("orgtree_status", {"status": "idle", "summary": summary}, org=org)),
                             {"recorded": "idle"})

        def frame(socket):
            value = json.loads(socket.recv(timeout=8))
            self.assertEqual(set(value), {"type", "org", "rev"})
            self.assertEqual((value["type"], value["org"]), ("changed", org))
            self.assertIs(type(value["rev"]), int)
            return value

        with self.target.websocket(org=org) as observer:
            with self.target.websocket(org=org) as departing:
                change("connected-a")
                first = frame(observer)
                self.assertEqual(frame(departing), first)
            change("offline-b")
            missed1 = frame(observer)
            change("offline-c")
            missed2 = frame(observer)
            self.assertEqual([missed1["rev"], missed2["rev"]], [first["rev"] + 1, first["rev"] + 2])
            with self.target.websocket(org=org) as reconnected:
                # LEGACY-L3: no snapshot/replay or text-ping acknowledgment.
                reconnected.send("ping")
                with self.assertRaises(TimeoutError):
                    reconnected.recv(timeout=0.2)
                snapshot = self.json_response(self.target.http(f"/api/orgs/{org}"))
                self.assertGreaterEqual(snapshot["sync_rev"], missed2["rev"])
                self.assertEqual(find_node(snapshot, "caller")["last_status"]["summary"], "offline-c")
                change("connected-d")
                latest = frame(observer)
                self.assertEqual(frame(reconnected), latest)
                self.assertGreater(latest["rev"], snapshot["sync_rev"])

    def test_mcp_initialize_list_and_correlation(self):
        with self.target.mcp() as mcp:
            mcp.send({"jsonrpc": "2.0", "id": "init", "method": "initialize",
                      "params": {"protocolVersion": "2024-11-05"}})
            self.assertEqual(mcp.receive(), {"jsonrpc": "2.0", "id": "init", "result": {
                "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "orgtree", "version": "1.0.0"}}})
            mcp.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            mcp.send({"jsonrpc": "2.0", "id": 0, "method": "tools/list"})
            listed = mcp.receive()
            self.assertEqual((listed["jsonrpc"], listed["id"]), ("2.0", 0))
            tools = listed["result"]["tools"]
            names = [tool["name"] for tool in tools]
            self.assertEqual(len(names), len(set(names)))
            self.assertTrue({"orgtree_status", "orgtree_present", "orgtree_work"}.issubset(names))
            status = next(tool for tool in tools if tool["name"] == "orgtree_status")
            self.assertEqual(status["inputSchema"]["type"], "object")

    def test_mcp_success_refusal_and_auth_errors(self):
        def request(mcp, identity, name, args):
            mcp.send({"jsonrpc": "2.0", "id": identity, "method": "tools/call",
                      "params": {"name": name, "arguments": args}})
            answer = mcp.receive()
            self.assertEqual(set(answer), {"jsonrpc", "id", "result"})
            self.assertEqual((answer["jsonrpc"], answer["id"]), ("2.0", identity))
            self.assertEqual(set(answer["result"]), {"content", "isError"})
            self.assertEqual(len(answer["result"]["content"]), 1)
            self.assertEqual(answer["result"]["content"][0]["type"], "text")
            return answer["result"]["isError"], json.loads(answer["result"]["content"][0]["text"])

        with self.target.mcp() as mcp:
            self.assertEqual(request(mcp, 10, "orgtree_status", {"status": "idle"}), (False, {"recorded": "idle"}))
            self.assertEqual(request(mcp, 11, "wire_unknown", {}),
                             (True, {"detail": "unknown orgtree tool 'wire_unknown'"}))
            self.assertEqual(request(mcp, 12, "orgtree_status", {"summary": []}),
                             (True, {"detail": "summary must be text, not list"}))
        for auth, node, detail in [
            ("none", "caller", "missing authentication; provide a desktop or live agent credential"),
            ("caller", "peer", "agent credential identity mismatch"),
            ("old", "old", "agent credential is stale: session generation changed; reconnect this session"),
        ]:
            with self.subTest(auth=auth, node=node), self.target.mcp(auth=auth, node=node) as mcp:
                self.assertEqual(request(mcp, "denied", "orgtree_chart", {}), (True, {"detail": detail}))

    def test_legacy_mcp_ignored_frames_and_unknown_method(self):
        # LEGACY-L1/L2: characterize current leniency, not normative JSON-RPC.
        before = self.json_response(self.target.http("/api/orgs/wire-other"))
        with self.target.mcp(org="wire-other") as mcp:
            for line in ("{", "null", "[]", "5"):
                mcp.send_raw(line)
            mcp.send({"jsonrpc": "2.0", "method": "tools/call",
                      "params": {"name": "orgtree_status", "arguments": {"status": "idle", "summary": "ignored-notification"}}})
            mcp.send({"jsonrpc": "2.0", "id": "barrier", "method": "unknown-method", "params": []})
            self.assertEqual(mcp.receive(), {"jsonrpc": "2.0", "id": "barrier", "result": {}})
            mcp.send({"jsonrpc": "2.0", "id": 22, "method": "initialize", "params": {"protocolVersion": "future-unnegotiated"}})
            result = mcp.receive()
            self.assertEqual(result["id"], 22)
            self.assertEqual(result["result"]["protocolVersion"], "future-unnegotiated")
        after = self.json_response(self.target.http("/api/orgs/wire-other"))
        self.assertEqual(find_node(before, "caller")["last_status"], find_node(after, "caller")["last_status"])


if __name__ == "__main__":
    unittest.main()
