"""The historical-quota-error guard, and the live-database read it depends on.

⚠ WHY THIS FILE EXISTS AT ALL. Before 2026-09-17 `antigravity_provenance` was
referenced by NO test anywhere in this repository — only `antigravityrun`
imported it. It shipped a guard that could never run: `_Read` opened the
conversation store with `immutable=1`, which is lock-free and fast but IGNORES
the write-ahead log, so `_identity` refused any database carrying a `-wal`
sidecar rather than read a stale main file. The CLI holds its conversation in
WAL mode for the DURATION of a turn, which is exactly when `reconcile` reopens
it, so the refusal fired every time.

Measured on this machine: `data/antigravity/provenance.ndjson` held 108
outcomes across six days and every single one was `declined`. A `flash` agent
sat frozen for 22 hours on a quota sentence its own conversation store showed
was historical, while the account still had capacity.

The tests below drive the REAL sqlite path — a genuine WAL database with a
live writer connection held open across capture/append/reconcile — rather than
stubbing the reader, because a stub cannot reproduce the only condition that
mattered. Two of them are negative controls: a current wall must still decline,
and a database swapped underneath the read must still be caught.
"""

import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest

_root = tempfile.TemporaryDirectory(prefix="v2-agy-provenance-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import antigravity_provenance as prov  # noqa: E402

CID = "84d16cbb-fd2e-4ee2-91f0-dc5904528756"
QUOTA = ("Individual quota reached. Please upgrade your subscription to "
         "increase your limits. Resets in 2h53m47s.")

# stored step_type values, from the module's own WIRE_TYPE map
USER, RESPONSE, ERROR_STEP, SYSTEM, TOOL = 14, 15, 17, 101, 132


# ── protobuf encoding, mirroring the module's `_fields` decoder ──────────────
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _vf(number: int, value: int) -> bytes:
    """A varint field."""
    return _varint(number << 3) + _varint(value)


def _bf(number: int, blob: bytes) -> bytes:
    """A length-delimited field."""
    return _varint(number << 3 | 2) + _varint(len(blob)) + blob


def user_payload(prompt: str) -> bytes:
    #    1 = step_type, 4 = status, 19 = the user message, whose 2 is the text
    return (_vf(1, USER) + _vf(4, 3) + _bf(19, _bf(2, prompt.encode("utf-8"))))


def response_payload(body: str, *, stop_reason: int = 2,
                     tool_call: bool = False) -> bytes:
    #   20 = the response, whose 8 is the body, 7 a tool call, 12 the stop reason
    inner = _bf(8, body.encode("utf-8")) + _vf(12, stop_reason)
    if tool_call:
        inner += _bf(7, b"\x08\x01")
    return _vf(1, RESPONSE) + _vf(4, 3) + _bf(20, inner)


def system_payload() -> bytes:
    return _vf(1, SYSTEM) + _vf(4, 3)


def run_error_payload(step_type: int, message: str) -> bytes:
    """A step carrying a RunError — what a REAL current wall writes.

    24 = the RunError, whose 3 is CortexErrorDetails{1: message, 4: is_benign}.
    """
    details = _bf(1, message.encode("utf-8")) + _vf(4, 0)
    return _vf(1, step_type) + _vf(4, 3) + _bf(24, _bf(3, details))


class Store:
    """A conversation database that behaves like the CLI's own."""

    def __init__(self, home: Path, cid: str = CID):
        self.cid = cid
        self.dir = home / ".gemini/antigravity-cli/conversations"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / (cid + ".db")
        self.env = {"USERPROFILE": str(home), "HOME": str(home)}
        self.writer: sqlite3.Connection | None = None
        db = sqlite3.connect(str(self.path))
        db.execute("CREATE TABLE `trajectory_meta` (`trajectory_id` text,"
                   "`cascade_id` text,`trajectory_type` integer,`source` integer,"
                   "PRIMARY KEY (`trajectory_id`))")
        db.execute("CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL "
                   "DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` "
                   "numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,"
                   "`permissions` blob,`task_details` blob,`render_info` blob,"
                   "`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,"
                   "PRIMARY KEY (`idx`))")
        db.execute("INSERT INTO trajectory_meta VALUES (?,?,0,0)", ("t", cid))
        db.commit()
        db.close()
        self.next = 0

    def append(self, step_type: int, payload: bytes, *, status: int = 3,
               error_details: bytes | None = None) -> int:
        idx = self.next
        self.next += 1
        conn = self.writer or sqlite3.connect(str(self.path))
        conn.execute(
            "INSERT INTO steps (idx,step_type,status,has_subtrajectory,metadata,"
            "error_details,permissions,task_details,render_info,step_payload,step_format)"
            " VALUES (?,?,?,0,NULL,?,NULL,NULL,NULL,?,0)",
            (idx, step_type, status, error_details, payload))
        conn.commit()
        if self.writer is None:
            conn.close()
        return idx

    def go_live(self) -> None:
        """Hold the database open in WAL mode, exactly as the CLI does for the
        duration of a turn. This is the condition the old code refused."""
        self.writer = sqlite3.connect(str(self.path))
        self.writer.execute("PRAGMA journal_mode=WAL").fetchall()
        # a committed write, so the -wal actually carries content
        self.writer.execute("CREATE TABLE IF NOT EXISTS _probe(x)")
        self.writer.commit()

    def close(self) -> None:
        if self.writer is not None:
            self.writer.close()
            self.writer = None

    @property
    def has_sidecar(self) -> bool:
        return (Path(str(self.path) + "-wal").exists()
                or Path(str(self.path) + "-journal").exists())

    def seed_history(self) -> int:
        """A conversation that hit a wall once, long ago, and carried on."""
        self.append(USER, user_payload("first question"))
        historical = self.append(ERROR_STEP, run_error_payload(ERROR_STEP, QUOTA))
        self.append(RESPONSE, response_payload("an answer from hours ago"))
        return historical

    def append_completed_turn(self, prompt: str, body: str) -> tuple[int, int]:
        """The interval a turn appends when it actually produced a response."""
        first = self.append(USER, user_payload(prompt))
        self.append(SYSTEM, system_payload())
        final = self.append(RESPONSE, response_payload(body))
        return first, final


def wire(final_index: int, body: str, *, state: str = "DONE",
         step_type: str = "agent_response", cid: str = CID) -> list[dict]:
    return [{"event": "step_update",
             "step_update": {"step_index": final_index, "conversation_id": cid,
                             "state": state, "step_type": step_type,
                             "text_delta": body}}]


def error_result(message: str = QUOTA, cid: str = CID) -> dict:
    return {"status": "ERROR", "error": message, "conversation_id": cid}


class ProvenanceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._home = tempfile.TemporaryDirectory(prefix="agy-home-")
        self.addCleanup(self._home.cleanup)
        self.home = Path(self._home.name)
        self.store = Store(self.home)
        self.addCleanup(self.store.close)

    def records(self) -> list[dict]:
        path = prov._records_path()
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]


