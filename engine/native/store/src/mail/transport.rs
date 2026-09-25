//! The outside-send TRANSPORT executor with a FAKE transport (P03 scope: "an
//! external endpoint with a fake transport only"; real transport, ingress and
//! the hub spool are P07). v6 MAIL-STAGES, "Agent to outside party": the
//! transport "executes the captured immutable send under its own fenced
//! dispatch claim. It does not re-read holder membership or reroute a prior
//! send. Remote acknowledgment is distinct from local Sent and remote agent
//! Read."
//!
//! One dispatch = three steps, and no transaction spans the network I/O:
//! 1. [`ClaimDispatch`]: pick one due pending intent (`FOR UPDATE SKIP
//!    LOCKED`), give it a fresh claim token and a lease (`due_at` moves out);
//! 2. the transport sends the CAPTURED handle and body (outside SQL);
//! 3. [`SettleDispatch`]: the outcome is written only if the token still
//!    matches (a claimer whose lease expired and was re-claimed is fenced out).
//!    `uncertain` (the remote may or may not have it) is terminal for P03's
//!    fake transport; P07 owns reconciliation.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, ExecError, Executor, Family, Isolation, Outcome};
use crate::mail::receive::receiver_binding;
use crate::session::{Connector, Session};
use crate::value::Val;
use crate::Tx;

pub static TRANSPORT: Family = Family { name: "mail.transport", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const PICK_SQL: &str = "SELECT t.intent_id, t.message_id, t.handle, s.body FROM transport_intents t \
    JOIN mail_sent s ON s.org_id = t.org_id AND s.message_id = t.message_id \
    WHERE t.org_id = $1 AND t.stage = 'pending' AND t.due_at <= $2 ORDER BY t.due_at, t.intent_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED";
pub const LEASE_SQL: &str = "UPDATE transport_intents SET claim_token = $3, attempts = attempts + 1, due_at = $4 \
    WHERE org_id = $1 AND intent_id = $2";
pub const SETTLE_SQL: &str = "UPDATE transport_intents SET stage = $4, result = $5 \
    WHERE org_id = $1 AND intent_id = $2 AND claim_token = $3 AND stage = 'pending' RETURNING intent_id";
pub const RELEASE_SQL: &str = "UPDATE transport_intents SET due_at = $4, result = $5 \
    WHERE org_id = $1 AND intent_id = $2 AND claim_token = $3 AND stage = 'pending' RETURNING intent_id";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claimed {
    pub intent_id: Uuid,
    pub message_id: Uuid,
    pub handle: String,
    pub body: String,
    pub token: Uuid,
}

/// Step 1: the fenced dispatch claim.
pub struct ClaimDispatch {
    pub lease_ms: i64,
}

impl Command for ClaimDispatch {
    type Output = Option<Claimed>;
    fn family(&self) -> &'static Family {
        &TRANSPORT
    }
    fn verb(&self) -> &'static str {
        "claim"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Option<Claimed>) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Option<Claimed>>, CmdError> {
        let org = b.op.org;
        let now = tx.now().await?;
        let rows = tx.exec("transport.pick", PICK_SQL, &[Val::Uuid(org), Val::Ts(now)]).await?;
        let Some(r) = rows.first() else { return Ok(Decided::Applied(None)) };
        let (Some(intent_id), Some(message_id)) = (r.first().and_then(Val::as_uuid), r.get(1).and_then(Val::as_uuid)) else {
            return Err(CmdError::Defect("undecodable transport intent".into()));
        };
        let token = Uuid::new_v4();
        tx.exec("transport.lease", LEASE_SQL, &[Val::Uuid(org), Val::Uuid(intent_id), Val::Uuid(token), Val::Ts(now + self.lease_ms * 1000)]).await?;
        Ok(Decided::Applied(Some(Claimed {
            intent_id,
            message_id,
            handle: r.get(2).and_then(Val::as_text).unwrap_or("").to_string(),
            body: r.get(3).and_then(Val::as_text).unwrap_or("").to_string(),
            token,
        })))
    }
}

/// What the transport reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum Sent {
    /// The remote acknowledged custody (not Read).
    Acked { remote_id: String },
    /// The remote refused it (terminal).
    Refused { reason: String },
    /// Transient failure: retry after a backoff (stays pending).
    Retry { reason: String },
    /// The connection died mid-send: the remote may or may not have it.
    Uncertain,
}

/// Step 3: settle under the claim token.
pub struct SettleDispatch {
    pub intent_id: Uuid,
    pub token: Uuid,
    pub sent: Sent,
    pub backoff_ms: i64,
}

impl Command for SettleDispatch {
    type Output = bool;
    fn family(&self) -> &'static Family {
        &TRANSPORT
    }
    fn verb(&self) -> &'static str {
        "settle"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &bool) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<bool>, CmdError> {
        let org = b.op.org;
        let result = Val::Json(json!(self.sent));
        let rows = match &self.sent {
            Sent::Retry { .. } => {
                let now = tx.now().await?;
                tx.exec("transport.release", RELEASE_SQL, &[Val::Uuid(org), Val::Uuid(self.intent_id), Val::Uuid(self.token), Val::Ts(now + self.backoff_ms * 1000), result]).await?
            }
            s => {
                let stage = match s {
                    Sent::Acked { .. } => "sent",
                    Sent::Refused { .. } => "refused",
                    _ => "uncertain",
                };
                tx.exec("transport.settle", SETTLE_SQL, &[Val::Uuid(org), Val::Uuid(self.intent_id), Val::Uuid(self.token), Val::text(stage), result]).await?
            }
        };
        Ok(Decided::Applied(!rows.is_empty()))
    }
}

/// The fake transport: records every send; a script can make the next sends
/// fail. Nothing leaves the machine.
#[derive(Default)]
pub struct FakeTransport {
    pub log: Mutex<Vec<(String, Uuid, String)>>,
    pub script: Mutex<Vec<Sent>>,
}

impl FakeTransport {
    pub fn send(&self, handle: &str, message: Uuid, body: &str) -> Sent {
        self.log.lock().unwrap().push((handle.to_string(), message, body.to_string()));
        let mut s = self.script.lock().unwrap();
        if s.is_empty() {
            Sent::Acked { remote_id: format!("fake-{message}") }
        } else {
            s.remove(0)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dispatched {
    pub claimed: Claimed,
    pub sent: Sent,
    pub settled: bool,
}

/// Claim one due outside send, hand it to the transport with no transaction
/// open, settle it under the claim token.
pub async fn dispatch_one<C: Connector>(exec: &Executor<C>, org: Uuid, transport: &FakeTransport, lease_ms: i64) -> Result<Option<Dispatched>, ExecError> {
    let claimed = match exec.run(&ClaimDispatch { lease_ms }, &receiver_binding(org, "transport-claim")).await? {
        Outcome::Applied(Some(c)) => c,
        _ => return Ok(None),
    };
    let sent = transport.send(&claimed.handle, claimed.message_id, &claimed.body);
    let settle = SettleDispatch { intent_id: claimed.intent_id, token: claimed.token, sent: sent.clone(), backoff_ms: lease_ms };
    let settled = matches!(exec.run(&settle, &receiver_binding(org, &format!("transport-settle:{}", claimed.intent_id))).await?, Outcome::Applied(true));
    Ok(Some(Dispatched { claimed, sent, settled }))
}
