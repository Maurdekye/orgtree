"""Durable operation receipts (docs/op-receipts.md, work item w71d69aac).

WHAT THIS ANSWERS. `mcptool.call_api` makes ONE POST to `/api/agent` with a
30 s timeout. When that response is lost — timeout, connection drop, backend
replaced — the caller cannot tell a refusal from a mutation that already
committed, and the retry re-executes it: a second hire, a second mail. The
incident is recorded at `supervisor.py` (the net-retry replay banner): "the
effects a dying turn commits are exactly the non-idempotent ones".

So every mutating agent call may carry an `op_key`, and a call whose document
transaction commits leaves a durable RECEIPT in the org document, appended
inside the SAME `DOC_LOCK` transaction as the effect. A later call with the
same key is answered from the receipt instead of being executed again. No
tool card exposes a key, so no agent's prompt prefix moves for this.

WHY A KEYED CALL IS A VERB OF ITS OWN (`orgtree_op_call`, `api._op_unwrap`).
The key first rode the request envelope, and that was wrong: a backend built
before receipts DROPS an unknown envelope field and executes the operation
anyway, leaving no receipt. Look the key up on a newer backend afterwards and
the absence of a receipt reads as "never applied — safe to reissue", which is
a licence to do it twice. Nothing observable after the fact distinguishes
that from a call that truly never landed, and a recent mint time certainly
does not. So the request is shaped so an old backend CANNOT execute it: it
refuses the unknown verb and applies nothing. That structural refusal — not a
timestamp, not a grace window — is what makes a missing receipt evidence.

WHAT A RECEIPT PROVES, AND WHAT IT DOES NOT.

  · It proves the DOCUMENT transaction committed. It says nothing about what
    happens after `save_org`: the recipient drive, `@org:`/`@net:` transport,
    the watchdog smoke run, `remote_reap`. `post_effects.observed` is
    "unknown" — never `false`, which would read as "failed".
  · It cannot cover work done OUTSIDE that transaction. Some verbs rename a
    folder, copy a transcript, launch a process or wait for a turn boundary,
    and none of that is rolled back when the transaction is discarded. Those
    verbs are classified (`COVERAGE` below) and their ABSENCE is reported as
    `unknown`, never as "not applied".
  · It is NOT exactly-once for an agent's INTENT. It de-duplicates transport
    retries of ONE tool call. A model that decides to issue the call again
    mints a new key and is admitted — that is a new intent, and no key can
    tell it from the first.

THE INVARIANT THAT MAKES "not applied" HONEST. Retention is bounded, so the
absence of a receipt is only evidence if nothing has been forgotten below it.
Every eviction — for any reason — advances a WATERMARK (`from_ms`) past the
largest mint time it evicted, and the watermark only ever increases. So:

    a key whose mint time is >= `from_ms`, with no receipt, was never applied.

Below the watermark the answer is `unknown`. That is the whole design: the
capped log may forget, and forgetting always costs a refusal, never a
duplicate.

CUSTODY. A restored document carries an older log, so its silence means
nothing. A key is therefore bound at mint to a server-issued EPOCH held in
THIS PROCESS's memory (`_EPOCHS`), never read back from the document, rotated
on exactly two events: BOOT (the table starts empty; every restore that stops
the backend is covered, legacy backups included) and a REWIND (`meta.seq`
counts appends; `_SEEN` holds the highest seq this process has COMMITTED per
(root, slug) — advanced by `witness()` after every successful save of a
receipt — and a document that comes back below it was rewound underneath a
running backend). A stale epoch refuses ADMISSION before dispatch and answers
a lookup `unknown` when no matching row exists; a matching applied row still
answers `applied`. Uncovered, said plainly: a whole-root rewind performed live
that loses no receipt this process has committed. Why the two earlier designs
(an export stamp, a quarantine) were wrong is recorded in docs/op-receipts.md.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import re
import threading
import time
import uuid
from typing import Any, cast

# ---------------------------------------------------------------- constants

SCHEMA = 1                  # receipt row shape
COVERAGE = 1                # the COVERAGE table's revision
HORIZON_MS = 900_000        # 15 min: a key older than this is refused
CEILING = 500               # rows retained before an eviction runs
TRIM_TO = 400               # …and what an eviction leaves behind
SKEW_MS = 60_000            # a key minted "in the future" by more than this is refused

SECTION = "op_receipts"
META = "op_receipts_meta"

# The three verbs receipts add to the dispatch. All are DISPATCH-ONLY on
# purpose — a backend without receipts refuses an unknown verb and executes
# nothing, which is how a client learns it cannot be protected here, and (for
# `OP_CALL`) the reason a missing receipt is evidence at all. `OP_EPOCH` is
# the client's PREFLIGHT: it reads the current epoch and mutates nothing, and
# an old build refusing it is the safest possible moment to discover that this
# backend has no receipts — before any mutation has been attempted.
OP_CALL = "orgtree_op_call"
OP_LOOKUP = "orgtree_op_lookup"
OP_EPOCH = "orgtree_op_epoch"
VERBS = (OP_CALL, OP_LOOKUP, OP_EPOCH)

# `<mint_ms>-<24 hex>`. The mint time is IN the key so the server can judge
# the key's own age without having recorded it first — which is what lets a
# never-seen key be refused as stale instead of being admitted blind.
KEY_RE = re.compile(r"^(\d{13,14})-([0-9a-f]{24})$")


def mint_key(now_ms: int | None = None) -> str:
    """Mint a client key. Only our own MCP client calls this; no tool card
    exposes a key, so an agent's model never invents one."""
    ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    return f"{ms}-{uuid.uuid4().hex[:24]}"


