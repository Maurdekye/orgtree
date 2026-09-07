# pyright: strict
"""ONE deterministic agent-text renderer per leaf — `render_agent(ev)` (design I1).

Every function here reproduces, byte for byte, the text the corresponding producer
writes at ROLLBACK_BASE (the `[DOCKET ASSIGNMENT · …]` headers, the engine bodies, the
org-change notices). The producers migrate to `mint(...)` + `render_agent(...)` one
family at a time (design §9 step 3) and B4 asserts parity against fixtures captured
from the previous release. Where a producer composes free lines from state this module
cannot see (a batch's scope decisions, a crash report summary), the leaf carries those
lines as data and the renderer joins them exactly as the producer did.

The renderer is called ONCE, at mint, and the row body is frozen thereafter; nothing
ever re-renders a stored row (design I1, Opus O3).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .events import renderer

USER = "@user"
_R = Mapping[str, Any]


def _who(by: str) -> str:
    """`the user` for the root, `"name"` for an agent — the ledger's `who` idiom."""
    return "the user" if by == USER else f'"{by}"'


def _who_cap(by: str) -> str:
    return _who(by).capitalize() if by == USER else _who(by)


def _user_or(by: str) -> str:
    """`the user` / bare name — the docket idiom (no quotes)."""
    return "the user" if by == USER else by


def _g(x: Any) -> str:
    """Python's `:g` formatting of a number, as the ledger prints credits."""
    return f"{float(x):g}"


def _obj(ev: _R) -> dict[str, Any]:
    o = ev.get("object")
    return dict(o) if isinstance(o, dict) else {}


# ================================================================== ordinary / reply
for _v in ("ordinary.message", "ordinary.question", "ordinary.request",
           "ordinary.decision", "ordinary.status", "ordinary.notice",
           "reply.document", "reply.mail", "lifecycle.kickoff"):
    renderer(_v)(lambda ev: str(ev["body"]))


@renderer("reply.docket")
def _r_reply_docket(ev: _R) -> str:
    """The docket reply as the agent reads it: the item header, the standing
    instruction for the role, then the user's text — byte for byte the former
    api.work_item_reply composition."""
    o = _obj(ev)
    if ev["role"] == "participant":
        how = (f"(the user replied on this docket item ADDRESSED TO "
               f"YOU AS A PARTICIPANT — the item is owned by "
               f"{ev.get('owner') or 'nobody (unassigned)'}, not by "
               f"you; treat this as item-linked mail, act on it, and "
               f"coordinate any update with the owner)")
    else:
        how = ("(the user replied on this docket item — treat it as "
               "item-linked mail and update the item if it changes "
               "the work)")
    return (f"[DOCKET REPLY · {o['slug']} \"{str(o.get('title') or '')[:80]}\"] "
            f"{how}\n{ev['body']}")


# =========================================================================== docket
def _docket_head(tag: str, ev: _R) -> str:
    o = _obj(ev)
    return f"[DOCKET {tag} · {o['slug']} \"{str(o.get('title') or '')[:80]}\"] "


@renderer("docket.assigned")
def _r_assigned(ev: _R) -> str:
    o = _obj(ev)
    prev, own = ev["previous_owner"], ev["owner"]
    return (_docket_head("ASSIGNMENT", ev)
            + "You are now the ASSIGNMENT on this docket item — that is "
              "OWNERSHIP: you hold its management rights, the user's replies on "
              "it come to you, and you are who the docket names as responsible."
            + f"\nAssigned by {_user_or(str(ev['assigner']))}"
            + (f" (previously {prev})" if prev and prev != own else "") + "."
            + f"\nDescription: {(ev['objective'] or '(none recorded)')[:600]}"
            + "\nLatest status — done so far: "
            + ("; ".join(ev["done_so_far"]) or "(nothing recorded)")
            + "\nWorking on / next: "
            + ("; ".join(ev["working_on_next"]) or "(nothing recorded)")
            + f"\nRead it in full with orgtree_work get slug={o['slug']}, and "
              "`update` it at the next meaningful boundary — your update is what "
              "the user reads.")


@renderer("docket.review_requested")
def _r_review_requested(ev: _R) -> str:
    return (_docket_head("REVIEW REQUEST", ev)
            + "You are named as the REVIEWER of this docket item. THIS IS NOT "
              f"OWNERSHIP: {ev['owner'] or 'its owner'} "
              "keeps the work and the responsibility for delivering it. You "
              "hold exactly three things — read it, add `evidence`, and record "
              "ONE decision with orgtree_work action='review': `approve` (the "
              "check passed — that COMPLETES the item) or `changes` (it goes "
              "back to the owner as in_progress, and your note is what they act "
              "on). Until you decide, the next action on this item is yours."
            + f"\nRequested by {_user_or(str(ev['requested_by']))}."
            + f"\nDescription: {(ev['objective'] or '(none recorded)')[:600]}"
            + "\nWhat the owner says is done: "
            + ("; ".join(ev["done_so_far"]) or "(nothing recorded)"))


def _relay_suffix(ev: _R) -> str:
    if not ev.get("relayed"):
        return ""
    return (f"\n(This notice comes from the docket itself: {ev['reviewer']} is the "
            f"item's reviewer but cannot address you directly under the mail rules. "
            f"Reply to your own superior if you need to reach them.)")


@renderer("docket.review_changes")
def _r_review_changes(ev: _R) -> str:
    note = ev.get("note")
    return (_docket_head("REVIEW", ev)
            + f"CHANGES REQUESTED by {_user_or(str(ev['reviewer']))} — the item is "
              "back with you as in_progress and the next action is yours."
            + (f"\nWhat the reviewer asked for: {str(note)[:500]}" if note else
               "\nThe reviewer left no note; ask them what they want changed rather "
               "than guessing.")
            + _relay_suffix(ev))


@renderer("docket.review_approved")
def _r_review_approved(ev: _R) -> str:
    note = ev.get("note")
    return (_docket_head("REVIEW", ev)
            + f"REVIEW PASSED — {_user_or(str(ev['reviewer']))} approved this item and "
              "it is now DONE. Nothing further is needed on it."
            + (f"\nReviewer's note: {str(note)[:500]}" if note else "")
            + _relay_suffix(ev))


@renderer("docket.participant_added")
def _r_participant(ev: _R) -> str:
    o = _obj(ev)
    return (_docket_head("PARTICIPATION", ev)
            + "You are now a PARTICIPANT on this docket item — not its assignment. "
              f"The item is owned by {ev['owner'] or 'nobody (unassigned)'}; you may "
              "read it, update it, add evidence and attach questions, and the "
              "user's replies addressed to you on it arrive as item-linked mail. "
              f"Added by {_user_or(str(ev['added_by']))}."
            + f"\nDescription: {(ev['objective'] or '(none recorded)')[:600]}"
            + f"\nRead it with orgtree_work get slug={o['slug']} when your work "
              "touches it; no reply is expected to this notice.")


@renderer("decision.attention_dismissed")
def _r_attention(ev: _R) -> str:
    o = _obj(ev)
    return (f"[DOCKET · {o['slug']}] The user DISMISSED your attention flag "
            f"(\"{str(ev['reason'])[:200]}\") — the item is now BLOCKED. Do not "
            f"re-raise the same reason without material new information; "
            f"{ev['pending_questions']} question(s) on the item are still pending.")