class LiveDatabaseReadTests(ProvenanceTestCase):
    """The defect itself: a database the CLI currently holds open."""

    def test_a_live_wal_database_is_captured_not_refused(self) -> None:
        self.store.seed_history()
        self.store.go_live()
        self.assertTrue(self.store.has_sidecar,
                        "the fixture must reproduce the sidecar, or this proves nothing")

        boundary = prov.capture(CID, self.store.env)

        self.assertIsNotNone(
            boundary, "a live WAL database must be read, not refused — this is the "
                      "condition that made the guard unreachable in production")
        assert boundary is not None
        self.assertEqual(len(boundary.errors), 1)
        self.assertEqual(boundary.errors[0][1], QUOTA)

    def test_a_standalone_database_still_reads(self) -> None:
        """Positive control: the path that always worked is untouched."""
        self.store.seed_history()
        self.assertFalse(self.store.has_sidecar)

        boundary = prov.capture(CID, self.store.env)

        self.assertIsNotNone(boundary)

    def test_the_live_read_sees_rows_committed_into_the_wal(self) -> None:
        """The reason `immutable=1` was wrong, stated as an assertion.

        Rows committed while the writer holds the database live land in the
        -wal, not the main file. A read that ignored the WAL would miss them
        and silently report an older boundary.
        """
        self.store.seed_history()
        self.store.go_live()
        last = self.store.append(RESPONSE, response_payload("written into the wal"))

        boundary = prov.capture(CID, self.store.env)

        assert boundary is not None
        self.assertEqual(boundary.index, last,
                         "the boundary must be the row committed into the WAL")