def parse_key(key: str) -> int | None:
    """The key's mint time in ms, or None when it is not one of ours."""
    m = KEY_RE.match(key or "")
    return int(m.group(1)) if m else None


# ------------------------------------------------------------- coverage map
#
# ⚠ CLASSIFIED BY READING EACH DISPATCH BRANCH, NOT BY MATCHING NAMES. A verb
# lands in `UNROLLED` because something it does is not inside the transaction
# the receipt shares — a process launch, a file copy, a sidecar write — and
# `test_op_receipts` fails when a verb reachable in the dispatch is missing
# here, so this table cannot quietly go stale.
#
#   TX        the whole effect is the document transaction
#   TX_POST   plus effects that run AFTER `save_org` (drive, transport,
#             smoke run, reap) which the receipt does not prove
#   PRE       an irreversible step runs BEFORE the transaction
#   UNROLLED  an external side effect runs INSIDE the lock and is not rolled
#             back when the transaction is discarded
#   NONE      never reaches the transaction at all — no receipt
#
# Only TX and TX_POST may ever be answered "not applied": for those two, no
# commit means nothing happened anywhere. PRE and UNROLLED answer `unknown`.
TX, TX_POST, PRE, UNROLLED, NONE = ("transaction", "transaction+post",
                                    "pre_transaction", "unrolled_side_effect",
                                    "none")

_COVERAGE_STATIC: dict[str, str] = {
    # -- no document transaction ------------------------------------------
    # read-only branch (api.py, the early `if body.tool in (…)`)
    "orgtree_read_transcript": NONE,
    "orgtree_read_scratch": NONE,
    "orgtree_chart": NONE,
    "orgtree_list_tiers": NONE,
    "orgtree_send_file": NONE,        # copies bytes; no doc transaction to share
    "orgtree_rename": NONE,           # takes DOC_LOCK itself and moves folders
    "orgtree_list_orgs": NONE,        # reads the store and the hub roster
    # -- external side effects that survive a discarded transaction -------
    # `launch_self_restart` / the primed loop start a DETACHED process from
    # inside the lock; the gate's org-log entry rides the save, the process
    # does not.
    "orgtree_self_restart": UNROLLED,
    "orgtree_self_update": UNROLLED,  # the deprecated alias, same branch
    "orgtree_prime_restart": UNROLLED,
    # `restart_wake` persists to its OWN sidecar file (restart_wake._wakes_write),
    # not to the org document — so the doc transaction cannot cover it.
    "orgtree_restart_wake": UNROLLED,
    # `export_predecessor_transcript` copies the predecessor's transcript
    # FILE inside the lock.
    "orgtree_cheap_compact": UNROLLED,
    # `supervisor.interrupt_turn` signals a live process inside the lock.
    "orgtree_interrupt": UNROLLED,
    "orgtree_unstick": TX_POST,
    # -- irreversible work BEFORE the transaction -------------------------
    # both wait for the target's turn boundary (`interrupt_before_archive`)
    # before the lock is taken.
    "orgtree_retire": PRE,
    "orgtree_dissolve": PRE,
    # -- document transaction, plus post-commit effects -------------------
    "orgtree_message": TX_POST,       # drive / @org: / @net: / mail_to
    "orgtree_send_notice": TX_POST,   # notice_to
    "orgtree_hire": TX_POST,          # _seat_finish appends the seat to drive
    # the seat, the item and the assignment in one transaction; the assignment
    # notification drives the seat afterwards exactly as a kickoff does
    "orgtree_staff": TX_POST,
    "orgtree_retool": TX_POST,        # ditto, for a retool that kicks off
    "orgtree_switch_model": TX_POST,  # stale_freeze_resumed wakes
    "orgtree_status": TX_POST,        # done/blocked reports to the parent
    "orgtree_audience": TX_POST,      # drives the grantee/forwarded superior
    "orgtree_ask": TX_POST,           # `routed` → drives the superior
    "orgtree_request_scope": TX_POST,  # ditto
    "orgtree_request_credits": TX_POST,
    "orgtree_present": TX_POST,       # routed when it lands on a superior
    # -- document transaction only ----------------------------------------
    "orgtree_withdraw_ask": TX,
    "orgtree_move": TX,
    "orgtree_swap": TX,
    "orgtree_self_subjugate": TX,
    "orgtree_reallocate": TX,
}