@renderer("status.report")
def _r_status(ev: _R) -> str:
    return f"[{str(ev['state']).upper()}] {ev['summary']}"


# ================================================================ answers / decisions
@renderer("answer.ask")
def _r_answer(ev: _R) -> str:
    qs: list[dict[str, Any]] = ev["questions"]
    txt = ev.get("text")
    if ev["dismissed"]:
        return ("[QUESTION DISMISSED] The user closed your question without "
                "answering:\nQ: " + str(qs[0]["question"])
                + "\nProceed on your best judgment, or re-ask later with a sharper "
                  "framing.")
    if ev["single"]:
        q = qs[0]
        sel: list[str] = q["selected"]
        body = "[ANSWER to your question]\nQ: " + str(q["question"])
        if sel:
            body += "\nSelected: " + " · ".join(sel)
        if txt:
            body += ("\nAnswer: " if not sel else "\nAlso: ") + str(txt)
        return body
    lines = ["[ANSWER to your questions]"]
    for i, q in enumerate(qs):
        label = q.get("label") or f"Q{i + 1}"
        lines.append(f"{label} — {q['question']}\n→ {' · '.join(q['selected'])}")
    if txt:
        lines.append("Also: " + str(txt))
    return "\n".join(lines)


@renderer("answer.batch")
def _r_batch(ev: _R) -> str:
    out: list[str] = []
    for s in ev["sections"]:
        k = s["kind"]
        if k == "ask":
            lines: list[str] = []
            answered = 0
            for i, q in enumerate(s["questions"]):
                label = q.get("label") or f"Q{i + 1}"
                if q["answer"] is None:
                    lines.append(f"{label} — {q['question']}\n→ (skipped — the user "
                                 f"left this one unanswered)")
                else:
                    answered += 1
                    lines.append(f"{label} — {q['question']}\n→ {q['answer']}")
            out.append(("[ANSWERS to your questions]\n" if answered else
                        "[your questions were SKIPPED]\n") + "\n".join(lines))
        elif k == "credit":
            if s["outcome"] == "skipped":
                out.append(f"[CREDIT REQUEST skipped] Your ask ({_g(s['old'])} → "
                           f"{_g(s['asked'])}) was left undecided — you may re-ask later.")
            else:
                out.append(_credit_text(s))
        elif k == "scope":
            out.append("\n".join(s["lines"]))
        elif k == "skipped":
            out.append(f"[QUESTION skipped] {s['question']}")
    return "\n\n".join(out)


def _credit_text(s: _R) -> str:
    old, new = _g(s["old"]), _g(s["asked"])
    asked = f"you asked {old} → {new}"
    oc = s["outcome"]
    if oc == "approved":
        return f"The user APPROVED your credit request — your grant is now {_g(s['now'])}."
    if oc == "counter":
        give = float(s["granted"])
        return (f"The user COUNTER-OFFERED: {asked}; granted {old} → {_g(give)} "
                f"({give - float(s['old']):+g}). You may take this as-is, request more "
                f"later, or find another way within it.")
    if oc == "declined":
        return (f"The user DECLINED the increase — {asked}; your grant stays "
                f"{_g(s['now'])}. You may re-ask with a stronger case, or work within it.")
    if oc == "reduced":
        give = float(s["granted"])
        return (f"The user REDUCED your grant: {asked}; your grant is now {_g(give)} "
                f"({give - float(s['old']):+g} — unused credits reclaimed). You may "
                f"re-ask, or work within it.")
    return (f"The user DENIED your credit request ({old} → {new}). Your grant stays "
            f"{old} — work within it, re-ask with a stronger case, or escalate "
            f"differently.")


renderer("decision.credit")(_credit_text)


@renderer("decision.audience")
def _r_decision_audience(ev: _R) -> str:
    if ev["granted"]:
        return (f"Audience granted: you may message {ev['decided_by']} directly until "
                f"it is rescinded.")
    if ev["decided_by"] == USER:
        return "The user declined your audience request."
    return (f"Your audience request to reach {ev['target']} was declined at "
            f"{ev['decided_by']}.")


@renderer("ask.routed")
def _r_ask_routed(ev: _R) -> str:
    parts: list[str] = []
    qs: list[dict[str, Any]] = ev["questions"]
    for qd in qs:
        p = str(qd["text"])
        if qd.get("header"):
            p = f"[{qd['header']}] {p}"
        if qd.get("work_item"):
            p = f"(docket item {qd['work_item']}) {p}"
        if qd["options"]:
            p += ("\nOptions: " + " · ".join(qd["options"])
                  + (" (several may apply)" if qd["multi"] else ""))
        parts.append(p)
    head = ("[QUESTION — needs an answer]\n" if len(qs) == 1
            else f"[QUESTIONS — {len(qs)} need answers]\n")
    return head + "\n\n".join(parts)


# ================================================================ access / resources
@renderer("access.scope_requested")
def _r_scope_requested(ev: _R) -> str:
    return ("[SCOPE REQUEST — needs a grant or an escalation]\n"
            + "\n".join("- " + x for x in ev["items"])
            + f"\nReason: {str(ev['reason']).strip()}"
            + "\nIf you hold these, grant them directly with orgtree_retool; "
              "otherwise escalate up your chain — only the user can grant past "
              "your own scope.")


@renderer("access.audience_requested")
def _r_audience_requested(ev: _R) -> str:
    frm, target, reason, stage = ev["from_node"], ev["target"], ev["reason"], ev["stage"]
    if stage == "initial":
        return (f'AUDIENCE REQUEST: your report "{frm}" asks to speak directly with '
                f'{target}. Reason: "{reason[:300]}". You may forward it one hop up '
                f'(orgtree_audience action=forward), deny it (action=deny), or simply '
                f'handle the matter yourself and deny.')
    if stage == "target":
        return (f'AUDIENCE REQUEST reached you: "{frm}" asks to speak with you '
                f'directly. Reason: {reason}. Grant with orgtree_audience '
                f'action=grant, or deny.')
    if stage == "user":
        return (f'Audience request (forwarded up the chain): "{frm}" asks to speak '
                f'with you directly. Reason: {reason}. Grant or deny it from the '
                f'inbox panel.')
    return (f'AUDIENCE REQUEST (forwarded): "{frm}" seeks {target}. Reason: {reason}. '
            f'Forward, deny, or handle it.')


