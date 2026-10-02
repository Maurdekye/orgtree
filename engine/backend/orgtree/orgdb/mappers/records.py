"""Record sections other than agents, the docket and settings (design Appendix A.4–A.6).

Each spec was drafted from the field inventory of the real rehearsal inputs and reviewed by hand
(scratch ``probe/gen_mappers.py``): a record's scalar fields are typed columns, an object of
scalars is flattened, a list of scalar records or of strings is a child table, and anything
deeper or of mixed shape is one JSON column (Q1). A record's own ``id`` field is the column
``public_id`` (the table's ``id`` is its surrogate key, §3.0).

Fields that name agents are kept as recorded, as text, in stage 1. The native modules that own
these tables (design §6.3 steps 4–5) add the agent-id columns of §3.0's current-holder class
(mailbox, recipient, asker, grantee, watchdog owner, reservation holder) beside them.
"""

from __future__ import annotations

from ..codec import Field as F, Spec
from ..sections import ByAgentLists, ByAgentMaps, Map, RecordList, Section

ATTACHMENTS = (F("name", "text"), F("path", "text"), F("bytes", "int"))

ASKS = Spec("asks", (
    F("id", "text", col="public_id"), F("node", "text"), F("kind", "text"),
    F("question", "text"), F("questions", "json"), F("at", "ts"),
    F("options", "list", spec=Spec("ask_options", (F("label", "text"), F("description", "text")))),
    F("header", "text"), F("work_items", "list", item="text", table="ask_work_items"),
    F("rev", "int"), F("status", "text"), F("reason", "text"), F("answer", "json"),
    F("resolved_at", "ts"), F("answer_mail", "text"),
))

CREDIT_REQUESTS = Spec("credit_requests", (
    F("id", "text", col="public_id"), F("node", "text"), F("old", "num"), F("new", "num"),
    F("reason", "text"), F("at", "ts"), F("rev", "int"), F("status", "text"),
    F("granted", "num"), F("notice", "text"),
))

SCOPE_REQUESTS = Spec("scope_requests", (
    F("id", "text", col="public_id"), F("node", "text"),
    F("items", "list", spec=Spec("scope_request_items", (
        F("kind", "text"), F("path", "text"), F("mode", "text"), F("decision", "text"),
        F("tool", "text"), F("server", "text")))),
    F("reason", "text"), F("at", "ts"), F("rev", "int"), F("status", "text"),
    F("resolved_at", "ts"),
))

AUDIENCE_GRANTS = Spec("audience_grants", (
    F("grantee", "text"), F("grantor", "text"), F("granted_at", "ts"), F("reason", "text"),
    F("delegated_by", "text"),
))

AUDIENCE_REQUESTS = Spec("audience_requests", (
    F("id", "text", col="public_id"), F("node", "text"), F("target", "text"),
    F("reason", "text"), F("at", "ts"), F("status", "text"),
))

WATCHDOGS = Spec("watchdogs", (
    F("id", "text", col="public_id"), F("owner", "text"), F("name", "text"), F("kind", "text"),
    F("target", "text"), F("pattern", "text"), F("interval_s", "int"), F("state", "text"),
    F("at", "ts"), F("fired", "int"),
    F("events", "list", spec=Spec("watchdog_events", (F("at", "ts"), F("gist", "text")))),
    F("high_water", "json"), F("last_check", "ts"), F("_last_check_ts", "float", col="last_check_ts"),
    F("checks_run", "int"), F("last_output", "text"), F("paused_why", "text"),
    F("last_exit", "int"), F("last_fired", "ts"), F("history_retained", "bool"),
    F("notice", "bool"), F("once", "bool"), F("shell", "text"),
    # silence alarms (watchdog_config): written only in silence mode, never as nulls
    F("fire_mode", "text"), F("quiet_period_s", "int"), F("silence_since", "ts"),
))

WATCHDOG_TOMBS = Spec("watchdog_tombs", (
    F("id", "text", col="public_id"), F("owner", "text"), F("name", "text"), F("kind", "text"),
    F("target", "text"), F("interval_s", "int"), F("at", "ts"), F("spent_at", "ts"),
    F("fired", "int"), F("orphaned_from", "text"), F("notice", "bool"),
    # a superseded one-shot dog's tomb (Org.watchdog_control "supersede")
    F("state", "text"), F("superseded_by", "text"), F("reason", "text"), F("once", "bool"),
    # watchdog_config.projection: fire_mode always ("event" for an event dog), the other two
    # only when the dog had them
    F("fire_mode", "text"), F("quiet_period_s", "int"), F("silence_since", "ts"),
))

