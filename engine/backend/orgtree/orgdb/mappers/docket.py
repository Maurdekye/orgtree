"""The docket: ``work_items`` and ``work_items_archive`` in one table (design Appendix A.3).

Active and archived items live together in ``work_items``; ``list_key`` says which legacy list
an item came from and ``ord`` its position there, so both lists read back exactly. Slugs are
unique across both (today's work_index trigger enforces the same).

The item's lists are child tables, as decision 7 asks for work events: participants, the two
progress lists, dependencies, dismissals, acceptance (with each condition's check history),
evidence, history, holders, scope, artifacts, findings (with their decisions) and review-seat
requests. Payloads with no fixed shape (an evidence receipt, a history entry's changes, review
packets and verdicts, delivery claims) are JSON (Q1).

Recorded roles remain exact, including values that do not fit text columns.
Migration 0007 adds indexed keys computed from the original record; every
encoder uses ``row_keys`` below. The agent-id assignment predicate (``owner_agent_id``
...), the counters and the access functions come with the native docket module (design §6.3
step 3).
"""

from __future__ import annotations

from typing import Any, Mapping

from .. import codec
from .. import enum_values as V
from ..codec import Field as F, Rows, ShapeError, Spec
from ..sections import Context, Section, table

BY = F("by", "obj", spec=Spec("", (F("node", "text"), F("generation", "int"))))


def holder(key: str, *, born: bool = True) -> F:
    fields = (F("node", "text"), F("generation", "int")) + ((F("born", "text"),) if born else ())
    return F(key, "obj", spec=Spec("", fields))


CHECK = (
    F("at", "ts"), BY, F("evidence_ref", "text"), F("note", "text", nullable=True),
    F("classification", "text", values=V.CLASSIFICATION), F("artifact", "text"), F("runner", "text"),
    F("execution", "text", values=V.EXECUTION), F("execution_means", "text"), F("result", "text", values=V.RESULT),
    F("classification_means", "text"), F("composition", "text"), F("gate", "text"),
    F("blocked_count", "int"),
)

