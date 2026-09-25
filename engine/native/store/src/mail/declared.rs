//! WS5's DECLARED-CONTACTS table (CONTRACT-M1 §5 r4; WS7 `oracle.py`
//! shape): per operation kind, every relation it may touch, the modes, and
//! whether every committed attempt must touch it. Q-C5 fails an undeclared
//! observed relation and a committed attempt missing a `required` one.
//!
//! Unsafe-control paths are NOT declared: a control run that touches an
//! undeclared relation is supposed to look wrong.

use serde_json::{json, Map, Value};

use crate::mail::{inbox, mailbox, receive};
use crate::runtime::admit;
use crate::{mail::human, sent};

fn rel(modes: &[&str], required: bool) -> Value {
    json!({"modes": modes, "required": required})
}

const R: &[&str] = &["read"];
const RW: &[&str] = &["read", "write"];
const W: &[&str] = &["write"];

fn receipts() -> (&'static str, Value) {
    ("operation_receipts", rel(RW, true))
}

fn entry(rels: Vec<(&'static str, Value)>, p01: Option<&str>, source: &str) -> Value {
    let mut m = Map::new();
    for (k, v) in rels {
        m.insert(k.to_string(), v);
    }
    json!({"relations": Value::Object(m), "p01_contract": p01, "source": source})
}

/// `"<family>.<verb>" → spec` for every WS5 operation and read.
pub fn declared() -> Value {
    let agent_send = |p01: &str| {
        entry(
            vec![
                receipts(),
                ("authority_epoch", rel(&["read", "for_share", "for_no_key_update", "write"], true)),
                ("org_controls", rel(&["read", "for_share"], true)),
                ("topology_edges", rel(&["read", "for_share"], true)),
                ("audience_grants", rel(&["read", "for_share", "write"], false)),
                ("mailboxes", rel(R, true)),
                ("agents", rel(R, false)),
                ("mail_sent", rel(RW, true)),
                ("outgoing_intents", rel(W, true)),
            ],
            Some(p01),
            "engine/native/store/src/mail/doors.rs AgentSend + sent.rs address_agent/address_user/record_sent (S3 E1.1)",
        )
    };
    let mut m = Map::new();
    m.insert("mail.source.message".into(), agent_send("mail.message"));
    m.insert("mail.source.notice".into(), agent_send("mail.notice"));
    m.insert(
        "mail.source.extern_send".into(),
        entry(
            vec![
                receipts(),
                ("authority_epoch", rel(&["read", "for_share", "for_no_key_update", "write"], true)),
                ("org_controls", rel(&["read", "for_share", "for_update", "write"], true)),
                ("extern_handles", rel(&["read", "for_share"], true)),
                ("audience_grants", rel(&["read", "write"], false)),
                ("topology_edges", rel(&["read", "for_share"], false)),
                ("restrictions", rel(W, false)),
                ("restriction_obligations", rel(W, false)),
                ("read_service_registrations", rel(R, false)),
                ("mailboxes", rel(R, false)),
                ("agents", rel(R, false)),
                ("mail_sent", rel(RW, true)),
                ("transport_intents", rel(W, true)),
                ("outgoing_intents", rel(W, false)),
            ],
            Some("exchange.extern-send"),
            "mail/doors.rs AgentSend (External) + sent.rs extern_effect (S3 E1.1 step 5; v6 EXTERN rows)",
        ),
    );
    m.insert(
        "mail.human.send".into(),
        entry(
            vec![
                receipts(),
                ("authority_epoch", rel(&["read", "for_no_key_update", "write"], true)),
                ("topology_edges", rel(&["read", "for_share"], true)),
                ("audience_grants", rel(W, false)),
                ("mailboxes", rel(R, true)),
                ("agents", rel(R, true)),
                ("mail_sent", rel(RW, true)),
                ("outgoing_intents", rel(W, true)),
            ],
            Some("mail.human-send"),
            "mail/human.rs HumanSend (S3 §4.6 mail branch, E-D4)",
        ),
    );
    m.insert(
        "mail.human.command".into(),
        entry(
            vec![
                receipts(),
                ("authority_epoch", rel(&["read", "for_no_key_update", "write"], true)),
                ("seat_session_facts", rel(R, false)),
                ("runtime_state", rel(R, false)),
                ("org_controls", rel(&["read", "for_share"], false)),
                ("topology_edges", rel(&["read", "for_share"], false)),
                ("audience_grants", rel(W, false)),
                ("mailboxes", rel(R, false)),
                ("agents", rel(R, false)),
                ("mail_sent", rel(W, false)),
                ("outgoing_intents", rel(W, false)),
                ("runtime_command_intents", rel(W, false)),
            ],
            Some("mail.human-send"),
            "mail/human.rs HumanCommand (S3 §4.6 session-command branch, E-D5)",
        ),
    );
    m.insert(
        "mail.inbox.read".into(),
        entry(vec![receipts(), ("mailboxes", rel(R, true)), ("mailbox_messages", rel(RW, false))], Some("mail.user-inbox-read"), "mail/human.rs MarkRead (S3 §4.7, E-D6)"),
    );
    let inbox_read = |p01: &str, src: &str| entry(vec![("mailboxes", rel(R, true)), ("mailbox_messages", rel(R, false)), ("mail_sent", rel(R, false))], Some(p01), src);
    m.insert("mail.inbox.user_inbox".into(), inbox_read("mail.user-inbox", "mail/inbox.rs UserInbox (one RR RO snapshot)"));
    for v in ["node_inbox", "node_inbox_pending", "node_inbox_in_flight", "node_inbox_delivered"] {
        m.insert(format!("mail.inbox.{v}"), inbox_read("mail.node-inbox", "mail/inbox.rs NodeInbox (one RR RO snapshot; parts only under Q-IB3's control)"));
    }
    m.insert(
        "mail.receive.deliver_agent".into(),
        entry(
            vec![
                receipts(),
                ("mail_sent", rel(R, true)),
                ("mailboxes", rel(&["read", "for_update", "write"], true)),
                ("mailbox_messages", rel(RW, true)),
                ("mail_pair_highwater", rel(&["read", "for_no_key_update", "write"], false)),
                ("authority_epoch", rel(&["read", "for_share"], false)),
                ("outgoing_intents", rel(W, false)),
            ],
            None,
            "mail/receive.rs Receive, agent mailbox (S3 E1.3: head FOR UPDATE first, P8)",
        ),
    );
    m.insert(
        "mail.receive.deliver_human".into(),
        entry(
            vec![
                receipts(),
                ("mail_sent", rel(R, true)),
                ("mailboxes", rel(R, true)),
                ("mailbox_messages", rel(RW, true)),
                ("mail_pair_highwater", rel(&["read", "for_no_key_update", "write"], false)),
            ],
            None,
            "mail/receive.rs Receive, human mailbox (S3 E1.4: no head row is locked or written)",
        ),
    );
    m.insert("mail.receive.route".into(), entry(vec![("mailboxes", rel(R, true))], None, "mail/receive.rs Route (read: which mailbox kind a delivery targets)"));
    m.insert(
        "mail.receive.retract".into(),
        entry(
            vec![
                receipts(),
                ("mailboxes", rel(&["read", "for_update", "write"], true)),
                ("mailbox_messages", rel(RW, true)),
                ("mail_sent", rel(R, false)),
                ("mail_pair_highwater", rel(&["read", "for_no_key_update", "write"], false)),
            ],
            None,
            "mail/receive.rs Retract (S3 E1.5)",
        ),
    );
    for (verb, extra) in [("grant", false), ("revoke", true)] {
        let mut rels = vec![
            receipts(),
            ("authority_epoch", rel(&["read", "for_share", "for_no_key_update", "write"], true)),
            ("org_controls", rel(&["read", "for_share"], true)),
            ("topology_edges", rel(&["read", "for_share"], true)),
            ("mailboxes", rel(R, true)),
            ("audience_grants", rel(if extra { RW } else { &["read", "write"] }, true)),
        ];
        if extra {
            rels.push(("restrictions", rel(W, false)));
            rels.push(("restriction_obligations", rel(W, false)));
        }
        m.insert(format!("audiences.{verb}"), entry(rels, Some(if extra { "audiences.revoke" } else { "audiences.grant" }), "mail/audience.rs Audience (schedule-grade; r7 C2a P1)"));
    }
    m.insert(
        "mail.transport.claim".into(),
        entry(vec![receipts(), ("transport_intents", rel(&["read", "for_update", "write"], true)), ("mail_sent", rel(R, true))], Some("exchange.extern-send"), "mail/transport.rs ClaimDispatch (fenced dispatch claim)"),
    );
    m.insert(
        "mail.transport.settle".into(),
        entry(vec![receipts(), ("transport_intents", rel(RW, true))], Some("exchange.extern-send"), "mail/transport.rs SettleDispatch (under the claim token)"),
    );
    m.insert("mail.ack.ack".into(), entry(vec![receipts(), ("outgoing_intents", rel(RW, true))], None, "mail/receive.rs Ack (source settles its intent)"));
    m.insert(
        "mail.recovery.sweep".into(),
        entry(vec![receipts(), ("outgoing_intents", rel(RW, true)), ("mail_sent", rel(R, true))], None, "mail/recovery.rs Sweep (v6 fair per-destination recovery)"),
    );
    m.insert("mail.recovery.reactivate".into(), entry(vec![receipts(), ("outgoing_intents", rel(RW, true))], None, "mail/recovery.rs Reactivate (bounded periodic check)"));
    m.insert(
        "runtime.admit".into(),
        entry(
            vec![
                receipts(),
                ("authority_epoch", rel(&["read", "for_share"], true)),
                ("topology_edges", rel(&["read", "for_share"], true)),
                ("scope_rows", rel(&["read", "for_share"], true)),
                ("runtime_state", rel(RW, true)),
                ("folder_move_intents", rel(R, true)),
                ("runtime_claims", rel(RW, true)),
                ("outgoing_intents", rel(RW, false)),
            ],
            None,
            "runtime/admit.rs Admit (Q-CR r2 runtime.admit; S3 §8 obligation 2)",
        ),
    );
    m.insert(
        "runtime.claim_input".into(),
        entry(
            vec![
                receipts(),
                ("runtime_claims", rel(&["read", "for_no_key_update"], true)),
                ("mailboxes", rel(&["read", "for_update"], false)),
                ("mailbox_messages", rel(RW, false)),
                ("mail_input_batches", rel(W, false)),
            ],
            None,
            "runtime/admit.rs ClaimInput",
        ),
    );
    m.insert(
        "runtime.confirm_input".into(),
        entry(
            vec![
                receipts(),
                ("mail_input_batches", rel(&["read", "for_no_key_update", "write"], true)),
                ("mailbox_messages", rel(RW, true)),
                ("outgoing_intents", rel(RW, false)),
            ],
            None,
            "runtime/admit.rs ConfirmInput (v6 Read: input-confirmed)",
        ),
    );
    m.insert(
        "runtime.abandon_input".into(),
        entry(
            vec![
                receipts(),
                ("mail_input_batches", rel(&["read", "for_no_key_update", "write"], true)),
                ("mailboxes", rel(&["read", "for_update"], false)),
                ("mailbox_messages", rel(RW, false)),
            ],
            None,
            "runtime/admit.rs AbandonInput",
        ),
    );
    m.insert("runtime.settle".into(), entry(vec![receipts(), ("runtime_claims", rel(RW, true)), ("runtime_state", rel(W, false))], None, "runtime/admit.rs Settle"));
    let capture = |src: &str| {
        entry(
            vec![
                ("authority_epoch", rel(R, true)),
                ("topology_edges", rel(R, true)),
                ("scope_rows", rel(R, true)),
                ("charter_heads", rel(R, false)),
                ("charter_versions", rel(R, false)),
            ],
            None,
            src,
        )
    };
    m.insert("charter.capture".into(), capture("runtime/admit.rs Capture: WS5 STAND-IN for WS4's charter.capture (Q-CR r2 step 1)"));
    m.insert("charter.partial_recapture".into(), capture("runtime/admit.rs PartialRecapture: runs ONLY under Q-CR2.partial_recapture"));
    m.insert("runtime.last_vector".into(), entry(vec![("runtime_claims", rel(R, true))], None, "runtime/admit.rs LastVector: runs ONLY under Q-CR3.cached_fallback"));
    Value::Object(m)
}

/// Every unsafe control WS5 compiles in.
pub fn controls() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = Vec::new();
    for list in [sent::CONTROLS, mailbox::CONTROLS, receive::CONTROLS, human::CONTROLS, inbox::CONTROLS, admit::CONTROLS] {
        v.extend_from_slice(list);
    }
    v
}

/// Family-specific pause points (beyond the generic ones and `stmt.*`).
/// (`runtime.turn.provider_input.begin/.end` are trace MARKERS, not points.)
pub fn points() -> Vec<String> {
    vec![
        "charter.capture.after_first_read".into(),
        "runtime.admit.after_recheck".into(),
    ]
}