@renderer("access.audience_changed")
def _r_audience_changed(ev: _R) -> str:
    oc, by, target, other = ev["outcome"], ev["by"], ev["target"], ev.get("other")
    who = "The user" if by == USER else f'"{by}"'
    if oc == "user_audience":
        return ("The user granted you a USER AUDIENCE — you may write to them directly "
                "until it is rescinded." if by == USER else
                f'{who} granted you a direct USER AUDIENCE — you may write to the '
                f'user directly until it is rescinded.')
    if oc == "audience_with":
        return (f'{who} granted you an audience with "{target}" — you may message '
                f'them directly until it is rescinded.')
    if oc == "audience_from":
        return (f'{who} granted "{other}" an audience with you — it may now message '
                f'you directly; you may revoke it at will.')
    if oc == "user_audience_seen":
        return (f'{who} granted "{other}" a direct audience to you — it may now write '
                f'to your inbox. Revoke it from the audience panel at will.')
    if oc == "org_inbox":
        return (f"{who} granted you audience with the ORG INBOX: you now receive "
                f"outside messages addressed to this organization (chatq sessions, "
                f"other orgs) and may reply for it with orgtree_message to the "
                f"sender's @org:/@mcp:/@net: address. Replies speak for the org as a "
                f"whole — coordinate with the other recipients before answering.")
    if oc == "org_inbox_auto":
        return ("Outside mail arrived and no one held the ORG-INBOX audience, so it "
                "was auto-granted to you (the senior top-level agent). You now receive "
                "outside messages addressed to this organization and reply for it. "
                "Extend the audience to a better-suited agent with orgtree_audience "
                "action=grant target=extern; revoke your own with action=revoke.")
    if oc == "org_inbox_released":
        return ("You gave up your ORG-INBOX audience — outside mail addressed to the "
                "org no longer reaches you.")
    if oc == "declined":
        return "The user declined your audience request."
    label = "the user" if target == USER else target
    return f"Your audience with {label} was rescinded — fall back to the parent chain."


@renderer("access.grant_changed")
def _r_grant_changed(ev: _R) -> str:
    who = _who_cap(str(ev["by"]))
    if ev["relation"] == "self":
        return (f"{who} adjusted your grant by {float(ev['delta']):+g} "
                f"(now {_g(ev['now'])}, free {_g(ev['free'])}).")
    return f"{who} adjusted \"{ev['node']}\"'s grant by {float(ev['delta']):+g}."


@renderer("access.scope_changed")
def _r_scope_changed(ev: _R) -> str:
    if ev["by"] == USER:
        return ("The user changed your configuration (folders, tools, charter, or "
                "org visibility). Your current scope is stated in your system prompt "
                "each turn.")
    return (f'Your superior "{ev["by"]}" changed your configuration (folders, tools, '
            f'charter, or org visibility). Your current scope is stated in your '
            f'system prompt each turn.')


@renderer("access.kiosk_clamped")
def _r_kiosk_clamped(ev: _R) -> str:
    return (f"The kiosk permission ceiling was adjusted; your grants were clamped "
            f"to fit: {', '.join(ev['lost'])}.")


@renderer("access.kiosk_ceiling")
def _r_kiosk_ceiling(ev: _R) -> str:
    return ("This kiosk now carries a PERMISSION CEILING — the maximum layer "
            "grantable to any agent in it. It was minted from what the org already "
            "does, so nothing changed today; review and tighten it in the kiosk "
            "panel. Retooling within the ceiling is now open to visitors (the /scope "
            "freeze is lifted).")


# ========================================================================= lifecycle
@renderer("lifecycle.hired")
def _r_hired(ev: _R) -> str:
    why = f" Role: {ev['why']}" if ev.get("why") else ""
    who = _who_cap(str(ev["by"]))
    if ev["relation"] == "report":
        return f'{who} hired "{ev["node"]}" ({ev["tier"]}, grant {int(ev["grant"])}) under you.{why}'
    return (f'{who} hired "{ev["node"]}" ({ev["tier"]}) alongside you, under '
            f'{ev.get("parent") or "the top level"}.{why}')


@renderer("lifecycle.retired")
def _r_retired(ev: _R) -> str:
    by, node = str(ev["by"]), str(ev["node"])
    who = ("the user" if by == USER else "itself (self-retirement)" if by == node
           else f'"{by}"')
    if ev["relation"] == "report":
        return f'Your report "{node}" was retired by {who} (freed {_g(ev["freed"])} credits).'
    return f'Your peer "{node}" was retired by {who}.'


@renderer("lifecycle.rescinded")
def _r_rescinded(ev: _R) -> str:
    return (f'Your report "{ev["node"]}" was RESCINDED by the user: it is archived and '
            f'your grant was reduced by {_g(ev["clawed"])} — rehiring it (or replacing '
            f'the seat) needs new capacity from above, not the freed headroom.')


@renderer("lifecycle.rehired")
def _r_rehired(ev: _R) -> str:
    who = _who(str(ev["by"]))
    rel = ev["relation"]
    if rel == "self":
        return f"{_who_cap(str(ev['by']))} rehired you. You are live again; your prior context is intact."
    if rel == "report":
        return f'Your report "{ev["node"]}" was rehired by {who} (grant {_g(ev["grant"])}).'
    return f'Your peer "{ev["node"]}" was rehired by {who}.'


@renderer("lifecycle.dissolved")
def _r_dissolved(ev: _R) -> str:
    who = _who(str(ev["by"]))
    if ev["relation"] == "report":
        return (f'{_who_cap(str(ev["by"]))} dissolved your report "{ev["node"]}" and its '
                f'whole suborganization ({ev["nodes"]} node(s), freed {_g(ev["freed"])} '
                f'credits).')
    return f'Your peer "{ev["node"]}" and its suborganization were dissolved by {who}.'


@renderer("lifecycle.deleted")
def _r_deleted(ev: _R) -> str:
    extra = int(ev["extra"])
    if ev["relation"] == "report":
        return (f'The user permanently DELETED your report "{ev["node"]}"'
                + (f" and its suborganization ({extra} more node(s))" if extra else "")
                + ". Its records are gone from the org.")
    return f'Your peer "{ev["node"]}" was permanently deleted by the user.'


@renderer("lifecycle.compacted")
def _r_compacted(ev: _R) -> str:
    gen, pred, node = ev["generation"], ev["predecessor"], ev["node"]
    size = ev.get("size_note") or ""
    if not ev["auto"]:
        if ev["relation"] == "report":
            return (f'"{node}" compacted (now generation {gen}). Its pre-compaction '
                    f'self is archived as "{pred}" — rehire it to consult the full '
                    f'detail the summary flattened.')
        return (f'You were compacted: you are now generation {gen}, and the context '
                f'you had before it is NOT in your summary in full. Your '
                f'pre-compaction self is archived as "{pred}" and is CONSULTABLE — '
                f'orgtree_rehire on that id brings it back as your own subordinate, '
                f'with everything you no longer remember, and you may retire it again '
                f'when done. Reach for it when the answer you need is detail the '
                f'summary flattened rather than something you can rederive.')
    if not ev["lost"]:
        if ev["relation"] == "report":
            return (f'"{node}" was auto-compacted BY THE CLI (now generation {gen}{size}). '
                    f'Its pre-compaction self is preserved as "{pred}" — rehire it to '
                    f'consult the full detail the summary flattened.')
        return (f'You were auto-compacted by the CLI: you are now generation {gen}, and '
                f'the context you had before it is NOT in your summary in full. Your '
                f'pre-compaction self is archived as "{pred}" and is CONSULTABLE — '
                f'orgtree_rehire on that id brings it back as your own subordinate, '
                f'with everything you no longer remember, and you may retire it again '
                f'when done. Reach for it when the answer you need is detail the '
                f'summary flattened rather than something you can rederive.')
    if ev["relation"] == "report":
        return (f'"{node}" was auto-compacted BY THE CLI (now generation {gen}{size}). '
                f'Its pre-compaction session could not be preserved — "{pred}" is '
                f'recorded as a LOST generation (visible, not consultable).')
    return (f'You were auto-compacted by the CLI: you are now generation {gen} and the '
            f'context you had before it survives only as your summary. There is NO '
            f'consultable bearer in this case — "{pred}" is a LOST generation and '
            f'cannot be rehired, so anything the summary dropped is gone. Ask whoever '
            f'gave you the work rather than hunting for a past self.')