WORK_ITEM = Spec("work_items", (
    F("slug", "text"), F("rev", "int"), F("kind", "text", values=('code', 'non-code')), F("title", "text"),
    F("objective", "text"), F("status", "text", values=V.WORK_STATUS),
    F("blocked_reason", "text", nullable=True), F("waiting_reason", "text", nullable=True),
    F("dropped_reason", "text", nullable=True),
    holder("owner"), holder("reviewer"), holder("created_by", born=False),
    holder("last_updater", born=False),
    F("participants", "list", item="text", table="work_item_participants"),
    F("at", "ts"), F("updated_at", "ts"), F("docket_at", "ts"), F("status_at", "ts"),
    F("archived_at", "ts", nullable=True),
    F("done_so_far", "list", item="text", table="work_item_done"),
    F("working_on_next", "list", item="text", table="work_item_next"),
    F("manual_attention", "json", nullable=True), F("manual_attention_rev", "int"),
    F("dismissals", "list", spec=Spec("work_item_dismissals", (
        F("at", "ts"), F("by", "text"), F("set_rev", "int"), F("reason", "text")))),
    F("acceptance", "list", spec=Spec("work_item_acceptance", (
        F("text", "text"),
        F("checked", "obj", spec=Spec("", CHECK)),
        F("check_history", "list", spec=Spec("work_item_acceptance_checks", CHECK)),
    ))),
    F("dependencies", "list", item="text", table="work_item_dependencies"),
    F("evidence", "list", spec=Spec("work_item_evidence", (
        F("at", "ts"), BY, F("kind", "text", values=('note', 'link', 'file', 'commit', 'log')), F("ref", "text"), F("note", "text"),
        F("execution", "text", values=V.EXECUTION), F("execution_means", "text"), F("receipt", "json"),
        F("classification", "text", values=V.CLASSIFICATION), F("artifact", "text"), F("runner", "text"),
        F("result", "text", values=V.RESULT), F("classification_means", "text"),
    ))),
    F("delivery", "json", nullable=True), F("accepted", "json", nullable=True),
    F("candidate_verdict", "json", nullable=True), F("candidate_verdicts", "json"),
    F("review_packet", "json", nullable=True), F("review_packets", "json"),
    F("review_seats", "json"),
    F("review_seat_requests", "list", spec=Spec("work_item_review_seat_requests", (
        F("seq", "int"), F("reviewer", "text"), F("requested_by", "text"), F("owner", "text"),
        F("to", "text"), F("at", "ts"), F("state", "text", values=('pending', 'granted', 'withdrawn', 'declined')), F("note", "text"),
        F("decided_by", "text", nullable=True), F("decided_at", "ts", nullable=True),
        F("decision_note", "text", nullable=True),
    ))),
    # one row per history entry; an entry's fields depend on its op (58 keys on the real
    # inputs), so each has its own column, typed where every input agrees
    F("history", "list", spec=Spec("work_item_history", (
        F("at", "ts"), F("by", "json"), F("op", "text"), F("kind", "text"),
        F("from", "json", nullable=True), F("to", "json", nullable=True),
        F("done", "json"), F("next", "json"), F("changes", "json"), F("now", "json"),
        F("why", "text"), F("note", "text", nullable=True), F("reason", "text"),
        F("status", "text", values=V.WORK_STATUS), F("status_from", "text", values=V.WORK_STATUS), F("status_to", "text", values=V.WORK_STATUS),
        F("stage", "text", values=V.STAGE), F("reviewer", "text"), F("candidate", "text"),
        F("decision", "text", values=('approve', 'changes', 'approve_stage')), F("disposition", "text", values=V.DISPOSITION), F("finding", "text"),
        F("artifact", "text"), F("name", "text"), F("scope", "text", values=('item', 'named')), F("via", "text"),
        F("evidence_gap", "text"), F("answer", "text"),
        F("scope_seq", "int"), F("batch", "int"), F("index", "int"), F("set_rev", "int"),
        F("supersedes", "int"), F("count", "int"),
        F("answered_request", "int", nullable=True),
        F("already_seated", "bool"), F("after_completion", "bool"),
        F("atomic_completion", "bool"), F("review_in_flight", "bool"),
        F("verified", "bool", nullable=True),
        F("accepted_at", "ts"), F("first_at", "ts"), F("last_at", "ts"), F("raised_at", "ts"),
        F("kinds", "json"), F("indexes", "json"), F("touched", "json"), F("requests", "json"),
        F("done_was", "json"), F("next_was", "json"), F("next_actor", "json"),
        F("raised_by", "json"),
        F("review_packet_was", "json", nullable=True), F("accepted_was", "json", nullable=True),
        F("superseded_by_was", "json", nullable=True),
        F("dropped_reason_was", "json", nullable=True),
        F("candidate_verdict_was", "json", nullable=True),
    ))),
    F("superseded_by", "text", nullable=True), F("parent", "text", nullable=True),
    F("holders", "list", spec=Spec("work_item_holders", (
        F("node", "text"), F("generation", "int"), F("born", "text"), F("from", "ts"),
        F("by", "json"), F("derived", "bool"),
    ))),
    F("notification_attention_epoch", "int"), F("notification_attention_active", "bool"),
    F("scope", "list", spec=Spec("work_item_scope", (
        F("seq", "int"), F("at", "ts"), BY, F("kind", "text", values=V.WORK_SCOPE_KIND), F("before", "text"),
        F("after", "text"), F("mode", "text", values=V.WORK_SCOPE_MODE), F("supersedes", "int", nullable=True),
        F("superseded_by", "int", nullable=True), F("text", "text"),
    ))),
    F("scope_seq", "int"), F("scope_guard", "int"), F("scope_logged", "int"),
    F("artifacts", "list", spec=Spec("work_item_artifacts", (
        F("id", "text", col="public_id"), F("seq", "int"), F("at", "ts"), BY,
        F("name", "text"), F("bytes", "int"), F("sha256", "text"), F("path", "text"),
        F("scope", "text", values=('item', 'named')), F("grants", "json"), F("note", "text"),
    ))),
    F("artifact_seq", "int"),
    F("findings", "list", spec=Spec("work_item_findings", (
        F("id", "text", col="public_id"), F("seq", "int"), F("at", "ts"), BY,
        F("title", "text"), F("disposition", "text", values=V.DISPOSITION),
        F("decisions", "list", spec=Spec("work_item_finding_decisions", (
            F("at", "ts"), BY, F("disposition", "text", values=V.DISPOSITION), F("note", "text")))),
        F("detail", "text"), F("severity", "text"), F("evidence_ref", "text"),
    ))),
    F("finding_seq", "int"),
    F("quick_staff_receipts", "json"), F("post_completion", "json"),
))