# Verbs whose coverage depends on the ARGUMENTS, not the name (Astra's
# correction: "classification covers actions within multipurpose tools").
_ACTION_COVERAGE: dict[str, dict[str, str]] = {
    # list/get/verify never reach the shared transaction — list/get are
    # answered before the lock and `verify` sequences its own lock → git →
    # lock. Every other action is ordinary docket work inside the transaction.
    # …and the three that can now MAIL AND WAKE the agent an item was handed
    # to are TX_POST, not TX: the notification is posted inside the transaction
    # and the assignee is driven after the save (api's orgtree_work branch), so
    # they have a post-commit effect the plain document actions do not.
    "orgtree_work": {"list": NONE, "get": NONE, "verify": NONE,
                     "assign": TX_POST, "create": TX_POST, "update": TX_POST},
    # arming a dog runs its target ONCE, after the commit, through the same
    # `_wd_popen` the engine uses; the other actions are document-only.
    "orgtree_watchdog": {"create": TX_POST},
}
_ACTION_DEFAULT: dict[str, str] = {
    "orgtree_work": TX,
    "orgtree_watchdog": TX,
}


def coverage(tool: str, args: dict[str, Any] | None = None) -> str:
    """The coverage class of THIS call — arguments included."""
    a = args or {}
    if tool == "orgtree_staff" and str(a.get("node") or "").strip() \
            and str(a.get("staff_mode") or "rehire").lower() != "hire":
        # staff in REHIRE mode runs the same pre-lock rename, and a rename
        # moves folders on disk before any transaction exists to cover it
        return PRE if str(a.get("name") or "").strip() else TX_POST
    if tool == "orgtree_rehire":
        # a rehire that also RENAMES moves folders on disk before the
        # transaction (and the dispatch says so in its own refusal); a plain
        # rehire is an ordinary transaction with a kickoff drive.
        return PRE if str(a.get("name") or "").strip() else TX_POST
    if tool in _ACTION_COVERAGE:
        act = str(a.get("action") or "")
        return _ACTION_COVERAGE[tool].get(act, _ACTION_DEFAULT[tool])
    return _COVERAGE_STATIC.get(tool, "")      # "" = unknown verb


def receipted(tool: str, args: dict[str, Any] | None = None) -> bool:
    """Does this call get a receipt at all? (NONE-class verbs never reach the
    transaction, so there is nothing to commit a receipt with.)"""
    return coverage(tool, args) in (TX, TX_POST, PRE, UNROLLED)


def provable_absence(cls: str) -> bool:
    """May the absence of a receipt be reported as "not applied"?"""
    return cls in (TX, TX_POST)


# ----------------------------------------------------------- fingerprinting

