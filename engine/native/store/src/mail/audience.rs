//! The audience grant and revoke tool (`audiences.grant`, `audiences.revoke`;
//! SLICE-VERBS C: WS5, READ COMMITTED, P1). SCHEDULE-GRADE in P03: the real
//! SQL and lock set, reached from the harness (no slice door), for Q-C7 (c)
//! and the Q-C6 restriction variants.
//!
//! The caller X grants a strict descendant G the right to address X
//! (`(G, agent, X)` anchored on X). Like every audience insert or delete it
//! updates G's authority-epoch row (r7 C2a P1), taken `FOR NO KEY UPDATE` at
//! C4 step 3 before the chain anchors (N4). A revoke also records a
//! restriction (the narrowing of G's authority, r7 C5).

use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Principal, Refusal};
use crate::hooks::controls;
use crate::mail::doors::anchor_agent_caller;
use crate::sent::{self, RecipientLock, Route, SendError};
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub static AUDIENCES: Family = Family { name: "audiences", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const INSERT_SQL: &str = "INSERT INTO audience_grants (org_id, grantee_id, target_kind, target_id, anchor_id, created_at) \
    VALUES ($1, $2, 'agent', $3, $3, $4) ON CONFLICT ON CONSTRAINT audience_grants_key DO NOTHING RETURNING grantee_id";
pub const DELETE_SQL: &str = "DELETE FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 AND target_kind = 'agent' AND target_id = $3 RETURNING grantee_id";
pub const BUMP_SQL: &str = "UPDATE authority_epoch SET audience_version = audience_version + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";

/// Grant (`revoke: false`) or revoke (`revoke: true`) `(grantee, caller)`.
pub struct Audience {
    pub grantee: Uuid,
    pub revoke: bool,
}

fn caller(b: &Binding) -> Result<(Uuid, i64), CmdError> {
    match b.principal {
        Principal::Agent { id, generation } => Ok((id, generation)),
        _ => Err(CmdError::Defect("the audience tool needs an agent caller".into())),
    }
}

impl Command for Audience {
    type Output = bool;
    fn family(&self) -> &'static Family {
        &AUDIENCES
    }
    fn verb(&self) -> &'static str {
        if self.revoke {
            "revoke"
        } else {
            "grant"
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let (id, generation) = caller(b)?;
        if let Some(r) = anchor_agent_caller(tx, b.op.org, id, generation).await? {
            return Err(CmdError::Refused(r));
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &bool) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<bool>, CmdError> {
        let org = b.op.org;
        let (x, _) = caller(b)?;
        let plan = match sent::plan_route(tx, org, x, sent::To::Agent(self.grantee)).await {
            Ok(p) if matches!(p.route, Route::Child | Route::DeepDescendant) => p,
            Ok(_) => return Ok(Decided::Refused(Refusal::new("not_descendant", "an audience is granted only to a strict descendant"))),
            Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
            Err(e) => return Err(e.into()),
        };
        // C4 step 3: the grantee's epoch row, exclusively, before the anchors
        match sent::resolve_recipient(tx, org, self.grantee, RecipientLock::Grant).await {
            Ok(_) => {}
            Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
            Err(e) => return Err(e.into()),
        }
        sent::anchor_route(tx, org, &plan).await.map_err(CmdError::from)?;
        let now = tx.now().await?;
        let changed = if self.revoke {
            !tx.exec("audiences.delete", DELETE_SQL, &[Val::Uuid(org), Val::Uuid(self.grantee), Val::Uuid(x)]).await?.is_empty()
        } else {
            !tx.exec("audiences.insert", INSERT_SQL, &[Val::Uuid(org), Val::Uuid(self.grantee), Val::Uuid(x), Val::Ts(now)]).await?.is_empty()
        };
        if changed && !controls::fire(&tx.scope(), "Q-C7.skip_epoch_bump") {
            tx.exec("audiences.bump", BUMP_SQL, &[Val::Uuid(org), Val::Uuid(self.grantee)]).await?;
        }
        if changed && self.revoke {
            crate::restrict::record(tx, org, "audience_revoked").await?;
        }
        Ok(Decided::Applied(changed))
    }
}