LISTS = {"work_items": "active", "work_items_archive": "archive"}

def row_keys(record: Mapping[str, Any], *, id: int, list_key: str, ord: int) -> dict[str, Any]:
    """Placement plus the native read header; the exact codec ignores the header.

    The converter and the compat per-item writer must both call this helper.
    """
    from ..docket import write_fields
    return dict(id=id,list_key=list_key,ord=ord,**write_fields(record))


WORK_ITEMS = table(
    WORK_ITEM, child_key="item_id",
    placement=(("list_key", "text",
                "list_key text NOT NULL CHECK (list_key IN ('active', 'archive'))"),
               ("ord", "bigint", "ord bigint NOT NULL")),
    derived=("anchor_name text GENERATED ALWAYS AS (coalesce(owner_node, created_by_node)) STORED",),
    indexes=(
        "CREATE UNIQUE INDEX work_items_list_ord ON orgtree.work_items (list_key, ord)",
        # one row per slug, active or archived, checked at COMMIT: a reopen in one save
        # writes the item's active row before it deletes the archived one (store.py's
        # order), so the two exist together inside that transaction only
        "ALTER TABLE orgtree.work_items ADD CONSTRAINT work_items_slug UNIQUE (slug) "
        "DEFERRABLE INITIALLY DEFERRED",
        "CREATE INDEX work_items_active_order ON orgtree.work_items "
        "(coalesce(docket_at, updated_at) DESC, slug DESC) WHERE archived_at IS NULL",
        "CREATE INDEX work_items_owner ON orgtree.work_items (owner_node)",
        "CREATE INDEX work_items_creator ON orgtree.work_items (created_by_node)",
        "CREATE INDEX work_items_reviewer ON orgtree.work_items (reviewer_node)",
        "CREATE INDEX work_items_anchor ON orgtree.work_items (anchor_name, archived_at)",
        "CREATE INDEX work_item_participants_name ON orgtree.work_item_participants (value, item_id)",
    ),
)


class Docket(Section):
    keys = tuple(LISTS)
    tables = (WORK_ITEMS,)

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        n = 0
        for key, list_key in LISTS.items():
            v = doc.get(key)
            if v is None:
                continue
            if not isinstance(v, list):
                raise ShapeError(f"{key}: expected a list of objects")
            for i, rec in enumerate(v):
                if not isinstance(rec, dict):
                    raise ShapeError(f"{key}[{i}]: expected an object")
                n += 1
                codec.encode(WORK_ITEM, rec, row_keys(rec,id=n,list_key=list_key,ord=i), out,
                             link=WORK_ITEMS.link)

    def decode(self, rows, ctx, present, doc) -> None:
        ch = self._children(rows, WORK_ITEMS)
        by_list: dict[str, list[Mapping[str, Any]]] = {}
        for r in rows.get("work_items", []):
            by_list.setdefault(r["list_key"], []).append(r)
        for key, list_key in LISTS.items():
            if key in present:
                recs = sorted(by_list.get(list_key, []), key=lambda r: r["ord"])
                doc[key] = [codec.decode(WORK_ITEM, r, ch, (r["id"],)) for r in recs]