# Stored per tool, and NOTHING outside the list is kept. Astra's ruling: a
# strict field allowlist, not a generic truncation of whatever came back —
# truncating a body still stores a body.
_RESULT_FIELDS: dict[str, tuple[str, ...]] = {
    "orgtree_message": ("delivered", "deferred", "id"),
    "orgtree_send_notice": ("delivered", "deferred", "id"),
    "orgtree_hire": ("node", "name", "tier", "grant", "started"),
    "orgtree_rehire": ("node", "name", "tier", "started"),
    "orgtree_retool": ("node", "started"),
    "orgtree_retire": ("archived", "node"),
    "orgtree_dissolve": ("archived", "node"),
    "orgtree_reallocate": ("node", "delta", "grant"),
    "orgtree_switch_model": ("node", "tier", "queued"),
    "orgtree_status": ("recorded", "reported_to", "delivered"),
    # `item` and `ref` are the canonical identity every docket mutation
    # carries (api._work_mutate sets them before the receipt is filed)
    "orgtree_work": ("created", "updated", "assigned", "id", "slug", "item",
                     "ref", "rev", "status", "notified"),
    # the seat AND the item, because that is what one staff call did
    "orgtree_staff": ("node", "name", "tier", "grant", "started", "item",
                      "created", "updated", "assigned_to"),
    "orgtree_ask": ("id", "routed", "deferred"),
    "orgtree_request_scope": ("id", "routed", "deferred"),
    "orgtree_request_credits": ("id", "routed", "deferred"),
    "orgtree_present": ("id", "presented", "routed", "deferred"),
    "orgtree_watchdog": ("id", "state", "created", "removed"),
    "orgtree_audience": ("granted", "revoked", "routed"),
    "orgtree_move": ("moved",),
    "orgtree_swap": ("swapped",),
    "orgtree_self_subjugate": ("parent",),
    "orgtree_withdraw_ask": ("withdrawn",),
    "orgtree_cheap_compact": ("node", "old_session"),
    "orgtree_interrupt": ("interrupted",),
    "orgtree_unstick": ("released", "warnings"),
    "orgtree_self_restart": ("target",),
    "orgtree_self_update": ("target",),
    "orgtree_prime_restart": ("state", "armed"),
    "orgtree_restart_wake": ("armed", "cancelled", "state"),
}
# identity-shaped arguments worth keeping on the row: node ids, docket item
# ids/slugs, delivery stages and refs. Bodies, charters, kickoffs, questions
# and summaries are deliberately absent.
_TARGET_ARGS = ("node", "to", "id", "slug", "work_item", "ref", "action",
                "stage", "tier", "target", "grantee", "from", "name")


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=str)


def fingerprint(tool: str, node: str, generation: int,
                args: dict[str, Any]) -> str:
    """FULL sha256 (Astra's correction — a truncated fingerprint makes a
    collision between two different calls under one key thinkable) over the
    canonical form of the whole call identity, generation included."""
    return hashlib.sha256(_canonical(
        {"tool": tool, "node": node, "generation": int(generation),
         "args": args}).encode("utf-8")).hexdigest()


def _targets(args: dict[str, Any]) -> dict[str, str]:
    return {k: str(args[k])[:80] for k in _TARGET_ARGS
            if isinstance(args.get(k), (str, int, float, bool))}


