//! Inbox reads (S3 §4.7): `GET /inbox` ([`UserInbox`]) and
//! `GET nodes/{nid}/inbox` ([`NodeInbox`]). Operator reads (E2): ONE
//! `REPEATABLE READ READ ONLY` snapshot through [`Executor::read`], no locks,
//! no output claim for the operator, never a write.
//!
//! The node inbox splits pending, in-flight (claimed by a runtime input
//! batch, not yet confirmed) and delivered by MESSAGE IDENTITY (E-D7); its
//! Sent list is the node's own source-owned Sent rows. The human mailbox is
//! ordered by `(Sent time, message id)` (E-D3).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{CmdError, ExecError, Executor};
use crate::hooks::{controls, Scope};
use crate::read::Read;
use crate::session::{Connector, Session};
use crate::value::{Rows, Val};
use crate::Tx;

pub const CONTROLS: &[&str] = &["Q-IB3.separate_snapshots"];
pub const TAIL: i64 = 50;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub id: Uuid,
    pub from_kind: String,
    pub from: Uuid,
    pub kind: String,
    pub class: String,
    pub body: String,
    /// Sent time, microseconds since the epoch.
    pub at: i64,
    pub urgent: bool,
    pub urgent_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentRow {
    pub id: Uuid,
    pub to_kind: String,
    pub to: Option<Uuid>,
    pub to_external: Option<String>,
    pub kind: String,
    pub body: String,
    pub at: i64,
}

pub const USER_UNREAD_SQL: &str = "SELECT m.original_message_id, m.source_kind, m.source_id, m.kind, m.class, coalesce(s.body, ''), m.sent_at, m.urgent, s.urgent_reason \
    FROM mailboxes b JOIN mailbox_messages m ON m.org_id = b.org_id AND m.mailbox_id = b.mailbox_id \
    LEFT JOIN mail_sent s ON s.org_id = m.org_id AND s.message_id = m.original_message_id \
    WHERE b.org_id = $1 AND b.owner_kind = 'user' AND m.state = 'pending' ORDER BY m.sent_at, m.original_message_id";
pub const USER_READ_SQL: &str = "SELECT * FROM (SELECT m.original_message_id, m.source_kind, m.source_id, m.kind, m.class, coalesce(s.body, ''), m.sent_at, m.urgent, s.urgent_reason \
    FROM mailboxes b JOIN mailbox_messages m ON m.org_id = b.org_id AND m.mailbox_id = b.mailbox_id \
    LEFT JOIN mail_sent s ON s.org_id = m.org_id AND s.message_id = m.original_message_id \
    WHERE b.org_id = $1 AND b.owner_kind = 'user' AND m.state = 'read' ORDER BY m.sent_at DESC, m.original_message_id DESC LIMIT $2) t \
    ORDER BY 7, 1";
pub const SENT_SQL: &str = "SELECT * FROM (SELECT message_id, dest_kind, dest_principal_id, dest_external, kind, body, sent_at FROM mail_sent \
    WHERE org_id = $1 AND source_kind = $2 AND source_id = $3 ORDER BY sent_at DESC, message_id DESC LIMIT $4) t ORDER BY 7, 1";
pub const NODE_MAILBOX_SQL: &str = "SELECT mailbox_id FROM mailboxes \
    WHERE org_id = $1 AND owner_kind = 'agent' AND owner_id = $2 ORDER BY incarnation DESC LIMIT 1";
pub const NODE_PENDING_SQL: &str = "SELECT m.original_message_id, m.source_kind, m.source_id, m.kind, m.class, coalesce(s.body, ''), m.sent_at, m.urgent, s.urgent_reason \
    FROM mailbox_messages m LEFT JOIN mail_sent s ON s.org_id = m.org_id AND s.message_id = m.original_message_id \
    WHERE m.org_id = $1 AND m.mailbox_id = $2 AND m.state = 'pending' ORDER BY m.recv_ord";
pub const NODE_INFLIGHT_SQL: &str = "SELECT m.original_message_id, m.source_kind, m.source_id, m.kind, m.class, coalesce(s.body, ''), m.sent_at, m.urgent, s.urgent_reason \
    FROM mailbox_messages m LEFT JOIN mail_sent s ON s.org_id = m.org_id AND s.message_id = m.original_message_id \
    WHERE m.org_id = $1 AND m.mailbox_id = $2 AND m.state = 'delivering' ORDER BY m.recv_ord";
pub const NODE_DELIVERED_SQL: &str = "SELECT * FROM (SELECT m.original_message_id, m.source_kind, m.source_id, m.kind, m.class, coalesce(s.body, ''), m.sent_at, m.urgent, s.urgent_reason, m.recv_ord \
    FROM mailbox_messages m LEFT JOIN mail_sent s ON s.org_id = m.org_id AND s.message_id = m.original_message_id \
    WHERE m.org_id = $1 AND m.mailbox_id = $2 AND m.state = 'delivered' ORDER BY m.recv_ord DESC LIMIT $3) t ORDER BY 10";

fn rows(r: &Rows) -> Vec<Row> {
    r.0.iter()
        .filter_map(|x| {
            Some(Row {
                id: x.first()?.as_uuid()?,
                from_kind: x.get(1)?.as_text().unwrap_or("").to_string(),
                from: x.get(2)?.as_uuid().unwrap_or_else(Uuid::nil),
                kind: x.get(3)?.as_text().unwrap_or("").to_string(),
                class: x.get(4)?.as_text().unwrap_or("").to_string(),
                body: x.get(5)?.as_text().unwrap_or("").to_string(),
                at: x.get(6)?.as_ts().unwrap_or(0),
                urgent: x.get(7) == Some(&Val::Bool(true)),
                urgent_reason: x.get(8).and_then(Val::as_text).map(str::to_string),
            })
        })
        .collect()
}

