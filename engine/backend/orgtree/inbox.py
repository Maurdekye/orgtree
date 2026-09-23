"""The manual inbox: an agent's own view of its waiting mail (M1+M2a).

THE DOOR IS CLOSED: there is no door. No tool card, agent_call selector or
dispatcher reaches this module or the supervisor's `manual_*` functions; only
the tests do. A door may be added only after the all-provider identity (P04),
original-key receipt and durable attempt (P06) and trusted input-evidence
(P08) gates are met, as a separate, reviewed P01 surface change that must
validate its arguments with `check_args` before calling anything here.

P06a (still no door) adds the original-key receipt of a keyed fetch, filed in
the fetch's own single save, and a durable ATTEMPT record per delivery that
outlives its journal row. P06b makes a KEYED chunk call a receipted
transaction: its call is recorded on the attempt (`chunk_calls`) and its key
replays the same bytes. Two things stay PROVISIONAL, closed compatibility
only, and are not C1 §E compliance: the unkeyed chunk read (internal, never a
door path) and the chunk 0 a fetch serves inline, which is no chunk's
original call. C1 §E still owes a dedicated keyed call for EVERY chunk,
including 0, bound to trusted provider call evidence (P08).

This module is PURE. It reads a loaded document plus a self-view state map the
supervisor computed from the shared ownership classifier, and returns plain
data. It takes no lock, loads and saves nothing, writes no field and mints no
identity; the one thing it computes that the supervisor later stores is a
chunk plan, which is a function of the message body alone.

Three rules carry the design:

  * SELF ONLY. The mailbox is the authenticated caller's own. No argument can
    name another agent's; a target-shaped argument is refused with one fixed
    text that never depends on whether the named peer exists.
  * LIST IS INSPECTION. It reports what is waiting and where it is, including
    mail already drained into a journal batch, and changes nothing. Notices
    (`kind == "notice"`) are ordinary mail here; the separate org-change
    notice queue is only counted.
  * FETCH NEVER TRUNCATES. A body is served whole or in chunks fixed at drain
    time (`chunk_plan`), with a digest of the whole body on every chunk. A
    message that does not fit the response budget is deferred, not cut.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any, Final

from .ledger import Org

LIST_DEFAULT: Final = 50
LIST_MAX: Final = 200
FETCH_MAX_IDS: Final = 20
#: Bytes of message content one fetch may return (inline bodies plus chunks).
FETCH_BUDGET_BYTES: Final = 256 * 1024
#: Largest single chunk; a body above this is served in chunks.
CHUNK_BYTES: Final = 64 * 1024
PREVIEW_CHARS: Final = 200
#: The receipt name of the manual inbox (opreceipts coverage and result fields).
TOOL: Final = "orgtree_inbox"
#: Resolved attempt records kept per mailbox; an open one is never dropped.
ATTEMPTS_KEEP: Final = 40
#: Distinct keyed chunk calls one delivery may record, per chunk it holds. At
#: the bound a new distinct call is refused before anything is served; no
#: recorded call is ever evicted.
CHUNK_CALLS_PER_CHUNK: Final = 4

#: Why no fetch can be confirmed yet. Returned on every fetch result.
WILL_REDELIVER_REASON: Final = (
    "no trusted input-evidence adapter exists for this runtime yet, so this "
    "fetch cannot be confirmed: the mail returns to your mailbox when this turn "
    "ends and you will see it again")

#: The single refusal for anything that tries to name a mailbox. It is a
#: constant so it cannot depend on the value, on the document, or on whether
#: the named agent exists.
TARGET_REFUSAL: Final = ("the manual inbox reads only your own mailbox; it "
                         "takes no agent, node, org or mailbox argument")

_ARGS: Final = {"list": frozenset({"cursor", "limit"}),
                "fetch": frozenset({"message_ids"}),
                "chunk": frozenset({"delivery_id", "message_id", "chunk_index"})}


def refusal(code: str, text: str, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "error": code, "text": text, **extra}


def check_args(action: Any, args: Any) -> dict[str, Any] | None:
    """None when `args` is acceptable for `action`, else a refusal.

    Any key outside the action's own set is refused with `TARGET_REFUSAL`,
    whatever the key or value: a door with no target parameter has nothing
    to authorize, and one fixed text leaks nothing about other agents."""
    if action not in _ARGS:
        return refusal("unknown_action", "the manual inbox supports list, "
                       "fetch and chunk")
    if not isinstance(args, Mapping):
        return refusal("bad_arguments", "arguments must be an object")
    if set(args) - _ARGS[action]:
        return refusal("target_refused", TARGET_REFUSAL)
    return None


# --------------------------------------------------------------------------
# chunk plan
# --------------------------------------------------------------------------

def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def chunk_plan(body: str, *, size: int = CHUNK_BYTES) -> dict[str, Any]:
    """The immutable chunk plan for one body: UTF-8 byte offsets, per-chunk
    digests and the digest of the whole.

    Boundaries never split a UTF-8 sequence, so each chunk decodes on its own
    and the chunks concatenate to the exact body. An empty body is one empty
    chunk, so every message has at least chunk 0."""
    data = body.encode("utf-8")
    chunks = []
    start = 0
    while True:
        end = min(start + size, len(data))
        while end < len(data) and (data[end] & 0xC0) == 0x80:
            end -= 1                      # back off a continuation byte
        chunks.append({"offset": start, "length": end - start,
                       "sha256": _sha(data[start:end])})
        if end >= len(data):
            break
        start = end
    return {"body_bytes": len(data), "body_sha256": _sha(data),
            "chunk_total": len(chunks), "chunks": chunks}


def chunk_text(body: Any, plan: Any, index: Any) -> str | None:
    """Chunk `index` of `body` exactly as `plan` fixed it, or None.

    None when the plan is malformed, the index is out of range, or the stored
    body no longer produces the recorded digests. Nothing is re-sliced to fit
    a body that changed."""
    if (not isinstance(body, str) or not isinstance(plan, Mapping)
            or isinstance(index, bool) or not isinstance(index, int)):
        return None
    chunks = plan.get("chunks")
    if not isinstance(chunks, list) or not 0 <= index < len(chunks):
        return None
    data = body.encode("utf-8")
    if _sha(data) != plan.get("body_sha256") or len(data) != plan.get("body_bytes"):
        return None
    c = chunks[index]
    if not isinstance(c, Mapping):
        return None
    off, length = c.get("offset"), c.get("length")
    if (isinstance(off, bool) or isinstance(length, bool)
            or not isinstance(off, int) or not isinstance(length, int)):
        return None
    part = data[off:off + length]
    if len(part) != length or _sha(part) != c.get("sha256"):
        return None
    return part.decode("utf-8")


def confirmation_complete(record: Any, evidence: Mapping[Any, Any]) -> bool:
    """Would `evidence` confirm this manual batch? Only with matched evidence
    for EVERY chunk index of EVERY message.

    `evidence` maps `(message_id, chunk_index)` to a truthy matched record.
    The last chunk alone, or all but one, confirms nothing. No caller exists
    yet: this is the rule the P08 confirmation stage must use."""
    if not isinstance(record, Mapping) or not isinstance(record.get("plan"), Mapping):
        return False
    plan = record["plan"]
    if not plan:
        return False
    for mid, entry in plan.items():
        total = entry.get("chunk_total") if isinstance(entry, Mapping) else None
        if isinstance(total, bool) or not isinstance(total, int) or total < 1:
            return False
        if not all(evidence.get((mid, i)) for i in range(total)):
            return False
    return True


# --------------------------------------------------------------------------
# rows
# --------------------------------------------------------------------------

def _body_bytes(row: Mapping[str, Any]) -> int | None:
    body = row.get("body")
    return len(body.encode("utf-8")) if isinstance(body, str) else None


def _preview(row: Mapping[str, Any]) -> str | None:
    body = row.get("body")
    if not isinstance(body, str):
        return None
    return body.split("\n", 1)[0][:PREVIEW_CHARS]


def _attachments(row: Mapping[str, Any]) -> list[dict[str, Any]]:
    out = []
    for a in row.get("attachments") or []:
        if isinstance(a, Mapping):
            out.append({"name": a.get("name"), "bytes": a.get("bytes")})
    return out


def message_meta(row: Mapping[str, Any]) -> dict[str, Any]:
    """Identity, delivery facts, attachment names/sizes, body size and a
    bounded first-line preview. Never the body, never a path."""
    return {"message_id": row.get("id"),
            **({"durable_message_id": row["message_id"]} if "message_id" in row else {}),
            "operation_id": row.get("operation_id"),
            "recv_seq": row.get("recv_seq"), "seq_origin": row.get("seq_origin"),
            "from": row.get("from"), "kind": row.get("kind"),
            "wakes": row.get("kind") != "notice", "at": row.get("at"),
            "redelivered": int(row.get("redelivered") or 0)
            if isinstance(row.get("redelivered"), int) else 0,
            "attachments": _attachments(row), "body_bytes": _body_bytes(row),
            "preview": _preview(row)}


def _key(row: Any, mine: str | None, position: int) -> tuple[int, int, str, int]:
    """Keyset position: ordered rows by `recv_seq`, then an unordered tail by
    message id. Same ordered/unordered rule as `Org.mailbox_in_receive_order`.
    A row without a readable id sorts last by position, which is the one case
    a cursor cannot keep stable, and says so by carrying no id."""
    if not isinstance(row, Mapping):
        return (2, 0, "", position)
    seq = Org._recv_ordinal(row.get("recv_seq"))
    own = ("mailbox" not in row) or (
        mine is not None and Org._mailbox_stamp(row["mailbox"]) == mine)
    mid = row.get("id") if isinstance(row.get("id"), str) and row.get("id") else None
    if seq is not None and own:
        return (0, seq, mid or "", 0)
    if mid is not None:
        return (1, 0, mid, 0)
    return (2, 0, "", position)


def pending_rows(org: Any, nid: str, states: Mapping[str, str]) -> list[dict[str, Any]]:
    """Every waiting message of this mailbox, in keyset order: the box plus
    every journal batch, each with its self-view state. A manual batch
    stamped with another seat (P04a-1) is not this seat's and is not listed;
    it stays protected where it is."""
    node = org.nodes.get(nid) or {}
    mine = Org._mailbox_stamp(node.get("mailbox_id"))
    out: list[tuple[tuple[int, int, str, int], dict[str, Any]]] = []
    position = 0
    for row in org.mailbox_in_receive_order(nid):
        entry = message_meta(row) if isinstance(row, Mapping) else {"message_id": None}
        entry.update(state="queued", delivery=None)
        out.append((_key(row, mine, position), entry))
        position += 1
    for batch in (org.d.get("delivering") or {}).get(nid) or []:
        if not isinstance(batch, Mapping):
            continue
        tok = batch.get("tok")
        state = states.get(tok, "unavailable") if isinstance(tok, str) else "unavailable"
        manual = batch.get("manual") if isinstance(batch.get("manual"), Mapping) else None
        if seat_mismatch(manual, node):
            continue
        delivery = {"mode": batch.get("mode"), "via": batch.get("via"),
                    "drained_at": batch.get("at"), "attempt": batch.get("attempt"),
                    **({"delivery_id": manual.get("delivery_id")} if manual else {})}
        for row in batch.get("mail") or []:
            entry = message_meta(row) if isinstance(row, Mapping) else {"message_id": None}
            entry.update(state=state, delivery=delivery)
            out.append((_key(row, mine, position), entry))
            position += 1
    out.sort(key=lambda p: p[0])
    for key, entry in out:
        entry["_key"] = list(key)
        entry["ordered"] = key[0] == 0
    return [entry for _, entry in out]


# --------------------------------------------------------------------------
# cursor
# --------------------------------------------------------------------------

def encode_cursor(mailbox: Any, generation: Any, key: list[Any], seat: Any = None) -> str:
    raw = json.dumps({"v": 1, "m": mailbox, "g": generation, "k": key, "s": seat},
                     separators=(",", ":"), sort_keys=True)
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def decode_cursor(cursor: Any) -> dict[str, Any] | None:
    if not isinstance(cursor, str) or not cursor:
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except (ValueError, binascii.Error, UnicodeError):
        return None
    k = d.get("k") if isinstance(d, dict) else None
    if (not isinstance(d, dict) or d.get("v") != 1 or not isinstance(k, list)
            or len(k) != 4 or not all(isinstance(x, int) and not isinstance(x, bool)
                                      for x in (k[0], k[1], k[3]))
            or not isinstance(k[2], str)):
        return None
    return d


def cursor_current(c: Mapping[str, Any], mailbox: Any, generation: Any, seat: Any) -> bool:
    """A decoded cursor still names this seat's mailbox identity and
    generation. A cursor without a seat (issued before P04a-1), or for a seat
    that has none, is not current."""
    return (c["m"] == mailbox and c["g"] == generation
            and bool(seat) and c.get("s") == seat)


def build_list(org: Any, nid: str, states: Mapping[str, str], *,
               generation: Any, cursor: Any = None, limit: Any = None) -> dict[str, Any]:
    """The `list` result. Pure.

    The cursor is bound to this mailbox's identity AS FOUND (absent stays
    absent), to the caller's generation and (P04a-1) to the seat — the
    principal — never to an array index: a page resumes strictly after the
    last key it returned, so rows consumed between pages cannot shift an
    unseen row out of reach. The seat is what refuses a same-name successor's
    cursor when neither seat has minted a mailbox yet; a cursor issued before
    the seat binding carries none and reads as stale."""
    if limit is None:
        limit = LIST_DEFAULT
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= LIST_MAX:
        return refusal("limit_out_of_range", f"limit must be 1..{LIST_MAX}")
    node = org.nodes.get(nid) or {}
    mailbox = node.get("mailbox_id")
    seat = node.get("seat_id")
    rows = pending_rows(org, nid, states)
    if cursor is not None:
        c = decode_cursor(cursor)
        if c is None:
            return refusal("cursor_invalid", "the cursor is not one this inbox issued")
        if not cursor_current(c, mailbox, generation, seat):
            return refusal("cursor_stale", "the cursor belongs to another seat, mailbox "
                           "identity or generation; list again without a cursor")
        after = tuple(c["k"])
        rows = [r for r in rows if tuple(r["_key"]) > after]
    page, rest = rows[:limit], rows[limit:]
    next_cursor = (encode_cursor(mailbox, generation, page[-1]["_key"], seat)
                   if rest and page else None)
    for r in page:
        r.pop("_key", None)
    notices = (org.d.get("notices") or {}).get(nid) or []
    return {"ok": True,
            **({"mailbox_id": mailbox} if "mailbox_id" in node else {}),
            "generation": generation, "rows": page,
            "next_cursor": next_cursor, "has_more": bool(rest),
            "notices_pending": len(notices) if isinstance(notices, list) else None}


# --------------------------------------------------------------------------
# fetch
# --------------------------------------------------------------------------

def normalize_ids(message_ids: Any) -> tuple[list[str], dict[str, Any] | None]:
    """Explicit, well-formed, at most `FETCH_MAX_IDS`, first occurrence kept."""
    if isinstance(message_ids, (str, bytes)) or not isinstance(message_ids, (list, tuple)):
        return [], refusal("bad_arguments", "message_ids must be a list of ids")
    if not message_ids:
        return [], refusal("bad_arguments", "name at least one message id")
    out: list[str] = []
    for mid in message_ids:
        if not isinstance(mid, str) or not mid:
            return [], refusal("bad_arguments", "every message id must be a non-empty string")
        if mid not in out:
            out.append(mid)
    if len(out) > FETCH_MAX_IDS:
        return [], refusal("too_many_ids", f"at most {FETCH_MAX_IDS} ids per fetch")
    return out, None


def fit_budget(requested: Iterable[str], box: Mapping[str, Mapping[str, Any]],
               *, budget: int = FETCH_BUDGET_BYTES) -> tuple[list[str], list[dict[str, Any]], list[str]]:
    """Split boxed ids into (take, deferred, unsupported) under the budget.

    A body above `CHUNK_BYTES` costs its first chunk; the rest is read by
    continuation. A message whose cost does not fit what is left is deferred
    with its size, and stays in the mailbox untouched."""
    take, deferred, unsupported = [], [], []
    left = budget
    for mid in requested:
        row = box.get(mid)
        if row is None:
            continue
        size = _body_bytes(row)
        if size is None:
            unsupported.append(mid)
            continue
        cost = chunk_plan(row["body"])["chunks"][0]["length"]
        if cost > left:
            deferred.append({"message_id": mid, "body_bytes": size})
            continue
        left -= cost
        take.append(mid)
    return take, deferred, unsupported


def manual_record(ident: Mapping[str, Any], *, engine: str, delivery_id: str,
                  mail: Iterable[Mapping[str, Any]], seat: Any) -> dict[str, Any]:
    """The journal row's `manual` record: who fetched it (its seat, the
    principal, since P04a-1), the continuation handle, and every message's
    immutable chunk plan."""
    return {**{k: ident[k] for k in ("mailbox", "generation", "session", "attempt")},
            "seat": seat, "engine": engine, "delivery_id": delivery_id,
            "plan": {m["id"]: chunk_plan(m["body"]) for m in mail}}


def fetched_item(row: Mapping[str, Any], plan: Mapping[str, Any],
                 delivery_id: str, index: int = 0) -> dict[str, Any]:
    """One message's content as served: chunk `index` plus the whole-body
    digest, so the reader can verify each chunk and the reassembled body."""
    text = chunk_text(row.get("body"), plan, index)
    chunk = plan["chunks"][index] if text is not None else None
    return {**message_meta(row), "delivery_id": delivery_id,
            "body_sha256": plan.get("body_sha256"), "chunk_index": index,
            "chunk_total": plan.get("chunk_total"),
            "chunk_sha256": chunk.get("sha256") if chunk else None,
            "content": text, "content_state": "present" if text is not None else "unsupported",
            "complete": text is not None and plan.get("chunk_total") == 1}


def disclosure() -> dict[str, Any]:
    return {"confirmable": False, "will_redeliver": True,
            "will_redeliver_reason": WILL_REDELIVER_REASON}


def fetch_counts(result: Mapping[str, Any]) -> dict[str, int]:
    """The scalar sizes of a fetch result: what its receipt can still say
    when the response that carried the lists was lost."""
    return {count: len(result.get(key) or []) for count, key in (
        ("fetched_count", "fetched"), ("deferred_count", "deferred_ids"),
        ("already_moved_count", "already_moved"), ("not_found_count", "not_found"),
        ("unsupported_count", "unsupported_ids"))}


# --------------------------------------------------------------------------
# durable attempt (P06a)
# --------------------------------------------------------------------------

def attempt_record(record: Mapping[str, Any], *, tok: str, at: str,
                   op_key: str | None, op_id: str | None) -> dict[str, Any]:
    """What one fetch handed out, kept after its journal row is gone.

    It is evidence of what was GIVEN, never of what was read: it confirms
    nothing. The provider's call identity is not supplied on any lane yet
    (P08); it is recorded as absent and never inferred."""
    plan = record.get("plan") or {}
    return {"v": 1, "at": at, "tok": tok,
            **{k: record.get(k) for k in ("mailbox", "generation", "session",
                                          "attempt", "engine", "delivery_id")},
            **({"seat": record["seat"]} if "seat" in record else {}),
            "op_key": op_key, "op_id": op_id, "mail_ids": list(plan),
            "digests": {mid: {"chunk_total": p.get("chunk_total"),
                              "body_sha256": p.get("body_sha256")}
                        for mid, p in plan.items() if isinstance(p, Mapping)},
            "provider_call_id": None, "call_id_source": "unsupplied",
            "resolved": None, "chunk_calls": []}


def chunk_call_record(item: Mapping[str, Any], *, op_key: str, op_id: str,
                      at: str) -> dict[str, Any]:
    """One keyed chunk call as served: which chunk, its digest and the call's
    key and receipt. The provider's own call identity is not supplied yet
    (P08); it is recorded as absent and never inferred. Confirms nothing."""
    return {"message_id": item.get("message_id"), "chunk_index": item.get("chunk_index"),
            "chunk_sha256": item.get("chunk_sha256"), "op_key": op_key, "op_id": op_id,
            "at": at, "provider_call_id": None, "call_id_source": "unsupplied"}


def chunk_call_bound(att: Mapping[str, Any]) -> int:
    """How many distinct keyed chunk calls this delivery may record: 0 when
    its digests are unreadable, so an unreadable record refuses."""
    total = 0
    for d in (att.get("digests") or {}).values() if isinstance(att.get("digests"), Mapping) else ():
        n = d.get("chunk_total") if isinstance(d, Mapping) else None
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            return 0
        total += n
    return CHUNK_CALLS_PER_CHUNK * total


def transition_state(org: Any, nid: str, delivery_id: str) -> str | None:
    """`redelivered` or `confirmed` from a POSITIVE transition receipt that
    names this delivery, `unknown` from one of any other outcome, None when
    no receipt names it."""
    found = None
    for receipt in ((org.d.get("mail_transitions") or {}).get(nid) or {}).values():
        if (isinstance(receipt, Mapping) and isinstance(receipt.get("deliveries"), Mapping)
                and delivery_id in receipt["deliveries"].values()):
            found = {"reclaimed": "redelivered",
                     "confirmed": "confirmed"}.get(receipt.get("outcome"), "unknown")
    return found


def attempt_open(att: Mapping[str, Any], org: Any, nid: str) -> bool:
    """Its batch is still journaled, or any of its mail is still waiting."""
    batches = [b for b in (org.d.get("delivering") or {}).get(nid) or []
               if isinstance(b, Mapping)]
    if att.get("tok") in {b.get("tok") for b in batches}:
        return True
    waiting = {m.get("id") for m in (org.d.get("mail") or {}).get(nid) or []
               if isinstance(m, Mapping)}
    waiting |= {m.get("id") for b in batches for m in b.get("mail") or []
                if isinstance(m, Mapping)}
    return any(mid in waiting for mid in att.get("mail_ids") or [])


def seat_mismatch(record: Any, node: Mapping[str, Any]) -> bool:
    """A record stamped with a seat that is not this node's (P04a-1). An
    unstamped record (written before the stamp) is not a mismatch: it keeps
    the mailbox/generation checks it always had."""
    return (isinstance(record, Mapping) and "seat" in record
            and record.get("seat") != node.get("seat_id"))


def gone_state(org: Any, nid: str, delivery_id: str) -> dict[str, Any]:
    """Where a delivery whose journal row is gone went, from positive records
    only: its transition receipt, else its resolved attempt, else `unknown`.
    Absence proves nothing. An attempt stamped with another seat is not this
    seat's delivery: `unavailable`, and nothing of it is reported."""
    att = ((org.d.get("manual_attempts") or {}).get(nid) or {}).get(delivery_id)
    if seat_mismatch(att, org.nodes.get(nid) or {}):
        return {"content_state": "unavailable", "attempt_recorded": False}
    state = transition_state(org, nid, delivery_id)
    if state is None and isinstance(att, Mapping) and att.get("resolved") in (
            "redelivered", "confirmed"):
        state = att["resolved"]
    return {"content_state": state or "unknown",
            "attempt_recorded": isinstance(att, Mapping)}
