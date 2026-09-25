//! The human doors (S3 §4.6-4.7): `POST nodes/{nid}/message` in its mail
//! branch ([`HumanSend`]) and its session-command branch ([`HumanCommand`]),
//! and the user inbox read mark ([`MarkRead`], `POST /inbox/read`).
//!
//! The source is the authenticated operator (E2); the user is one pair
//! source per organization (E1.2). The door binds the operation key: the
//! request's `client_op` when present (E-D4, namespace `Operator`), else a
//! minted key (E4). A refusal commits nothing (E-D5).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, ExecError, Executor, Family, Isolation, Outcome, Refusal};
use crate::hooks::{controls, Scope};
use crate::sent::{self, GrantEffect, Lifecycle, MailSource, RecipientLock, SendError, SendRequest};
use crate::session::{Connector, Session};
use crate::value::Val;
use crate::Tx;

pub static MAIL_HUMAN: Family = Family { name: "mail.human", isolation: Isolation::ReadCommitted, retry_unique: &[] };
pub static INBOX: Family = Family { name: "mail.inbox", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const CONTROLS: &[&str] = &[
    "Q-HM2.client_op_unbound",
    "Q-HM3.effects_before_refusals",
    "Q-HM4.chain_unanchored",
    "Q-HM4.chain_unanchored_only",
    "Q-IB1.rewrite_unread_list",
    "Q-IB2.commit_empty_mark",
];

pub const EDGE_SHARE_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const EDGE_READ_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
pub const EPOCH_SQL: &str = "SELECT lifecycle, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
pub const FACTS_SQL: &str = "SELECT frozen, remote_controlled, knowledge_bearer, has_conversation, just_compacted \
    FROM seat_session_facts WHERE org_id = $1 AND principal_id = $2";
pub const BUSY_SQL: &str = "SELECT busy FROM runtime_state WHERE org_id = $1 AND principal_id = $2";
pub const KILLSWITCH_SQL: &str = "SELECT coalesce((value->>'engaged')::boolean, false) FROM org_controls \
    WHERE org_id = $1 AND family = 'killswitch' FOR SHARE";
pub const COMMAND_INTENT_SQL: &str = "INSERT INTO runtime_command_intents (org_id, intent_id, principal_id, command, args, created_at) \
    VALUES ($1, $2, $3, $4, $5, $6)";
pub const MARK_READ_SQL: &str = "UPDATE mailbox_messages SET state = 'read', read_at = $3 \
    WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $4 AND read_at IS NULL AND state = 'pending' RETURNING 1";
/// Q-IB1 unsafe control: legacy's section rewrite: read the whole unread
/// list, delete it, and write it back from that read (marked rows as read).
pub const UNREAD_LIST_SQL: &str = "SELECT original_message_id, fingerprint, received_at, class, kind, source_kind, source_id, pair_seq, sent_at, urgent     FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND state = 'pending'";
pub const DELETE_UNREAD_SQL: &str = "DELETE FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND state = 'pending'";
pub const REWRITE_ROW_SQL: &str = "INSERT INTO mailbox_messages     (org_id, mailbox_id, original_message_id, fingerprint, state, is_notice, received_at, read_at, class, kind, source_kind, source_id, pair_seq, sent_at, urgent)     VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, $11, $12, $13, $14)";

const MAX_DEPTH: usize = 64;

/// Walk the node's chain upward, anchoring each edge row `FOR SHARE` (C3),
/// and return the strict ancestors below USER, nearest first. Under the Q-HM4
/// control the edges are read without anchors.
async fn anchored_ancestors<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid) -> Result<Vec<Uuid>, CmdError> {
    let unanchored = controls::fire(&tx.scope(), "Q-HM4.chain_unanchored") || controls::fire(&tx.scope(), "Q-HM4.chain_unanchored_only");
    let mut out = Vec::new();
    let mut cur = node;
    loop {
        let rows = if unanchored {
            tx.exec("human.chain_read", EDGE_READ_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?
        } else {
            tx.exec("human.chain_anchor", EDGE_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?
        };
        match rows.first().and_then(|r| r.first()).and_then(Val::as_uuid) {
            Some(p) if out.len() < MAX_DEPTH => {
                out.push(p);
                cur = p;
            }
            _ => break,
        }
    }
    Ok(out)
}

/// One `context.deep_reach` system notice per non-user ancestor (legacy
/// `user_deep_reach`, `ledger.py:4361`): source SYSTEM, class Notice, no pair
/// sequence (lead ruling A2).
async fn deep_reach<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid, chain: &[Uuid], kind: &str, gist: &str) -> Result<(), SendError> {
    for a in chain {
        let dest = sent::mailbox_of(tx, org, *a).await?;
        let body = serde_json::json!({"variant": "context.deep_reach", "node": node.to_string(), "kind": kind, "gist": gist}).to_string();
        let n = SendRequest::notice(MailSource::System, dest, Uuid::new_v4(), "context.deep_reach", body, "deep-reach");
        sent::record_sent(tx, &n).await?;
    }
    Ok(())
}

fn gist(body: &str) -> String {
    body.trim().lines().next().unwrap_or("").chars().take(80).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanSendResult {
    pub message_id: Uuid,
    pub deferred: bool,
    pub notified: Vec<Uuid>,
    pub audience_granted: bool,
}

/// The mail branch of the human send (S3 §4.6).
pub struct HumanSend {
    pub node: Uuid,
    pub message_id: Uuid,
    pub kind: String,
    pub body: String,
}

impl Command for HumanSend {
    type Output = HumanSendResult;
    fn family(&self) -> &'static Family {
        &MAIL_HUMAN
    }
    fn verb(&self) -> &'static str {
        "send"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        // The operator has no authority-epoch row (E2).
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &HumanSendResult) -> Result<bool, CmdError> {
        Ok(true)
    }
    fn causal_refs(&self) -> Vec<String> {
        vec![self.message_id.to_string()]
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<HumanSendResult>, CmdError> {
        let org = b.op.org;
        // step 3: the node's epoch row FOR NO KEY UPDATE from the start, since
        // this send may insert the first-contact grant (E1.1 step 5, N4).
        // Q-HM1's control takes it FOR SHARE (no lock before the grant read).
        // Q-HM1's control: no lock on the node's epoch row before the grant
        // read. Q-HM4's (compound, see anchored_ancestors) drops it too: with
        // the row held exclusively (N4) a move of the node serializes with the
        // send on it, so removing only the edge anchors is not a control.
        let unlocked = controls::fire(&tx.scope(), "Q-HM1.no_lock_no_key") || controls::fire(&tx.scope(), "Q-HM4.chain_unanchored");
        let lock = if unlocked { RecipientLock::Unanchored } else { RecipientLock::Grant };
        let rcpt = match sent::resolve_recipient(tx, org, self.node, lock).await {
            Ok(r) => r,
            Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
            Err(e) => return Err(e.into()),
        };
        let chain = anchored_ancestors(tx, org, self.node).await?;
        let grant = if chain.is_empty() { GrantEffect::None } else { GrantEffect::FirstContactUser { node: self.node } };
        let req = SendRequest::message(MailSource::User, rcpt.dest.clone(), self.message_id, self.kind.clone(), self.body.clone(), b.op.fingerprint.clone()).with_grant(grant);
        let rec = match sent::record_sent(tx, &req).await {
            Ok(r) => r,
            Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
            Err(e) => return Err(e.into()),
        };
        deep_reach(tx, org, self.node, &chain, "message", &gist(&self.body)).await.map_err(CmdError::from)?;
        Ok(Decided::Applied(HumanSendResult {
            message_id: rec.message_id,
            deferred: rcpt.lifecycle == Lifecycle::Archived,
            notified: chain,
            audience_granted: rec.grant_inserted,
        }))
    }
}

/// The seat facts a `/compact` refusal reads (schedule-grade, see 0300).
#[derive(Default)]
struct Facts {
    frozen: bool,
    remote: bool,
    bearer: bool,
    conversation: bool,
    just_compacted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    pub intent_id: Uuid,
    pub notified: Vec<Uuid>,
    pub audience_granted: bool,
}

/// The session-command branch (S3 §4.6, E-D5): every refusal is evaluated
/// before any write; only then the deep-reach effects and the command intent.
pub struct HumanCommand {
    pub node: Uuid,
    pub command: String,
    pub args: Value,
    /// Q-HM3 control plumbing: write only the effects (legacy's first write
    /// cycle), skipping every refusal. Set only by [`human_command`].
    effects_only: bool,
}

impl HumanCommand {
    pub fn new(node: Uuid, command: impl Into<String>, args: Value) -> HumanCommand {
        HumanCommand { node, command: command.into(), args, effects_only: false }
    }
    fn is_compact(&self) -> bool {
        self.command == "/compact"
    }
}

fn refusal(status: u16, code: &str, msg: &str) -> Decided<CommandResult> {
    Decided::Refused(Refusal::new(code, format!("{status}: {msg}")))
}

impl Command for HumanCommand {
    type Output = CommandResult;
    fn family(&self) -> &'static Family {
        &MAIL_HUMAN
    }
    fn verb(&self) -> &'static str {
        "command"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &CommandResult) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<CommandResult>, CmdError> {
        let org = b.op.org;
        let rows = tx.exec("human.node_epoch", EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(self.node)]).await?;
        let Some(r) = rows.first() else { return Ok(refusal(404, "not_found", "no such node")) };
        let live = r.first().and_then(Val::as_text) == Some("live");
        let halted = r.get(1) == Some(&Val::Bool(true));
        if !self.effects_only {
            // every refusal first (E-D5), in legacy's order (api.py:5538-5631)
            if !live {
                return Ok(refusal(409, "not_live", "the node is not live"));
            }
            let f = tx.exec("human.facts", FACTS_SQL, &[Val::Uuid(org), Val::Uuid(self.node)]).await?;
            let facts = f
                .first()
                .map(|r| Facts {
                    frozen: r.first() == Some(&Val::Bool(true)),
                    remote: r.get(1) == Some(&Val::Bool(true)),
                    bearer: r.get(2) == Some(&Val::Bool(true)),
                    conversation: r.get(3) != Some(&Val::Bool(false)),
                    just_compacted: r.get(4) == Some(&Val::Bool(true)),
                })
                .unwrap_or(Facts { conversation: true, ..Facts::default() });
            if facts.frozen {
                return Ok(refusal(409, "frozen", "the node is frozen"));
            }
            if facts.remote {
                return Ok(refusal(409, "remote_controlled", "the node is remote-controlled"));
            }
            if self.is_compact() {
                let ks = tx.exec("human.killswitch", KILLSWITCH_SQL, &[Val::Uuid(org)]).await?;
                if halted || ks.first().and_then(|r| r.first()) == Some(&Val::Bool(true)) {
                    return Ok(refusal(409, "halted", "the node is halted or the killswitch is engaged"));
                }
                if facts.bearer {
                    return Ok(refusal(422, "knowledge_bearer", "a knowledge bearer cannot be compacted"));
                }
                if !facts.conversation {
                    return Ok(refusal(422, "no_conversation", "there is no conversation to compact"));
                }
                if facts.just_compacted {
                    return Ok(refusal(422, "just_compacted", "the node was just compacted"));
                }
                // busy: read without a lock, as legacy's pre-check (N6)
                let busy = tx.exec("human.busy", BUSY_SQL, &[Val::Uuid(org), Val::Uuid(self.node)]).await?;
                if busy.first().and_then(|r| r.first()) == Some(&Val::Bool(true)) {
                    return Ok(refusal(409, "busy", "the node is busy"));
                }
            }
        }
        // then the effects: deep-reach notices, the first-contact audience,
        // and (unless this is the control's effects-only cycle) the intent
        let chain = anchored_ancestors(tx, org, self.node).await?;
        let mut granted = false;
        if !chain.is_empty() {
            granted = sent::grant_user_audience(tx, self.node).await.map_err(CmdError::from)?;
        }
        deep_reach(tx, org, self.node, &chain, "command", &self.command).await.map_err(CmdError::from)?;
        let intent = Uuid::new_v4();
        if !self.effects_only {
            let now = tx.now().await?;
            tx.exec("human.command_intent", COMMAND_INTENT_SQL, &[Val::Uuid(org), Val::Uuid(intent), Val::Uuid(self.node), Val::text(self.command.clone()), Val::Json(self.args.clone()), Val::Ts(now)]).await?;
        }
        Ok(Decided::Applied(CommandResult { intent_id: intent, notified: chain, audience_granted: granted }))
    }
}