class ReconcileTests(ProvenanceTestCase):
    """Whether a stale quota error is corrected, and whether a real one survives."""

    def test_a_historical_quota_error_is_reconciled_away(self) -> None:
        """END TO END, on a live WAL database: the agent must not freeze."""
        historical = self.store.seed_history()
        self.store.go_live()
        boundary = prov.capture(CID, self.store.env)
        self.assertIsNotNone(boundary)
        body = "the turn really did answer"
        _first, final = self.store.append_completed_turn("a new question", body)

        out = prov.reconcile(boundary, "a new question", CID,
                             error_result(), wire(final, body))

        self.assertIsNotNone(
            out, "the CLI returned a quota error identical to one already in its "
                 "own history while the turn actually completed — that is a replay")
        assert out is not None
        self.assertEqual(out["kind"], "historical_cli_quota_error")
        self.assertEqual(out["historical_step"], historical)
        self.assertEqual(out["final_step"], final)
        self.assertEqual([r for r in self.records() if r["outcome"] == "fired"][-1:][0]["outcome"],
                         "fired")

    def test_a_genuine_current_wall_still_declines(self) -> None:
        """⚠ NEGATIVE CONTROL. A real wall hit by THIS turn stores a type-17
        error step, exactly as the retained conversation does at step 418. It
        must keep freezing the agent.

        It declines at the step-type allowlist, which sits BEFORE the payload
        checks — 17 is not one of the types an ordinary turn may contain. That
        is the production shape; `step_run_error` below is the same refusal
        reached through the other door.
        """
        self.store.seed_history()
        self.store.go_live()
        boundary = prov.capture(CID, self.store.env)
        self.store.append(USER, user_payload("a new question"))
        current = self.store.append(ERROR_STEP, run_error_payload(ERROR_STEP, QUOTA))

        out = prov.reconcile(boundary, "a new question", CID, error_result(),
                             wire(current, ""))

        self.assertIsNone(out, "a current wall must still freeze the agent")
        self.assertEqual(self.records()[-1]["reason"], "step_type")

    def test_a_run_error_on_an_ordinary_step_still_declines(self) -> None:
        """⚠ NEGATIVE CONTROL, the discriminator itself. The module's stated
        rule is that a RunError in the payload disqualifies the interval
        REGARDLESS of the SQL step type, because a real refusal is stored as
        status 3 and would otherwise look healthy. Proved on an allowed type,
        so the allowlist above cannot be what rejects it."""
        self.store.seed_history()
        self.store.go_live()
        boundary = prov.capture(CID, self.store.env)
        self.store.append(USER, user_payload("a new question"))
        current = self.store.append(RESPONSE, run_error_payload(RESPONSE, QUOTA))

        out = prov.reconcile(boundary, "a new question", CID, error_result(),
                             wire(current, ""))

        self.assertIsNone(out, "a RunError means this turn hit the wall itself")
        self.assertEqual(self.records()[-1]["reason"], "step_run_error")

    def test_an_error_absent_from_the_history_declines(self) -> None:
        """A wall whose wording was never seen before is NOT a replay."""
        self.store.seed_history()
        self.store.go_live()
        boundary = prov.capture(CID, self.store.env)
        body = "an answer"
        _first, final = self.store.append_completed_turn("a new question", body)

        out = prov.reconcile(
            boundary, "a new question", CID,
            error_result("Individual quota reached. Resets in 42m1s."),
            wire(final, body))

        self.assertIsNone(out)
        self.assertEqual(self.records()[-1]["reason"], "error_not_historical")

    def test_a_turn_that_produced_nothing_declines(self) -> None:
        """No completed interval means no proof the turn worked. The probe
        floor from `a-replayed-usage-limit-message-from-an-old-turn` is the
        backstop for this case, deliberately."""
        self.store.seed_history()
        self.store.go_live()
        boundary = prov.capture(CID, self.store.env)

        out = prov.reconcile(boundary, "a new question", CID, error_result(), [])

        self.assertIsNone(out)
        self.assertEqual(self.records()[-1]["reason"], "interval_too_short")


