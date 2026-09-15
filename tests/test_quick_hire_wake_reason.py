"""The Quick Hire wake-reason failure and its whole class, measured end to end.

THE MEASURED DEFECT (user report, 2026-09-15). Quick Hire on a backlogged
ticket moved it to Open, posted the staffing request, answered 200 — and then
the RECIPIENT's turn died before the CLI launched with

    bad_literal at reason (expected literal[user_mail|agent_mail|...])

`api.quick_staff_select` stated `ping_reason="quick_staff"` and the event table
never listed it, so the nudge composed fine at the send and failed on the other
agent's turn-start thread, minutes later. No agent was hired, the ticket sat
falsely at Open, the request sat unread, and nothing told the user.

THE CLASS, not the instance: `api.node_unstick` states `ping_reason="unstuck"`
and was never listed either. §2 is the test that closes it — every reason any
send site in the engine states has to be one the table can type.

Every section carries its own control, because each of these assertions is
the kind that reads green for the wrong reason: a mint that never could have
failed, a ticket that is backlogged because nothing ran, a retry that looks
idempotent because the first attempt did nothing either.
"""
import ast
import copy
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="qh-wake-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="qh-wake-tests")
from engine.launch import load_app
app, *_ = load_app()
from fastapi.testclient import TestClient
from orgtree import (api, appsettings, events, events_table, ledger,
                     quickstaff, store, supervisor)

HEADERS = {"X-Orgtree-Desktop-Token": "qh-wake-tests"}
REPO_ROOT = Path(__file__).resolve().parents[1]
ENGINE = REPO_ROOT / "engine" / "backend" / "orgtree"
ACCEPTED = {"accepted": True, "queued": 0}


def _mint(reason):
    """The exact line `supervisor._ping_drive` runs, with the table's own guard
    left out — this is what the engine did before the fix, so it is the only
    call in this file that can still reproduce the original failure."""
    return events.mint("context.drive_mail_pointer", supervisor._SYSTEM_ACTOR,
                       {"kind": "node", "org": "o", "id": "n", "name": "n",
                        "generation": 1},
                       text="(orgtree) You have new mail above.", reason=reason)