fn sent_rows(r: &Rows) -> Vec<SentRow> {
    r.0.iter()
        .filter_map(|x| {
            Some(SentRow {
                id: x.first()?.as_uuid()?,
                to_kind: x.get(1)?.as_text().unwrap_or("").to_string(),
                to: x.get(2).and_then(Val::as_uuid),
                to_external: x.get(3).and_then(Val::as_text).map(str::to_string),
                kind: x.get(4)?.as_text().unwrap_or("").to_string(),
                body: x.get(5)?.as_text().unwrap_or("").to_string(),
                at: x.get(6)?.as_ts().unwrap_or(0),
            })
        })
        .collect()
}

/// `GET /inbox`: unread user mail, and the newest 50 read rows and user
/// Sent rows, from ONE snapshot.
pub struct UserInbox;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInboxView {
    pub inbox: Vec<Row>,
    pub read: Vec<Row>,
    pub sent: Vec<SentRow>,
}

pub struct Org(pub Uuid);

impl Read for (UserInbox, Org) {
    type Output = UserInboxView;
    fn family(&self) -> &'static str {
        "mail.inbox"
    }
    fn verb(&self) -> &'static str {
        "user_inbox"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<UserInboxView, CmdError> {
        let org = self.1 .0;
        let unread = tx.exec("inbox.user_unread", USER_UNREAD_SQL, &[Val::Uuid(org)]).await?;
        let read = tx.exec("inbox.user_read", USER_READ_SQL, &[Val::Uuid(org), Val::Int(TAIL)]).await?;
        let sent = tx.exec("inbox.user_sent", SENT_SQL, &[Val::Uuid(org), Val::text("user"), Val::Uuid(Uuid::nil()), Val::Int(TAIL)]).await?;
        Ok(UserInboxView { inbox: rows(&unread), read: rows(&read), sent: sent_rows(&sent) })
    }
}

/// `GET /inbox` through the executor's read path.
pub async fn user_inbox<C: Connector>(exec: &Executor<C>, org: Uuid) -> Result<UserInboxView, ExecError> {
    exec.read(&(UserInbox, Org(org)), org, None).await
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct NodeInboxView {
    pub pending: Vec<Row>,
    pub in_flight: Vec<Row>,
    pub delivered: Vec<Row>,
    pub sent: Vec<SentRow>,
}

/// Which lists a node-inbox read covers (all of them, normally).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Part {
    All,
    Pending,
    InFlight,
    Delivered,
}

pub struct NodeInbox {
    pub org: Uuid,
    pub node: Uuid,
    pub part: Part,
}

impl Read for NodeInbox {
    type Output = NodeInboxView;
    fn family(&self) -> &'static str {
        "mail.inbox"
    }
    fn verb(&self) -> &'static str {
        match self.part {
            Part::All => "node_inbox",
            Part::Pending => "node_inbox_pending",
            Part::InFlight => "node_inbox_in_flight",
            Part::Delivered => "node_inbox_delivered",
        }
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<NodeInboxView, CmdError> {
        let (org, node) = (self.org, self.node);
        let mut v = NodeInboxView::default();
        let mb = tx.exec("inbox.node_mailbox", NODE_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(node)]).await?;
        let Some(mailbox) = mb.first().and_then(|r| r.first()).and_then(Val::as_uuid) else { return Ok(v) };
        let all = self.part == Part::All;
        if all || self.part == Part::Pending {
            v.pending = rows(&tx.exec("inbox.node_pending", NODE_PENDING_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?);
        }
        if all || self.part == Part::InFlight {
            v.in_flight = rows(&tx.exec("inbox.node_in_flight", NODE_INFLIGHT_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?);
        }
        if all || self.part == Part::Delivered {
            v.delivered = rows(&tx.exec("inbox.node_delivered", NODE_DELIVERED_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Int(TAIL)]).await?);
        }
        if all {
            v.sent = sent_rows(&tx.exec("inbox.node_sent", SENT_SQL, &[Val::Uuid(org), Val::text("agent"), Val::Uuid(node), Val::Int(TAIL)]).await?);
        }
        Ok(v)
    }
}

/// `GET nodes/{nid}/inbox`: every list from ONE snapshot. Under the Q-IB3
/// unsafe control each list is read in its own snapshot (the legacy
/// regression `api.py:14140-14143` names).
pub async fn node_inbox<C: Connector>(exec: &Executor<C>, org: Uuid, node: Uuid) -> Result<NodeInboxView, ExecError> {
    let op = crate::exec::OpIdentity::minted(org, "", "none");
    let separate = {
        let s = Scope { hooks: exec.hooks(), family: "mail.inbox", verb: "node_inbox", op: Some(&op), op_tag: None, attempt: 0 };
        controls::fire(&s, "Q-IB3.separate_snapshots")
    };
    if !separate {
        return exec.read(&NodeInbox { org, node, part: Part::All }, org, None).await;
    }
    let pending = exec.read(&NodeInbox { org, node, part: Part::Pending }, org, None).await?.pending;
    let in_flight = exec.read(&NodeInbox { org, node, part: Part::InFlight }, org, None).await?.in_flight;
    let delivered = exec.read(&NodeInbox { org, node, part: Part::Delivered }, org, None).await?.delivered;
    Ok(NodeInboxView { pending, in_flight, delivered, sent: Vec::new() })
}

