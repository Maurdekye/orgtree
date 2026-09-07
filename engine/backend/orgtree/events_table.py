# pyright: strict
"""THE ONE DECLARATIVE SOURCE for canonical typed messages (design:
feature-fable/typed-message-architecture-backend.md VERSION 5, approved
2026-09-06). Everything else — the Python validators, the JSON schema, the
TypeScript unions, the field-disposition manifest, the family table — is
GENERATED from this module by `events.py` / `tools/gen_events.py`. Nothing
about a leaf is decided anywhere else.

FIELD SPEC MINI-LANGUAGE (`t`):
    str | int | float | bool            strict scalars (bool is not int; floats finite)
    <T>?                                nullable — the KEY IS STILL REQUIRED
    [<T>]  [<T>]{1}                     list, optionally with a minimum length
    L[a|b|c]                            string literal set
    R:<RefName>                         one of the REFS below (a typed object reference)
    N:<RecordName>                      a named nested record (RECORDS below)
    U:<UnionName>                       a named nested union of records discriminated by `kind`

EVERY field carries TWO explicit attributes and there is NO DEFAULT for either
(the generator refuses a field lacking one — the refusal IS the visitor boundary):
    d   disposition   both | human_only | model_only | internal
    p   public        True | False   — may a kiosk VISITOR see it (PublicEvent)
    x   public_exempt (optional, only with p=True) — the value reaches the body only in
        transformed form; listed so a reviewer sees exactly these.

Rules the generator enforces (tests in test_events.py):
  * p=True is only legal on d in {both, human_only}.
  * STRUCTURAL keys (v, variant, projection, actor.kind, every Ref `kind`, every nested
    union `kind`) are public BY RULE and must not be marked otherwise; they are excluded
    from the B16 disclosure invariant by construction and never appear in `x`.
  * every leaf declares `object` as exactly one Ref name or None.
  * every leaf has a `family` from FAMILIES (explicit; never derived from the prefix).
"""

from __future__ import annotations

from typing import Any, Final

EVENT_V: Final = 1

FAMILIES: Final = (
    "ordinary", "linked_reply", "assignment", "review", "status", "answer_decision",
    "access_resources", "lifecycle", "monitor", "runtime_recovery", "reminder",
    "context_change",
)

# ---------------------------------------------------------------------------- helpers
def F(t: str, d: str, p: bool, x: str | None = None) -> dict[str, Any]:
    f: dict[str, Any] = {"t": t, "d": d, "p": p}
    if x is not None:
        f["x"] = x
    return f


B = "both"
H = "human_only"
M = "model_only"
I = "internal"
_LINK = "object identity for the link; the body names it in prose or not at all"
_VARIANT = "variant-dependent: today's text names it only in some variants"
_RECITAL = "rendered by the envelope's reply recital, not the body"

# ------------------------------------------------------------------------------ refs
# `kind` on every ref is STRUCTURAL (public by rule). `org` is routing scope: internal.
REFS: Final[dict[str, dict[str, dict[str, Any]]]] = {
    "WorkItemRef": {"kind": F("L[work_item]", B, True), "org": F("str", I, False),
                    "slug": F("str", B, True, _LINK), "title": F("str", B, True, _LINK)},
    "DocumentRef": {"kind": F("L[document]", B, True), "org": F("str", I, False),
                    "id": F("str", B, True, _LINK), "title": F("str", B, True, _LINK),
                    "node": F("str", B, True, _LINK)},
    "MailRef": {"kind": F("L[mail]", B, True), "org": F("str", I, False),
                "box": F("L[user|org|node]", B, True), "node": F("str?", B, True, _LINK),
                "id": F("str", B, True, _LINK), "sender": F("str", B, True, _LINK),
                "at": F("str", B, True, _LINK)},
    "AskRef": {"kind": F("L[ask]", B, True), "org": F("str", I, False),
               "id": F("str", B, True, _LINK), "node": F("str", B, True, _LINK)},
    "BatchRef": {"kind": F("L[batch]", B, True), "org": F("str", I, False),
                 "id": F("str", B, True, _LINK), "node": F("str", B, True, _LINK)},
    "CreditReqRef": {"kind": F("L[credit_request]", B, True), "org": F("str", I, False),
                     "id": F("str", B, True, _LINK), "node": F("str", B, True, _LINK)},
    # an audience request has no id of its own: (from node, target) IS its identity
    # (Org._find_request); the ref carries exactly that pair
    "AudienceReqRef": {"kind": F("L[audience_request]", B, True), "org": F("str", I, False),
                       "node": F("str", B, True, _LINK), "target": F("str", B, True, _LINK)},
    "WatchdogRef": {"kind": F("L[watchdog]", B, True), "org": F("str", I, False),
                    "id": F("str", B, True, _LINK), "name": F("str", B, True, _LINK),
                    "owner": F("str", B, True, _LINK)},
    "NodeRef": {"kind": F("L[node]", B, True), "org": F("str", I, False),
                "id": F("str", B, True, _LINK), "name": F("str", B, True, _LINK),
                "generation": F("int", B, True)},
    "TaskRef": {"kind": F("L[task]", B, True), "org": F("str", I, False),
                "id": F("str", B, True, _LINK), "node": F("str", B, True, _LINK),
                "description": F("str", B, True, _LINK)},
    "BuildRef": {"kind": F("L[build]", B, True), "commit": F("str", B, True, _LINK),
                 "short": F("str", B, True, _LINK), "dirty": F("bool", B, True),
                 "pid": F("int", B, True)},
    "OrgRef": {"kind": F("L[org]", B, True), "org": F("str", I, False)},
    "SessionRef": {"kind": F("L[session]", B, True), "org": F("str", I, False),
                   "node": F("str", B, True, _LINK), "session_id": F("str", B, False)},
}

