//! The mail doors' command transactions (S3 §4.5-4.7): agent send
//! (`mail.message`, `mail.notice`), the outside send (`exchange.extern-send`),
//! human send (`mail.human-send`) and the inbox read mark
//! (`mail.user-inbox-read`). The store service routes the door's verbs here;
//! the door has already authenticated the caller and bound the principal.
//!
//! Every refusal is decided before any write, and a refusal commits nothing,
//! not even the receipt (E-D5).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Principal, Refusal};
use crate::sent::{self, Destination, GrantEffect, Lifecycle, MailClass, MailSource, Route, SendError, SendRequest};
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub static MAIL_SOURCE: Family = Family { name: "mail.source", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const CALLER_ANCHOR_SQL: &str = "SELECT lifecycle, generation, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const KILLSWITCH_SQL: &str = "SELECT coalesce((value->>'engaged')::boolean, false) FROM org_controls \
    WHERE org_id = $1 AND family = 'killswitch' FOR SHARE";
pub const HANDLE_SQL: &str = "SELECT 1 FROM extern_handles WHERE org_id = $1 AND principal_id = $2 AND handle = $3 FOR SHARE";

fn refused(r: SendError) -> Result<Decided<SendResult>, CmdError> {
    match r {
        SendError::Refused(r) => Ok(Decided::Refused(r)),
        e => Err(e.into()),
    }
}

/// E1.1 step 1 (C3): the sender's authority-epoch row `FOR SHARE` (live,
/// current generation, not halted) and the org's killswitch row `FOR SHARE`
/// (P6), so a latch and a send order as they do under `DOC_LOCK`.
pub async fn anchor_agent_caller<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid, generation: i64) -> Result<Option<Refusal>, CmdError> {
    let rows = tx.exec("mail.anchor_caller", CALLER_ANCHOR_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    let Some(r) = rows.first() else { return Ok(Some(Refusal::new("not_live", "the caller is not a node of this organization"))) };
    if r.first().and_then(Val::as_text) != Some("live") {
        return Ok(Some(Refusal::new("not_live", "the caller is not live")));
    }
    if r.get(1).and_then(Val::as_int) != Some(generation) {
        return Ok(Some(Refusal::new("stale_generation", "the caller's session generation is not current")));
    }
    if r.get(2) == Some(&Val::Bool(true)) {
        return Ok(Some(Refusal::new("halted", "the caller is halted")));
    }
    let ks = tx.exec("mail.anchor_killswitch", KILLSWITCH_SQL, &[Val::Uuid(org)]).await?;
    if ks.first().and_then(|r| r.first()) == Some(&Val::Bool(true)) {
        return Ok(Some(Refusal::new("killswitch", "the organization's killswitch is engaged")));
    }
    Ok(None)
}

/// Where an agent's send goes (resolved by the door from the address).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "to", rename_all = "snake_case")]
pub enum Target {
    Agent { principal: Uuid },
    User,
    External { handle: String },
}

/// The door's answer (legacy `post_mail` result fields).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendResult {
    pub message_id: Uuid,
    pub delivered: String,
    pub deferred: bool,
    pub recipient_state: Option<String>,
    pub pair_seq: Option<i64>,
    pub warnings: Vec<String>,
}

/// `orgtree_message` / `orgtree_send_notice` / an outside send, as the
/// bound agent. `class` is `Message` or `Passive` (an agent never files a
/// system notice). `reply_grant` is true for explicit sends and false for the
/// automatic participation notice (v6 matrix).
pub struct AgentSend {
    pub target: Target,
    pub message_id: Uuid,
    pub class: MailClass,
    pub kind: String,
    pub body: String,
    pub urgent_reason: Option<String>,
    pub reply_grant: bool,
}

impl AgentSend {
    fn caller(b: &Binding) -> Result<(Uuid, i64), CmdError> {
        match b.principal {
            Principal::Agent { id, generation } => Ok((id, generation)),
            _ => Err(CmdError::Defect("AgentSend needs an agent principal".into())),
        }
    }
    fn request(&self, sender: Uuid, dest: Destination, fingerprint: &str) -> SendRequest {
        let source = MailSource::Agent { principal: sender };
        let mut r = match self.class {
            MailClass::Passive => SendRequest::passive(source, dest, self.message_id, self.kind.clone(), self.body.clone(), fingerprint),
            _ => SendRequest::message(source, dest, self.message_id, self.kind.clone(), self.body.clone(), fingerprint),
        };
        if let Some(reason) = &self.urgent_reason {
            r = r.with_urgent(reason.clone());
        }
        r
    }
}

