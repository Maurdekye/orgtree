"""Nothing written to a docket is ever silently cut.

SUGGESTION PACKAGE W02, reconciled from seventeen agent reports that all
described the same failure from different sides: a bare `[:N]` on a docket
string. A slice is the worst of the three possible behaviours — the caller is
told it succeeded, the stored record READS as complete, and the loss surfaces
much later. The reports:

  · an `attention_reason` truncated to 500 while only WARNING about it, so the
    user read a sentence that stopped mid-thought and the agent learned of it
    from a warning that arrived after the write. Five round trips to find a
    length that fit (636 -> 25 -> 6 -> 2 -> 1 -> 1 -> 0);
  · review notes cut in the mail that delivered them AND again in
    `history[].note`, so one agent recovered its own review by reading
    `mail_log` out of the sqlite file;
  · an approval note and an evidence note ending at `rerun focused/full r` and
    inside a filename;
  · progress-list entries losing their tails;
  · a rejected 40-character sha echoed back as `'b390277706c7977c1853'...`,
    hiding the single wrong character that caused the rejection;
  · a no-access refusal naming `improve-inline-reply` for a call that said
    `improve-inline-reply-previews` — an access problem that read as a typo.

SO THE CONTRACT (`orgtree/workfields.py`) HAS EXACTLY TWO BEHAVIOURS:

  LOSSLESS   every `note` and the description: stored entire, returned entire.
  BOUNDED    title, the progress lists, the state reasons, `attention_reason`
             and the path/sha refs: the limit stays, and text over it REFUSES
             THE WHOLE CALL before anything is written, naming the submitted
             length, the limit and the overage.

A preview is not a third behaviour: a notification may carry a shortened copy
only through `workfields.excerpt`, which says it is an excerpt, gives the full
length and names the call that returns the whole.

WHAT THIS SUITE PINS:

  §1  LOSSLESS notes round-trip whole — review (both verdicts), acceptance,
      evidence, check and claim — through storage and `work_get`.
  §2  ATOMICITY: an over-length bounded field changes NOTHING. Not the status,
      title, description, lists or flag; no history row; no mail.
  §3  The refusal carries all three numbers, and the limit is the one the tool
      card advertises (one contract, not two).
  §4  BOUNDARIES: exactly at the limit passes, one over refuses — for every
      bounded field, read from the contract rather than listed here.
  §5  UNICODE is counted as code points, after the ends are trimmed, and the
      reported numbers agree with `len()`.
  §6  EVENTS: a long review note reaches the mail as a MARKED excerpt that
      names the full length and the `get` that returns it, while the whole
      note is retrievable from the item; a short one arrives whole, unmarked.
  §7  DIAGNOSTICS echo exactly what was submitted — the full slug, the full
      sha — and name the fault, without revealing whether an item exists.
  §8  The write paths hold no `[:N]` slice at all (the scan that would have
      caught every one of the reports above).

The description half of the same requirement is
`tests/test_work_description_complete.py`; this suite does not repeat it.
"""
import os
import re
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-lossless-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

# ⚠ `events` BEFORE `events_render`: events.py imports the renderer module at
# its own tail, so importing the renderer first hands it a half-built `events`
# and its completeness check fires on an empty table.
from orgtree import events  # noqa: E402,F401
from orgtree import events_render  # noqa: E402,F401
from orgtree import ledger, mcptool, store, workfields, workitems  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

_n = 0

#: a note of the shape an agent actually writes — three findings, well past
#: every limit in the contract, ending in a sentinel a slice would eat
LONG_NOTE = (
    "Three findings, all reproduced against the candidate:\n\n"
    "1. The cheap exit compared only EXISTING chips, so an unknown bare name "
    "left no element at all and a later index change was never noticed. "
    "Repro: \"Follow alpha-ticket and beta-ticket\" with alpha alone indexed.\n"
    "2. The scan fingerprint was a polynomial hash, which is lossy by "
    "construction and loses exactly where the bug is: `an-ticket` and "
    "`c0-ticket` collide (97*31+110 == 99*31+48 == 3117, identical tails).\n"
    "3. `assertDeepEqual` on DOM nodes can never fail; the repo's own "
    "meta-guard was red for it.\n\n"
    + ("Rerun the focused renderer suites and the full one before landing; "
       "the browser probe is what catches the CSS specificity defect, and no "
       "jsdom test can see it. " * 6)
    + "END-OF-NOTE")