def result_slice(tool: str, result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    r = cast("dict[str, Any]", result)
    out: dict[str, Any] = {}
    for k in _RESULT_FIELDS.get(tool, ()):
        if k in r and isinstance(r[k], (str, int, float, bool)):
            out[k] = r[k] if not isinstance(r[k], str) else r[k][:200]
    return out


# --------------------------------------------------------- the log and meta


def _log(d: dict[str, Any], create: bool) -> list[dict[str, Any]]:
    """The receipt rows. ⚠ TOUCHING THIS MATERIALISES THE SECTION, which is
    measured at ~3 ms per call at 300 rows and ~23 ms at 2000
    (evidence/receipt-cost.json) — so nothing calls it unless the request
    actually carries a key."""
    if not create and SECTION not in d:
        return []
    return cast("list[dict[str, Any]]", d.setdefault(SECTION, []))


def _meta(d: dict[str, Any], now_ms: int, create: bool) -> dict[str, Any]:
    m = cast("dict[str, Any] | None", d.get(META))
    if m is None:
        if not create:
            return {}
        # `from_ms` starts at 0: nothing has ever been evicted, so nothing is
        # unprovable yet. There is deliberately NO "receipts began at" time
        # here. One lived here until 2026-09-05 and admitted keys minted
        # within five minutes of it as covered — which is exactly the claim
        # a mint time cannot support (see the module docstring). Coverage is
        # established by the SHAPE of the request, not by its age.
        m = {"schema": SCHEMA, "coverage": COVERAGE, "created_at": now_ms,
             "from_ms": 0, "horizon_ms": HORIZON_MS, "ceiling": CEILING,
             "trim_to": TRIM_TO, "evicted": 0, "seq": 0}
        d[META] = m
    return m


def watermark(d: dict[str, Any]) -> int:
    m = cast("dict[str, Any]", d.get(META) or {})
    return int(m.get("from_ms") or 0)


def seq(d: dict[str, Any]) -> int:
    """How many receipts this document has ever appended. Monotonic within one
    continuously-recording document, and the ONLY thing `_SEEN` compares."""
    m = cast("dict[str, Any]", d.get(META) or {})
    return int(m.get("seq") or 0)


# --------------------------------------------------------------- custody
#
# ⚠ IN MEMORY, DELIBERATELY, AND NOT IN THE DATA ROOT. Both tables below are
# this process's own witness. A file inside `DATA_ROOT` would be restored
# along with the document it is supposed to be judging — which is how the two
# previous attempts failed. Keeping them here means:
#
#   · a restart empties them, so every restore that stops the backend (all of
#     them — it holds the database open) mints a fresh epoch on the next
#     touch, and no key from before can be answered `not_applied`;
#   · a rewind under a LIVE backend is caught by the seq comparison, because
#     the restore cannot reach `_SEEN`.
#
# Keyed by (data root, slug): a test root and the live root never share an
# epoch, and one org's restore does not invalidate another org's keys.

_LOCK = threading.Lock()
_EPOCHS: dict[tuple[str, str], str] = {}
_SEEN: dict[tuple[str, str], int] = {}


def new_epoch() -> str:
    return uuid.uuid4().hex[:16]


def custody(d: dict[str, Any], root: str, slug: str) -> tuple[str, str]:
    """The current epoch for this document, and why it is current.

    Returns (epoch, rotation_reason) where the reason is "" when the epoch was
    already established and this document is still ahead of everything this
    process has written to it. MUST be called inside the caller's `DOC_LOCK`,
    with the document as loaded, before any receipt decision is taken."""
    n, k = seq(d), (root, slug)
    with _LOCK:
        ep, seen = _EPOCHS.get(k), _SEEN.get(k)
        why = ""
        if ep is None:
            # first touch in this process: a restart, a fresh root, or an org
            # this backend has not served since it booted
            why = "boot"
        elif seen is not None and n < seen:
            # this document has FEWER receipts than this process has already
            # appended to it: it was replaced by an older copy while we ran
            why = f"rewound from seq {seen} to {n}"
        if why:
            ep = new_epoch()
            _EPOCHS[k] = ep
            _SEEN[k] = n
        else:
            _SEEN[k] = max(int(seen or 0), n)
        return cast("str", ep), why


def witness(root: str, slug: str, n: int) -> None:
    """Record that THIS PROCESS has committed a document carrying seq `n`.
    Called by the API AFTER `save_org` returned, still under DOC_LOCK — never
    before: a save that raises committed nothing, and a witness advanced for
    it would call the unchanged document a rewind.

    ⚠ `custody()` advances the witness only when it is CALLED, and it is
    called before admission. Without this, a receipt appended and saved with
    no later custody read left the witness at the pre-append seq, so a
    restore to that exact state was indistinguishable from no restore and a
    delayed original was admitted again (Astra's counterexample,
    2026-09-05)."""
    k = (root, slug)
    with _LOCK:
        if k in _EPOCHS:
            _SEEN[k] = max(int(_SEEN.get(k) or 0), int(n))


def witnessed(root: str, slug: str) -> int | None:
    """The highest seq this process has committed for the document, or None
    when it holds no epoch for it. Read-only; for the suite."""
    with _LOCK:
        return _SEEN.get((root, slug))


def forget_custody(root: str = "", slug: str = "") -> None:
    """Drop remembered custody — for tests that emulate a restart, and for a
    document leaving this process's care. No arguments = everything."""
    with _LOCK:
        if not root and not slug:
            _EPOCHS.clear()
            _SEEN.clear()
            return
        _EPOCHS.pop((root, slug), None)
        _SEEN.pop((root, slug), None)


def schema_ahead(d: dict[str, Any]) -> str:
    """A document written by a NEWER receipts build, now being read by this
    one. Its rows were admitted and classified by rules this build does not
    have, so this build cannot say what their absence means — the same
    reasoning that removed the bootstrap grace, applied in the other
    direction. Returns a reason, or "" when this build is current."""
    m = cast("dict[str, Any]", d.get(META) or {})
    if int(m.get("schema") or 0) > SCHEMA:
        return f"row schema {m.get('schema')} > {SCHEMA}"
    if int(m.get("coverage") or 0) > COVERAGE:
        return f"coverage table {m.get('coverage')} > {COVERAGE}"
    return ""


def find(d: dict[str, Any], node: str, key: str) -> dict[str, Any] | None:
    """The row for this key on this node.

    ⚠ GENERATION IS NOT A MATCHER (Astra, 2026-09-05). It was, and that made
    a receipt INVISIBLE the moment the seat's session lineage changed: the
    call applied at generation g, the answer was lost, the seat compacted,
    and then the lookup (which reads the CURRENT generation) found nothing and
    said "not applied — safe to reissue", while a delayed original arriving on
    the same key was admitted and ran a second time. Both are the duplicate
    this file exists to prevent.

    A key belongs to the CALL that minted it, not to an incarnation. Finding
    it under any generation means it has been used; what the generation
    decides is how the row may be ANSWERED, not whether it is seen — see
    `admit` (a foreign generation can never be admitted) and the lookup (which
    compares the fingerprint at the ROW's generation, because that is the one
    it was computed with)."""
    for row in reversed(_log(d, create=False)):
        if row.get("key") == key and row.get("node") == node:
            return row
    return None


def fp_node(row: dict[str, Any]) -> str:
    """The node id this row's fingerprint was computed WITH — which is not
    necessarily the id the row is filed under today, because `rekey_nodes`
    moves a row to the seat's new name after a rename while leaving the
    fingerprint exactly as it was minted."""
    return str(row.get("fp_node") or row.get("node") or "")


def matches(row: dict[str, Any], tool: str, args: dict[str, Any]) -> bool:
    """Does this row identify THIS call? Tool and full fingerprint, computed
    at the row's own subject (`fp_node`) and generation — the ones it was
    minted with. Every claim about a row ("already applied", "fenced",
    "replay") goes through this first: a row's existence under a key says
    nothing about which call it was."""
    fp = fingerprint(tool, fp_node(row), int(row.get("gen") or 0), args)
    return row.get("tool") == tool and row.get("fp") == fp


def classify(row: dict[str, Any] | None, tool: str, args: dict[str, Any]
             ) -> str:
    """"" (no row) | "conflict" (a different call) | "applied" | "fenced"."""
    if row is None:
        return ""
    if not matches(row, tool, args):
        return "conflict"
    return "fenced" if row.get("outcome") == "fenced" else "applied"


_ROW_DETAIL = {
    "applied": "A receipt shows the operation ALREADY APPLIED; do not issue "
               "it again.",
    "fenced": "A lookup FENCED this key: no transaction under it was ever "
              "recorded and none can be now. It did not apply at the "
              "document; issue a fresh key if you mean to do it.",
    "conflict": "The row under this key identifies a DIFFERENT operation; "
                "nothing about this one is recorded.",
    "": "Whether the original call applied is UNKNOWN: its receipt would "
        "have been rolled out of the document by the same event. Do not "
        "assume it failed.",
}


def rekey_nodes(d: dict[str, Any], renamed: dict[str, str]) -> int:
    """Follow a RENAME. `ledger.rename` re-keys every per-node structure in
    the document; the receipt rows are one of them, and without this a call
    that applied under the old id is invisible to a lookup under the new one —
    which reads as "not applied, safe to reissue" about an operation that
    happened.

    ⚠ THE FINGERPRINT IS NEVER RECOMPUTED (Astra's constraint). It covers the
    call's original subject, so `fp_node` records the id it was computed with
    and is written with `setdefault`: a seat renamed A → B → C still
    fingerprints at A, because only the first rename may claim to be where the
    print came from.

    Returns the number of rows moved. Does NOT materialise the section when
    the document has never carried a receipt."""
    if SECTION not in d or not renamed:
        return 0
    moved = 0
    for row in _log(d, create=False):
        old = str(row.get("node") or "")
        if old in renamed:
            row.setdefault("fp_node", old)
            row["node"] = renamed[old]
            moved += 1
    return moved


# ------------------------------------------------------------- admission
#
# Every one of these decisions is taken INSIDE the caller's single DOC_LOCK
# acquisition — the same one that mutates the document and calls `save_org`.
# It cannot move earlier: a check before the lock is a time-of-check /
# time-of-use hole, and two concurrent duplicates would both pass it.

ADMIT, REPLAY, CONFLICT, REFUSE = "admit", "replay", "conflict", "refuse"


def admit(d: dict[str, Any], node: str, generation: int, key: str, tool: str,
          args: dict[str, Any], now_ms: int | None = None, *,
          epoch_ok: bool) -> tuple[str, dict[str, Any]]:
    """Decide what happens to a keyed call. Returns (decision, info).

    `epoch_ok` is REQUIRED and has no default: it is the custody proof (the
    epoch the client was issued still being this process's epoch for this
    document), and a guard with a permissive default is a guard that goes
    missing at the one call site that forgets it."""
    ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    mint = parse_key(key)
    if mint is None:
        return REFUSE, {"reason": "malformed_key",
                        "detail": "op_key must be `<mint_ms>-<24 hex>`"}
    if not epoch_ok:
        # the refusal no clock can reach: the key's epoch was rotated (a
        # restart or a rewind), so this may be the delayed original of a call
        # whose receipt went with the restore. Refuse before dispatch. A row
        # found here is reported for what it IS — applied, fenced or a
        # different call — never as "applied" from its mere existence.
        prior = find(d, node, key)
        return REFUSE, {
            "reason": "stale_epoch", "row": prior,
            "row_state": classify(prior, tool, args),
            "detail": ("this key was issued under an operation epoch that is "
                       "no longer current — the backend restarted, or this "
                       "document was restored — so nothing was done. "
                       + _ROW_DETAIL[classify(prior, tool, args)])}
    if mint > ms + SKEW_MS:
        return REFUSE, {"reason": "key_from_the_future",
                        "detail": f"minted {(mint - ms) / 1000:.0f}s ahead of "
                                  f"this server's clock"}
    if ms - mint > HORIZON_MS:
        return REFUSE, {"reason": "key_stale",
                        "detail": f"minted {(ms - mint) / 1000:.0f}s ago; the "
                                  f"receipt horizon is {HORIZON_MS // 1000}s"}
    row = find(d, node, key)
    if row is not None:
        # classified BEFORE any claim about it, whatever its outcome or
        # generation: a key identifies one call, and a different call under
        # it is a conflict, not a fence and not a replay (`matches` compares
        # at the row's own subject and generation)
        state = classify(row, tool, args)
        if state == "conflict":
            return CONFLICT, {"row": row, "reason": "key_reused",
                              "detail": f"this key already identifies "
                                        f"{row.get('tool')} at {row.get('at')}"}
        if state == "fenced":
            # a lookup already fenced this key: the caller was told the
            # operation had not been recorded, so it must never apply now
            return REFUSE, {"reason": "fenced", "row": row,
                            "row_state": state,
                            "detail": "this key was fenced by a lookup at "
                                      f"{row.get('at')} — it can no longer be "
                                      "admitted; issue a fresh key"}
        if int(row.get("gen") or 0) != int(generation):
            # used by an EARLIER INCARNATION of this seat: never execute,
            # never replay another incarnation's result as this one's
            return REFUSE, {"reason": "foreign_generation", "row": row,
                            "row_state": state,
                            "detail": f"this key was used at generation "
                                      f"{row.get('gen')} and this seat is now "
                                      f"at generation {generation}, so it "
                                      f"will not be run now. "
                                      + _ROW_DETAIL[state]}
        return REPLAY, {"row": row}
    ahead = schema_ahead(d)
    if ahead:
        return REFUSE, {"reason": "schema_ahead",
                        "detail": f"this document's receipts were written by a "
                                  f"newer build ({ahead}); this one cannot "
                                  f"judge them, so the outcome is unknown"}
    # UNCONDITIONAL. It used to be skipped when the document had no meta at
    # all, which made "no receipts have ever been written here" a silently
    # different code path from "receipts exist and nothing was evicted". Both
    # mean a watermark of 0; say so once.
    if mint < watermark(d):
        return REFUSE, {"reason": "horizon_evicted",
                        "detail": "receipts for keys this old have been "
                                  "evicted; the outcome is unknown"}
    return ADMIT, {"mint_ms": mint}


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def append(d: dict[str, Any], row: dict[str, Any], now_ms: int | None = None
           ) -> dict[str, Any]:
    """File a row and evict if the log is over the ceiling. Returns the meta."""
    ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    m = _meta(d, ms, create=True)
    # ⚠ THE COUNTER THIS PROCESS'S WITNESS COMPARES (`custody`). It counts
    # appends, never rows, so an eviction cannot lower it and a rewind cannot
    # hide behind one: a restored document has a SMALLER seq than the number
    # of receipts we have written into it, and that is the whole detection.
    m["seq"] = int(m.get("seq") or 0) + 1
    log = _log(d, create=True)
    log.append(row)
    if len(log) > CEILING:
        # ONE eviction rule, and it runs in a batch: the trim rewrites the
        # whole section (measured — the SQLite row seqs are renumbered),
        # while an ordinary append does not, so paying it once per
        # CEILING-TRIM_TO calls is the difference between ~6 ms and ~6 ms
        # amortised instead of every call.
        cut = len(log) - TRIM_TO
        evicted = log[:cut]
        # ⚠ THE WATERMARK MOVES PAST THE LARGEST MINT TIME EVICTED, not past
        # the newest row's `at`. A key minted with allowed future skew can be
        # evicted while its mint time is still ahead of "now" — comparing
        # against `at` would leave exactly that key admissible with its
        # receipt gone, which is the one thing this design must never do.
        hi = max((int(r.get("mint_ms") or 0) for r in evicted), default=0)
        m["from_ms"] = max(int(m.get("from_ms") or 0), hi + 1)  # monotonic: a
        # clock that rolls back can never lower a watermark already raised
        m["evicted"] = int(m.get("evicted") or 0) + len(evicted)
        d[SECTION] = log[cut:]      # slice assignment — the batched rewrite
    return m


def row(*, op_id: str, node: str, generation: int, key: str, mint_ms: int,
        tool: str, args: dict[str, Any], cls: str, outcome: str, at: str,
        result: Any = None, ev: tuple[int | None, int | None] = (None, None),
        post_expected: list[str] | None = None,
        summary: str = "") -> dict[str, Any]:
    """One receipt row. Note what is NOT here: no argument bodies, no charter,
    no kickoff, no question text — only a full fingerprint and identity-shaped
    arguments."""
    r: dict[str, Any] = {
        "v": SCHEMA, "id": op_id, "at": at, "mint_ms": int(mint_ms),
        "node": node, "gen": int(generation), "tool": tool, "key": key,
        "fp": fingerprint(tool, node, generation, args),
        "targets": _targets(args), "cls": cls, "outcome": outcome,
    }
    if summary:
        r["summary"] = summary[:200]
    if outcome == "applied":
        r["result"] = result_slice(tool, result)
        # DOCUMENT events only. These are indices into the unbounded `events`
        # log and say nothing about post-commit effects.
        r["ev_from"], r["ev_to"] = ev
        r["post_effects"] = {
            # what the dispatch will attempt after `save_org` …
            "expected": list(post_expected or []),
            # … and the honest state of every one of them. NOT `false`:
            # false reads as "failed", and nothing here observed anything.
            "observed": "unknown",
        }
    return r


# ------------------------------------------------ reading back, for the agent
#
# Phase 2 of w71d69aac: the net-retry banner (supervisor.resume_frozen) names
# the operations a dying turn had already committed. These two are the whole
# read API it uses. Both are pure; neither creates the section.


def at_ms(row: dict[str, Any]) -> int | None:
    """The row's filing time — `at`, minted by `ledger.now()` on the server's
    clock when the receipt was appended — in ms, or None when it does not
    parse. ⚠ NOT `mint_ms`: that is the CLIENT's clock at key mint, and the
    bound it is compared with is a server stamp (`_run_one_turn` entry), so
    the comparison has to be server clock against server clock."""
    s = str(row.get("at") or "")
    try:
        d = _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        try:
            d = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    return int(d.timestamp() * 1000)


def applied_since(d: dict[str, Any], node: str, since_ms: int
                  ) -> list[dict[str, Any]]:
    """The receipts this node COMMITTED at or after `since_ms`, in filing
    order.

      · `outcome == "applied"` only. A fenced row records that a lookup found
        the key UNRECORDED — a call that did not apply is not something the
        agent must avoid repeating.
      · GENERATION IS NOT A FILTER. A cheap-compact can land mid-turn and bump
        the seat's generation without ending the turn; the seat that filed
        the row is the seat being told about it.
      · a row whose `at` does not parse is left out — rows drop out
        conservatively, none are ever invented — and a clock stepped backwards
        between the bound and the filing hides a row the same way.

    Does not materialise the section when the document has never carried a
    receipt (`_log(create=False)`)."""
    out: list[dict[str, Any]] = []
    for r in _log(d, create=False):
        if r.get("node") != node or r.get("outcome") != "applied":
            continue
        ms = at_ms(r)
        if ms is None or ms < int(since_ms):
            continue
        out.append(r)
    return out