class IdentityProtectionTests(ProvenanceTestCase):
    """The guard `_identity` was really there for, kept rather than deleted."""

    def test_a_replaced_database_is_caught(self) -> None:
        """⚠ NEGATIVE CONTROL. Swapping the file for a different one mid-read
        must still be refused — that protection survives the fix."""
        self.store.seed_history()
        boundary = prov.capture(CID, self.store.env)
        self.assertIsNotNone(boundary)
        assert boundary is not None
        replaced = prov.Boundary(boundary.path, boundary.cid,
                                 (boundary.identity[0], boundary.identity[1] + 1),
                                 boundary.index, boundary.fingerprint, boundary.errors)
        body = "an answer"
        _first, final = self.store.append_completed_turn("a new question", body)

        out = prov.reconcile(replaced, "a new question", CID,
                             error_result(), wire(final, body))

        self.assertIsNone(out)
        self.assertEqual(self.records()[-1]["reason"], "database_replaced")

    def test_a_missing_database_is_refused(self) -> None:
        self.store.path.unlink()

        self.assertIsNone(prov.capture(CID, self.store.env))


class DeclineReasonTests(ProvenanceTestCase):
    """`no_boundary` used to swallow every capture outcome (100 of 108)."""

    def test_the_no_boundary_decline_names_the_capture_predicate(self) -> None:
        self.store.append(USER, user_payload("no wall has ever happened here"))
        self.assertIsNone(prov.capture(CID, self.store.env),
                          "no historical quota error means nothing to match against")

        out = prov.reconcile(None, "a new question", CID, error_result(), [])

        self.assertIsNone(out)
        self.assertEqual(self.records()[-1]["reason"],
                         "no_boundary_no_historical_quota_error")

    def test_a_thread_that_never_captured_says_so(self) -> None:
        """⚠ The stale-reason trap (found in peer review, freeze-provenance).

        The reason is thread-local, so a turn reaching reconcile with no
        boundary WITHOUT having called capture must not inherit whatever the
        previous turn on that thread left behind. Run on a genuinely fresh
        thread, which is the only way to prove the default rather than a
        leftover.
        """
        self.store.append(USER, user_payload("something"))
        prov.capture(CID, self.store.env)      # dirty THIS thread's reason
        seen: list[str] = []

        def fresh() -> None:
            prov.reconcile(None, "q", CID, error_result(), [])
            seen.append(self.records()[-1]["reason"])

        thread = threading.Thread(target=fresh)
        thread.start()
        thread.join()

        self.assertEqual(seen, ["no_boundary_no_capture_on_thread"])

    def test_a_successful_capture_clears_the_previous_reason(self) -> None:
        """A decline must not outlive the turn that produced it."""
        self.store.append(USER, user_payload("no wall here"))
        prov.capture(CID, self.store.env)                      # -> declines
        self.store.seed_history()
        self.assertIsNotNone(prov.capture(CID, self.store.env))  # -> succeeds

        prov.reconcile(None, "q", CID, error_result(), [])

        self.assertEqual(self.records()[-1]["reason"], "no_boundary_captured",
                         "a stale decline reason must not be reported against "
                         "a later turn on the same thread")

    def test_a_benign_no_boundary_is_distinguishable_from_a_failure(self) -> None:
        """The whole point: the benign majority must not read like the defect."""
        self.store.append(USER, user_payload("no wall here"))
        prov.capture(CID, self.store.env)
        prov.reconcile(None, "q", CID, error_result(), [])
        benign = self.records()[-1]["reason"]

        prov.capture("not-a-uuid", self.store.env)
        prov.reconcile(None, "q", CID, error_result(), [])
        malformed = self.records()[-1]["reason"]

        self.assertNotEqual(benign, malformed)
        self.assertEqual(malformed, "no_boundary_unqualified_conversation")


if __name__ == "__main__":
    unittest.main()