# --------------------------------------------------------------------------- records
RECORDS: Final[dict[str, dict[str, dict[str, Any]]]] = {
    "Quote": {"from": F("str", B, True, _RECITAL), "at": F("str", B, True, _RECITAL),
              "gist": F("str", B, True, _RECITAL)},
    "Folder": {"path": F("str", B, False), "mode": F("L[ro|rw]", B, True)},
    "ToolWant": {"bash": F("bool?", B, True), "web": F("bool?", B, True),
                 "edit": F("bool?", B, True), "subagents": F("bool?", B, True),
                 "mcp": F("[str]?", B, False)},
    "ScopeWant": {"folders": F("[N:Folder]", B, True), "tools": F("N:ToolWant", B, True),
                  "permission_mode": F("str?", B, False), "org_visibility": F("str?", B, False)},
    "AnsweredQ": {"label": F("str?", B, True), "question": F("str", B, True),
                  "selected": F("[str]", B, True)},
    "BatchQ": {"label": F("str?", B, True), "question": F("str", B, True),
               "answer": F("str?", B, True)},
    "ScopeDecision": {"label": F("str", B, False),
                      "decision": F("L[approve|deny|skip|approve (partial)|"
                                    "approve (clamped — not in effect)]", B, True)},
    "RoutedQ": {"header": F("str?", B, True), "text": F("str", B, True),
                "work_item": F("str?", B, True), "options": F("[str]", B, True),
                "multi": F("bool", B, True)},
    "DocketItem": {"slug": F("str", B, True), "title": F("str", B, True),
                   "status": F("str", B, True),
                   "role": F("L[owner|reviewer|unassigned_review|stale_reviewer]", B, True)},
    "Orphan": {"id": F("str", B, True), "description": F("str", B, True),
               "output_file": F("str?", B, False)},
    "ReportRow": {"id": F("str", M, False), "name": F("str", M, False),
                  "tier": F("str", M, False), "state": F("str", M, False)},
    "Credits": {"seat": F("float", M, False), "grant": F("float", M, False),
                "free": F("float", M, False)},
    "OrgStateSnapshot": {"seq": F("int?", M, False), "at": F("str", M, False),
                         "reports": F("[N:ReportRow]", M, False), "peers": F("[str]", M, False),
                         "chart": F("str?", M, False), "chart_ref": F("int?", M, False),
                         "credits": F("N:Credits", M, False), "notes": F("[str]", M, False)},
    "UsageRow": {"provider": F("str", M, False), "lane": F("str", M, False),
                 "window": F("str", M, False), "used_pct": F("float?", M, False),
                 "amount": F("str?", M, False), "reset_at": F("str?", M, False),
                 "observed_at": F("str?", M, False), "state": F("str", M, False)},
    "CrashReport": {"kind": F("str", B, False), "message": F("str", B, False),
                    "stack": F("str?", H, False), "url": F("str?", B, False),
                    "at": F("str", B, False)},
    "DigestMember": {"at": F("str", B, True), "event": F("E:Event", B, True)},
    "DigestGroup": {"variant": F("str", B, True), "object_kind": F("str", B, True),
                    "members": F("[N:DigestMember]{1}", B, True)},
    # answer.batch sections (discriminated union members)
    "SectionAsk": {"kind": F("L[ask]", B, True), "ask_id": F("str", B, False),
                   "questions": F("[N:BatchQ]{1}", B, True)},
    "SectionCredit": {"kind": F("L[credit]", B, True),
                      "outcome": F("L[skipped|approved|counter|declined|reduced|denied]", B, True),
                      "old": F("float", B, True), "asked": F("float", B, True),
                      "granted": F("float?", B, True), "now": F("float?", B, True)},
    "SectionScope": {"kind": F("L[scope]", B, True), "lines": F("[str]{1}", B, True),
                     "decisions": F("[N:ScopeDecision]", B, True)},
    "SectionSkipped": {"kind": F("L[skipped]", B, True), "ask_id": F("str", B, False),
                       "question": F("str", B, True)},
}