@renderer("lifecycle.cheap_compacted")
def _r_cheap(ev: _R) -> str:
    pred = ev["predecessor"]
    if ev["relation"] == "self":
        return (f'You were CHEAP-COMPACTED: your seat, scope, team and budget are '
                f'unchanged, but this session is FRESH — you have NO memory of your '
                f'predecessor\'s work, and unlike a normal compaction there is no '
                f'summary. Your predecessor\'s breadcrumbs.md — its realtime log of '
                f'decisions and findings — is spliced into your system prompt when it '
                f'exists (tail-truncated if long), and survives in your working folder: '
                f'keep appending to it yourself. The full transcript is at '
                f'transcript.jsonl beside it; Grep/Read the parts you need instead of '
                f'reading it whole. You may also orgtree_rehire "{pred}" as your own '
                f'subordinate to interrogate it directly, and retire it again when '
                f'done.{ev.get("team_note") or ""}')
    by = str(ev["by"])
    who = "the user" if by == USER else "the system (auto)" if by == "@system" else by
    return (f'Your report "{ev["node"]}" was cheap-compacted by {who}: same seat and '
            f'team, fresh session — its prior self is consultable as "{pred}".')


@renderer("lifecycle.reseeded")
def _r_reseeded(ev: _R) -> str:
    if ev["relation"] == "self":
        return (f"{_who_cap(str(ev['by']))} re-seeded you after your previous session "
                f"was lost. Your role, charter, credits and reports are intact, but "
                f"your memory starts fresh — check your scratch CLAUDE.md and ask your "
                f"chain to re-orient you.")
    return (f'Your report "{ev["node"]}" was RE-SEEDED by {_who(str(ev["by"]))}: its '
            f'dead session is archived as "{ev["predecessor"]}" (a lost generation) '
            f'and it starts fresh — same role, credits and reports, empty memory.')


@renderer("lifecycle.recovered")
def _r_recovered(ev: _R) -> str:
    return (f'"{ev["predecessor"]}" is RECOVERED — the generation recorded as lost was '
            f'never actually gone, and it is now a consultable knowledge bearer. '
            f'Rehire it to reach the context that compaction summarized away.')


@renderer("lifecycle.phantom_removed")
def _r_phantom(ev: _R) -> str:
    return (f'The lineage entry "{ev["predecessor"]}" has been removed: it was a '
            f'PHANTOM. It recorded a generation that never existed — orgtree logged '
            f'its own §8 compaction a second time, as a loss. Every record it named '
            f'is held, in full, by "{ev["holder"]}". Nothing was deleted but a false '
            f'row.')


@renderer("lifecycle.unrecoverable")
def _r_unrecoverable(ev: _R) -> str:
    return (f'⚠ Your report "{ev["node"]}" is UNRECOVERABLE — its session failed to '
            f'resume ({ev["reason"]}). Its seat is still held; rehire it to RE-SEED it '
            f'(fresh session, same identity and credits), or retire it to free the '
            f'credits.')


@renderer("lifecycle.bearer_lost")
def _r_bearer_lost(ev: _R) -> str:
    return (f'Knowledge bearer "{ev["bearer"]}" lost its transcript and is now a LOST '
            f'generation — it can no longer be consulted; what it held survives only '
            f'in what was already written down.')


@renderer("lifecycle.bearer_exhausted")
def _r_bearer_exhausted(ev: _R) -> str:
    return (f'Knowledge bearer "{ev["bearer"]}" has exhausted its headroom and is now '
            f'a PRESERVING ORACLE — it still answers, but exchanges are no longer '
            f'retained by it.')


@renderer("lifecycle.handoff_record")
def _r_handoff(ev: _R) -> str:
    return (f"A handoff record for this boundary is at handoff-g{ev['generation']}/"
            f"record.md in your working folder: a citation index of instructions, "
            f"tool calls, artifacts and mail built from files, with line refs into "
            f"transcript.jsonl — not memory, and not evidence that any provider "
            f"context carried over.")


@renderer("lifecycle.model_switched")
def _r_switched(ev: _R) -> str:
    who = _who_cap(str(ev["by"]))
    old, new = ev["old"], ev["new"]
    if ev["relation"] == "report":
        return f'{who} switched "{ev["node"]}" {old}→{new}.'
    qnote = (" — queued while you were mid-turn, applied when that turn ended"
             if ev["queued"] else "")
    head = (f'{who} switched your model {old}→{new} (seat {_g(ev["seat_old"])}→'
            f'{_g(ev["seat_new"])}){qnote}. ')
    if not ev["crossed"]:
        return head + "Your context is intact — carry on."
    return head + (
        f'That is a different PROVIDER ({ev["old_provider"]}→{ev["new_provider"]}), so '
        f'your conversation could NOT be carried over: this session is FRESH and you '
        f'have no memory of your predecessor\'s work. Your predecessor is archived as '
        f'"{ev["predecessor"]}" — its full transcript is at transcript.jsonl beside '
        f'your breadcrumbs.md (Grep/Read the parts you need instead of reading it '
        f'whole), and you may orgtree_rehire "{ev["predecessor"]}" as your own '
        f'subordinate to interrogate it directly. Your warm process and prompt cache '
        f'are gone with it, so this turn is a cold open and costs far more than a '
        f'normal one — expect it, and do not switch back and forth. Check your scratch '
        f'CLAUDE.md, and your breadcrumbs and mail are untouched; read them to pick up '
        f'where you left off.')


@renderer("lifecycle.switch_dropped")
def _r_switch_dropped(ev: _R) -> str:
    return (f"the queued switch of {ev['node']} to {ev['target']} was DROPPED at the "
            f"end of its turn: {ev['reason']}. It stays on {ev['kept']}; ask "
            f"again once that is resolved.")


@renderer("lifecycle.switch_queued")
def _r_switch_queued(ev: _R) -> str:
    return (f'{_who_cap(str(ev["by"]))} queued a model switch for "{ev["node"]}": '
            f'{ev["old"]}→{ev["new"]}, applied when its current turn ends.')


@renderer("lifecycle.switch_cancelled")
def _r_switch_cancelled(ev: _R) -> str:
    by = str(ev["by"])
    return (f'{"The user" if by == USER else by} cancelled the queued switch of '
            f'"{ev["node"]}" to {ev["target"]}.')


