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

EVERY field carries an explicit disposition and there is NO DEFAULT (the generator
refuses a field lacking one):
    d   disposition   both | human_only | model_only | internal

Rules the generator enforces (tests in test_events.py):
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
def F(t: str, d: str) -> dict[str, Any]:
    return {"t": t, "d": d}


B = "both"
H = "human_only"
M = "model_only"
I = "internal"

# ------------------------------------------------------------------------------ refs
# `kind` on every ref is STRUCTURAL. `org` is routing scope: internal.
REFS: Final[dict[str, dict[str, dict[str, Any]]]] = {
    "WorkItemRef": {"kind": F("L[work_item]", B), "org": F("str", I),
                    "slug": F("str", B), "title": F("str", B)},
    "DocumentRef": {"kind": F("L[document]", B), "org": F("str", I),
                    "id": F("str", B), "title": F("str", B),
                    "node": F("str", B)},
    "MailRef": {"kind": F("L[mail]", B), "org": F("str", I),
                "box": F("L[user|org|node]", B), "node": F("str?", B),
                "id": F("str", B), "sender": F("str", B),
                "at": F("str", B)},
    "AskRef": {"kind": F("L[ask]", B), "org": F("str", I),
               "id": F("str", B), "node": F("str", B)},
    "BatchRef": {"kind": F("L[batch]", B), "org": F("str", I),
                 "id": F("str", B), "node": F("str", B)},
    "CreditReqRef": {"kind": F("L[credit_request]", B), "org": F("str", I),
                     "id": F("str", B), "node": F("str", B)},
    # an audience request has no id of its own: (from node, target) IS its identity
    # (Org._find_request); the ref carries exactly that pair
    "AudienceReqRef": {"kind": F("L[audience_request]", B), "org": F("str", I),
                       "node": F("str", B), "target": F("str", B)},
    "WatchdogRef": {"kind": F("L[watchdog]", B), "org": F("str", I),
                    "id": F("str", B), "name": F("str", B),
                    "owner": F("str", B)},
    "NodeRef": {"kind": F("L[node]", B), "org": F("str", I),
                "id": F("str", B), "name": F("str", B),
                "generation": F("int", B)},
    "TaskRef": {"kind": F("L[task]", B), "org": F("str", I),
                "id": F("str", B), "node": F("str", B),
                "description": F("str", B)},
    "BuildRef": {"kind": F("L[build]", B), "commit": F("str", B),
                 "short": F("str", B), "dirty": F("bool", B),
                 "pid": F("int", B),
                 "provenance": F("L[source|packaged|unknown]", B)},
    "OrgRef": {"kind": F("L[org]", B), "org": F("str", I)},
    "SessionRef": {"kind": F("L[session]", B), "org": F("str", I),
                   "node": F("str", B), "session_id": F("str", B)},
}