def fixture():
    """A fresh in-memory org: owner-a holds an item, rev-r reviews it."""
    global _n
    _n += 1
    org = ledger.Org.create(f"ll-{_n}")
    for nid in ("owner-a", "peer-b"):
        org.hire(USER, None, "haiku", 0, nid)
    org.hire(USER, "owner-a", "haiku", 0, "rev-r")
    org.work_create("owner-a", "Lossless fixture",
                    objective="Problem: docket writes lost their tails. "
                              "Solution: these assertions.",
                    acceptance=["notes survive"])
    return org, org.d["work_items"][-1]["slug"]


def item(org, wid):
    for bucket in ("work_items", "work_items_archive"):
        for it in org.d.get(bucket, []):
            if it["slug"] == wid:
                return it
    raise AssertionError(f"{wid} vanished")


def mailcount(org):
    return sum(len(v) for v in (org.d.get("mail") or {}).values())


def review_seat(org, wid):
    """Put the item under review by rev-r, ready for a decision."""
    org.work_update("owner-a", wid, ["built it"], ["await review"],
                    status="review", reviewer="rev-r")


class LosslessNotes(unittest.TestCase):
    """§1 — every `note` is stored and returned entire."""

    def test_s1_review_changes_keeps_the_whole_note_in_history(self):
        org, wid = fixture()
        review_seat(org, wid)
        org.work_review_decide("rev-r", wid, "changes", LONG_NOTE)

        rows = [h for h in item(org, wid)["history"]
                if h.get("op") == "review_changes"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["note"], LONG_NOTE)
        self.assertTrue(rows[0]["note"].endswith("END-OF-NOTE"))

    def test_s1b_review_approve_keeps_the_whole_note_in_acceptance(self):
        org, wid = fixture()
        review_seat(org, wid)
        org.work_review_decide("rev-r", wid, "approve", LONG_NOTE)
        self.assertEqual(item(org, wid)["accepted"]["note"], LONG_NOTE)

    def test_s1c_accept_keeps_the_whole_note(self):
        org, wid = fixture()
        org.work_accept("owner-a", wid, LONG_NOTE)
        self.assertEqual(item(org, wid)["accepted"]["note"], LONG_NOTE)

    def test_s1d_evidence_check_and_claim_notes_are_whole(self):
        org, wid = fixture()
        org.work_evidence("owner-a", wid, "note", "tests/run.log", LONG_NOTE)
        org.work_check("owner-a", wid, 0, "tests/run.log", LONG_NOTE)
        org.work_claim("owner-a", wid, "implemented", None, LONG_NOTE)

        it = item(org, wid)
        self.assertEqual(it["evidence"][0]["note"], LONG_NOTE)
        self.assertEqual(it["acceptance"][0]["checked"]["note"], LONG_NOTE)
        self.assertEqual(it["delivery"]["implemented"]["note"], LONG_NOTE)

    def test_s1e_the_reader_gets_them_whole_too(self):
        """The stored value is not the claim — `work_get` is what an agent
        reads, and the evidence note is where the contract sends every detail
        too long for a bounded field."""
        org, wid = fixture()
        org.work_evidence("owner-a", wid, "log", "tests/run.log", LONG_NOTE)
        review_seat(org, wid)
        org.work_review_decide("rev-r", wid, "approve", LONG_NOTE)

        got = org.work_get("owner-a", wid)
        self.assertEqual(got["evidence"][0]["note"], LONG_NOTE)
        self.assertEqual(got["accepted"]["note"], LONG_NOTE)

    def test_s1f_unicode_and_markdown_survive_a_note_byte_for_byte(self):
        org, wid = fixture()
        # deliberately past the old 500-character cut, so the characters an
        # escaping bug eats and the tail a slice eats are one assertion
        note = ("Findings — em dash, ellipsis …, fence:\n```py\nx = '[:500]'\n"
                "```\n| a | b |\n| - | - |\n完全 \U0001f600 & <tag> "
                "\"quoted\"\n"
                + "- 完全に — every rule, stated in full …\n" * 20
                + "END-OF-UNICODE-NOTE")
        self.assertGreater(len(note), 500)
        org.work_evidence("owner-a", wid, "note", "ref", note)
        self.assertEqual(item(org, wid)["evidence"][0]["note"], note)