WATCHDOG_HISTORY = Spec("watchdog_history", (
    F("at", "ts"), F("gist", "text"), F("watchdog", "text"), F("node", "text"), F("body", "text"),
))

RESERVATIONS = Spec("reservations", (
    F("id", "text", col="public_id"), F("owner", "text"), F("item", "text"),
    F("resource", "text"), F("candidate", "text"), F("base", "text"),
    F("paths", "list", item="text", table="reservation_paths"),
    F("state", "text"), F("created_at", "ts"), F("updated_at", "ts"),
    F("created_ts", "float"), F("updated_ts", "float"), F("expires_ts", "float"),
    F("expires_at", "ts"), F("heartbeat_ts", "float"), F("heartbeat_at", "ts"),
    F("stale_s", "float"), F("integration_key", "text", nullable=True),
    F("integration_receipt", "text"), F("landed_at", "ts"), F("release_receipt", "text"),
    F("successor", "json", nullable=True),
))

DOCUMENTS = Spec("documents", (
    F("id", "text", col="public_id"), F("node", "text"), F("title", "text"), F("body", "text"),
    F("at", "ts"), F("format", "text"), F("file", "text"), F("bytes", "int"),
    F("orphaned_from", "text"),
))

EVENTS = Spec("events", (
    F("op", "text"), F("actor", "text"), F("at", "ts"), F("detail", "json"),
    F("warnings", "list", item="text", table="event_warnings"),
))

LIFECYCLE = Spec("lifecycle_events", (
    F("operation_id", "text"), F("kind", "text"), F("state", "text"), F("at", "ts"),
    F("count", "int"), F("message_id", "text"), F("recipient", "text"), F("sender", "text"),
    F("delivery", "text"), F("waited", "text"), F("boundary_for", "text", nullable=True),
    F("observed", "bool"), F("task_id", "text"), F("owner", "text"), F("settlement", "text"),
    F("summary", "text"), F("item", "text"), F("issued_revision", "int"),
    F("current_revision", "int"), F("issued_candidate", "text", nullable=True),
    F("current_candidate", "json", nullable=True), F("node", "text"), F("cleanup", "text"), F("door", "text"),
    F("reason", "text"), F("status", "text"),
))

NOTICE_LOG = Spec("notice_log", (
    F("node", "text"), F("at", "ts"), F("text", "text"), F("ev", "json"),
))

ORG_INBOX = Spec("org_inbox", (
    F("id", "text", col="public_id"), F("dir", "text"), F("peer", "text"), F("body", "text"),
    F("at", "ts"), F("by", "text"), F("state", "text"), F("state_at", "ts"), F("net_id", "text"),
    F("attributed", "bool"),
))

USER_INBOX = Spec("user_inbox", (
    F("id", "text", col="public_id"), F("from", "text"), F("kind", "text"), F("body", "text"),
    F("at", "ts"), F("message_id", "text"), F("operation_id", "text"),
    F("attachments", "list", spec=Spec("user_inbox_attachments", ATTACHMENTS)),
    F("ev", "json"),
))

USER_OUTBOX = Spec("user_outbox", (
    F("id", "text", col="public_id"), F("from", "text"), F("kind", "text"), F("body", "text"),
    F("at", "ts"), F("relationship", "text"), F("message_id", "text"),
    F("operation_id", "text"), F("client_op", "text"), F("ev", "json"), F("to", "text"),
    F("recv_seq", "int"), F("seq_origin", "text"), F("mailbox", "text"),
    F("attachments", "list", spec=Spec("user_outbox_attachments", ATTACHMENTS)),
    F("reply_to", "json"),
    F("attachments_missing", "list", item="text", table="user_outbox_attachments_missing"),
))

USER_MAIL_LOG = Spec("user_mail_log", (
    F("id", "text", col="public_id"), F("from", "text"), F("kind", "text"), F("body", "text"),
    F("at", "ts"), F("message_id", "text"), F("operation_id", "text"),
    F("attachments", "list", spec=Spec("user_mail_log_attachments", ATTACHMENTS)),
    F("ev", "json"), F("urgent", "bool"), F("urgent_reason", "text"),
))

OP_RECEIPTS = Spec("op_receipts", (
    F("v", "int"), F("id", "text", col="public_id"), F("at", "ts"), F("mint_ms", "int"),
    F("node", "text"), F("gen", "int"), F("tool", "text"), F("key", "text"), F("fp", "text"),
    F("targets", "json"), F("cls", "text"), F("outcome", "text"), F("result", "json"),
    F("ev_from", "json", nullable=True), F("ev_to", "json", nullable=True),
    F("post_effects", "json"),
    F("fp_node", "text"), F("orphaned_from", "text"),
))