@renderer("lifecycle.seat_swapped")
def _r_swapped(ev: _R) -> str:
    a, b, role, by = ev["a"], ev["b"], ev["role"], str(ev["by"])
    who = _who_cap(by)
    if role == "parent_of_a":
        if ev["nested"]:
            return (f'{who} swapped the seats of your reports "{a}" and "{b}" — each '
                    f'now leads the other\'s former team.')
        return (f'{who} seated "{b}" in "{a}"\'s place — "{b}" now reports to you, '
                f'leading that seat\'s team.')
    if role == "peer_of_a":
        if ev["nested"]:
            return (f'Your peers "{a}" and "{b}" swapped seats — each now leads the '
                    f'other\'s former team.')
        return f'"{a}" and "{b}" swapped seats — "{b}" now holds "{a}"\'s seat beside you.'
    if role == "parent_of_b":
        return f'{who} seated "{a}" in "{b}"\'s place — "{a}" now reports to you.'
    if role == "peer_of_b":
        return f'"{a}" and "{b}" swapped seats — "{a}" now holds "{b}"\'s seat beside you.'
    if role == "child_of_a":
        return (f'Seat change above you: "{b}" took over "{a}"\'s seat. You now report '
                f'to "{b}"; your own team, grant and scope are unchanged.')
    if role == "child_of_b":
        return (f'Seat change above you: "{a}" took over "{b}"\'s seat. You now report '
                f'to "{a}"; your own team, grant and scope are unchanged.')
    disp = ev.get("reports_to_after")
    disp_s = f'"{disp}"' if disp else "the top level"
    aud = ev.get("audience_note") or ""
    if role == "a":
        return (f'{who} swapped your seat with "{b}": you now report to {disp_s} and '
                f'hold that seat\'s team, grant ({ev["grant_after"]}) and scope; your '
                f'identity, charter and mailbox are unchanged.{aud}')
    return (f'{who} seated you in "{a}"\'s place: you now report to {disp_s}, lead its '
            f'former team, and hold the seat\'s grant ({ev["grant_after"]}) and scope; '
            f'your identity, charter and mailbox are unchanged.{aud}')


@renderer("lifecycle.moved")
def _r_moved(ev: _R) -> str:
    who = _who(str(ev["by"]))
    tail = ev.get("tail") or ""
    frm = ev.get("from_parent") or "the top level"
    to = ev.get("to_parent") or "the top level"
    node, role = ev["node"], ev["role"]
    if role == "old_parent":
        return f'{_who_cap(str(ev["by"]))} moved your report "{node}" away — it now reports to {to}.{tail}'
    if role == "old_peer":
        return f'Your peer "{node}" was moved by {who} to under {to}.{tail}'
    if role == "new_parent":
        return f'{_who_cap(str(ev["by"]))} moved "{node}" (from {frm}) to report to you.{tail}'
    if role == "new_peer":
        return f'"{node}" joined your team (moved by {who} from {frm}).{tail}'
    return (f"{_who_cap(str(ev['by']))} moved you: you now report to {to} (you were "
            f"under {frm}). Your entire suborganization moved with you.")


@renderer("lifecycle.inserted")
def _r_inserted(ev: _R) -> str:
    who = _who(str(ev["by"]))
    node, target, role = ev["node"], ev["above"], ev["role"]
    p = ev.get("parent") or "the top level"
    if role == "parent":
        return (f'{_who_cap(str(ev["by"]))} inserted "{node}" above your report '
                f'"{target}": "{node}" now holds that position and "{target}" reports '
                f'to it, keeping its own team.')
    if role == "peer":
        return (f'"{node}" joined your team (inserted by {who} above "{target}", which '
                f'now reports to it).')
    if role == "target":
        return (f'{_who_cap(str(ev["by"]))} inserted "{node}" directly above you: you '
                f'now report to "{node}" instead of {p}, and your entire team, scope '
                f'and remaining grant ({ev["grant_target"]}) came with you.')
    if role == "child":
        return (f'"{target}" now reports to "{node}", inserted above it by {who}. You '
                f'still report to "{target}"; your own team, grant and scope are '
                f'unchanged.')
    return (f'{_who_cap(str(ev["by"]))} placed you in "{target}"\'s position: you report '
            f'to {p}, "{target}" and its whole team now report to YOU, and you hold '
            f"that seat's scope with a grant of {ev['grant_new']} (of which "
            f'{ev["committed"]} is committed to "{target}").')


@renderer("lifecycle.renamed")
def _r_renamed(ev: _R) -> str:
    by = str(ev["by"])
    return (f"You have been renamed: {ev['old']} → {ev['new']} "
            f"(by {'the user' if by == USER else by}). "
            f"Sign and refer to yourself as {ev['new']!r} from now on.")


@renderer("lifecycle.disk_migrated")
def _r_disk_migrated(ev: _R) -> str:
    return (f"Storage migration: this org's {ev['floored_from']} MB limit was raised to "
            f"the 4096 MB one-disk minimum (system seed + transcripts now count inside "
            f"the cap). Its agents may consume up to 4 GB; the disk can be grown online "
            f"or shrunk (staged) from the storage browser.")


@renderer("policy.fable_flagged")
def _r_fable_flagged(ev: _R) -> str:
    node, oc, aud = ev["node"], ev["outcome"], ev["audience"]
    detail = str(ev["detail"])[:200]
    if aud == "user":
        if oc == "autopsy_unavailable":
            return (f'A Fable content filter flagged a message from "{node}" (auto-autopsy '
                    f'configured with model "{ev["autopsy_model"]}", but that model is '
                    f'currently unavailable: {ev["reason"]}; turn halted). Detail: {detail}')
        if oc == "autopsy":
            return (f'A Fable content filter flagged a message from "{node}" (org policy '
                    f'applied: auto-autopsy — hired {ev["autopsy"]} [{ev["autopsy_model"]}], '
                    f'replacement {ev["replacement"]}). Detail: {detail}')
        policy = "opus" if oc == "switched" else "halt"
        return (f'A Fable content filter flagged a message from "{node}" (org policy '
                f'applied: {policy}{" — retried on opus" if oc == "switched" else ""}). '
                f'Detail: {detail}')
    if aud == "peer":
        return f'Your peer "{node}" switched fable→opus (content filter, org policy).'
    if oc == "switched":
        return (f'Your report "{node}" switched fable→opus: a Fable content filter '
                f'flagged its message (org policy). Seat cost dropped 10→5; the flagged '
                f'turn retries on opus.')
    if oc == "autopsy_unavailable":
        return (f'Your report "{node}" had a message FLAGGED by Fable\'s content filters '
                f'— auto-autopsy model "{ev["autopsy_model"]}" is unavailable '
                f'({ev["reason"]}); its turn HALTED (org policy).')
    if oc == "autopsy":
        return (f'Your report "{node}" had a message FLAGGED by Fable\'s content filters. '
                f'Auto-autopsy invoked: hired "{ev["autopsy"]}" ({ev["autopsy_model"]}), '
                f'replacement "{ev["replacement"]}" (fable), and retired "{node}".')
    return (f'Your report "{node}" had a message FLAGGED by Fable\'s content filters — '
            f'its turn HALTED (org policy). Re-task it, or the user may switch the org '
            f'filter policy to auto-convert to opus.')