# --------------------------------------------------------------------------- records
RECORDS: Final[dict[str, dict[str, dict[str, Any]]]] = {
    "Quote": {"from": F("str", B), "at": F("str", B),
              "gist": F("str", B)},
    "Folder": {"path": F("str", B), "mode": F("L[ro|rw]", B)},
    "ToolWant": {"bash": F("bool?", B), "web": F("bool?", B),
                 "edit": F("bool?", B), "subagents": F("bool?", B),
                 "mcp": F("[str]?", B)},
    "ScopeWant": {"folders": F("[N:Folder]", B), "tools": F("N:ToolWant", B),
                  "permission_mode": F("str?", B), "org_visibility": F("str?", B)},
    "AnsweredQ": {"label": F("str?", B), "question": F("str", B),
                  "selected": F("[str]", B)},
    "BatchQ": {"label": F("str?", B), "question": F("str", B),
               "answer": F("str?", B)},
    "ScopeDecision": {"label": F("str", B),
                      "decision": F("L[approve|deny|skip|approve (partial)|"
                                    "approve (clamped — not in effect)]", B)},
    "RoutedQ": {"header": F("str?", B), "text": F("str", B),
                "work_item": F("str?", B), "options": F("[str]", B),
                "multi": F("bool", B)},
    "DocketItem": {"slug": F("str", B), "title": F("str", B),
                   "status": F("str", B),
                   "role": F("L[owner|deployer|reviewer|unassigned_review|stale_reviewer]", B)},
    "Orphan": {"id": F("str", B), "description": F("str", B),
               "output_file": F("str?", B)},
    "ReportRow": {"id": F("str", M), "name": F("str", M),
                  "tier": F("str", M), "state": F("str", M)},
    "Credits": {"seat": F("float", M), "grant": F("float", M),
                "free": F("float", M)},
    "OrgStateSnapshot": {"seq": F("int?", M), "at": F("str", M),
                         "reports": F("[N:ReportRow]", M), "peers": F("[str]", M),
                         "chart": F("str?", M), "chart_ref": F("int?", M),
                         "credits": F("N:Credits", M), "notes": F("[str]", M)},
    "UsageRow": {"provider": F("str", M), "lane": F("str", M),
                 "window": F("str", M), "used_pct": F("float?", M),
                 "amount": F("str?", M), "reset_at": F("str?", M),
                 "observed_at": F("str?", M), "state": F("str", M)},
    "CrashReport": {"kind": F("str", B), "message": F("str", B),
                    "stack": F("str?", H), "url": F("str?", B),
                    "at": F("str", B)},
    "DigestMember": {"at": F("str", B), "event": F("E:Event", B)},
    "DigestGroup": {"variant": F("str", B), "object_kind": F("str", B),
                    "members": F("[N:DigestMember]{1}", B)},
    # answer.batch sections (discriminated union members)
    "SectionAsk": {"kind": F("L[ask]", B), "ask_id": F("str", B),
                   "questions": F("[N:BatchQ]{1}", B)},
    "SectionCredit": {"kind": F("L[credit]", B),
                      "outcome": F("L[skipped|approved|counter|declined|reduced|denied]", B),
                      "old": F("float", B), "asked": F("float", B),
                      "granted": F("float?", B), "now": F("float?", B)},
    "SectionScope": {"kind": F("L[scope]", B), "lines": F("[str]{1}", B),
                     "decisions": F("[N:ScopeDecision]", B)},
    "SectionSkipped": {"kind": F("L[skipped]", B), "ask_id": F("str", B),
                       "question": F("str", B)},
}

UNIONS: Final[dict[str, tuple[str, ...]]] = {
    "Section": ("SectionAsk", "SectionCredit", "SectionScope", "SectionSkipped"),
}

# ------------------------------------------------------------------------------ leaves
# Every leaf: family, object (Ref name or None), fields. Envelope keys (v, variant, actor,
# engine_authored) are added by the generator with fixed dispositions (§4 manifest).
# FIELDS ARE EXACTLY THE FACTS TODAY'S TEXT CARRIES (B4 byte parity) plus literals/numbers/
# bools.
def leaf(family: str, obj: str | None, **fields: dict[str, Any]) -> dict[str, Any]:
    return {"family": family, "object": obj, "fields": fields}


_BODY = F("str", B)

# ⚠ THE SINGLE SOURCE OF TRUTH for `context.drive_mail_pointer.reason`, and the
# reason it is a tuple rather than a literal spelled inline (user-reported Quick
# Hire failure, 2026-09-15). The literal below is BUILT from this tuple, and
# `supervisor.check_ping_reason` validates every `send_message(ping_reason=…)`
# against the SAME tuple at the sending door. Before that they were two
# independent lists: `api.quick_staff_select` stated `quick_staff` and
# `api.node_unstick` stated `unstuck`, neither of which was ever added here, so
# the nudge composed fine at the call and then killed the RECIPIENT's turn at
# admission with `bad_literal at reason` — a failure that surfaced on an
# innocent agent, minutes later, after the docket had already been advanced and
# the mail already posted. Adding a new reason means adding it HERE; nothing
# else needs touching, and nothing else may carry its own copy of this list.
DRIVE_MAIL_POINTER_REASONS: Final[tuple[str, ...]] = (
    "user_mail", "agent_mail", "notice", "participation", "docket_reply",
    "ask_answer", "batch", "credit_decision", "audience", "rehire_waited",
    "reconcile_waited", "freeze_lifted", "remote_released",
    "unfrozen_by_switch", "external_inbox", "watchdog", "watchdog_quiet",
    "storage", "failure", "checkup", "reminder",
    "docket_abandoned_reassignment",
    # the two the product has always sent and the table never listed
    "quick_staff", "unstuck",
)