ORG_DIRS = Spec("org_dirs", (F("path", "text"), F("mode", "text")))

NET_HUBS = Spec("net_hubs", (
    F("id", "text", col="public_id"), F("address", "text"), F("enabled", "bool"),
    F("name", "text"),
))

MAIL = Spec("mail", (
    F("id", "text", col="public_id"), F("from", "text"), F("kind", "text"), F("body", "text"),
    F("at", "ts"), F("relationship", "text"), F("restart_notice", "bool"), F("ev", "json"),
    F("recv_seq", "int"), F("seq_origin", "text"), F("mailbox", "text"),
    F("message_id", "text"), F("operation_id", "text"), F("redelivered", "int"),
))

NOTICES = Spec("notices", (F("at", "ts"), F("text", "text"), F("ev", "json")))

DELIVERY_BATCHES = Spec("delivery_batches", (
    F("tok", "text"), F("at", "ts"), F("mail", "json"), F("notices", "json"), F("via", "text"),
    F("custody", "obj", spec=Spec("", (F("mailbox", "text"), F("generation", "int"),
                                       F("session", "text")))),
    F("engines", "json"), F("mode", "text"), F("attempt", "json"),
    F("drive", "json", nullable=True), F("segments", "json"), F("manual", "json"),
    F("claim", "obj", spec=Spec("", (F("delivery_id", "text"), F("tool_use_id", "text"),
                                     F("claimed_at", "float"), F("lease_until", "float")))),
    F("attempts", "int"),
    F("delivery_ids", "list", item="text", table="delivery_batch_ids"),
))

MAIL_LOG = Spec("mail_log", (
    F("id", "text", col="public_id"), F("from", "text"), F("kind", "text"), F("body", "text"),
    F("at", "ts"), F("relationship", "text"), F("message_id", "text"),
    F("operation_id", "text"), F("client_op", "text"), F("ev", "json"),
    F("restart_notice", "bool"), F("recv_seq", "int"), F("seq_origin", "text"),
    F("mailbox", "text"),
    F("attachments", "list", spec=Spec("mail_log_attachments", ATTACHMENTS)),
    F("stale", "bool"), F("stale_at", "ts"), F("stale_revision", "int"),
    F("stale_candidate", "text", nullable=True), F("net_id", "text"), F("reply_to", "json"),
    F("model_only", "bool"), F("retracted", "bool"),
    F("attachments_missing", "list", item="text", table="mail_log_attachments_missing"),
))

STEER_RECORDS = Spec("steer_records", (
    F("at", "ts"), F("delivery_id", "text"), F("level", "text"),
    F("mail_ids", "list", item="text", table="steer_record_mail_ids"),
    F("delivery_ids", "list", item="text", table="steer_record_delivery_ids"),
    F("acked_ids", "list", item="text", table="steer_record_acked_ids"),
    F("recorded_ids", "list", item="text", table="steer_record_recorded_ids"),
    F("attempts", "int"), F("retried", "bool"), F("confirmed_duplicate", "bool"),
    F("text", "text"), F("visible_id", "text"), F("segments", "json"), F("fold", "int"),
    F("where", "text"), F("outcome", "text"),
))

AGENT_TURNS = Spec("agent_turns", (
    F("n", "int"), F("at", "ts"), F("cost", "float"), F("ms", "int", nullable=True),
    F("toks", "int"), F("denials", "int"), F("approvals", "int"), F("ran_as", "text"),
    F("killed", "bool"), F("estimated", "bool"), F("cost_complete", "bool"),
    F("cost_source", "text"), F("cost_unknown_fields", "json"), F("route", "json"),
    F("reported", "json"), F("model_usage_key", "json"),
))

AGENT_TURN_ERRORS = Spec("agent_turn_errors", (F("at", "ts"), F("text", "text"),
                                               F("ran_as", "text")))

WORK_SCOPE_LOG = Spec("work_scope_log", (
    F("seq", "int"), F("at", "ts"),
    F("by", "obj", spec=Spec("", (F("node", "text"), F("generation", "int")))),
    F("kind", "text"), F("text", "text"), F("supersedes", "int", nullable=True),
    F("superseded_by", "int", nullable=True), F("before", "text"), F("after", "text"),
    F("mode", "text"),
))

MAIL_TRANSITIONS = Spec("mail_transitions", (
    F("operation", "text"), F("outcome", "text"), F("node", "text"), F("identity", "json"),
    F("before", "json"), F("deliveries", "json"),
))