UNIONS: Final[dict[str, tuple[str, ...]]] = {
    "Section": ("SectionAsk", "SectionCredit", "SectionScope", "SectionSkipped"),
}

# ------------------------------------------------------------------------------ leaves
# Every leaf: family, object (Ref name or None), fields. Envelope keys (v, variant, actor,
# engine_authored) are added by the generator with fixed dispositions (§4 manifest).
# FIELDS ARE EXACTLY THE FACTS TODAY'S TEXT CARRIES (B4 byte parity) plus literals/numbers/
# bools; a public string that today's text does not print is either `p=False` or carries
# an `x` exemption naming why (B16).
def leaf(family: str, obj: str | None, **fields: dict[str, Any]) -> dict[str, Any]:
    return {"family": family, "object": obj, "fields": fields}


_BODY = F("str", B, True)
_YOU = "addressed as 'you' in the text"
_STATUS = "L[backlogged|open|in_progress|blocked|waiting|review|done|superseded|dropped]"   # = Org.WORK_STATUSES

LEAVES: Final[dict[str, dict[str, Any]]] = {
    # ---- family ordinary (authored; the only family reachable from the agent tool wire)
    "ordinary.message":  leaf("ordinary", None, body=_BODY),
    "ordinary.question": leaf("ordinary", None, body=_BODY),
    "ordinary.request":  leaf("ordinary", None, body=_BODY),
    "ordinary.decision": leaf("ordinary", None, body=_BODY),
    "ordinary.status":   leaf("ordinary", None, body=_BODY),
    "ordinary.notice":   leaf("ordinary", None, body=_BODY),
    # ---- family linked_reply
    "reply.docket":   leaf("linked_reply", "WorkItemRef", body=_BODY,
                           role=F("L[owner|participant]", B, True),
                           owner=F("str?", B, True, "named in the header prose only for participants")),
    "reply.document": leaf("linked_reply", "DocumentRef", body=_BODY),
    "reply.mail":     leaf("linked_reply", "MailRef", body=_BODY, quote=F("N:Quote", B, True)),
    # ---- family assignment (orgtree_staff and hire+work_item reuse this same mail)
    "docket.assigned": leaf(
        "assignment", "WorkItemRef",
        owner=F("str", B, True, _YOU), previous_owner=F("str?", B, True),
        assigner=F("str", B, True), status=F(_STATUS, B, True),
        objective=F("str", B, True), done_so_far=F("[str]", B, True),
        working_on_next=F("[str]", B, True)),
    # ---- family review
    "docket.review_requested": leaf(
        "review", "WorkItemRef",
        reviewer=F("str", B, True, _YOU), requested_by=F("str", B, True),
        owner=F("str", B, True), objective=F("str", B, True),
        done_so_far=F("[str]", B, True)),
    "docket.review_changes": leaf(
        "review", "WorkItemRef", reviewer=F("str", B, True), owner=F("str", B, True, _YOU),
        note=F("str?", B, True), relayed=F("bool", B, True)),
    "docket.review_approved": leaf(
        "review", "WorkItemRef", reviewer=F("str", B, True), owner=F("str", B, True, _YOU),
        note=F("str?", B, True), relayed=F("bool", B, True)),
    # ---- family status
    "status.report": leaf("status", "NodeRef", state=F("L[done|blocked]", B, True),
                          summary=F("str", B, True)),
    # ---- family answer_decision
    "answer.ask": leaf("answer_decision", "AskRef", questions=F("[N:AnsweredQ]{1}", B, True),
                       text=F("str?", B, True), dismissed=F("bool", B, True),
                       single=F("bool", B, True)),
    "answer.batch": leaf("answer_decision", "BatchRef", sections=F("[U:Section]{1}", B, True)),
    "decision.credit": leaf("answer_decision", "CreditReqRef",
                            outcome=F("L[approved|counter|declined|reduced|denied]", B, True),
                            old=F("float", B, True), asked=F("float", B, True),
                            granted=F("float?", B, True), now=F("float?", B, True)),
    "decision.audience": leaf("answer_decision", "AudienceReqRef", granted=F("bool", B, True),
                              target=F("str", B, True, "named only when declined"),
                              decided_by=F("str", B, True)),
    "decision.attention_dismissed": leaf(
        "answer_decision", "WorkItemRef", reason=F("str", B, True),
        pending_questions=F("int", B, True), dismissed_by=F("str", B, False)),
    # a ROUTED question is mail to the superior, never an ask record — there is no
    # AskRef to point at; the object is the asker
    "ask.routed": leaf("answer_decision", "NodeRef", from_node=F("str", B, False),
                       questions=F("[N:RoutedQ]{1}", B, True)),
    # ---- family access_resources
    # a ROUTED scope request (no user audience) is mail to the superior — no
    # scope_requests record exists for it, so the object is the requester
    "access.scope_requested": leaf("access_resources", "NodeRef",
                                   items=F("[str]{1}", B, True), reason=F("str", B, True),
                                   wanted=F("N:ScopeWant", B, True)),
    "access.audience_requested": leaf("access_resources", "AudienceReqRef",
                                      stage=F("L[initial|forwarded|target|user]", B, True),
                                      from_node=F("str", B, True),
                                      target=F("str", B, True, "'you' when stage=target"),
                                      reason=F("str", B, True)),
    "access.audience_changed": leaf(
        "access_resources", "NodeRef",
        outcome=F("L[user_audience|audience_with|audience_from|user_audience_seen|org_inbox|"
                  "org_inbox_auto|org_inbox_released|rescinded|declined]", B, True),
        by=F("str", B, True, "'the user' idiom; absent in some variants"),
        target=F("str", B, True, "named only in some variants"),
        other=F("str?", B, True, _VARIANT)),
    "access.grant_changed": leaf("access_resources", "NodeRef",
                                 relation=F("L[self|report]", B, True), node=F("str", B, True, _VARIANT),
                                 delta=F("float", B, True), now=F("float", B, True),
                                 free=F("float", B, True), by=F("str", B, True)),
    "access.scope_changed": leaf(
        "access_resources", "NodeRef", by=F("str", B, True),
        changed=F("[L[folders|tools|charter|org_visibility|permission_mode]]", B, True)),
    "access.kiosk_clamped": leaf("access_resources", "NodeRef", lost=F("[str]{1}", B, True)),
    "access.kiosk_ceiling": leaf("access_resources", "OrgRef"),
    # ---- family lifecycle
    "lifecycle.kickoff": leaf("lifecycle", "NodeRef", body=_BODY, hired_by=F("str", B, False),
                              reason=F("L[hire|rehire|staff|autopsy]", B, True),
                              tier=F("str", B, False), grant=F("float", B, True)),
    "lifecycle.hired": leaf("lifecycle", "NodeRef", node=F("str", B, True), by=F("str", B, True),
                            relation=F("L[report|peer]", B, True), tier=F("str", B, True),
                            grant=F("float", B, True), parent=F("str?", B, True, _VARIANT),
                            why=F("str?", B, True)),
    "lifecycle.retired": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                              by=F("str", B, True, "'itself' idiom for self-retirement"),
                              relation=F("L[report|peer]", B, True), freed=F("float", B, True)),
    "lifecycle.rescinded": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                                clawed=F("float", B, True)),
    "lifecycle.rehired": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                              by=F("str", B, True), relation=F("L[self|report|peer]", B, True),
                              grant=F("float", B, True)),
    "lifecycle.dissolved": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                                by=F("str", B, True), relation=F("L[report|peer]", B, True),
                                nodes=F("int", B, True), freed=F("float", B, True)),
    "lifecycle.deleted": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                              relation=F("L[report|peer]", B, True), extra=F("int", B, True)),
    "lifecycle.compacted": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                                relation=F("L[self|report]", B, True),
                                generation=F("int", B, True), predecessor=F("str", B, True),
                                auto=F("bool", B, True), lost=F("bool", B, True),
                                size_note=F("str?", B, True)),
    "lifecycle.cheap_compacted": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                                      relation=F("L[self|report]", B, True),
                                      by=F("str", B, True, "not named in the self text"),
                                      predecessor=F("str", B, True),
                                      team_note=F("str?", B, True, _VARIANT)),
    "lifecycle.reseeded": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                               relation=F("L[self|report]", B, True), by=F("str", B, True),
                               predecessor=F("str", B, True, "absent in the self text")),
    "lifecycle.recovered": leaf("lifecycle", "NodeRef", predecessor=F("str", B, True),
                                successor=F("str", B, False)),
    "lifecycle.phantom_removed": leaf("lifecycle", "NodeRef", predecessor=F("str", B, True),
                                      holder=F("str", B, True)),
    "lifecycle.unrecoverable": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                                    reason=F("str", B, True)),
    "lifecycle.bearer_lost": leaf("lifecycle", "NodeRef", bearer=F("str", B, True)),
    "lifecycle.bearer_exhausted": leaf("lifecycle", "NodeRef", bearer=F("str", B, True)),
    "lifecycle.handoff_record": leaf("lifecycle", "NodeRef", generation=F("int", B, True)),
    "lifecycle.model_switched": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                                     relation=F("L[self|report]", B, True),
                                     old=F("str", B, True), new=F("str", B, True),
                                     seat_old=F("float", B, True), seat_new=F("float", B, True),
                                     by=F("str", B, True), queued=F("bool", B, True),
                                     crossed=F("bool", B, True),
                                     old_provider=F("str?", B, True),
                                     new_provider=F("str?", B, True),
                                     predecessor=F("str?", B, True)),
    "lifecycle.switch_queued": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                                    old=F("str", B, True), new=F("str", B, True),
                                    by=F("str", B, True)),
    "lifecycle.switch_cancelled": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                                       target=F("str", B, True), by=F("str", B, True)),
    "lifecycle.switch_dropped": leaf("lifecycle", "NodeRef", node=F("str", B, True),
                                     target=F("str", B, True), kept=F("str", B, True),
                                     reason=F("str", B, True)),
    "lifecycle.seat_swapped": leaf(
        "lifecycle", "NodeRef", a=F("str", B, True, _VARIANT), b=F("str", B, True, _VARIANT),
        role=F("L[parent_of_a|parent_of_b|peer_of_a|peer_of_b|child_of_a|child_of_b|a|b]",
               B, True),
        nested=F("bool", B, True), by=F("str", B, True, "not named in every variant"),
        reports_to_after=F("str?", B, True), grant_after=F("str?", B, True),
        audience_note=F("str?", B, True)),
    "lifecycle.moved": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                            from_parent=F("str?", B, True, _VARIANT), to_parent=F("str?", B, True, _VARIANT),
                            role=F("L[old_parent|old_peer|new_parent|new_peer|self]", B, True),
                            by=F("str", B, True), tail=F("str?", B, True)),
    "lifecycle.inserted": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                               above=F("str", B, True), parent=F("str?", B, True),
                               role=F("L[parent|peer|target|child|self]", B, True),
                               by=F("str", B, True), grant_target=F("str?", B, True),
                               grant_new=F("str?", B, True), committed=F("str?", B, True)),
    "lifecycle.renamed": leaf("lifecycle", "NodeRef", old=F("str", B, True),
                              new=F("str", B, True), by=F("str", B, True)),
    "lifecycle.disk_migrated": leaf("lifecycle", "OrgRef", floored_from=F("str", B, True)),
    "policy.fable_flagged": leaf("lifecycle", "NodeRef",
                                 audience=F("L[parent|peer|user]", B, True),
                                 node=F("str", B, True),
                                 outcome=F("L[switched|autopsy_unavailable|autopsy|halted]",
                                           B, True),
                                 autopsy=F("str?", B, True), autopsy_model=F("str?", B, True),
                                 replacement=F("str?", B, True, _VARIANT), reason=F("str?", B, True, _VARIANT),
                                 detail=F("str", B, True, _VARIANT)),
    "policy.weekly_limit": leaf("lifecycle", "NodeRef",
                                relation=F("L[self|report|peer|user]", B, True),
                                node=F("str", B, True, _YOU),
                                outcome=F("L[switched|dissolved|halted]", B, True),
                                nodes=F("int?", B, True), freed=F("str?", B, True),
                                policy=F("str?", B, True, _VARIANT), detected_at=F("str?", B, True, _VARIANT),
                                halted=F("str?", B, True, _VARIANT), dissolved=F("str?", B, True, _VARIANT),
                                converted=F("str?", B, True, _VARIANT)),
    "policy.unstuck": leaf("lifecycle", "NodeRef"),
    "policy.unlocked": leaf("lifecycle", "NodeRef", node=F("str", B, True, _YOU),
                            relation=F("L[self|report|peer]", B, True)),
    "policy.limit_reset": leaf("lifecycle", "NodeRef",
                               relation=F("L[self|report|peer|user]", B, True),
                               node=F("str", B, True, _YOU), released=F("[str]", B, True, _VARIANT)),
    # ---- family monitor
    "monitor.watchdog_fired": leaf("monitor", "WatchdogRef", prefix=F("str", B, True),
                                   lines=F("[str]{1}", B, True), count=F("int", B, True),
                                   once=F("bool", B, True)),
    "monitor.watchdog_quiet": leaf("monitor", "WatchdogRef", headline=F("str", B, True, "printed upper-cased"),
                                   facts=F("[str]{1}", B, True), advice=F("str", B, True)),
    # ---- family runtime_recovery
    "runtime.turn_failed_terminal": leaf("runtime_recovery", "SessionRef",
                                         door=F("str", B, True), err=F("str", B, True)),
    "runtime.turn_failed_repeated": leaf("runtime_recovery", "SessionRef",
                                         attempts=F("int", B, True),
                                         classified=F("str", B, True), err=F("str", B, True)),
    "runtime.report_stalled": leaf("runtime_recovery", "NodeRef", report=F("str", B, True),
                                   report_name=F("str", B, True),
                                   cause=F("L[terminal|repeated]", B, True),
                                   audience=F("L[superior|user]", B, True),
                                   attempts=F("int?", B, True), classified=F("str?", B, True, _VARIANT),
                                   door=F("str?", B, True, _VARIANT), err=F("str", B, True)),
    "runtime.report_parked": leaf("runtime_recovery", "NodeRef", report=F("str", B, True),
                                  report_name=F("str", B, True),
                                  audience=F("L[superior|user]", B, True),
                                  headline=F("str", B, True), detail=F("str", B, True),
                                  lane=F("str", B, True), err=F("str?", B, True)),
    "runtime.report_limited": leaf("runtime_recovery", "NodeRef", report=F("str", B, True),
                                   report_name=F("str", B, True),
                                   audience=F("L[superior|user]", B, True),
                                   lane=F("str", B, True), reset_at=F("str?", B, True),
                                   err=F("str?", B, True)),
    "runtime.subagent_died": leaf("runtime_recovery", "SessionRef",
                                  orphans=F("[N:Orphan]{1}", B, True), count=F("int", B, True),
                                  reason=F("str", B, True)),
    "runtime.background_task_stopped": leaf("runtime_recovery", "TaskRef",
                                            summary=F("str?", B, True),
                                            output_file=F("str?", B, False)),
    "runtime.restart_notice": leaf("runtime_recovery", "BuildRef", prev_pid=F("int?", B, True),
                                   started_at=F("str", B, True), branch=F("str?", B, True)),
    "runtime.storage": leaf("runtime_recovery", "OrgRef",
                            level=F("L[heads_up|over|cleared]", B, True),
                            used_mb=F("float", B, True), cap_mb=F("float?", B, True),
                            scope=F("L[disk|storage]", B, True)),
    "runtime.token_expiry": leaf("runtime_recovery", "OrgRef", days=F("float", B, True)),
    "runtime.delivery_unread": leaf("runtime_recovery", "MailRef", to=F("str", B, True),
                                    waited=F("str", B, True), boundary_for=F("str?", B, True)),
    "runtime.ui_crash_report": leaf("runtime_recovery", "OrgRef", summary=F("str", B, True),
                                    report=F("N:CrashReport", B, False)),
    "runtime.external_unroutable": leaf("runtime_recovery", "OrgRef", peer=F("str", B, True),
                                        excerpt=F("str", B, True)),
    # ---- family reminder
    "reminder.working_checkup": leaf("reminder", "NodeRef"),
    "reminder.idle_docket": leaf("reminder", "NodeRef",
                                 items=F("[N:DocketItem]{1}", B, True), more=F("int", B, True)),
    # ---- family context_change
    "docket.participant_added": leaf("context_change", "WorkItemRef",
                                     added_by=F("str", B, True), owner=F("str", B, True),
                                     objective=F("str", B, True)),
    "context.deep_reach": leaf("context_change", "NodeRef", node=F("str", B, True),
                               gist=F("str", B, True), kind=F("L[message|command]", B, True)),
    "context.notice_digest": leaf("context_change", None,
                                  groups=F("[N:DigestGroup]", B, True),
                                  untyped=F("int", B, True)),
    "context.org_state": leaf("context_change", "OrgRef", text=F("str", M, False),
                              snapshot=F("N:OrgStateSnapshot", M, False)),
    "context.provider_usage": leaf("context_change", "OrgRef", text=F("str", M, False),
                                   rows=F("[N:UsageRow]", M, False), seq=F("int", M, False)),
    "context.cache_continuity": leaf("context_change", "OrgRef", text=F("str", M, False)),
    "context.org_charter": leaf("context_change", "OrgRef", text=F("str", M, False),
                                readable=F("bool", M, False)),
    "context.command": leaf("context_change", "NodeRef", text=F("str", B, True)),
    # Minted at COMPOSITION for every `ping` carrier (supervisor._ping_drive): `text` is
    # the nudge exactly as the agent reads it; `reason` is the SENDING site's stated
    # reason (send_message ping_reason=…) and null when the site did not state one —
    # composition never guesses it from the text or the drained batch.
    "context.drive_mail_pointer": leaf(
        "context_change", "NodeRef", text=F("str", M, False),
        reason=F("L[user_mail|agent_mail|notice|participation|docket_reply|ask_answer|batch|"
                 "credit_decision|audience|rehire_waited|reconcile_waited|freeze_lifted|"
                 "remote_released|unfrozen_by_switch|external_inbox|watchdog|watchdog_quiet|"
                 "storage|failure|checkup|reminder]?", M, False)),
    "context.drive_restart_interrupted": leaf("context_change", "BuildRef",
                                              text=F("str", M, False)),
    "context.drive_restart_wake": leaf("context_change", "BuildRef", text=F("str", M, False),
                                       reason=F("str?", M, False),
                                       armed_by_pid=F("int?", M, False),
                                       mode=F("L[one_shot|cut]", M, False)),
}