class ReasonTableTests(unittest.TestCase):
    """§1/§2 — the typed reason boundary itself."""

    def test_every_reason_the_table_lists_mints_and_an_unlisted_one_does_not(self):
        for reason in events_table.DRIVE_MAIL_POINTER_REASONS:
            with self.subTest(reason=reason):
                self.assertEqual(_mint(reason)["reason"], reason)
        self.assertIsNone(_mint(None)["reason"])
        # ⚠ INSTRUMENT CONTROL. Without this the section above proves only that
        # `mint` accepts things, not that it discriminates — and the whole
        # defect was a value it did discriminate against. This is the field
        # error, character for character.
        with self.assertRaises(events.EventInvalid) as caught:
            _mint("not_a_reason")
        self.assertIn("bad_literal at reason", str(caught.exception))
        self.assertIn("quick_staff", str(caught.exception))

    def test_the_two_reasons_that_failed_in_the_field_are_typeable(self):
        for reason in ("quick_staff", "unstuck"):
            with self.subTest(reason=reason):
                self.assertIn(reason, events_table.DRIVE_MAIL_POINTER_REASONS)
                self.assertEqual(_mint(reason)["reason"], reason)

    def test_no_send_site_in_the_engine_states_an_untypeable_reason(self):
        """§2 — THE CLASS. Both field failures were a call site stating a reason
        the table did not carry, and nothing anywhere compared the two lists.
        This reads every `ping_reason=` the engine actually ships."""
        found = self._stated_reasons()
        # the scan has to SEE the known sites, or an empty result would pass
        self.assertIn("quick_staff", found)
        self.assertIn("unstuck", found)
        self.assertGreaterEqual(len(found), 10, found)
        unknown = sorted(found - set(events_table.DRIVE_MAIL_POINTER_REASONS))
        self.assertEqual(unknown, [], "send sites state reasons the event "
                         f"table cannot type: {unknown}")

    def test_the_scan_control_finds_a_reason_that_is_not_in_the_table(self):
        """CONTROL for the scan above: planted text is found and reported. A
        scan that silently matched nothing would make §2 unconditionally green,
        which is the exact shape of the bug it is guarding. Both spellings are
        planted — the literal, and the named constant `api.quick_staff_select`
        actually uses, which a plain text search does NOT resolve."""
        planted = self._stated_reasons(extra=(
            'PLANTED_REASON = "planted_constant"\n'
            'def f():\n'
            '    send_message(s, n, t, ping_reason="planted_literal")\n'
            '    send_message(s, n, t, ping_reason=PLANTED_REASON)\n'))
        self.assertIn("planted_literal", planted)
        self.assertIn("planted_constant", planted)
        for name in ("planted_literal", "planted_constant"):
            self.assertNotIn(name, events_table.DRIVE_MAIL_POINTER_REASONS)

    def _stated_reasons(self, extra=""):
        """Every value any `ping_reason=` keyword in the engine can take.

        ⚠ PARSED, NOT GREPPED, and that is load-bearing: the Quick Hire site
        passes a module constant (`ping_reason=QUICK_STAFF_PING_REASON`) and a
        text search for a quoted literal walks straight past it — which is how
        a scan meant to catch this class would have missed the very site that
        caused it. Constants are resolved from the module's own top level; a
        conditional is followed down both arms; anything genuinely dynamic is
        skipped rather than guessed at."""
        sources = [p.read_text(encoding="utf-8")
                   for p in sorted(ENGINE.glob("*.py"))]
        if extra:
            sources.append(extra)
        found = set()
        for src in sources:
            tree = ast.parse(src)
            consts = {t.id: n.value.value
                      for n in tree.body if isinstance(n, ast.Assign)
                      for t in n.targets
                      if isinstance(t, ast.Name) and isinstance(n.value, ast.Constant)
                      and isinstance(n.value.value, str)}
            consts.update({n.target.id: n.value.value
                           for n in tree.body if isinstance(n, ast.AnnAssign)
                           and isinstance(n.target, ast.Name)
                           and isinstance(n.value, ast.Constant)
                           and isinstance(n.value.value, str)})

            def values(node):
                if isinstance(node, ast.Constant):
                    return [node.value] if isinstance(node.value, str) else []
                if isinstance(node, ast.Name) and node.id in consts:
                    return [consts[node.id]]
                if isinstance(node, ast.IfExp):
                    return values(node.body) + values(node.orelse)
                return []

            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                for kw in node.keywords:
                    if kw.arg == "ping_reason":
                        found.update(values(kw.value))
        return found


class SendDoorTests(unittest.TestCase):
    """§3 — the door refuses what the table cannot type, and composition never
    dies of it."""

    def setUp(self):
        self.org = ledger.Org.create("qhd-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"] = {"haiku": 1}
        self.nid = self.org.hire(ledger.USER, None, "haiku", 2, "manager",
            add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                "subagents": False, "mcp": []},
            org_visibility="self")["node"]
        store.save_org(self.org)
        self.slug = self.org.d["slug"]

    def test_send_message_refuses_an_untypeable_reason_before_touching_state(self):
        with patch.object(supervisor, "_admit_message") as admitted:
            with self.assertRaises(ValueError) as caught:
                supervisor.send_message(self.slug, self.nid, "hi",
                                        mail_ping=True, ping_reason="not_a_reason")
        # the refusal happens OUTSIDE halt admission, which is the point: that
        # decorator persists `ping_reason` into the node's halt queue, so a
        # value checked any later than this outlives the process that sent it
        admitted.assert_not_called()
        self.assertIn("not_a_reason", str(caught.exception))
        self.assertIn("quick_staff", str(caught.exception))

    def test_send_message_admits_every_reason_the_table_carries(self):
        """CONTROL for the refusal: the door is not simply closed."""
        with patch.object(supervisor, "_admit_message",
                          return_value=ACCEPTED) as admitted:
            for reason in (*events_table.DRIVE_MAIL_POINTER_REASONS, None):
                supervisor.send_message(self.slug, self.nid, "hi",
                                        mail_ping=True, ping_reason=reason)
            self.assertEqual(admitted.call_count,
                             len(events_table.DRIVE_MAIL_POINTER_REASONS) + 1)

    def test_composition_drops_an_unknown_reason_instead_of_killing_the_turn(self):
        """A carrier that was persisted BEFORE the door existed — `halt.retain`
        writes `ping_reason` into the org document — must still deliver its
        mail when it is replayed. The reason is model-only metadata on a
        segment the human transcript does not render; the turn is not."""
        ev = supervisor._ping_drive(self.org, self.nid, "(orgtree) mail.",
                                    "not_a_reason")
        self.assertIsNone(ev["reason"])
        self.assertEqual(ev["text"], "(orgtree) mail.")
        # CONTROL: a known reason still reaches the event, so the drop above is
        # discrimination and not a blanket erase
        self.assertEqual(
            supervisor._ping_drive(self.org, self.nid, "x", "quick_staff")["reason"],
            "quick_staff")