MANUAL_ATTEMPTS = Spec("manual_attempts", (
    F("v", "int"), F("at", "ts"), F("tok", "text"), F("mailbox", "text"),
    F("generation", "int"), F("session", "text"), F("attempt", "text"), F("engine", "text"),
    F("delivery_id", "text"), F("seat", "text"), F("op_key", "text"), F("op_id", "text"),
    F("mail_ids", "list", item="text", table="manual_attempt_mail_ids"),
    F("digests", "json"), F("provider_call_id", "json", nullable=True),
    F("call_id_source", "text"), F("resolved", "json", nullable=True), F("chunk_calls", "json"),
))

STEER_ATTEMPTS = Spec("steer_attempts", (
    F("at", "ts"), F("tool_use_id", "text"),
    F("toks", "list", item="text", table="steer_attempt_toks"),
    F("mail_ids", "list", item="text", table="steer_attempt_mail_ids"),
    F("transcript_path", "text"), F("tp_offset", "int"), F("texts_n", "int"),
    F("retried", "bool"), F("acked_at", "ts"), F("recorded_at", "ts"), F("resolved", "text"),
    F("views", "list", item="text", table="steer_attempt_views"),
    F("view_segments", "json"),
))

ORG_DOC_MIGRATIONS = Spec("org_doc_migrations", (
    F("at", "ts"), F("repaired", "int"), F("stripped", "int"), F("mode", "text"),
    F("holders", "list", item="text", table="org_doc_migration_holders"),
    F("multi_holder", "bool"),
    F("healed", "list", item="text", table="org_doc_migration_healed"),
    F("minted", "int"), F("shared", "int"),
))

NET_STATE = Spec("net_state", (
    F("registered_at", "ts"), F("address", "text"),
    F("seen_ids", "list", item="text", table="net_state_seen_ids"),
))

# {quarantine key: where it came from} (ledger._quarantine_freed_key)
ORPHAN_KEYS = Spec("orphan_keys", (
    F("from", "text"), F("at", "ts"), F("cause", "text"), F("arriving_seat", "json"),
    F("owner", "json", nullable=True),
    F("sections", "list", item="text", table="orphan_key_sections"),
))


def sections() -> list[Section]:
    """In dependency order: every by-agent table refers to agents, which come first."""
    return [
        RecordList("asks", ASKS),
        RecordList("credit_requests", CREDIT_REQUESTS),
        RecordList("scope_requests", SCOPE_REQUESTS),
        RecordList("audiences", AUDIENCE_GRANTS),
        RecordList("audience_requests", AUDIENCE_REQUESTS),
        RecordList("watchdogs", WATCHDOGS),
        RecordList("watchdog_tombs", WATCHDOG_TOMBS),
        RecordList("watchdog_history", WATCHDOG_HISTORY),
        RecordList("reservations", RESERVATIONS),
        RecordList("documents", DOCUMENTS),
        RecordList("events", EVENTS),
        RecordList("lifecycle", LIFECYCLE),
        RecordList("notice_log", NOTICE_LOG),
        RecordList("org_inbox", ORG_INBOX),
        RecordList("user_inbox", USER_INBOX),
        RecordList("user_outbox", USER_OUTBOX),
        RecordList("user_mail_log", USER_MAIL_LOG),
        RecordList("op_receipts", OP_RECEIPTS),
        RecordList("dirs", ORG_DIRS),
        RecordList("net_hubs", NET_HUBS),
        Map("orphan_keys", "orphan_keys", spec=ORPHAN_KEYS),
        ByAgentLists("mail", MAIL),
        ByAgentLists("notices", NOTICES),
        ByAgentLists("delivering", DELIVERY_BATCHES),
        ByAgentLists("mail_log", MAIL_LOG),
        ByAgentLists("steered_log", STEER_RECORDS),
        ByAgentLists("turn_log", AGENT_TURNS),
        ByAgentLists("turn_error_log", AGENT_TURN_ERRORS),
        ByAgentLists("work_scope_log", WORK_SCOPE_LOG),
        ByAgentMaps("mail_transitions", MAIL_TRANSITIONS),
        ByAgentMaps("manual_attempts", MANUAL_ATTEMPTS),
        ByAgentMaps("steer_attempts", STEER_ATTEMPTS),
        Map("_migrations", "org_doc_migrations", spec=ORG_DOC_MIGRATIONS),
        Map("net_state", "net_state", spec=NET_STATE),
        Map("tiers", "org_tier_prices", item="num"),
        Map("models", "org_tier_models", item="text"),
    ]