/// The door's session-command driver. Normally one transaction. Under the
/// Q-HM3 control it reproduces legacy's order: the effects commit in their
/// own transaction first, and only then are the refusals checked.
pub async fn human_command<C: Connector>(exec: &Executor<C>, cmd: HumanCommand, b: &Binding) -> Result<Outcome<CommandResult>, ExecError> {
    let legacy_order = {
        let s = Scope { hooks: exec.hooks(), family: MAIL_HUMAN.name, verb: "command", op: Some(&b.op), op_tag: b.op_tag.as_deref(), attempt: 0 };
        controls::fire(&s, "Q-HM3.effects_before_refusals")
    };
    if legacy_order {
        let mut first = b.clone();
        first.op = crate::exec::OpIdentity::minted(b.op.org, b.op.fingerprint.clone(), "ws5-legacy-order");
        let effects = HumanCommand { effects_only: true, ..HumanCommand::new(cmd.node, cmd.command.clone(), cmd.args.clone()) };
        exec.run(&effects, &first).await?;
    }
    exec.run(&cmd, b).await
}

/// `POST /inbox/read` (S3 §4.7, E-D6): a conditional per-row update of the
/// user mailbox's read state. The answer's `read` is the number of rows THIS
/// call changed; unknown ids are ignored; a mark that matches nothing is
/// refused as `nothing_marked`, so it commits nothing and the feed publishes
/// nothing (the door answers `{read: 0}`).
pub struct MarkRead {
    pub ids: Vec<Uuid>,
}