@renderer("policy.weekly_limit")
def _r_weekly(ev: _R) -> str:
    node, oc, rel = ev["node"], ev["outcome"], ev["relation"]
    if rel == "user":
        conv = ev.get("converted") or ""
        return (f"Weekly Fable usage limit exhausted (detected at "
                f"{ev.get('detected_at') or 'unknown'}; policy: {ev['policy']}). "
                f"Halted: {ev.get('halted') or 'none'}. Dissolved (whole subtrees): "
                f"{ev.get('dissolved') or 'none'}. Switched to opus: {conv or 'none'}"
                + (" — they stay opus until you change them." if conv else ".")
                + " Rehiring a fable yourself, or clearing the lock in settings, "
                  "lifts the freeze.")
    if oc == "switched":
        if rel == "self":
            return ("Weekly Fable usage limit exhausted: per org policy you now run as "
                    "OPUS. Carry on.")
        return (f'Your report "{node}" switched fable→opus: weekly Fable usage limit '
                f'exhausted (org policy). Its seat cost dropped 10→5; it keeps working.')
    if oc == "dissolved":
        if rel == "report":
            return (f'Your report "{node}" and its entire suborganization ({ev["nodes"]} '
                    f'node(s)) were dissolved: weekly Fable usage limit exhausted (org '
                    f'policy). {ev["freed"]} credits returned to you.')
        return (f'Your peer "{node}" and its suborganization were dissolved (weekly '
                f'Fable limit, org policy).')
    if rel == "self":
        return ("Weekly Fable usage limit exhausted: you are halted. Your reports "
                "remain active.")
    if rel == "peer":
        return f'Your peer "{node}" has halted (weekly Fable limit).'
    return (f'Your report "{node}" has HALTED: weekly Fable usage limit exhausted. It '
            f'holds its seat and will not run until the limit resets or the user '
            f'intervenes — decide how to cover its work.')


@renderer("policy.unstuck")
def _r_unstuck(ev: _R) -> str:
    return ("The user manually UNSTUCK you (override) — any limit that held you is "
            "released; continue.")


@renderer("policy.unlocked")
def _r_unlocked(ev: _R) -> str:
    if ev["relation"] == "self":
        return "The Fable lock was cleared by the user: you are no longer halted. Carry on."
    return (f'"{ev["node"]}" is RELEASED from the weekly-Fable halt (the user cleared '
            f'it). It runs again; no need to keep covering its work.')


@renderer("policy.limit_reset")
def _r_limit_reset(ev: _R) -> str:
    rel = ev["relation"]
    if rel == "user":
        return ("Weekly Fable limit reset — halted fable agent(s) released: "
                + ", ".join(ev["released"]) + ". Their superiors were told to stop covering.")
    if rel == "self":
        return "The weekly Fable limit has reset: you are no longer halted. Carry on."
    return (f'"{ev["node"]}" is RELEASED from the weekly-Fable halt — the limit reset. '
            f'It runs again; no need to keep covering its work.')


# =========================================================================== monitor
#: appended to a ONE-SHOT dog's fire mail (D-200). The owner must be told in the mail
#: itself, because the alternative is an agent calling `list`, not finding its dog,
#: and having to work out whether it broke something. Lives here (not in the ledger)
#: because the renderer is the one place the sentence is produced; the ledger's raw
#: path calls `watchdog_once_note` so both paths share the SAME truncation.
WATCHDOG_ONCE_NOTE: str = (
    "\n\n— This was a ONE-SHOT dog: it fired once and has REMOVED ITSELF. "
    "It is gone from your list and will not fire again. Nothing is wrong "
    "and you need not remove it. If you want to watch for this again, "
    "arm a new one.")


def watchdog_once_note(body: str) -> str:
    """A fire body with the one-shot note appended, capped at the 8000 the mail row
    keeps — truncated BEFORE the note, so a long event body can never push the
    "it removed itself" sentence off the end of the mail that explains its absence."""
    return body[:8000 - len(WATCHDOG_ONCE_NOTE)].rstrip() + WATCHDOG_ONCE_NOTE


@renderer("monitor.watchdog_fired")
def _r_wd_fired(ev: _R) -> str:
    o = _obj(ev)
    lines: list[str] = ev["lines"]
    body = (f"[WATCHDOG {o['name']}]{ev['prefix']} {ev['count']} event(s):\n"
            + "\n".join(x[:500] for x in lines[:20])
            + (f"\n… {ev['count'] - 20} more" if ev["count"] > 20 else ""))
    return watchdog_once_note(body) if ev["once"] else body


@renderer("monitor.watchdog_quiet")
def _r_wd_quiet(ev: _R) -> str:
    o = _obj(ev)
    return (f"[WATCHDOG {o['name']}] ⚠ {str(ev['headline']).upper()}\n\n"
            + "\n".join(ev["facts"])
            + f"\n\n{ev['advice']}\n\n"
            + "⚠ This is about the THING BEING WATCHED, not about orgtree. Restarts "
              "and deploys do not produce this message: the counter above only "
              "advances on checks that actually ran (D-176).")


# ================================================================= runtime / recovery
@renderer("runtime.turn_failed_terminal")
def _r_terminal(ev: _R) -> str:
    return (f"[TURN FAILED TERMINALLY — nothing will retry it]\n"
            f"How it died: {ev['door']}\n"
            f"Error: {str(ev['err'])[:300] or 'no output'}\n\n"
            "orgtree classified this as NOT retryable and stopped. You were not driven "
            "for it — if the failure is in your CLI or your environment, another turn "
            "would die the same way — so this mail is waiting for you rather than "
            "waking you.\n\n"
            "⚠ WORK MAY BE UNFINISHED. Anything the dead turn had already done was "
            "NOT undone; anything it was about to do did not happen. Do not trust your "
            "own last message as a record of what ran — a turn can announce an edit in "
            "prose and die before the tool call. Check the disk.")[:8000]


@renderer("runtime.turn_failed_repeated")
def _r_repeated(ev: _R) -> str:
    return (f"[TURN FAILED REPEATEDLY — {ev['attempts']} attempts, giving up]\n"
            f"Classified as: {ev['classified']}\n"
            f"Last error: {str(ev['err'])[:300] or 'no output'}\n\n"
            "orgtree retried this turn automatically and has now stopped. You are no "
            "longer frozen, so this message is itself a live turn — you are running "
            "right now.\n\n"
            "⚠ WORK MAY BE UNFINISHED AND UNSAVED. A turn died part-way through, "
            "possibly more than once. Anything it had already done — files edited, "
            "mail sent, commands run — DID happen and was not undone; anything it was "
            "about to do did not. Before redoing work, CHECK THE ACTUAL STATE: your "
            "working folder, `git status` if you are in a repo, and your own last "
            "messages. Then finish what was interrupted, or report that you cannot.")[:8000]