class NotesThroughStorage(unittest.TestCase):
    """§1g — the durable half. `work_get` reading back an in-memory object
    proves the projection; only a save-and-reload proves the STORE, which is
    what acceptance asks for ("survives storage") and what an org export is a
    copy of."""

    def test_s1g_notes_survive_save_and_reload(self):
        slug = f"ll-store-{os.getpid()}"
        org = store.create_org(slug)
        try:
            org.hire(USER, None, "haiku", 0, "owner-a", add_dirs=[],
                     tools={"bash": False, "web": False, "edit": False,
                            "subagents": False, "mcp": []},
                     org_visibility="self", charter="fixture agent")
            created = org.work_create("owner-a", "Stored notes",
                                      objective="Problem. Solution.",
                                      acceptance=["notes survive storage"])
            wid = created["created"]
            org.work_evidence("owner-a", wid, "log", "tests/run.log", LONG_NOTE)
            org.work_check("owner-a", wid, 0, "tests/run.log", LONG_NOTE)
            org.work_accept("owner-a", wid, LONG_NOTE)
            store.save_org(org)
            store._POOL.close_all(slug)

            back = store.load_org(slug).work_get("owner-a", wid)
            self.assertEqual(back["evidence"][0]["note"], LONG_NOTE)
            self.assertEqual(back["acceptance"][0]["checked"]["note"],
                             LONG_NOTE)
            self.assertEqual(back["accepted"]["note"], LONG_NOTE)
        finally:
            store._POOL.close_all(slug)