pub const USER_MAILBOX_SQL: &str = "SELECT mailbox_id FROM mailboxes WHERE org_id = $1 AND owner_kind = 'user' AND state = 'open'";

impl Command for MarkRead {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &INBOX
    }
    fn verb(&self) -> &'static str {
        "read"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        let mb = tx.exec("inbox.user_mailbox", USER_MAILBOX_SQL, &[Val::Uuid(org)]).await?;
        let Some(mailbox) = mb.first().and_then(|r| r.first()).and_then(Val::as_uuid) else {
            return Ok(Decided::Refused(Refusal::new("nothing_marked", "no user mailbox")));
        };
        let now = tx.now().await?;
        let mut marked = 0i64;
        if controls::fire(&tx.scope(), "Q-IB1.rewrite_unread_list") {
            // Unsafe: legacy's section rewrite from one earlier read.
            let unread = tx.exec("inbox.unread_list", UNREAD_LIST_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
            tx.pause("after_unread_list").await?;
            tx.exec("inbox.delete_unread", DELETE_UNREAD_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
            for r in &unread.0 {
                let Some(id) = r.first().and_then(Val::as_uuid) else { continue };
                let read = self.ids.contains(&id);
                let g = |i: usize| r.get(i).cloned().unwrap_or(Val::Null);
                tx.exec(
                    "inbox.rewrite_row",
                    REWRITE_ROW_SQL,
                    &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(id), g(1), Val::text(if read { "read" } else { "pending" }), g(2), if read { Val::Ts(now) } else { Val::Null }, g(3), g(4), g(5), g(6), g(7), g(8), g(9)],
                )
                .await?;
                marked += read as i64;
            }
        } else {
            for id in &self.ids {
                let r = tx.exec("inbox.mark", MARK_READ_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Ts(now), Val::Uuid(*id)]).await?;
                marked += r.len() as i64;
            }
        }
        if marked == 0 && controls::fire(&tx.scope(), "Q-IB2.commit_empty_mark") {
            // Unsafe control: legacy's unconditional broadcast — the empty
            // mark commits (its receipt row is a published group).
            return Ok(Decided::Applied(0));
        }
        if marked == 0 {
            // E-D6: nothing changed, so nothing commits and nothing publishes
            return Ok(Decided::Refused(Refusal::new("nothing_marked", "no listed message was unread")));
        }
        Ok(Decided::Applied(marked))
    }
}