@renderer("runtime.report_stalled")
def _r_stalled(ev: _R) -> str:
    name, nid = ev["report_name"], ev["report"]
    err = str(ev["err"])[:300] or "no output"
    if ev["cause"] == "terminal":
        if ev["audience"] == "user":
            return (f"{name} ({nid}) stopped: its turn failed in a way orgtree does not "
                    f"retry, and it has no superior to tell.\nHow it died: {ev['door']}\n"
                    f"Error: {err}\nIt is idle now and nothing will re-drive it. It may "
                    f"be holding unfinished work.")[:2000]
        return (f"[REPORT STALLED — {name} ({nid}) is not running]\n"
                f"Its turn failed in a way orgtree does not retry, and nothing will "
                f"re-drive it.\nHow it died: {ev['door']}\nError: {err}\n\n"
                f"It has NOT been driven — if the fault is its CLI or its environment, "
                f"waking it would just kill another turn. It is idle now and will stay "
                f"idle until something changes. It may also be holding unfinished work "
                f"from the turn that died.\n\n"
                f"You are the one who can act: fix the cause, or message it once you "
                f"have.")[:8000]
    if ev["audience"] == "user":
        return (f"{name} ({nid}) is stuck: {ev['attempts']} turns in a row failed and "
                f"orgtree has stopped retrying. It has no superior to tell.\n"
                f"Classified as: {ev['classified']}\nLast error: {err}\n"
                f"It has been told and driven, so it may recover on its own — but "
                f"nothing will retry it again automatically.")[:2000]
    return (f"[REPORT STALLED — {name} ({nid})]\n"
            f"Its turn failed {ev['attempts']} times in a row and orgtree has stopped "
            f"retrying.\nClassified as: {ev['classified']}\nLast error: {err}\n\n"
            "It has been told and driven, so it may recover on its own — but it may "
            "also be holding unfinished or uncommitted work from the turn that died. "
            "Nothing will retry it again automatically. Check on it.")[:8000]


@renderer("runtime.report_parked")
def _r_parked(ev: _R) -> str:
    name, nid = ev["report_name"], ev["report"]
    err = ev.get("err") or "no detail"
    if ev["audience"] == "user":
        return (f"{name} ({nid}) {ev['headline']} and is stopped with no reset time — "
                f"nothing will wake it, and it has no superior to tell.\n"
                f"Lane: {ev['lane']}\nWhat it said: {err}")[:2000]
    return (f"[REPORT STOPPED — {name} ({nid}) {ev['headline']}]\n{ev['detail']}\n\n"
            f"Lane: {ev['lane']}\nWhat it said: {err}\n\n"
            "It is not frozen on a timer and orgtree will not re-drive it, so nothing "
            "changes until someone acts. It may also be holding unfinished work from "
            "the turn that stopped.\n\n"
            "You have NOT been woken for this, and you will not hear about it again "
            "until it has completed a turn and got stuck afresh.")[:8000]


@renderer("runtime.report_limited")
def _r_limited(ev: _R) -> str:
    name, nid = ev["report_name"], ev["report"]
    until = ev.get("reset_at") or "not known"
    err = ev.get("err") or "no detail"
    if ev["audience"] == "user":
        return (f"{name} ({nid}) is out of provider capacity: its provider refused the "
                f"turn on a usage limit and it is frozen. It has no superior to tell.\n"
                f"Lane: {ev['lane']}\nLimit lifts: {until}\nProvider said: {err}")[:2000]
    return (f"[REPORT LIMITED — {name} ({nid}) is out of provider capacity]\n"
            f"Its provider refused the turn on a usage limit, so it stopped mid-task "
            f"and is now FROZEN.\nLane: {ev['lane']}\nLimit lifts: {until}\n"
            f"Provider said: {err}\n\n"
            "It is blocked, not broken — the work it was doing is held and will be "
            "replayed when it runs again. Whether it wakes by itself when the window "
            "lifts depends on this org's auto-resume setting; ▶ resume works either "
            "way.\n\n"
            "You have NOT been woken for this, and you will not hear about this wall "
            "again: it is one notice per episode, and the next one comes only after "
            "it has run a turn and been walled afresh. If the work cannot wait for "
            "the reset, move it to another agent or another lane.")[:8000]


@renderer("runtime.subagent_died")
def _r_subagent(ev: _R) -> str:
    orphans: list[dict[str, Any]] = ev["orphans"]
    lines: list[str] = []
    salvage = False
    for o in orphans[:20]:
        outf = o.get("output_file")
        salvage = salvage or bool(outf)
        lines.append(f"- \"{o['description']}\" (task {o['id']})"
                     + (f"\n  partial output: {outf}" if outf else ""))
    n = int(ev["count"])
    return (f"[SUBAGENT DIED — {n} background subagent(s) were killed before "
            f"finishing]\nReason: {ev['reason']}\n\n" + "\n".join(lines)
            + (f"\n… and {n - 20} more" if n > 20 else "")
            + "\n\nNo completion record exists for these — do NOT keep waiting on "
              "them, and do not assume their work landed."
            + (" The partial output files named above are real and may hold most of "
               "the work — READ THEM before redoing anything." if salvage else
               " Nothing usable was left on disk for these.")
            + " To retry, relaunch — and prefer run_in_background:false, which fails "
              "loudly instead of silently if it happens again.")


@renderer("runtime.background_task_stopped")
def _r_bg_task(ev: _R) -> str:
    o = _obj(ev)
    return (f"[BACKGROUND TASK STOPPED — \"{o['description']}\" did not complete]\n"
            f"task id: {o['id']}\n"
            + (f"CLI summary: {ev['summary']}\n" if ev.get("summary") else "")
            + (f"partial output: {ev['output_file']}\n" if ev.get("output_file") else "")
            + "\nThis was reported by the CLI itself while your process was still "
              "alive — it did not die and nothing killed it. Whatever you were waiting "
              "for did not finish. Do NOT assume the work landed; check the actual "
              "state before continuing.")[:8000]


def _build_lines(ev: _R) -> str:
    o = _obj(ev)
    dirty = " [DIRTY - uncommitted changes present at boot]" if o["dirty"] else ""
    prev = ev.get("prev_pid")
    pid = f"{o['pid']}" + (f" (was: {prev})" if prev is not None and prev != o["pid"] else "")
    # the branch rides on the Started-at line, exactly as restart_wake.py wrote it
    branch = f", branch: {ev['branch']}" if ev.get("branch") else ""
    return (f"Running build:\n- Commit: {o['commit']} (short: {o['short']}){dirty}\n"
            f"- Backend PID: {pid}\n- Started at: {ev['started_at']}{branch}")


@renderer("runtime.restart_notice")
def _r_restart_notice(ev: _R) -> str:
    o = _obj(ev)
    return ("[ORGTREE RESTART NOTICE] The backend was restarted. This is an "
            "informational notice delivered to live agents so you know what code "
            "version went live.\n\n" + _build_lines(ev) + "\n\n"
            "What you can do with this:\n"
            "- If you were waiting on or verifying a deployed fix, check whether the "
            "running commit contains your changes with:\n"
            f"  git merge-base --is-ancestor <your-commit> {o['commit']}\n"
            "- If you need to be woken immediately with a turn on the NEXT restart, "
            "call orgtree_restart_wake.\n"
            "- Otherwise, no action is needed; this notice is for your awareness.")