_STATUS = "L[backlogged|open|in_progress|blocked|waiting|review|deploy_ready|done|superseded|dropped]"   # = Org.WORK_STATUSES

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
                           role=F("L[owner|participant]", B),
                           owner=F("str?", B)),
    "reply.document": leaf("linked_reply", "DocumentRef", body=_BODY),
    "reply.mail":     leaf("linked_reply", "MailRef", body=_BODY, quote=F("N:Quote", B)),
    # ---- family assignment (orgtree_staff and hire+work_item reuse this same mail)
    "docket.assigned": leaf(
        "assignment", "WorkItemRef",
        owner=F("str", B), previous_owner=F("str?", B),
        assigner=F("str", B), status=F(_STATUS, B),
        objective=F("str", B), done_so_far=F("[str]", B),
        working_on_next=F("[str]", B),
        acceptance=F("[str]", B),
        # W09: one sentence saying the description above may not be the whole
        # scope, rendered immediately before it. Null — and absent on an
        # historical fixture — means it IS the whole scope, and renders
        # nothing, so every existing body is unchanged.
        objective_notice=F("str?", B)),
    # ---- family review
    "docket.review_requested": leaf(
        "review", "WorkItemRef",
        reviewer=F("str", B), requested_by=F("str", B),
        owner=F("str", B), objective=F("str", B),
        done_so_far=F("[str]", B), acceptance=F("[str]", B),
        revision=F("int", B), candidate=F("str?", B),
        base=F("str?", B),
        # W09 — see docket.assigned. A reviewer reads the description to judge
        # the work against it, so they need this as much as the owner does.
        objective_notice=F("str?", B),
        # Same field, same meaning, as on review_changes/review_approved: the
        # namer could not address the reviewer under §7.2, so the docket
        # carried the notice. Reachable since the REVIEW SEAT let an owner name
        # a granted peer in another branch of the org.
        relayed=F("bool", B)),
    # THE REVIEW SEAT. An owner may name only itself, its subtree or its own
    # superior as reviewer, so a PEER reviewer has to be granted the seat by
    # the agent above them both. `requested` is the owner's ask, addressed to
    # that agent; `decided` is the answer, addressed back to the owner.
    "docket.review_seat_requested": leaf(
        "review", "WorkItemRef",
        reviewer=F("str", B), requested_by=F("str", B),
        owner=F("str", B), grantor=F("str", B),
        note=F("str?", B)),
    "docket.review_seat_decided": leaf(
        "review", "WorkItemRef",
        reviewer=F("str", B), owner=F("str", B),
        decided_by=F("str", B),
        decision=F("L[granted|revoked|declined]", B),
        # True only when the grant also handed the seat over on the spot,
        # which it does exactly when the item was already at status review.
        seated=F("bool", B), note=F("str?", B),
        revision=F("int", B)),
    "docket.review_changes": leaf(
        "review", "WorkItemRef", reviewer=F("str", B), owner=F("str", B),
        note=F("str?", B), relayed=F("bool", B)),
    "docket.review_approved": leaf(
        "review", "WorkItemRef", reviewer=F("str", B), owner=F("str", B),
        note=F("str?", B), relayed=F("bool", B)),
    # the THIRD review outcome: an exact commit passed, and the item is NOT
    # done because it is not landed. `candidate` is required rather than
    # optional — the whole point of this outcome is that the approval names a
    # commit, so an event carrying none would describe nothing checkable.
    "docket.review_approved_stage": leaf(
        "review", "WorkItemRef", reviewer=F("str", B), owner=F("str", B),
        candidate=F("str", B), note=F("str?", B),
        relayed=F("bool", B)),
    # ---- family status
    "status.report": leaf("status", "NodeRef", state=F("L[done|blocked]", B),
                          summary=F("str", B)),
    # ---- family answer_decision
    "answer.ask": leaf("answer_decision", "AskRef", questions=F("[N:AnsweredQ]{1}", B),
                       text=F("str?", B), dismissed=F("bool", B),
                       single=F("bool", B)),
    "answer.batch": leaf("answer_decision", "BatchRef", sections=F("[U:Section]{1}", B)),
    "decision.credit": leaf("answer_decision", "CreditReqRef",
                            outcome=F("L[approved|counter|declined|reduced|denied]", B),
                            old=F("float", B), asked=F("float", B),
                            granted=F("float?", B), now=F("float?", B)),
    "decision.audience": leaf("answer_decision", "AudienceReqRef", granted=F("bool", B),
                              target=F("str", B),
                              decided_by=F("str", B)),
    "decision.attention_dismissed": leaf(
        "answer_decision", "WorkItemRef", reason=F("str", B),
        pending_questions=F("int", B), dismissed_by=F("str", B)),
    # a ROUTED question is mail to the superior, never an ask record — there is no
    # AskRef to point at; the object is the asker
    "ask.routed": leaf("answer_decision", "NodeRef", from_node=F("str", B),
                       questions=F("[N:RoutedQ]{1}", B)),
    # ---- family access_resources
    # a ROUTED scope request (no user audience) is mail to the superior — no
    # scope_requests record exists for it, so the object is the requester
    "access.scope_requested": leaf("access_resources", "NodeRef",
                                   items=F("[str]{1}", B), reason=F("str", B),
                                   wanted=F("N:ScopeWant", B)),
    "access.audience_requested": leaf("access_resources", "AudienceReqRef",
                                      stage=F("L[initial|forwarded|target|user]", B),
                                      from_node=F("str", B),
                                      target=F("str", B),
                                      reason=F("str", B)),
    "access.audience_changed": leaf(
        "access_resources", "NodeRef",
        outcome=F("L[user_audience|audience_with|audience_from|user_audience_seen|org_inbox|"
                  "org_inbox_auto|org_inbox_released|rescinded|declined]", B),
        by=F("str", B),
        target=F("str", B),
        other=F("str?", B)),
    "access.grant_changed": leaf("access_resources", "NodeRef",
                                 relation=F("L[self|report]", B), node=F("str", B),
                                 delta=F("float", B), now=F("float", B),
                                 free=F("float", B), by=F("str", B)),
    "access.scope_changed": leaf(
        "access_resources", "NodeRef", by=F("str", B),
        changed=F("[L[folders|tools|charter|org_visibility|permission_mode]]", B)),
    # ---- family lifecycle
    "lifecycle.kickoff": leaf("lifecycle", "NodeRef", body=_BODY, hired_by=F("str", B),
                              reason=F("L[hire|rehire|staff|autopsy]", B),
                              tier=F("str", B), grant=F("float", B)),
    "lifecycle.hired": leaf("lifecycle", "NodeRef", node=F("str", B), by=F("str", B),
                            relation=F("L[report|peer]", B), tier=F("str", B),
                            grant=F("float", B), parent=F("str?", B),
                            why=F("str?", B)),
    "lifecycle.retired": leaf("lifecycle", "NodeRef", node=F("str", B),
                              by=F("str", B),
                              relation=F("L[report|peer]", B), freed=F("float", B)),
    "lifecycle.rescinded": leaf("lifecycle", "NodeRef", node=F("str", B),
                                clawed=F("float", B)),
    "lifecycle.rehired": leaf("lifecycle", "NodeRef", node=F("str", B),
                              by=F("str", B), relation=F("L[self|report|peer]", B),
                              grant=F("float", B)),
    "lifecycle.dissolved": leaf("lifecycle", "NodeRef", node=F("str", B),
                                by=F("str", B), relation=F("L[report|peer]", B),
                                nodes=F("int", B), freed=F("float", B)),
    "lifecycle.deleted": leaf("lifecycle", "NodeRef", node=F("str", B),
                              relation=F("L[report|peer]", B), extra=F("int", B)),
    "lifecycle.compacted": leaf("lifecycle", "NodeRef", node=F("str", B),
                                relation=F("L[self|report]", B),
                                generation=F("int", B), predecessor=F("str", B),
                                auto=F("bool", B), lost=F("bool", B),
                                size_note=F("str?", B)),
    "lifecycle.cheap_compacted": leaf("lifecycle", "NodeRef", node=F("str", B),
                                      relation=F("L[self|report]", B),
                                      by=F("str", B),
                                      predecessor=F("str", B),
                                      team_note=F("str?", B),
                                      request_note=F("str?", B)),
    "lifecycle.reseeded": leaf("lifecycle", "NodeRef", node=F("str", B),
                               relation=F("L[self|report]", B), by=F("str", B),
                               predecessor=F("str", B)),
    "lifecycle.recovered": leaf("lifecycle", "NodeRef", predecessor=F("str", B),
                                successor=F("str", B)),
    "lifecycle.phantom_removed": leaf("lifecycle", "NodeRef", predecessor=F("str", B),
                                      holder=F("str", B)),
    "lifecycle.unrecoverable": leaf("lifecycle", "NodeRef", node=F("str", B),
                                    reason=F("str", B)),
    "lifecycle.bearer_lost": leaf("lifecycle", "NodeRef", bearer=F("str", B)),
    "lifecycle.bearer_exhausted": leaf("lifecycle", "NodeRef", bearer=F("str", B)),
    "lifecycle.handoff_record": leaf("lifecycle", "NodeRef", generation=F("int", B)),
    "lifecycle.model_switched": leaf("lifecycle", "NodeRef", node=F("str", B),
                                     relation=F("L[self|report]", B),
                                     old=F("str", B), new=F("str", B),
                                     seat_old=F("float", B), seat_new=F("float", B),
                                     by=F("str", B), queued=F("bool", B),
                                     crossed=F("bool", B),
                                     old_provider=F("str?", B),
                                     new_provider=F("str?", B),
                                     predecessor=F("str?", B)),
    # E (2026-09-16): minted by `finish_switch_binding` when the ACCOUNT move
    # riding a SAME-provider model switch archives the session (openai/codex
    # session-boundary lanes). The model_switched notice for a non-crossed
    # switch says the conversation carries over; this event is the correction
    # that says the account move ended the session anyway. A NEW leaf, not new
    # fields on model_switched: every leaf field is required on decode, so
    # widening model_switched would turn every stored historical row malformed.
    "lifecycle.session_rebound": leaf("lifecycle", "NodeRef",
                                      node=F("str", B),
                                      predecessor=F("str", B)),
    "lifecycle.switch_queued": leaf("lifecycle", "NodeRef", node=F("str", B),
                                    old=F("str", B), new=F("str", B),
                                    by=F("str", B)),
    "lifecycle.switch_cancelled": leaf("lifecycle", "NodeRef", node=F("str", B),
                                       target=F("str", B), by=F("str", B)),
    "lifecycle.switch_dropped": leaf("lifecycle", "NodeRef", node=F("str", B),
                                     target=F("str", B), kept=F("str", B),
                                     reason=F("str", B)),
    "lifecycle.seat_swapped": leaf(
        "lifecycle", "NodeRef", a=F("str", B), b=F("str", B),
        role=F("L[parent_of_a|parent_of_b|peer_of_a|peer_of_b|child_of_a|child_of_b|a|b]",
               B),
        nested=F("bool", B), by=F("str", B),
        reports_to_after=F("str?", B), grant_after=F("str?", B),
        audience_note=F("str?", B)),
    "lifecycle.subtree_promoted": leaf(
        "lifecycle", "NodeRef",
        promoted=F("str", B), demoted=F("str", B),
        role=F("L[new_parent|peer|former_parent|caller_child|target_child"
               "|promoted|demoted]", B),
        by=F("str", B), reports_to_after=F("str?", B),
        subtree=F("int", B)),
    "lifecycle.moved": leaf("lifecycle", "NodeRef", node=F("str", B),
                            from_parent=F("str?", B), to_parent=F("str?", B),
                            role=F("L[old_parent|old_peer|new_parent|new_peer|self]", B),
                            by=F("str", B), tail=F("str?", B)),
    "lifecycle.inserted": leaf("lifecycle", "NodeRef", node=F("str", B),
                               above=F("str", B), parent=F("str?", B),
                               role=F("L[parent|peer|target|child|self]", B),
                               by=F("str", B), grant_target=F("str?", B),
                               grant_new=F("str?", B), committed=F("str?", B)),
    "lifecycle.renamed": leaf("lifecycle", "NodeRef", old=F("str", B),
                              new=F("str", B), by=F("str", B)),
    "policy.fable_flagged": leaf("lifecycle", "NodeRef",
                                 audience=F("L[parent|peer|user]", B),
                                 node=F("str", B),
                                 outcome=F("L[switched|autopsy_unavailable|autopsy|halted]",
                                           B),
                                 autopsy=F("str?", B), autopsy_model=F("str?", B),
                                 replacement=F("str?", B), reason=F("str?", B),
                                 detail=F("str", B)),
    "policy.weekly_limit": leaf("lifecycle", "NodeRef",
                                relation=F("L[self|report|peer|user]", B),
                                node=F("str", B),
                                outcome=F("L[switched|dissolved|halted]", B),
                                nodes=F("int?", B), freed=F("str?", B),
                                policy=F("str?", B), detected_at=F("str?", B),
                                halted=F("str?", B), dissolved=F("str?", B),
                                converted=F("str?", B)),
    "policy.unstuck": leaf("lifecycle", "NodeRef"),
    "policy.unlocked": leaf("lifecycle", "NodeRef", node=F("str", B),
                            relation=F("L[self|report|peer]", B)),
    "policy.limit_reset": leaf("lifecycle", "NodeRef",
                               relation=F("L[self|report|peer|user]", B),
                               node=F("str", B), released=F("[str]", B)),
    # ---- family monitor
    "monitor.watchdog_fired": leaf("monitor", "WatchdogRef", prefix=F("str", B),
                                   lines=F("[str]{1}", B), count=F("int", B),
                                   once=F("bool", B)),
    "monitor.watchdog_quiet": leaf("monitor", "WatchdogRef", headline=F("str", B),
                                   facts=F("[str]{1}", B), advice=F("str", B)),
    # ---- family runtime_recovery
    "runtime.turn_failed_terminal": leaf("runtime_recovery", "SessionRef",
                                         door=F("str", B), err=F("str", B)),
    "runtime.turn_failed_repeated": leaf("runtime_recovery", "SessionRef",
                                         attempts=F("int", B),
                                         classified=F("str", B), err=F("str", B)),
    "runtime.report_stalled": leaf("runtime_recovery", "NodeRef", report=F("str", B),
                                   report_name=F("str", B),
                                   cause=F("L[terminal|repeated]", B),
                                   audience=F("L[superior|user]", B),
                                   attempts=F("int?", B), classified=F("str?", B),
                                   door=F("str?", B), err=F("str", B)),
    "runtime.report_parked": leaf("runtime_recovery", "NodeRef", report=F("str", B),
                                  report_name=F("str", B),
                                  audience=F("L[superior|user]", B),
                                  headline=F("str", B), detail=F("str", B),
                                  lane=F("str", B), err=F("str?", B)),
    "runtime.report_limited": leaf("runtime_recovery", "NodeRef", report=F("str", B),
                                   report_name=F("str", B),
                                   audience=F("L[superior|user]", B),
                                   lane=F("str", B), reset_at=F("str?", B),
                                   err=F("str?", B)),
    "runtime.subagent_died": leaf("runtime_recovery", "SessionRef",
                                  orphans=F("[N:Orphan]{1}", B), count=F("int", B),
                                  reason=F("str", B)),
    "runtime.background_task_stopped": leaf("runtime_recovery", "TaskRef",
                                            summary=F("str?", B),
                                            output_file=F("str?", B)),
    # `version` is the INSTALLED release the running build reports for itself,
    # and it is null wherever there is no authoritative one (a source checkout,
    # unreadable or malformed packaged metadata). It sits on the leaf beside
    # `branch` and `started_at` rather than on BuildRef, which three unminted
    # variants also share: this notice is the only place a version is stated.
    "runtime.restart_notice": leaf("runtime_recovery", "BuildRef", prev_pid=F("int?", B),
                                   started_at=F("str", B), branch=F("str?", B),
                                   version=F("str?", B)),
    "runtime.token_expiry": leaf("runtime_recovery", "OrgRef", days=F("float", B)),
    "runtime.delivery_unread": leaf("runtime_recovery", "MailRef", to=F("str", B),
                                    waited=F("str", B), boundary_for=F("str?", B)),
    "runtime.ui_crash_report": leaf("runtime_recovery", "OrgRef", summary=F("str", B),
                                    report=F("N:CrashReport", B)),
    "runtime.external_unroutable": leaf("runtime_recovery", "OrgRef", peer=F("str", B),
                                        excerpt=F("str", B)),
    # ---- family reminder
    "reminder.working_checkup": leaf("reminder", "NodeRef"),
    "reminder.idle_docket": leaf("reminder", "NodeRef",
                                 items=F("[N:DocketItem]{1}", B), more=F("int", B)),
    # ---- family context_change
    "docket.participant_added": leaf("context_change", "WorkItemRef",
                                     added_by=F("str", B), owner=F("str", B),
                                     objective=F("str", B),
                                     # W09 — see docket.assigned. This mail
                                     # carries the description too, so it
                                     # carries the warning about it too.
                                     objective_notice=F("str?", B)),
    "context.deep_reach": leaf("context_change", "NodeRef", node=F("str", B),
                               gist=F("str", B), kind=F("L[message|command]", B)),
    "context.notice_digest": leaf("context_change", None,
                                  groups=F("[N:DigestGroup]", B),
                                  untyped=F("int", B)),
    "context.org_state": leaf("context_change", "OrgRef", text=F("str", M),
                              snapshot=F("N:OrgStateSnapshot", M)),
    "context.provider_usage": leaf("context_change", "OrgRef", text=F("str", M),
                                   rows=F("[N:UsageRow]", M), seq=F("int", M)),
    "context.cache_continuity": leaf("context_change", "OrgRef", text=F("str", M)),
    "context.org_charter": leaf("context_change", "OrgRef", text=F("str", M),
                                readable=F("bool", M)),
    "context.command": leaf("context_change", "NodeRef", text=F("str", B)),
    # Minted at COMPOSITION for every `ping` carrier (supervisor._ping_drive): `text` is
    # the nudge exactly as the agent reads it; `reason` is the SENDING site's stated
    # reason (send_message ping_reason=…) and null when the site did not state one —
    # composition never guesses it from the text or the drained batch.
    "context.drive_mail_pointer": leaf(
        "context_change", "NodeRef", text=F("str", M),
        reason=F("L[" + "|".join(DRIVE_MAIL_POINTER_REASONS) + "]?", M)),
    # Minted by `supervisor._restart_replay` when a turn the shutdown killed is
    # re-sent on the next boot. `text` is the instruction the AGENT reads —
    # imperative, addressed to it, model_only as it always was.
    #
    # ⚠ `summary` is why this leaf is no longer human-hidden (user report
    # 2026-09-16). The replay hands the agent the whole enveloped turn again,
    # and the desk drew NOTHING for it: a reader watched an old mail envelope
    # reappear with no account of itself, which is the half of that report that
    # is worst for a person and cheapest to answer. One `both` field is all it
    # takes — `human_hidden_variants` is derived from dispositions, so the card
    # turns on by declaring a human field, never by naming the variant.
    "context.drive_restart_interrupted": leaf("context_change", "BuildRef",
                                              text=F("str", M),
                                              summary=F("str", B)),
    "context.drive_restart_wake": leaf("context_change", "BuildRef", text=F("str", M),
                                       reason=F("str?", M),
                                       armed_by_pid=F("int?", M),
                                       mode=F("L[one_shot|cut]", M)),
}

# Envelope keys every leaf carries, with their fixed dispositions (§4 manifest).
ENVELOPE: Final[dict[str, dict[str, Any]]] = {
    "v": F("int", B),
    "variant": F("str", B),
    "actor": F("N:Actor", B),
    "engine_authored": F("bool", H),
}
ACTOR: Final[dict[str, dict[str, Any]]] = {
    "kind": F("L[user|agent|system|external|watchdog]", B),
    "id": F("str", B),
}

# Structural keys (emitted as STRUCTURAL_KEYS and the manifest's `structural`).
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