/// Map a MarkRead outcome to the door's `{read: n}`.
pub fn read_count(o: &Outcome<i64>) -> i64 {
    match o {
        Outcome::Applied(n) | Outcome::Replayed(n) => *n,
        _ => 0,
    }
}

/// The human door's binding (E4/E-D4): the request's `client_op` is the
/// operation key under the operator's namespace; without one the key is
/// minted. The Q-HM2 unsafe control ignores `client_op` (legacy: stored,
/// never read back), so a repeat posts again.
pub fn human_binding(hooks: &crate::hooks::Hooks, org: Uuid, operator: Uuid, client_op: Option<&str>, fingerprint: &str) -> Binding {
    use crate::exec::{KeyNamespace, OpIdentity, Principal};
    let probe = OpIdentity::minted(org, fingerprint, "legacy-1");
    let s = Scope { hooks, family: MAIL_HUMAN.name, verb: "send", op: Some(&probe), op_tag: None, attempt: 0 };
    let op = match client_op {
        Some(k) if !controls::fire(&s, "Q-HM2.client_op_unbound") => {
            OpIdentity { org, ns: KeyNamespace::Operator { operator }, key: k.to_string(), fingerprint: fingerprint.to_string(), fingerprint_codec: "legacy-1", caller_keyed: true }
        }
        _ => probe,
    };
    Binding { principal: Principal::Operator { id: operator }, acting: None, op, db_incarnation: Uuid::nil(), op_tag: None }
}