# Envelope keys every leaf carries, with their fixed dispositions (§4 manifest).
ENVELOPE: Final[dict[str, dict[str, Any]]] = {
    "v": F("int", B, True),
    "variant": F("str", B, True),
    "actor": F("N:Actor", B, True),
    "engine_authored": F("bool", H, False),
}
ACTOR: Final[dict[str, dict[str, Any]]] = {
    "kind": F("L[user|agent|system|external|watchdog]", B, True),
    "id": F("str", B, True, "the row's FROM header carries it, not the body"),
}

# Structural keys — public BY RULE, excluded from the B16 invariant by construction.
STRUCTURAL: Final = frozenset({"v", "variant", "projection", "actor.kind"})

# Leaves whose canonical `body` is by definition the row body: the ROW encoder elides the
# duplicate and the row decoder restores it (§5). Bare events are always serialised in full.
# `reply.docket` is NOT elided: its row body is the renderer's header + instruction
# + the user's text, while `body` on the event is the user's text alone (the
# compact card shows the text; the header is the agent's recital).
ELIDED_FIELDS: Final[dict[str, tuple[str, ...]]] = {
    **{k: ("body",) for k in LEAVES if k.startswith("ordinary.")},
    "reply.mail": ("body",), "reply.document": ("body",),
}

# The closed list of engine-authored events that today are routed under the USER's name and
# keep `from=USER` on the row (I3 exception): actor is system, engine_authored true.
USER_ROUTED_ENGINE_AUTHORED: Final = frozenset({
    ("lifecycle.kickoff", "autopsy"), ("runtime.ui_crash_report", None),
})

RESERVED: Final[frozenset[str]] = frozenset()   # leaves with no producer yet — empty at launch