impl Command for AgentSend {
    type Output = SendResult;
    fn family(&self) -> &'static Family {
        &MAIL_SOURCE
    }
    fn verb(&self) -> &'static str {
        match (&self.target, self.class) {
            (Target::External { .. }, _) => "extern_send",
            (_, MailClass::Passive) => "notice",
            _ => "message",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let (id, generation) = Self::caller(b)?;
        if let Some(r) = anchor_agent_caller(tx, b.op.org, id, generation).await? {
            // Refusal before the claim: surfaced as a refusal by execute().
            return Err(CmdError::Refused(r));
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &SendResult) -> Result<bool, CmdError> {
        // the replay goes to the same immutable sender principal (E7 namespace)
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<SendResult>, CmdError> {
        let org = b.op.org;
        let (sender, _) = Self::caller(b)?;
        let fp = b.op.fingerprint.clone();
        let mut warnings = Vec::new();
        match &self.target {
            Target::Agent { principal } => {
                let a = match sent::address_agent(tx, org, sender, *principal, self.reply_grant).await {
                    Ok(a) => a,
                    Err(e) => return refused(e),
                };
                let req = self.request(sender, a.recipient.dest.clone(), &fp).with_grant(a.grant.clone());
                let rec = match sent::record_sent(tx, &req).await {
                    Ok(r) => r,
                    Err(e) => return refused(e),
                };
                let deferred = a.recipient.lifecycle == Lifecycle::Archived;
                if deferred {
                    warnings.push(
                        "the recipient is archived — the mail is saved in its inbox, but NOTHING WILL READ IT until somebody rehires it. If no rehire is intended, treat this as UNDELIVERED and send it to a live agent.".to_string(),
                    );
                }
                if rec.grant_inserted {
                    warnings.push(format!("audience granted: {principal} may now reply to {sender} directly"));
                }
                Ok(Decided::Applied(SendResult {
                    message_id: rec.message_id,
                    delivered: principal.to_string(),
                    deferred,
                    recipient_state: Some(if deferred { "archived" } else { "live" }.into()),
                    pair_seq: rec.pair_seq,
                    warnings,
                }))
            }
            Target::User => {
                let (_route, dest): (Route, Destination) = match sent::address_user(tx, org, sender).await {
                    Ok(x) => x,
                    Err(e) => return refused(e),
                };
                let rec = match sent::record_sent(tx, &self.request(sender, dest, &fp)).await {
                    Ok(r) => r,
                    Err(e) => return refused(e),
                };
                Ok(Decided::Applied(SendResult { message_id: rec.message_id, delivered: "user_inbox".into(), deferred: false, recipient_state: None, pair_seq: rec.pair_seq, warnings }))
            }
            Target::External { handle } => {
                // exact held handle: attributed, no EXTERN (v6 matrix)
                let held = !tx.exec("mail.extern_handle", HANDLE_SQL, &[Val::Uuid(org), Val::Uuid(sender), Val::text(handle.clone())]).await?.is_empty();
                let dest = Destination::External { handle: handle.clone() };
                let req = if held { self.request(sender, dest, &fp).attributed() } else { self.request(sender, dest, &fp).with_grant(GrantEffect::Extern) };
                let rec = match sent::record_sent(tx, &req).await {
                    Ok(r) => r,
                    Err(e) => return refused(e),
                };
                if rec.grant_inserted {
                    warnings.push("you now hold the ORG-INBOX audience (auto-granted by this send): replies and future outside mail addressed to the org will reach you; revoke it with orgtree_audience action=revoke once someone else should hold it".to_string());
                }
                Ok(Decided::Applied(SendResult { message_id: rec.message_id, delivered: handle.clone(), deferred: false, recipient_state: None, pair_seq: None, warnings }))
            }
        }
    }
}
