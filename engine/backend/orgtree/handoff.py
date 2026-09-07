"""Verified handoff record — a citation index across a session boundary.

Audit §3 / reset-action-plan item 15 (Astra-approved contract 2026-09-05,
mail-ack-contract/handoff-contract.md v2). When a seat's SESSION is replaced
(cross-provider `switch_model`, `cheap_compact`), the successor starts with
no memory. This module builds a bounded, deterministic RECORD from the files
that boundary already leaves behind — the exported transcript, the D-229
prompt-view sidecar, the node doc, the mailbox, the mooted ask — so the
successor (or a reviewer) has something it can CHECK rather than trust.

What the record is NOT: memory, a summary written by a model, or a claim of
provider-context continuity. `continuity.provider_context` is the constant
"none". No provider call is made anywhere in this module.

Rules (each executable in `verify`, each with a rejected forgery in
tests/test_handoff_record.py):

  V0 the transcript named by hash must be the transcript in hand
  V1 RECONSTRUCTION: `extract(inputs, lines)` re-run from the artifact's own
     captured inputs must deep-equal `record` — a forged quotation, role,
     pair, excerpt, omission or seat differs from the rebuild
  I1 no private reasoning. THE GUARANTEE IS STRUCTURAL, not the scan: an
     assistant row yields `text` and `tool_use` and NOTHING else, so any
     reasoning form — Claude's `thinking`, a future `redacted_thinking`, a
     provider's own block type — is never read in the first place, and is
     counted by type name as an `unrecognized_assistant_block:<type>`
     omission. What each lane actually persists, read in the writers
     (2026-09-05): the codex leg turns a `reasoning` item into exactly
     Claude's shape, `{"type": "thinking", "thinking": …, "signature":
     "codex"}` (supervisor.py `_codex_item` ~10750); the antigravity and
     openrouter legs persist only `text`, `tool_use` and `tool_result`
     (supervisor.py ~12078/12152/12172, ~11100), and journalled user rows
     only `text`, `image` and `tool_result` (~6182). The scan is
     SUPPLEMENTAL and has two halves under ONE rule — private text that
     also exists verbatim in an admissible source is not private, and
     neither half reports it: exact containment for whole strings shorter
     than LEAK_GUARANTEE, `leak_fragments` above it, which catches a
     TRUNCATED leak (any contiguous run of ≥ LEAK_GUARANTEE private chars
     that reached the artifact). Measured cost of a whole publication
     inside the caller's DOC_LOCK, 2026-09-05: 0.09 s on a real 1.5 MB
     session, 0.81 s on an 8.4 MB one carrying 6 MB of unsealed reasoning;
     the scan's own memory is a flat 8 MB filter
     (evidence/handoff/cost_publication.json)
  I2 every quotation's role equals the cited line's record type, the line
     hash matches, unprojected text is a decoded substring of the cited
     content, projected text equals the captured view text for that line
  I3 independent recount of thinking/signature/sidechain/compaction/orphan/
     unpaired rows equals the omission counts
  I4 STRUCTURED file references only (artifact list; file_path/notebook_path
     args of Write/Edit/MultiEdit/NotebookEdit/Read/NotebookRead) lie inside
     the captured grants. ⚠ Quoted text, mail bodies, commands and result
     excerpts are NOT path-filtered — no free-text grant claim is made.
  I5 continuity constants
  A1-A3 ANCHORS (optional): captured views/seat/mailbox against the live
     sidecar rows / node doc / mailbox. Without an anchor a CONSISTENT
     forgery of a captured input passes; `verify` says which anchors ran.

Publication: a generation directory `handoff-g<gen>/` holding record.json,
record.md and manifest.json (sha256 of both) is staged privately and
published by ONE directory rename; `read_generation` requires the manifest
and matching hashes, so a partial or stale generation is never read as
complete. An existing generation is never overwritten.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import uuid
from typing import Any, Iterable

V = 3
#: versions a READER accepts; writing is always V. Records published before a
#: shape change are on disk in live scratch dirs — publication does not wait for
#: the flag — and a version bump must not make them vanish. An older record
#: still reads and still splices; it cannot pass THIS version's `verify`, which
#: rebuilds the current shape. `read_generation` reports which version it read.
V_READABLE = (2, 3)
KIND = "orgtree.handoff"
CAP_TEXT = 1200       # chars quoted per user/assistant item
CAP_RESULT = 400      # chars of a tool result excerpt
CAP_CMD = 200
KEEP_USER = 8         # last N human user rows (plus the first)
KEEP_ASSISTANT = 6    # last N assistant final texts / claims
# selected history (spec: mail-ack-contract/selected-history-spec.md)
SEL_RADIUS = 2        # admitted units either side of a quoted one — a CHOICE
SEL_ROWS = 24         # admitted rows, where a row is one admitted BLOCK
SEL_CHARS = 20000     # RENDERED characters of the section, heading included
SEL_HEADING = ("## Selected history (rows next to the quoted ones; nothing is "
               "admitted here that the rules above do not already admit)")
#: kinds of admitted unit, in the fixed order the §3 tiebreak uses
SEL_KIND_ORDER = {"user_text": 0, "assistant_text": 1, "tool_call": 2}
ARTIFACT_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})
PATH_ARG_TOOLS = ARTIFACT_TOOLS | {"Read", "NotebookRead"}
CLAIM_TOOLS = ("orgtree_status", "orgtree_message", "orgtree_send_notice", "orgtree_ask")
ENVELOPE_RE = re.compile(r"^\s*\[(ORG STATE|MAIL|ORG NOTICES|PROVIDER USAGE|BREADCRUMBS)\b")
SEAT_KEYS = ("charter", "team_charter", "parent", "grant", "last_status")
RECORD_JSON, RECORD_MD, MANIFEST = "record.json", "record.md", "manifest.json"
STATEMENT = ("The provider session did NOT carry over. This record is derived "
             "from durable files at the boundary; it is a citation index, not memory.")
AUTHORITY = ("No item here has authority of its own. Each quoted item keeps its "
             "original author's role; a predecessor claim is a claim, not a fact, "
             "until its ref is checked.")


def sha256(s: str | bytes) -> str:
    b = s.encode("utf-8") if isinstance(s, str) else s
    return hashlib.sha256(b).hexdigest()


def _cap(s: str, n: int) -> tuple[str, bool]:
    return (s, False) if len(s) <= n else (s[:n], True)


def _under(path: str, roots: Iterable[str]) -> bool:
    p = os.path.normcase(os.path.abspath(path))
    for r in roots:
        rr = os.path.normcase(os.path.abspath(r))
        if p == rr or p.startswith(rr.rstrip("\\/") + os.sep):
            return True
    return False


def _kind_label(v: Any) -> str:
    """A row/block TYPE NAME, safe to use as an omission key: the name only,
    never content. A transcript is provider output, so its type field is not
    trusted to be short or to be a name at all."""
    s = re.sub(r"[^A-Za-z0-9_.\-]", "", str(v))[:24]
    return s or "unnamed"


def _user_text(content: Any) -> str | None:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                return str(b.get("text") or "")
    return None


def _result_body(b: dict[str, Any]) -> str:
    body = b.get("content")
    if isinstance(body, list):
        body = "\n".join(str(x.get("text") or "") for x in body if isinstance(x, dict))
    return str(body or "")


def _loads(line: str) -> dict[str, Any] | None:
    try:
        rec = json.loads(line)
    except ValueError:
        return None
    return rec if isinstance(rec, dict) else None


# ------------------------------------------------------ selected history
def _ukey(u: Any) -> tuple[int, str, int]:
    u = u if isinstance(u, dict) else {}
    return (int(u.get("line") or 0), str(u.get("kind") or ""),
            int(u.get("index") or 0))


def render_selected_row(e: dict[str, Any]) -> str:
    """ONE renderer: the section's budget measures exactly what `render_md`
    writes, because both call this. A second formatter is how a budget starts
    lying about the thing it bounds."""
    u = e.get("unit") or {}
    return (f"- [{e.get('role')} · L{u.get('line')}#{u.get('index')} · d{e.get('distance')}"
            f"{' · projected' if e.get('projected') else ''}] "
            f"{e.get('text', '')}{' …[cut]' if e.get('truncated') else ''}")


def render_selected(entries: list[dict[str, Any]]) -> str:
    body = [render_selected_row(e) for e in entries] or ["- (none)"]
    return SEL_HEADING + "\n" + "\n".join(body) + "\n"


def _select_history(seq: list[dict[str, Any]], *, anchors: list[dict[str, Any]],
                    quoted_elsewhere: list[dict[str, Any]],
                    omit: Any) -> list[dict[str, Any]]:
    """The rows NEXT TO the ones the record already quotes, bounded.

    Selection only — over the units `extract` has already admitted. There is no
    second pass over the raw transcript and no second admission rule, so no
    thinking block, sidechain row, compaction summary, image or unrecognized
    block form can arrive here: no code path in this function can reach one.

    Tool calls are NOT candidates: `tool_pairs` already publishes every call
    with its result, so admitting one here would print it twice. They still
    consume radius, so the neighbourhood keeps its shape.

    A neighbour that is already quoted — a call, or an adjacent anchor — is
    skipped WITHOUT an omission count: I3 counts what the reader cannot see,
    and this exclusion set is read out of the record itself, so everything it
    drops is on the page. `verify` checks the same property from the other
    side, by refusing a selected row that appears elsewhere.
    """
    quoted = {_ukey(a.get("unit")) for a in anchors}
    quoted |= {_ukey(p.get("unit")) for p in quoted_elsewhere}
    at = {_ukey(u): i for i, u in enumerate(seq)}
    best: dict[tuple[int, str, int], int] = {}          # unit → best distance
    for a in anchors:
        i = at.get(_ukey(a.get("unit")))
        if i is None:
            continue
        for d in range(1, SEL_RADIUS + 1):
            for j in (i - d, i + d):
                if 0 <= j < len(seq):
                    k = _ukey(seq[j])
                    if d < best.get(k, 1 << 30):
                        best[k] = d
    # §3 total order: distance, then recency, then (line, kind, index)
    cands = sorted(best.items(),
                   key=lambda kv: (kv[1], -kv[0][0],
                                   SEL_KIND_ORDER.get(kv[0][1], 9), kv[0][2]))
    out: list[dict[str, Any]] = []
    rows = 0
    chars = len(SEL_HEADING) + 1
    for k, d in cands:
        if k in quoted:
            continue
        item = seq[at[k]]["item"]
        e = {**{x: y for x, y in item.items() if x != "unit"},
             "unit": dict(item["unit"]), "distance": d}
        cost = len(render_selected_row(e)) + 1
        if rows + 1 > SEL_ROWS:
            omit("selected_rows_over_budget")
            continue
        if chars + cost > SEL_CHARS:
            omit("selected_chars_over_budget")
            continue
        if e.get("truncated"):
            omit("selected_truncated_row")
        rows += 1
        chars += cost
        out.append(e)
    return out


# ------------------------------------------------------------------ extract
def extract(inputs: dict[str, Any], lines: list[str]) -> dict[str, Any]:
    """PURE bounded extraction: (captured inputs, transcript lines) → record.
    Reads nothing from disk; every on-disk observation arrives in `inputs`."""
    views: dict[str, str] = inputs.get("views") or {}
    grants: list[str] = inputs.get("grants") or []
    disk: dict[str, dict[str, Any]] = inputs.get("artifact_disk") or {}
    om: dict[str, int] = {}
    om_ids: dict[str, list[str]] = {}

    def omit(kind: str, detail: str | None = None) -> None:
        om[kind] = om.get(kind, 0) + 1
        if detail:
            om_ids.setdefault(kind, []).append(detail)

    users: list[dict[str, Any]] = []
    finals: list[dict[str, Any]] = []
    claims: list[dict[str, Any]] = []
    # PAIRING RULE (⚠ a transcript may reuse a tool_use id — a resumed or
    # concatenated session does, and the codex journal's ids are per turn):
    # every tool_use OCCURRENCE is its own pair, and a tool_result attaches to
    # the EARLIEST occurrence of its id that has no result yet. Anything left
    # over is an omission on one side or the other. `_recount` implements the
    # same rule by a different walk — keying pairs by id alone made 250
    # repeated calls render as 250 copies of the last one, and put `extract`
    # and the recount permanently at odds (found by this suite's §10 cost
    # fixture, 2026-09-05).
    calls: dict[str, list[dict[str, Any]]] = {}
    order: list[dict[str, Any]] = []
    artifacts: dict[str, dict[str, Any]] = {}
    # ⚠ A LINE IS NOT A UNIT. One assistant row can carry two `text` blocks and
    # three `tool_use` blocks, and today all five items get the SAME `ref` —
    # `ref` has no block position. Identity is therefore (line, kind, index),
    # `index` being the ordinal among items of that kind from that same line;
    # for a tool call it is also the occurrence index the pairing rule above
    # already depends on. `seq` is every admitted unit in transcript order and
    # is what selected history (§2 of the spec) counts its radius in.
    seq: list[dict[str, Any]] = []
    seq_n: dict[tuple[int, str], int] = {}      # O(1) index, never a rescan

    def unit_of(line_no: int, kind: str, item: dict[str, Any]) -> dict[str, Any]:
        idx = seq_n.get((line_no, kind), 0)
        seq_n[(line_no, kind)] = idx + 1
        u = {"line": line_no, "kind": kind, "index": idx}
        item["unit"] = u
        seq.append({**u, "item": item})
        return u

    for i, line in enumerate(lines):
        rec = _loads(line)
        if rec is None:
            omit("unparsable_or_non_record_line")
            continue
        if rec.get("isSidechain"):
            omit("sidechain_row")
            continue
        if rec.get("isMeta"):
            omit("meta_row")
            continue
        t = rec.get("type")
        if t == "system":
            if rec.get("subtype") == "compact_boundary":
                omit("compaction_boundary")
            continue
        if t not in ("user", "assistant"):
            # ⚠ NAME WHAT WAS SKIPPED. A real Claude transcript also carries
            # `attachment`, `queue-operation`, `last-prompt`, `atis-latch` and
            # `mode` rows (observed in a 441-row CLI 2.1.258 transcript,
            # 2026-09-05). None of them is admitted; a silent skip would leave
            # the reader unable to tell "nothing there" from "not looked at".
            omit("skipped_row:" + _kind_label(t))
            continue
        m = rec.get("message")
        if not isinstance(m, dict):
            omit("row_without_message")
            continue
        ref = {"src": "transcript.jsonl", "line": i + 1, "uuid": rec.get("uuid"),
               "ts": rec.get("timestamp"), "sha256": sha256(line.rstrip("\r\n"))}
        content = m.get("content", "")
        if t == "user":
            if rec.get("isCompactSummary"):
                omit("compaction_summary")
                continue
            if isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        omit("unrecognized_user_block:not-a-block")
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        pass                # quoted below, via `_user_text`
                    elif bt == "image":
                        omit("image_block")
                    elif bt != "tool_result":
                        omit("unrecognized_user_block:" + _kind_label(bt))
                    else:
                        tid = str(b.get("tool_use_id") or "")
                        body = _result_body(b)
                        open_call = next((c for c in calls.get(tid) or []
                                          if "result" not in c), None)
                        if open_call is not None:
                            ex, cut = _cap(body, CAP_RESULT)
                            open_call["result"] = {
                                "chars": len(body), "sha256": sha256(body),
                                "is_error": bool(b.get("is_error")), "excerpt": ex,
                                "truncated": cut, "ref": ref}
                            if cut:
                                omit("truncated_tool_result")
                        else:
                            omit("orphan_tool_result", tid)
            text = _user_text(content)
            if text is None:
                continue
            raw_sha = sha256(text)
            vis = views.get(raw_sha)
            if vis is None and ENVELOPE_RE.match(text):
                omit("machine_envelope_unprojected")
                continue
            human = vis if vis is not None else text
            if not human.strip():
                omit("machine_only_turn")
                continue
            q, cut = _cap(human, CAP_TEXT)
            item: dict[str, Any] = {"role": "user", "text": q, "truncated": cut, "ref": ref}
            if vis is not None:
                item["projected"] = {"raw_sha256": raw_sha, "visible_sha256": sha256(vis)}
            unit_of(i + 1, "user_text", item)
            users.append(item)
            continue
        # assistant
        if m.get("model") == "<synthetic>" or rec.get("isApiErrorMessage"):
            omit("synthetic_or_api_error_row")
            continue
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for b in blocks:
            if not isinstance(b, dict):
                omit("unrecognized_assistant_block:not-a-block")
                continue
            bt = b.get("type")
            if bt == "thinking":
                omit("thinking_block")
                if b.get("signature"):
                    omit("signature")
                continue
            if bt == "text":
                s = str(b.get("text") or "")
                if s.strip():
                    q, cut = _cap(s, CAP_TEXT)
                    it = {"role": "assistant", "text": q, "truncated": cut, "ref": ref}
                    unit_of(i + 1, "assistant_text", it)
                    finals.append(it)
                continue
            if bt == "tool_use":
                tid = str(b.get("id") or "")
                name = str(b.get("name") or "tool")
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                bare = name.removeprefix("mcp__orgtree__")
                entry: dict[str, Any] = {"id": tid, "name": name, "ref": ref}
                u = unit_of(i + 1, "tool_call", entry)
                if bare in CLAIM_TOOLS:
                    claims.append({"role": "assistant", "tool": bare,
                                   "input": {k: _cap(str(v), CAP_TEXT)[0] for k, v in inp.items()
                                             if k in ("status", "summary", "to", "body",
                                                      "kind", "question")},
                                   "ref": ref, "unit": u})
                p = str(inp.get("file_path") or inp.get("notebook_path") or "")
                if p and name in PATH_ARG_TOOLS:
                    inside = _under(p, grants)
                    entry["path"] = p if inside else None
                    if not inside:
                        omit("file_ref_outside_grant")
                    if name in ARTIFACT_TOOLS:
                        a = artifacts.setdefault(p, {"path": p, "tool": name,
                                                     "first_ref": ref, "writes": 0})
                        a["writes"] += 1
                elif "command" in inp:
                    entry["command"], _ = _cap(str(inp["command"]), CAP_CMD)
                calls.setdefault(tid, []).append(entry)
                order.append(entry)
                continue
            # ⚠ THE EXCLUSION IS THIS WHITELIST, NOT THE I1 SCAN. Nothing but
            # `text` and `tool_use` is ever read out of an assistant row, so a
            # reasoning form this code does not know — a future
            # `redacted_thinking`, a provider's `reasoning` block, anything —
            # cannot reach the record even in part. It is COUNTED, by its type
            # name only, so a reader sees that something was there.
            omit("unrecognized_assistant_block:" + _kind_label(bt))
    pairs = []
    for c in order:
        c["paired"] = "result" in c
        if not c["paired"]:
            omit("unpaired_tool_use", c["id"])
        pairs.append(c)
    arts: list[dict[str, Any]] = []
    for p, a in artifacts.items():
        if _under(p, grants):
            a["disk"] = disk.get(p, {"exists": None})
            arts.append(a)
        else:
            omit("artifact_outside_grant")
    keep_users = ([users[0]] if users else []) + users[1:][-KEEP_USER:]
    if len(keep_users) < len(users):
        om["user_rows_not_quoted"] = len(users) - len(keep_users)
    keep_finals = finals[-KEEP_ASSISTANT:]
    if len(keep_finals) < len(finals):
        om["assistant_rows_not_quoted"] = len(finals) - len(keep_finals)
    keep_claims = claims[-KEEP_ASSISTANT:]
    if len(keep_claims) < len(claims):
        om["claim_rows_not_quoted"] = len(claims) - len(keep_claims)
    selected = _select_history(seq, anchors=keep_users + keep_finals + keep_claims,
                               quoted_elsewhere=pairs, omit=omit)
    seat = inputs.get("seat") or {}
    return {
        "continuity": {"provider_context": "none", "cache": "unknown",
                       "statement": STATEMENT},
        "authority": AUTHORITY,
        "seat": {**{k: seat.get(k) for k in SEAT_KEYS},
                 "add_dirs": seat.get("add_dirs"), "tools": seat.get("tools"),
                 "source": "ledger.node (snapshot in inputs.seat)"},
        "instructions_received": keep_users,
        "predecessor_said": keep_finals,
        "predecessor_claims": keep_claims,
        "selected_history": selected,
        "tool_pairs": pairs,
        "artifacts": arts,
        "mail": {"pending": inputs.get("mailbox") or [],
                 "mooted_ask": inputs.get("mooted_ask")},
        "omissions": [{"kind": k, "count": n, **({"ids": om_ids[k]} if k in om_ids else {})}
                      for k, n in sorted(om.items())],
    }


# ------------------------------------------------------------------ capture
def seat_snapshot(node: dict[str, Any]) -> dict[str, Any]:
    sc = node.get("scope") or {}
    return {**{k: copy.deepcopy(node.get(k)) for k in SEAT_KEYS},
            "add_dirs": [d.get("path") if isinstance(d, dict) else d
                         for d in sc.get("add_dirs", [])],
            "tools": copy.deepcopy(sc.get("tools"))}


def mailbox_snapshot(mailbox: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"id": e.get("id"), "from": e.get("from"), "kind": e.get("kind"),
             "at": e.get("at"), "body": _cap(str(e.get("body") or ""), CAP_TEXT)[0]}
            for e in mailbox]


def capture(*, nid: str, node: dict[str, Any], lines: list[str],
            views_all: dict[str, str] | None, mailbox: list[dict[str, Any]],
            mooted_ask: dict[str, Any] | None, grants: list[str],
            boundary: dict[str, Any], scratch: str | None = None,
            at: str = "") -> dict[str, Any]:
    """Snapshot every input the extraction needs, then extract. The snapshot
    rides inside the artifact so `verify` can rebuild without the ledger."""
    used: dict[str, str] = {}
    if views_all:
        for line in lines:
            rec = _loads(line)
            if rec and rec.get("type") == "user" and isinstance(rec.get("message"), dict):
                txt = _user_text(rec["message"].get("content"))
                if txt is not None and sha256(txt) in views_all:
                    used[sha256(txt)] = views_all[sha256(txt)]
    ask = ({"id": mooted_ask.get("id"), "question": mooted_ask.get("question"),
            "status": mooted_ask.get("status"), "reason": mooted_ask.get("reason")}
           if mooted_ask else None)
    bc = None
    if scratch:
        bp = os.path.join(scratch, "breadcrumbs.md")
        if os.path.isfile(bp):
            with open(bp, "rb") as f:
                b = f.read()
            bc = {"path": "breadcrumbs.md", "bytes": len(b), "sha256": sha256(b)}
    inputs: dict[str, Any] = {
        "node": nid, "boundary": boundary, "grants": list(grants),
        "seat": seat_snapshot(node), "views": used,
        "mailbox": mailbox_snapshot(mailbox), "mooted_ask": ask, "breadcrumbs": bc,
        "transcript": {"path": "transcript.jsonl", "lines": len(lines),
                       "sha256": sha256("".join(lines))},
        "artifact_disk": {},
    }
    first = extract(inputs, lines)
    disk: dict[str, dict[str, Any]] = {}
    for a in first["artifacts"]:
        p = a["path"]
        if os.path.isfile(p):
            with open(p, "rb") as f:
                disk[p] = {"exists": True, "sha256": sha256(f.read())}
        else:
            disk[p] = {"exists": False}
    inputs["artifact_disk"] = disk
    return {"v": V, "kind": KIND, "node": nid, "at": at,
            "inputs": inputs, "record": extract(inputs, lines)}


# ------------------------------------------------------------------- verify
def _diff(a: Any, b: Any, path: str, out: list[str]) -> None:
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{path}.{k}: {'missing' if k not in a else 'extra'} in artifact")
            else:
                _diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} items in artifact, {len(b)} rebuilt")
        for i, (x, y) in enumerate(zip(a, b)):
            _diff(x, y, f"{path}[{i}]", out)
    elif a != b:
        out.append(f"{path}: artifact {json.dumps(a, ensure_ascii=False)[:80]} ≠ rebuilt "
                   f"{json.dumps(b, ensure_ascii=False)[:80]}")


def _recount(lines: list[str]) -> dict[str, int]:
    """Independent counts for I3 (deliberately NOT sharing extract's loop)."""
    c = {"thinking_block": 0, "signature": 0, "sidechain_row": 0,
         "compaction_boundary": 0, "compaction_summary": 0}
    # the pairing rule of `extract`, counted rather than linked: `avail[id]` is
    # how many occurrences of that id are still waiting for a result
    avail: dict[str, int] = {}
    orphan = 0
    for line in lines:
        rec = _loads(line)
        if rec is None:
            continue
        if rec.get("isSidechain"):
            c["sidechain_row"] += 1
            continue
        if rec.get("isMeta"):
            continue
        if rec.get("type") == "system" and rec.get("subtype") == "compact_boundary":
            c["compaction_boundary"] += 1
        if rec.get("type") == "user" and rec.get("isCompactSummary"):
            c["compaction_summary"] += 1
            continue
        m = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        blocks = m.get("content") if isinstance(m.get("content"), list) else []
        if rec.get("type") == "assistant" and not (
                m.get("model") == "<synthetic>" or rec.get("isApiErrorMessage")):
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "thinking":
                    c["thinking_block"] += 1
                    if b.get("signature"):
                        c["signature"] += 1
                if b.get("type") == "tool_use":
                    tid = str(b.get("id") or "")
                    avail[tid] = avail.get(tid, 0) + 1
        if rec.get("type") == "user":
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    tid = str(b.get("tool_use_id") or "")
                    if avail.get(tid, 0) > 0:
                        avail[tid] -= 1
                    else:
                        orphan += 1
    c["orphan_tool_result"] = orphan
    c["unpaired_tool_use"] = sum(avail.values())
    return c


def private_strings(lines: list[str]) -> list[str]:
    """Every thinking text and signature the transcript holds (for I1)."""
    out: list[str] = []
    for line in lines:
        rec = _loads(line)
        if rec is None or rec.get("type") != "assistant":
            continue
        m = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        for b in m.get("content") if isinstance(m.get("content"), list) else []:
            if isinstance(b, dict) and b.get("type") == "thinking":
                if str(b.get("thinking") or "").strip():
                    out.append(str(b["thinking"]))
                if len(str(b.get("signature") or "")) >= 16:
                    out.append(str(b["signature"]))
    return out


LEAK_WINDOW = 64        # chars in a compared window
LEAK_STEP = 32          # positions between windows on the SAMPLED side
LEAK_GUARANTEE = LEAK_WINDOW + LEAK_STEP - 1     # 95: see `leak_fragments`
_FILTER_BITS = 1 << 26  # 8 MB, FIXED — the scan's memory does not grow with input
_FILTER_MASK = _FILTER_BITS - 1


def _strings(x: Any) -> Iterable[str]:
    """Every string VALUE in the artifact, walked — the scan must not depend
    on how the artifact happens to be serialized."""
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from _strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from _strings(v)


def admissible_text(art: dict[str, Any], lines: list[str]) -> str:
    """Everything `extract` is ALLOWED to emit, as one blob: user and
    assistant text blocks, tool inputs, tool results, and the captured
    ledger-side snapshots. Used only to clear a hit — text that also exists in
    an admissible source is not private, and a model that quotes its own
    instructions inside its reasoning must not make the record unpublishable
    for repeating what the user said."""
    parts: list[str] = []
    for line in lines:
        rec = _loads(line)
        if rec is None:
            continue
        m = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    parts.append(str(b.get("text") or ""))
                elif b.get("type") == "tool_result":
                    parts.append(_result_body(b))
                elif b.get("type") == "tool_use":
                    parts.append(json.dumps(b.get("input"), ensure_ascii=False))
    inputs = {k: v for k, v in (art.get("inputs") or {}).items() if k != "transcript"}
    parts.append(json.dumps(inputs, ensure_ascii=False))
    return "\n".join(parts)


def _bitmap(strings: Iterable[str]) -> bytearray:
    """A fixed-size membership filter over EVERY window of `strings`. Two bits
    per window in 8 MB: no per-window object, so the scan's memory is the
    same for a 100 KB session and a 100 MB one, and every hit is confirmed
    against the real text afterwards (a filter may say "maybe", never
    "yes")."""
    bits = bytearray(_FILTER_BITS >> 3)
    for s in strings:
        for i in range(len(s) - LEAK_WINDOW + 1):
            h = hash(s[i:i + LEAK_WINDOW])
            for x in (h & _FILTER_MASK, (h >> 26) & _FILTER_MASK):
                bits[x >> 3] |= 1 << (x & 7)
    return bits


def _maybe(bits: bytearray, w: str) -> bool:
    h = hash(w)
    for x in (h & _FILTER_MASK, (h >> 26) & _FILTER_MASK):
        if not bits[x >> 3] & (1 << (x & 7)):
            return False
    return True


def leak_fragments(art: dict[str, Any], lines: list[str],
                   admissible: str | None = None) -> list[str]:
    """SUPPLEMENTAL (see I1 in the module docstring): runs of private text
    that reached the artifact IN PART. Whole-string containment cannot see a
    truncated leak — an extractor that emitted the first 300 characters of a
    thinking block would pass it.

    GUARANTEE: any contiguous run of >= LEAK_GUARANTEE (95) characters shared
    by the transcript's private text and the artifact is found, unless that
    run also occurs in `admissible_text` — in which case it is not private.
    One side is walked at every position and the other at LEAK_STEP, so an
    aligned window of the sampled side always falls inside a run that long.
    Which side is dense is chosen by SIZE (the smaller one), because the cost
    of this scan is the dense side; that choice changes speed, never the
    guarantee. Runs shorter than the guarantee are judged by verify's exact
    whole-string check instead.

    It is a scan, not the guarantee. The guarantee is structural: `extract`
    reads `text` and `tool_use` out of an assistant row and nothing else, so
    no reasoning form — known or future — is admitted in the first place.

    Cost, measured 2026-09-05 (evidence/handoff/cost_publication.json): an
    8.4 MB transcript with 6 MB of unsealed reasoning and a 1.35 MB artifact
    scans in ~0.6 s with a flat 8 MB filter, inside the caller's DOC_LOCK."""
    priv = [p for p in private_strings(lines) if len(p) >= LEAK_WINDOW]
    art_strs = [s for s in _strings(art) if len(s) >= LEAK_WINDOW]
    if not priv or not art_strs:
        return []
    art_len, priv_len = sum(map(len, art_strs)), sum(map(len, priv))
    dense_art = art_len <= priv_len
    dense, sampled = (art_strs, priv) if dense_art else (priv, art_strs)
    bits = _bitmap(dense)
    blob = "\x00".join(dense)
    hits: list[str] = []
    for s in sampled:
        for i in range(0, len(s) - LEAK_WINDOW + 1, LEAK_STEP):
            w = s[i:i + LEAK_WINDOW]
            if not _maybe(bits, w) or w not in blob:
                continue                      # filter false positive, or none
            if admissible is None:
                admissible = admissible_text(art, lines)
            if w not in admissible:
                hits.append(w)
                break
    return hits


#: the LAST TWO core results, keyed by the artifact's own bytes and the
#: transcript's hash. `_verify_core` is pure — same artifact, same transcript,
#: same answer — and a publication verifies TWICE by design: the caller with
#: its anchors, then `write_generation` unanchored as a belt. On a large
#: session that second pass is a second full rebuild and a second scan for a
#: question already answered; the memo pays it once. It is never a substitute
#: for verifying: a different artifact or a different transcript misses.
_CORE_MEMO: dict[tuple[str, str, int], list[str]] = {}


def verify(art: dict[str, Any], lines: list[str], *,
           views_all: dict[str, str] | None = None,
           seat: dict[str, Any] | None = None,
           mailbox: list[dict[str, Any]] | None = None) -> list[str]:
    """Rebuild from the artifact's own captured inputs + the transcript; the
    rebuilt record must be identical. Then the intrinsic invariants, then
    whichever anchors were supplied. Returns problems ([] = verified).
    See `anchors_ran` for what a given call could and could not check."""
    bad = list(_verify_core(art, lines))
    if bad and bad[0] == f"not a v{V} handoff record":
        return bad
    inputs = art.get("inputs") or {}
    views = inputs.get("views") or {}
    if views_all is not None:
        for h, vis in views.items():
            if views_all.get(h) != vis:
                bad.append(f"A1 captured view row {h[:12]} ≠ sidecar")
    if seat is not None:
        _diff(inputs.get("seat"), seat_snapshot(seat), "A2 inputs.seat", bad)
    if mailbox is not None:
        _diff(inputs.get("mailbox"), mailbox_snapshot(mailbox), "A3 inputs.mailbox", bad)
    return bad


def _verify_core(art: dict[str, Any], lines: list[str]) -> list[str]:
    """V0-I5: everything that depends only on the artifact and the transcript,
    so the answer can be remembered (see `_CORE_MEMO`). The anchors are NOT
    here: they compare against live ledger state, which is not part of the
    key and must never be answered from a memo."""
    bad: list[str] = []
    if not isinstance(art, dict) or art.get("kind") != KIND or art.get("v") != V:
        return [f"not a v{V} handoff record"]
    blob = json.dumps(art, ensure_ascii=False)
    # ⚠ THE KEY HASHES THE BYTES IN HAND, NEVER THE ONES THE ARTIFACT CLAIMS
    # (Astra review 2026-09-05 12:10Z, found in this code). Keying on
    # `inputs.transcript.sha256` — the artifact's own claim — made the memo
    # answer for a DIFFERENT transcript: verify once with the genuine file,
    # then hand the same artifact an altered file of the same line count and
    # the cached [] came back with V0 never re-run. The hash is computed here
    # and V0 is checked against this same value below, so the thing the key
    # identifies and the thing V0 tests can never drift apart.
    actual = sha256("".join(lines))
    key = (sha256(blob), actual, len(lines))
    memo = _CORE_MEMO.get(key)
    if memo is not None:
        return memo
    inputs = art.get("inputs") or {}
    tr = inputs.get("transcript") or {}
    if actual != tr.get("sha256") or len(lines) != tr.get("lines"):
        bad.append("V0 transcript does not match the captured hash/line count")
    rec = art.get("record") or {}
    _diff(rec, extract(inputs, lines), "V1 record", bad)
    adm: str | None = None
    # WHOLE private strings, for the lengths the window scan does not
    # guarantee. Same admissibility rule as the scan (Astra review 2026-09-05:
    # the two used to disagree — a short thinking text that the assistant also
    # wrote in its visible reply, or that the user quoted back, was refused by
    # this check and exempted by that one). Text that also exists in an
    # admissible source is not private: the record is quoting the source.
    for s in private_strings(lines):
        if len(s) >= LEAK_GUARANTEE or s not in blob:
            continue                     # long ones are the scan's, by length
        if adm is None:
            adm = admissible_text(art, lines)
        if s not in adm:
            bad.append(f"I1 private reasoning/signature present: {s[:24]!r}")
    for w in leak_fragments(art, lines, adm):
        bad.append(f"I1 private reasoning FRAGMENT present ({LEAK_WINDOW}+ chars, "
                   f"not in any admissible text): {w[:24]!r}")
    quoted = (rec.get("instructions_received", []) + rec.get("predecessor_said", [])
              + rec.get("predecessor_claims", []) + rec.get("selected_history", []))
    views = inputs.get("views") or {}
    for it in quoted:
        ref = it.get("ref") or {}
        ln = ref.get("line")
        if not isinstance(ln, int) or not 1 <= ln <= len(lines):
            bad.append(f"I2 ref does not resolve: {ref}")
            continue
        raw = lines[ln - 1].rstrip("\r\n")
        if sha256(raw) != ref.get("sha256"):
            bad.append(f"I2 line hash mismatch at L{ln}")
            continue
        src = _loads(raw)
        if src is None:
            bad.append(f"I2 cited line L{ln} is not a record")
            continue
        if src.get("type") != it.get("role"):
            bad.append(f"I2 role {it.get('role')!r} ≠ source type {src.get('type')!r} at L{ln}")
        if "text" not in it:
            continue
        pj = it.get("projected")
        if pj:
            txt = _user_text((src.get("message") or {}).get("content"))
            if txt is None or sha256(txt) != pj.get("raw_sha256"):
                bad.append(f"I2 projected quotation's raw hash is not L{ln}'s text block")
            vis = views.get(pj.get("raw_sha256"))
            if vis is None or sha256(vis) != pj.get("visible_sha256"):
                bad.append(f"I2 projected quotation has no matching captured view row (L{ln})")
            elif _cap(vis, CAP_TEXT)[0] != it["text"]:
                bad.append(f"I2 projected quotation text ≠ captured view text (L{ln})")
        else:
            body = json.dumps((src.get("message") or {}).get("content"), ensure_ascii=False)
            if it["text"] and json.dumps(it["text"], ensure_ascii=False)[1:-1] not in body:
                bad.append(f"I2 quoted text not found in L{ln}")
    # I6 selected history: bounded, never a second copy, in the stated order.
    # Checked from the artifact itself, not by re-running the selector — a
    # check that just calls the code it is checking cannot catch that code.
    sel = rec.get("selected_history")
    if not isinstance(sel, list):
        bad.append("I6 selected_history missing")
        sel = []
    elsewhere = {_ukey(it.get("unit")) for it in
                 (rec.get("instructions_received", []) + rec.get("predecessor_said", [])
                  + rec.get("predecessor_claims", []) + rec.get("tool_pairs", []))}
    seen: set[tuple[int, str, int]] = set()
    order_key: list[tuple[Any, ...]] = []
    for e in sel:
        k = _ukey(e.get("unit"))
        if k in elsewhere:
            bad.append(f"I6 selected row is already quoted elsewhere: {k}")
        if k in seen:
            bad.append(f"I6 selected row appears twice: {k}")
        seen.add(k)
        d = e.get("distance")
        if not isinstance(d, int) or not 1 <= d <= SEL_RADIUS:
            bad.append(f"I6 selected row is outside radius {SEL_RADIUS}: {k} d={d}")
        order_key.append((d if isinstance(d, int) else 1 << 30, -k[0],
                          SEL_KIND_ORDER.get(k[1], 9), k[2]))
    if order_key != sorted(order_key):
        bad.append("I6 selected history is not in the specified order")
    if len(sel) > SEL_ROWS:
        bad.append(f"I6 selected history is {len(sel)} rows > {SEL_ROWS}")
    if len(render_selected(sel)) > SEL_CHARS:
        bad.append(f"I6 selected history renders {len(render_selected(sel))} "
                   f"chars > {SEL_CHARS}")
    rc = _recount(lines)
    om = {o["kind"]: o["count"] for o in rec.get("omissions", [])
          if isinstance(o, dict)}
    for k, n in rc.items():
        if om.get(k, 0) != n:
            bad.append(f"I3 omissions.{k}: artifact {om.get(k, 0)} ≠ recount {n}")
    grants = inputs.get("grants") or []
    for a in rec.get("artifacts", []):
        if not _under(str(a.get("path") or ""), grants):
            bad.append(f"I4 artifact outside grants: {a.get('path')}")
    for p in rec.get("tool_pairs", []):
        if p.get("path") and not _under(p["path"], grants):
            bad.append(f"I4 file reference outside grants: {p['path']}")
    c = rec.get("continuity") or {}
    if c.get("provider_context") != "none" or c.get("cache") != "unknown":
        bad.append("I5 continuity claim")
    while len(_CORE_MEMO) >= 2:
        _CORE_MEMO.pop(next(iter(_CORE_MEMO)))
    _CORE_MEMO[key] = bad
    return bad


def anchors_ran(*, views_all: Any = None, seat: Any = None, mailbox: Any = None) -> str:
    """One line naming what a `verify` call could check — an OFFLINE reader
    without the ledger must say it ran without anchors (contract §2)."""
    ran = [n for n, v in (("views", views_all), ("seat", seat), ("mailbox", mailbox))
           if v is not None]
    return ("anchored: " + ", ".join(ran)) if ran else \
        "WITHOUT anchors (captured seat/mail/view snapshots not checked against the ledger)"


# ------------------------------------------------------------ publication
def generation_dir(scratch: str, gen: int) -> str:
    return os.path.join(scratch, f"handoff-g{gen}")


def write_generation(scratch: str, gen: int, art: dict[str, Any],
                     lines: list[str]) -> str | None:
    """Publish generation `gen` ATOMICALLY: stage record.json, record.md and
    manifest.json in a private directory, then ONE rename into place. Only
    after `verify` (the caller has already run it anchored; this re-runs the
    unanchored part as a belt) and both renders succeed. Any failure removes
    the staging directory and returns None; nothing partial is ever visible
    under the published name. An existing generation is never overwritten."""
    dst = generation_dir(scratch, gen)
    if os.path.exists(dst):
        return None
    stage = os.path.join(scratch, f".handoff-g{gen}.staging-{uuid.uuid4().hex[:8]}")
    try:
        if verify(art, lines):
            raise ValueError("record does not verify")
        js = json.dumps(art, indent=1, ensure_ascii=False)
        md = render_md(art)
        os.makedirs(stage)
        with open(os.path.join(stage, RECORD_JSON), "w", encoding="utf-8", newline="\n") as f:
            f.write(js)
        with open(os.path.join(stage, RECORD_MD), "w", encoding="utf-8", newline="\n") as f:
            f.write(md)
        man = {"v": V, "kind": KIND, "node": art.get("node"), "generation": gen,
               "files": {RECORD_JSON: {"sha256": sha256(js), "bytes": len(js.encode("utf-8"))},
                         RECORD_MD: {"sha256": sha256(md), "bytes": len(md.encode("utf-8"))}}}
        with open(os.path.join(stage, MANIFEST), "w", encoding="utf-8", newline="\n") as f:
            json.dump(man, f, indent=1)
        os.rename(stage, dst)       # the ONE publication step
        return dst
    except Exception:                                            # noqa: BLE001
        shutil.rmtree(stage, ignore_errors=True)
        return None


def read_generation(scratch: str, gen: int,
                    node: str | None = None) -> dict[str, Any] | None:
    """The published generation, or None — NEVER an exception for a reader
    that is only deciding whether a record exists.

    ⚠ EVERY FIELD IS UNTRUSTED (Astra review, 2026-09-05). The first cut
    checked that `files` was a dict and then called `.get` on `files[name]`,
    which raises `AttributeError` on a manifest that is valid JSON with a
    string where an entry belongs — and the caller in `identity_prompt` would
    have taken that exception instead of quietly rendering no block. So every
    shape is checked before it is used, and anything unexpected is "no
    record", not a crash: manifest version and kind, per-file entry shapes,
    the artifact's own version/kind, and the generation and node the manifest
    claims (pass `node` to bind it — a record published for another seat is
    not this seat's record).

    VERSIONS: any version in `V_READABLE`, with the manifest and the artifact
    agreeing on which; the version read is returned as `out["v"]`. An older
    record is still a record — it was verified when it was published, and this
    reader is the prompt path, which never re-verifies. `verify` is the place
    that speaks only the current version, and it says which by name."""
    d = generation_dir(scratch, gen)
    try:
        with open(os.path.join(d, MANIFEST), encoding="utf-8") as f:
            man = json.load(f)
        if not isinstance(man, dict):
            return None
        files = man.get("files")
        if (not isinstance(files, dict) or man.get("kind") != KIND
                or man.get("v") not in V_READABLE or man.get("generation") != gen
                or (node is not None and man.get("node") != node)):
            return None
        out: dict[str, Any] = {"dir": d, "generation": gen, "v": man["v"]}
        for name in (RECORD_JSON, RECORD_MD):
            want = files.get(name)
            if (not isinstance(want, dict)
                    or not isinstance(want.get("sha256"), str)
                    or not isinstance(want.get("bytes"), int)):
                return None
            with open(os.path.join(d, name), "rb") as f:
                b = f.read()
            if sha256(b) != want["sha256"] or len(b) != want["bytes"]:
                return None
            out[name] = b.decode("utf-8")
        art = json.loads(out[RECORD_JSON])
        if (not isinstance(art, dict) or art.get("kind") != KIND
                or art.get("v") != man["v"]        # manifest and record agree
                or (node is not None and art.get("node") != node)
                or ((art.get("inputs") or {}).get("boundary") or {}).get("bearer")
                not in (None, f"{art.get('node')}@{gen}")):
            return None
        out["record"] = art
        return out
    except (OSError, ValueError, UnicodeDecodeError, TypeError, AttributeError):
        return None


# ------------------------------------------------------------------ render
def render_md(art: dict[str, Any], *, include_selected: bool = True) -> str:
    """The record as markdown. `include_selected=False` renders the FILE-ONLY
    sections away — it is how the prompt projection is built, and it is a
    different render, never a cut of this one: quoted text can contain any
    line this file emits, including a section heading or the footer."""
    inp, rec = art["inputs"], art["record"]
    b = inp["boundary"]
    out = [f"# HANDOFF RECORD — {art['node']} ({b.get('reason')}: "
           f"{b.get('from', {}).get('tier')}/{b.get('from', {}).get('provider')} → "
           f"{b.get('to', {}).get('tier')}/{b.get('to', {}).get('provider')})",
           f"_{rec['continuity']['statement']}_", f"_{rec['authority']}_", ""]
    st = (rec.get("seat") or {}).get("last_status")
    if st:
        out.append(f"**Last self-reported status** (predecessor's claim): "
                   f"{st.get('status')} — {st.get('summary')}")
    out.append("\n## Instructions received (verbatim, original role)")
    for it in rec["instructions_received"]:
        out.append(f"- [user · L{it['ref']['line']} · {it['ref'].get('ts')}"
                   f"{' · projected' if it.get('projected') else ''}] "
                   f"{it['text']}{' …[cut]' if it.get('truncated') else ''}")
    out.append("\n## What the predecessor said (its claims, not verified facts)")
    for it in rec["predecessor_said"]:
        out.append(f"- [{it['role']} · L{it['ref']['line']}] {it['text']}"
                   f"{' …[cut]' if it.get('truncated') else ''}")
    for it in rec["predecessor_claims"]:
        out.append(f"- [assistant · {it['tool']} · L{it['ref']['line']}] "
                   f"{json.dumps(it['input'], ensure_ascii=False)}")
    out.append("\n## Tool calls (paired by id)")
    for p in rec["tool_pairs"]:
        r = p.get("result") or {}
        what = p.get("path") or ("<file outside successor grants>" if "path" in p
                                 else p.get("command", ""))
        out.append(f"- L{p['ref']['line']} {p['name']} {what} → "
                   + (f"{'ERROR ' if r.get('is_error') else ''}{r.get('chars')} chars: "
                      f"{r.get('excerpt', '')!r}"
                      if p.get("paired") else "UNPAIRED (no result recorded)"))
    out.append("\n## Artifacts (structured refs inside the successor's grants; "
               "disk state at the boundary)")
    for a in rec["artifacts"]:
        d = a.get("disk") or {}
        out.append(f"- {a['path']} ({a['tool']} ×{a['writes']}; "
                   f"{'present' if d.get('exists') else 'MISSING'}"
                   + (f", sha256 {d['sha256'][:12]}" if d.get("sha256") else "") + ")")
    out.append("\n## Mail")
    for e in rec["mail"]["pending"]:
        out.append(f"- pending from {e['from']} ({e['kind']}, {e['at']}): {e['body']}")
    if rec["mail"]["mooted_ask"]:
        q = rec["mail"]["mooted_ask"]
        out.append(f"- OPEN QUESTION MOOTED at the boundary (re-pose if still needed): "
                   f"{q['question']!r}")
    out.append("\n## Omitted (by rule)")
    for o in rec["omissions"]:
        out.append(f"- {o['kind']}: {o['count']}" + (f" {o['ids']}" if o.get("ids") else ""))
    # FILE ONLY: the prompt's render leaves this out entirely (see
    # `prompt_projection`); its position in the file is a reading order.
    if include_selected:
        out.append("\n" + render_selected(rec.get("selected_history") or []).rstrip("\n"))
    tr = inp["transcript"]
    out.append(f"\nSource: {tr['path']} ({tr['lines']} lines, sha256 {tr['sha256'][:12]}); "
               + (f"breadcrumbs.md {inp['breadcrumbs']['bytes']} bytes"
                  if inp.get("breadcrumbs") else "no breadcrumbs.md")
               + ". ⚠ Quoted text, mail bodies, commands and result excerpts are NOT "
                 "path-filtered. Verify offline with handoff.verify(record, transcript "
                 "lines); without the ledger the seat/mail/view snapshots are unanchored.")
    return "\n".join(out) + "\n"


def prompt_projection(got: dict[str, Any]) -> str:
    """What the prompt may splice, from a `read_generation` result.

    ⚠ NEVER BY CUTTING THE RENDERED FILE. `render_md` writes user text,
    assistant text, mail bodies and result excerpts VERBATIM, so a quoted line
    can BE a section heading or the `Source:` footer — an ordinary transcript,
    not an attack — and a delimiter search would then delete real instructions,
    claims and mail from the prompt. A record of the CURRENT version is
    RE-RENDERED from its own JSON with the file-only sections off. Any other
    readable version is passed through unchanged: it was published before those
    sections existed, so it has none to remove, and this code does not know its
    shape well enough to re-render it."""
    art = got.get("record")
    if got.get("v") == V and isinstance(art, dict):
        return render_md(art, include_selected=False)
    return str(got.get(RECORD_MD) or "")