class QuickHireTests(unittest.TestCase):
    """§4-§8 — the real route, over HTTP, against the real ledger."""

    def setUp(self):
        self.client = TestClient(app)
        self.org = ledger.Org.create("qhr-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"] = {"haiku": 1}
        self.owner = self.org.hire(ledger.USER, None, "haiku", 2, "manager",
            add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                "subagents": False, "mcp": []},
            org_visibility="self")["node"]
        self.item = self.org.work_create(self.owner, "Repair the widget",
            "The widget is broken. Repair it.", status="backlogged",
            done_so_far=["Described the defect."],
            working_on_next=["Implement it."])["slug"]
        store.save_org(self.org)
        self.slug = self.org.d["slug"]
        self.path = f"/api/orgs/{self.slug}/work-items/{self.item}/quick-staff"
        for target, kwargs in [("provider_hire_gate", {"return_value": None}),
                               ("hub_changed", {"return_value": None}),
                               ("mail_notify", {"return_value": None})]:
            p = patch.object(api, target, **kwargs); p.start(); self.addCleanup(p.stop)
        for target, value in [("account_reason", None),
                              ("supported_efforts", ["low", "high"])]:
            p = patch.object(quickstaff, target, return_value=value)
            p.start(); self.addCleanup(p.stop)
        p = patch.object(api, "_providers_payload", return_value={"providers": [
            {"id": "claude", "hire_enabled": True,
             "tiers": [{"tier": "haiku", "seat": 1}]}]})
        p.start(); self.addCleanup(p.stop)
        appsettings.set_quick_staff_behavior("request")

    # ---------------------------------------------------------------- helpers
    def selection(self, tier="haiku", effort="low", request_id=None):
        r = self.client.get(self.path, headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()
        return {k: p[k] for k in ("mode", "configured_mode", "owner")} | {
            "request_id": request_id or str(uuid.uuid4()),
            **({"tier": tier} if tier else {}),
            **({"effort": effort} if effort is not None else {})}

    def send(self, body):
        return self.client.post(self.path, headers=HEADERS, json=body)

    def loaded(self):
        return store.load_org(self.slug)

    def item_now(self, org=None):
        return (org or self.loaded())._work_find(self.item)[0]

    def box(self, org=None):
        return ((org or self.loaded()).d.get("mail") or {}).get(self.owner) or []

    def accepting(self):
        p = patch.object(api.supervisor, "send_message", return_value=ACCEPTED)
        self.addCleanup(p.stop)
        return p.start()

    # ------------------------------------------------- §4 the measured request
    def test_the_field_request_admits_a_turn_the_engine_can_actually_compose(self):
        """THE REPRODUCTION. Run the exact Quick Hire the user ran — backlogged
        ticket, sonnet-shaped request with an effort — let the REAL send door
        run, capture the carrier it hands the turn worker, and compose that
        carrier the way `_run_turn` composes it. That mint is the statement
        that failed in the field."""
        carriers = []
        with patch.object(supervisor, "_start_turn_worker",
                          side_effect=lambda s, n, c: carriers.append((s, n, c))):
            r = self.send(self.selection("haiku", "low"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("kickoff_failed", r.json())
        self.assertEqual(len(carriers), 1, "exactly one turn is started")
        _slug, nid, carrier = carriers[0]
        self.assertEqual(nid, self.owner)
        # the value under test comes from the PRODUCT, not from this file
        reason = supervisor._carrier_ping_reason(carrier)
        self.assertEqual(reason, "quick_staff")
        ev = supervisor._ping_drive(self.loaded(), nid, carrier["text"], reason)
        self.assertEqual(ev["reason"], "quick_staff")
        # and the same value through the unguarded mint — what the engine ran
        self.assertEqual(_mint(reason)["reason"], "quick_staff")
        item = self.item_now()
        self.assertEqual(item["status"], "open")
        self.assertEqual(item["working_on_next"], ["Implement it."])
        self.assertEqual(item["done_so_far"], ["Described the defect."])
        requests = [m for m in self.box() if m["kind"] == "request"]
        self.assertEqual(len(requests), 1)
        self.assertIn("Suggested model: haiku.", requests[0]["body"])
        self.assertIn("Suggested effort: low.", requests[0]["body"])

    def test_an_untypeable_reason_refuses_before_the_ticket_moves(self):
        """The pre-flight. With the reason back to an unlisted value — the state
        the engine shipped in — the request is refused at the door and the
        ticket is untouched: no Open, no mail, no receipt, no turn."""
        drive = self.accepting()
        with patch.object(api, "QUICK_STAFF_PING_REASON", "not_a_reason"):
            r = self.send(self.selection())
        self.assertEqual(r.status_code, 422)
        self.assertIn("not_a_reason", r.json()["detail"])
        item = self.item_now()
        self.assertEqual(item["status"], "backlogged")
        self.assertEqual(item.get("quick_staff_receipts") or {}, {})
        self.assertEqual(self.box(), [])
        drive.assert_not_called()

    # ------------------------------------------------------- §5 the roll back
    def test_a_refused_kickoff_undoes_the_request_entirely(self):
        before = copy.deepcopy(self.item_now())
        with patch.object(api.supervisor, "send_message",
                          return_value={"accepted": False, "error": "no slot"}):
            r = self.send(self.selection())
        self.assertEqual(r.status_code, 422, r.text)
        detail = r.json()["detail"]
        self.assertIn("no slot", detail)
        self.assertIn("back where it was", detail)
        item = self.item_now()
        self.assertEqual(item["status"], "backlogged")
        self.assertEqual(item["done_so_far"], before["done_so_far"])
        self.assertEqual(item["working_on_next"], before["working_on_next"])
        self.assertEqual(item["owner"]["node"], before["owner"]["node"])
        self.assertEqual(item.get("quick_staff_receipts") or {}, {})
        self.assertEqual([m for m in self.box() if m["kind"] == "request"], [],
                         "the stranded request is withdrawn, not left unread")
        log = (self.loaded().d.get("mail_log") or {}).get(self.owner) or []
        posted = [m for m in log if m["kind"] == "request"]
        self.assertEqual(len(posted), 1, "the record keeps what was sent")
        self.assertTrue(posted[0].get("retracted"),
                        "and marks it retracted rather than deleting it")

    def test_a_raising_kickoff_undoes_the_request_too(self):
        with patch.object(api.supervisor, "send_message",
                          side_effect=ValueError("boom")):
            r = self.send(self.selection())
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("boom", r.json()["detail"])
        self.assertEqual(self.item_now()["status"], "backlogged")
        self.assertEqual([m for m in self.box() if m["kind"] == "request"], [])

    def test_control_an_accepted_kickoff_leaves_the_request_standing(self):
        """CONTROL for both roll backs: `backlogged` afterwards has to MEAN the
        undo ran. Same request, same fixture, accepting door — Open, mail,
        receipt, all intact."""
        self.accepting()
        r = self.send(self.selection())
        self.assertEqual(r.status_code, 200, r.text)
        item = self.item_now()
        self.assertEqual(item["status"], "open")
        self.assertEqual(len(item["quick_staff_receipts"]), 1)
        self.assertEqual(len([m for m in self.box() if m["kind"] == "request"]), 1)

    def test_the_undo_refuses_to_clobber_an_item_somebody_else_moved(self):
        """The compensation is not a longer transaction, so it has to lose a
        race rather than win it. Another writer advances the item between the
        commit and the failed kickoff; the failure is still reported, and the
        other writer's state stands."""
        def move_then_fail(*a, **k):
            org = store.load_org(self.slug)
            org.work_update(self.owner, self.item, ["Started."], ["Finish."],
                            status="in_progress")
            store.save_org(org)
            return {"accepted": False, "error": "no slot"}
        with patch.object(api.supervisor, "send_message",
                          side_effect=move_then_fail):
            r = self.send(self.selection())
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("changed by someone else", r.json()["detail"])
        item = self.item_now()
        self.assertEqual(item["status"], "in_progress")
        self.assertEqual(item["done_so_far"], ["Started."])

    # ------------------------------------------------------- §6 idempotency
    def test_a_retry_after_a_roll_back_makes_exactly_one_request(self):
        # ⚠ ONE body, sent three times — a browser retrying the same submission.
        # Re-previewing between attempts would hide the whole question, because
        # the preview refuses once the ticket is no longer backlogged.
        body = self.selection()
        with patch.object(api.supervisor, "send_message",
                          return_value={"accepted": False, "error": "no slot"}):
            self.assertEqual(self.send(body).status_code, 422)
        drive = self.accepting()
        first = self.send(body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(drive.call_count, 1)
        again = self.send(body)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertTrue(again.json()["replayed"])
        self.assertEqual(again.json()["mail"], first.json()["mail"])
        self.assertEqual(drive.call_count, 1, "a replay starts no second turn")
        item = self.item_now()
        self.assertEqual(len(item["quick_staff_receipts"]), 1)
        self.assertEqual(len([m for m in self.box() if m["kind"] == "request"]), 1)
        self.assertEqual(len(self.loaded().nodes), 1, "and hires nobody")

    def test_a_retry_with_a_different_selection_under_one_id_is_refused(self):
        """CONTROL for the receipt: it is keyed to the SELECTION, so replay is
        not a blanket 'this id already answered'."""
        self.accepting()
        body = self.selection("haiku", "low")
        self.assertEqual(self.send(body).status_code, 200)
        r = self.send({**body, "effort": "high"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("different selection", r.json()["detail"])

    # --------------------------------------------------------- §7 halted node
    def test_a_halted_recipient_is_reported_and_not_undone(self):
        """A halt is lifted, and `halt.admission` has already written this
        carrier durably — so the request really will run and undoing it would
        destroy work. What was wrong was answering 'Staffing requested' with no
        hint that nothing had woken up."""
        org = self.loaded()
        org.d["killswitch"] = {"at": ledger.now(), "by": ledger.USER}
        store.save_org(org)
        with patch.object(supervisor, "_start_turn_worker") as worker:
            r = self.send(self.selection())
        self.assertEqual(r.status_code, 200, r.text)
        worker.assert_not_called()
        self.assertIn("killswitch", r.json()["kickoff_held"])
        self.assertIn("starts when it is released", r.json()["message"])
        self.assertEqual(self.item_now()["status"], "open")
        # and the carrier the halt retained carries the reason DURABLY — this
        # is why an untypeable one had to be refused at the door and not at
        # composition: it survives the process that stated it
        held = self.loaded().node(self.owner).get("halt_queue") or []
        pings = [c for c in held if c.get("ping")]
        self.assertEqual([c.get("ping_reason") for c in pings], ["quick_staff"])

    # ---------------------------------------------------- §8 immediate staffing
    def test_immediate_staffing_reports_a_failed_kickoff_and_keeps_the_seat(self):
        """The hire already happened and un-hiring is a different operation, so
        this branch reports instead of rolling back — but it must not claim the
        agent started."""
        appsettings.set_quick_staff_behavior("under_assignee")
        with patch.object(api.supervisor, "send_message",
                          return_value={"accepted": False, "error": "no slot"}):
            r = self.send(self.selection("haiku", "low"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("no slot", body["kickoff_failed"])
        self.assertIn("first turn did not start", body["message"])
        self.assertEqual(len(self.loaded().nodes), 2, "the seat is real")

    def test_control_immediate_staffing_stays_silent_when_the_kickoff_lands(self):
        appsettings.set_quick_staff_behavior("under_assignee")
        self.accepting()
        r = self.send(self.selection("haiku", "low"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("kickoff_failed", r.json())
        self.assertNotIn("kickoff_held", r.json())
        self.assertEqual(len(self.loaded().nodes), 2)


if __name__ == "__main__":
    unittest.main()