@renderer("runtime.storage")
def _r_storage(ev: _R) -> str:
    used, cap, lvl = float(ev["used_mb"]), ev.get("cap_mb"), ev["level"]
    if ev["scope"] == "disk":
        total = float(cap or 0)
        if lvl == "over":
            return (f"⚠ The org disk is at {used:.0f} of {total:.0f} MB (past the 90% "
                    f"soft cap). New turns are PAUSED until usage drops under 85% — the "
                    f"remaining space is the reserve that keeps session journaling "
                    f"alive. Delete files (the admin can also use the recovery browser "
                    f"or grow the disk); at 100% every write fails with ENOSPC.")
        if lvl == "cleared":
            return (f"The org disk is back under the soft cap ({used:.0f} / {total:.0f} "
                    f"MB) — turns resume.")
        return (f"Heads-up: the org disk is at {used:.0f} of {total:.0f} MB (past 80%). "
                f"Clean up or curb file growth — at 90% new turns pause; at 100% "
                f"writes fail with ENOSPC.")
    # the cap was an int (`storage_limit_mb`) in the old text: print it as one
    lim = ("∞" if cap is None else
           str(int(cap)) if float(cap).is_integer() else f"{float(cap):g}")
    if lvl == "over":
        return (f"⚠ The org is OVER its storage limit ({used:.1f} / {lim} MB — "
                f"workspace + scratch + uploads together). File creation and writes in "
                f"the workspace and every scratch folder are now BLOCKED at the OS "
                f"level — new writes will fail with permission errors. Deleting still "
                f"works: remove large files you created and the block lifts "
                f"automatically at the next check. Do NOT keep generating files.")
    if lvl == "cleared":
        return f"Storage is back under the limit ({used:.1f} / {lim} MB) — writes are unblocked."
    return (f"Heads-up: the org is at {used:.1f} of {lim} MB (past 90% of the storage "
            f"limit). Clean up or curb file growth — at the limit, workspace AND "
            f"scratch writes are blocked at the OS level.")


@renderer("runtime.token_expiry")
def _r_token(ev: _R) -> str:
    return (f"⚠ The Claude subscription's refresh token expires in "
            f"~{max(0.0, float(ev['days'])):.1f} days. When it lapses, re-login is "
            f"INTERACTIVE and every turn fails until someone signs in — open Claude "
            f"Code on this machine soon, or give the org an API key (settings → "
            f"autonomy).")


@renderer("runtime.delivery_unread")
def _r_unread(ev: _R) -> str:
    nid = ev["to"]
    b = ev.get("boundary_for")
    return (f'Your mid-turn message to "{nid}" has NOT been read yet — it has been '
            f'waiting {ev["waited"]} in its steer store. Mid-turn mail is injected when '
            f'the recipient\'s current tool call returns'
            + (f", and {nid} has been inside one call for {b}" if b else "")
            + f'. Nothing is lost — it is delivered at that boundary, or at {nid}\'s '
              f'next turn if the turn ends first. If it cannot wait that long, '
              f'orgtree_interrupt (⏸) on {nid} creates a boundary immediately without '
              f'ending its session.')


@renderer("runtime.ui_crash_report")
def _r_crash(ev: _R) -> str:
    return str(ev["summary"])


@renderer("runtime.external_unroutable")
def _r_unroutable(ev: _R) -> str:
    return (f"Outside party {ev['peer']} messaged this org, but no top-level agents "
            f"are live to receive it:\n\n" + str(ev["excerpt"])[:2000])


# ========================================================================= reminders
_CHECKUP = ("[AUTOMATIC 20-MINUTE WORKING-STATUS CHECK]\n"
            "You previously reported that you were working, but Orgtree has not woken "
            "you for 20 minutes. Check the actual work, files, processes, and messages. "
            "If useful work remains, make concrete progress now. Then report honestly "
            "with orgtree_status: use working only if work is still in progress, done "
            "if it is complete, or blocked if you truly cannot proceed. Do not claim "
            "that work is continuing without verifying it.")
_IDLE_ROLE = {
    "owner": "",
    "reviewer": " — awaiting YOUR review",
    "unassigned_review": " — NO REVIEWER NAMED: assign one, do not review "
                         "your own work",
    "stale_reviewer": " — its named reviewer is no longer live: name another, "
                      "do not review your own work",
}


@renderer("reminder.working_checkup")
def _r_checkup(ev: _R) -> str:
    return _CHECKUP


@renderer("reminder.idle_docket")
def _r_idle_docket(ev: _R) -> str:
    items: list[dict[str, Any]] = ev["items"]
    lines = [f"- {it['slug']} ({it['status']}{_IDLE_ROLE.get(it['role'], '')}): "
             f"{it['title']}" for it in items]
    more = int(ev["more"])
    if more:
        lines.append(f"- …and {more} more item(s) waiting on you; orgtree_work list "
                     f"shows them all")
    return ("[AUTOMATIC IDLE DOCKET REMINDER]\n"
            "You have been idle for 20 minutes and these docket items are waiting on "
            "YOU for their next action:\n" + "\n".join(lines) + "\n"
            "Pick the work back up: read each one with orgtree_work get, take the "
            "next concrete step, and leave an honest orgtree_work update. Assert "
            "review only if an item is really finished; blocked (with a "
            "blocked_reason) if it truly cannot move; waiting (with a waiting_reason "
            "naming the external event and how you will hear of it) if its next step "
            "is not yours to take. Items that are backlogged, already waiting on an "
            "external event, or waiting on the user through an attention flag or an "
            "open question are deliberately not listed here — and nor is anything "
            "whose next action belongs to somebody else.")


# =================================================================== context / change
@renderer("context.deep_reach")
def _r_deep_reach(ev: _R) -> str:
    nid, gist = ev["node"], ev["gist"]
    if ev["kind"] == "command":
        return (f'The user ran the session command "{gist}" on "{nid}", inside your '
                f'chain. It came from the USER directly, not through you. Re-check any '
                f'plan of yours that assumes {nid}\'s session is unchanged. You are '
                f'being told, not asked to act.')
    return (f'The user gave a direct instruction to "{nid}", inside your chain: '
            f'"{gist}" — it carries the USER\'s authority and outranks anything you '
            f'have told {nid}. Re-check any plan of yours that depends on it. You are '
            f'being told, not asked to act.')


@renderer("context.notice_digest")
def _r_digest(ev: _R) -> str:
    from .events import render_agent
    groups: list[dict[str, Any]] = ev["groups"]
    total = sum(len(g["members"]) for g in groups)
    out = [f"{total} notice(s) since your last turn, grouped by kind — every one is "
           f"listed in full below" + (f", plus {ev['untyped']} older untyped notice(s) "
                                      f"shown verbatim after them" if ev["untyped"] else "")
           + ":"]
    for g in groups:
        out.append(f"■ {g['variant']} · {g['object_kind']} × {len(g['members'])}")
        for m in g["members"]:
            out.append(f"  - {m['at']}: {render_agent(m['event'])}")
    return "\n".join(out)


for _v in ("context.org_state", "context.provider_usage", "context.cache_continuity",
           "context.org_charter", "context.command", "context.drive_mail_pointer",
           "context.drive_restart_interrupted", "context.drive_restart_wake"):
    renderer(_v)(lambda ev: str(ev["text"]))