class AtomicRefusal(unittest.TestCase):
    """§2 — an over-length bounded field changes nothing at all."""

    def _snapshot(self, org, wid):
        it = item(org, wid)
        return {
            "status": it.get("status"), "title": it.get("title"),
            "objective": it.get("objective"), "rev": it.get("rev"),
            "done": list(it.get("done_so_far") or []),
            "next": list(it.get("working_on_next") or []),
            "history": len(it.get("history") or []),
            "attention": it.get("manual_attention"),
            "attention_rev": it.get("manual_attention_rev"),
            "mail": mailcount(org),
        }

    def test_s2_an_overlong_attention_reason_writes_absolutely_nothing(self):
        org, wid = fixture()
        before = self._snapshot(org, wid)
        over = "x" * (workfields.limit_of("attention_reason") + 1)

        with self.assertRaises(LedgerError):
            org.work_update("owner-a", wid, ["shipped it"], ["land it"],
                            status="deploy_ready", title="A new title",
                            objective="A rewritten description.",
                            attention=True, attention_reason=over)

        self.assertEqual(self._snapshot(org, wid), before,
                         "the refused update changed the item anyway")

    def test_s2b_it_is_a_refusal_and_not_a_warning(self):
        """The regression itself: the old code STORED a truncated reason and
        returned a warning beside it."""
        org, wid = fixture()
        over = "y" * (workfields.limit_of("attention_reason") + 40)
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", wid, ["a"], [], attention=True,
                            attention_reason=over)
        self.assertIsNone(item(org, wid).get("manual_attention"))

    def test_s2c_an_overlong_blocked_reason_does_not_move_the_status(self):
        org, wid = fixture()
        before = self._snapshot(org, wid)
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", wid, ["a"], [], status="blocked",
                            blocked_reason="z" * 900)
        self.assertEqual(self._snapshot(org, wid), before)

    def test_s2d_an_overlong_title_leaves_the_old_one_standing(self):
        org, wid = fixture()
        before = self._snapshot(org, wid)
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", wid, ["a"], [], status="in_progress",
                            title="t" * 400)
        self.assertEqual(self._snapshot(org, wid), before)

    def test_s2e_an_overlong_list_entry_refuses_the_whole_update(self):
        org, wid = fixture()
        before = self._snapshot(org, wid)
        with self.assertRaises(LedgerError) as cm:
            org.work_update("owner-a", wid,
                            ["fine", "d" * 700, "also fine"], ["next"],
                            status="in_progress")
        self.assertEqual(self._snapshot(org, wid), before)
        # and it says WHICH entry: a list of forty is not searchable by eye
        self.assertIn("entry 2 of 3", str(cm.exception))

    def test_s2f_create_refuses_before_the_item_exists(self):
        org, _ = fixture()
        n = len(org.d["work_items"])
        with self.assertRaises(LedgerError):
            org.work_create("owner-a", "t" * 300,
                            objective="Problem. Solution.")
        self.assertEqual(len(org.d["work_items"]), n,
                         "a refused create left an item on the docket")

    def test_s2g_an_overlong_evidence_ref_adds_no_evidence_row(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_evidence("owner-a", wid, "file", "p" * 900, "note")
        self.assertEqual(item(org, wid).get("evidence") or [], [])


class ExactNumbers(unittest.TestCase):
    """§3 — the refusal is actionable in one step."""

    def test_s3_the_refusal_names_submitted_limit_and_overage(self):
        org, wid = fixture()
        limit = workfields.limit_of("attention_reason")
        sent = "q" * (limit + 112)
        with self.assertRaises(LedgerError) as cm:
            org.work_update("owner-a", wid, ["a"], [], attention=True,
                            attention_reason=sent)
        msg = str(cm.exception)
        for n in (str(len(sent)), str(limit), "112"):
            self.assertIn(n, msg, f"the refusal does not state {n}")
        self.assertIn("NOTHING WAS WRITTEN", msg)
        # and it says how it counted, because the agent that hit this was
        # counting differently from the product and could not tell
        self.assertIn("code points", msg)

    def test_s3b_the_error_object_carries_the_numbers_structurally(self):
        with self.assertRaises(workfields.FieldLimitError) as cm:
            workfields.bounded("title", "t" * 250)
        e = cm.exception
        self.assertEqual((e.field, e.submitted, e.limit, e.over),
                         ("title", 250, 200, 50))

    def test_s3c_the_tool_card_advertises_the_same_limits(self):
        """ONE contract. A cap the agent cannot see is how an agent ends up
        bisecting its way down to a length that fits."""
        spec = next(t for t in mcptool.TOOLS if t["name"] == "orgtree_work")
        props = spec["inputSchema"]["properties"]
        for field in ("title", "attention_reason", "blocked_reason",
                      "dropped_reason", "done_so_far", "working_on_next",
                      "evidence_ref", "ref", "acceptance"):
            text = props[field]["description"]
            self.assertIn(str(workfields.limit_of(field)), text,
                          f"{field} does not document its limit")
            self.assertIn("refused", text.lower())
        # and the lossless ones say they are lossless
        for field in ("objective", "note"):
            self.assertIn("no length limit",
                          props[field]["description"].lower())

    def test_s3d_the_ledger_reads_its_constant_from_the_contract(self):
        self.assertEqual(ledger.Org.WORK_ATTENTION_REASON_MAX,
                         workfields.limit_of("attention_reason"))


class Boundaries(unittest.TestCase):
    """§4 — exactly at the limit is fine; one over is refused."""

    def test_s4_every_bounded_field_admits_exactly_its_limit(self):
        for field, (limit, _advice) in workfields.LIMITS.items():
            self.assertEqual(len(workfields.bounded(field, "a" * limit)), limit,
                             f"{field} refused a string of exactly its limit")
            with self.assertRaises(workfields.FieldLimitError,
                                   msg=f"{field} accepted one over its limit"):
                workfields.bounded(field, "a" * (limit + 1))

    def test_s4b_the_boundary_holds_through_the_ledger_too(self):
        org, wid = fixture()
        limit = workfields.limit_of("attention_reason")
        org.work_update("owner-a", wid, ["a"], [], attention=True,
                        attention_reason="r" * limit)
        self.assertEqual(len(item(org, wid)["manual_attention"]["reason"]),
                         limit)

    def test_s4c_trailing_whitespace_does_not_count_against_the_limit(self):
        limit = workfields.limit_of("title")
        self.assertEqual(workfields.bounded("title", "  " + "a" * limit + "\n "),
                         "a" * limit)


class UnicodeCounting(unittest.TestCase):
    """§5 — code points, as `len()` counts them."""

    def test_s5_em_dashes_count_one_each(self):
        limit = workfields.limit_of("attention_reason")
        text = "—" * limit                       # em dashes
        self.assertEqual(len(workfields.bounded("attention_reason", text)),
                         limit)
        with self.assertRaises(workfields.FieldLimitError) as cm:
            workfields.bounded("attention_reason", text + "…")   # ellipsis
        self.assertEqual(cm.exception.submitted, limit + 1)
        self.assertEqual(cm.exception.over, 1)

    def test_s5b_astral_characters_count_by_code_point(self):
        limit = workfields.limit_of("title")
        text = "\U0001f600" * limit                   # one code point each
        self.assertEqual(len(workfields.bounded("title", text)), limit)
        with self.assertRaises(workfields.FieldLimitError):
            workfields.bounded("title", text + "\U0001f600")

    def test_s5c_a_long_unicode_note_still_has_no_limit(self):
        org, wid = fixture()
        note = "—…完" * 2000
        org.work_evidence("owner-a", wid, "note", "ref", note)
        self.assertEqual(item(org, wid)["evidence"][0]["note"], note)


class NotificationExcerpts(unittest.TestCase):
    """§6 — a preview says it is a preview and names the whole."""

    def _last_mail(self, org, nid):
        return (org.d.get("mail") or {}).get(nid, [])[-1]["body"]

    def test_s6_a_long_sendback_note_is_a_marked_excerpt_in_the_mail(self):
        org, wid = fixture()
        review_seat(org, wid)
        org.work_review_decide("rev-r", wid, "changes", LONG_NOTE)

        body = self._last_mail(org, "owner-a")
        self.assertIn("EXCERPT", body)
        self.assertIn(str(len(LONG_NOTE)), body,
                      "the mail does not say how much there is to read")
        self.assertIn(f"orgtree_work get slug={wid}", body)
        self.assertLess(len(body), len(LONG_NOTE) + 2000)
        # ...and the whole note is where the mail says it is
        rows = [h for h in item(org, wid)["history"]
                if h.get("op") == "review_changes"]
        self.assertEqual(rows[0]["note"], LONG_NOTE)

    def test_s6b_a_long_approval_note_is_marked_too(self):
        org, wid = fixture()
        review_seat(org, wid)
        org.work_review_decide("rev-r", wid, "approve", LONG_NOTE)
        body = self._last_mail(org, "owner-a")
        self.assertIn("EXCERPT", body)
        self.assertIn(str(len(LONG_NOTE)), body)
        self.assertEqual(item(org, wid)["accepted"]["note"], LONG_NOTE)

    def test_s6c_a_short_note_arrives_whole_and_unmarked(self):
        org, wid = fixture()
        review_seat(org, wid)
        org.work_review_decide("rev-r", wid, "changes",
                               "Fix the fingerprint; it is lossy.")
        body = self._last_mail(org, "owner-a")
        self.assertIn("Fix the fingerprint; it is lossy.", body)
        self.assertNotIn("EXCERPT", body)

    def test_s6d_a_dismissed_attention_reason_is_quoted_whole(self):
        """The notice is minted by the dismissal route, so this renders the
        leaf directly — the same call the route makes."""
        org, wid = fixture()
        reason = "Decision beyond spec: " + "w" * 400
        org.work_update("owner-a", wid, ["a"], [], attention=True,
                        attention_reason=reason)
        rev = item(org, wid)["manual_attention_rev"]
        r = org.work_dismiss_attention(wid, rev)
        self.assertEqual(r["reason"], reason)

        body = events.render_agent(events.mint(
            "decision.attention_dismissed", {"kind": "user", "id": USER},
            org.work_item_ref(item(org, wid)), reason=str(r["reason"]),
            pending_questions=0, dismissed_by=USER))
        self.assertIn(reason, body,
                      "the agent cannot tell which sentence the user rejected")

    def test_s6e_the_dismissal_carries_the_whole_reason_into_blocked(self):
        """A reason at EXACTLY its limit, so the sentence the product wraps
        around it pushes the composed string past 500 — which is where the
        old slice cut the tail off the very reason the agent is told not to
        re-raise."""
        org, wid = fixture()
        limit = workfields.limit_of("attention_reason")
        reason = "Decision beyond spec: " + "w" * (limit - 23) + "."
        self.assertEqual(len(reason), limit)
        org.work_update("owner-a", wid, ["a"], [], attention=True,
                        attention_reason=reason)
        org.work_dismiss_attention(wid, item(org, wid)["manual_attention_rev"])
        self.assertIn(reason, item(org, wid)["blocked_reason"])


class Diagnostics(unittest.TestCase):
    """§7 — errors echo exactly what was submitted."""

    def test_s7_a_no_access_refusal_echoes_the_whole_slug(self):
        """The reported failure: a call naming `improve-inline-reply-previews`
        was refused with `improve-inline-reply`, so an access problem read as
        a typo the caller then went hunting for."""
        org, _ = fixture()
        name = "improve-inline-reply-previews-and-their-hover-cards"
        self.assertGreater(len(name), 20, "the fixture must exceed the old cut")
        with self.assertRaises(LedgerError) as cm:
            org.work_get("peer-b", name)
        self.assertIn(name, str(cm.exception))

    def test_s7b_the_refusal_still_does_not_reveal_whether_it_exists(self):
        org, wid = fixture()
        hidden = str(cm_msg(org, "peer-b", wid))
        missing = str(cm_msg(org, "peer-b", "no-such-item-at-all"))
        # the two differ only where the caller's own words appear
        self.assertEqual(hidden.replace(wid, "X"),
                         missing.replace("no-such-item-at-all", "X"))

    def test_s7c_a_rejected_sha_is_echoed_in_full_with_the_fault_named(self):
        bad = "b390277706c7977c1853" + "g" + "a" * 19   # 40 chars, one wrong
        self.assertEqual(len(bad), 40)
        with self.assertRaises(workitems.ShaError) as cm:
            workitems.validate_sha(bad)
        msg = str(cm.exception)
        self.assertIn(bad, msg, "the typo is invisible in a shortened echo")
        self.assertIn("21", msg, "the refusal does not locate the bad character")

    def test_s7d_sha_faults_are_told_apart(self):
        cases = {
            "abc": "7",                       # too short
            "a" * 41: "41",                   # too long
            "B390277": "uppercase",           # wrong case
        }
        for value, expected in cases.items():
            with self.assertRaises(workitems.ShaError) as cm:
                workitems.validate_sha(value)
            self.assertIn(expected, str(cm.exception), f"for {value!r}")

    def test_s7e_a_valid_short_sha_is_still_accepted(self):
        """Nothing invalid is admitted to save a round trip — but the short
        form that was always legal stays legal."""
        self.assertEqual(workitems.validate_sha("b390277"), "b390277")
        self.assertEqual(workitems.validate_sha("  b390277  "), "b390277")

    def test_s7f_a_no_op_move_says_so_in_a_field(self):
        org, wid = fixture()
        org.hire(USER, "owner-a", "haiku", 0, "kid-k")
        r = org.move("owner-a", "kid-k", "owner-a")
        self.assertIs(r.get("changed"), False)
        self.assertIs(r.get("moved"), False)


def cm_msg(org, viewer, name):
    try:
        org.work_get(viewer, name)
    except LedgerError as e:
        return e
    raise AssertionError(f"{name} was readable by {viewer}")


class NoSlicesLeft(unittest.TestCase):
    """§8 — the scan that would have caught every report in the header."""

    #: the methods that WRITE an agent-supplied docket string
    WRITERS = ("work_create", "work_update", "_work_norm_list",
               "_work_state_info", "work_evidence", "work_check",
               "work_claim", "_work_accept_core", "work_review_decide",
               "work_attach")

    def test_s8_no_write_path_slices_a_string(self):
        """Parsed, not grepped. Every comment and docstring on these methods
        QUOTES the slice it replaced — `[:500]`, `[:200]`, `[:2000]` — so a
        textual scan is guaranteed to be either blind or permanently red. The
        AST sees the four characters that actually cut a value."""
        import ast
        import inspect
        import textwrap
        bad = []
        for name in self.WRITERS:
            tree = ast.parse(textwrap.dedent(
                inspect.getsource(getattr(ledger.Org, name))))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Subscript):
                    continue
                sl = node.slice
                if (isinstance(sl, ast.Slice) and sl.lower is None
                        and sl.step is None
                        and isinstance(sl.upper, ast.Constant)
                        and isinstance(sl.upper.value, int)):
                    bad.append(f"{name}: line {sl.lineno} of its source "
                               f"cuts at [:{sl.upper.value}]")
        self.assertEqual(bad, [], "a silent truncation is back on a write path")

    def test_s8b_the_notification_renderers_slice_only_through_the_contract(self):
        import inspect
        src = inspect.getsource(events_render)
        for i, line in enumerate(src.splitlines(), 1):
            code = line.split("#", 1)[0]
            if "[:_" in code or re.search(r"str\(note\)\[:", code):
                self.fail(f"events_render:{i} cuts a note outside `excerpt`: "
                          f"{line.strip()}")


if __name__ == "__main__":
    unittest.main()
