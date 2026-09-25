//! Schedule-grade request FILINGS for r7 Q-C12 (C2a P7): an ask
//! (`ask_user`) and a scope request (`request_scope`). The credit request is
//! WS4's real writer (`funding.rs`), which already bumps the asker's
//! requests version.
//!
//! READ COMMITTED, outside the island (r7 C2a). One attempt:
//! 1. the caller anchor: the asker's authority-epoch row `FOR SHARE` (live,
//!    current generation, not halted) and the killswitch;
//! 2. P7: the asker's authority-epoch row UPDATED — a conditional update
//!    (`… WHERE live AND generation AND NOT halted`) bumping its requests
//!    version, so a retire or dissolve whose snapshot predates this commit
//!    gets `40001` on its `FOR NO KEY UPDATE` and its retry moots the
//!    filing; a filing that waited behind a retire sees the archived state
//!    and refuses;
//! 3. the request row inserted (`request_batches`, one pending per asker and
//!    kind).
//!
//! Unsafe control `Q-C12.filing_skips_epoch_bump` (r7 Q-C12): step 2 is
//! skipped: an open card for an archived agent.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Principal};
use crate::hooks::controls;
use crate::island;
use crate::lifecycle::topo::decided;
use crate::lifecycle::OUTSIDE;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub use crate::funding::REQUEST_BUMP_SQL;
pub const FILE_SQL: &str = "INSERT INTO request_batches (org_id, batch_id, asker_id, kind, state, rev, payload, created_at) \
    VALUES ($1, $2, $3, $4, 'pending', 1, $5, clock_timestamp())";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filed {
    pub batch: Uuid,
}

#[derive(Clone, Debug)]
pub struct FileRequest {
    /// `ask` or `scope`.
    pub kind: &'static str,
    pub payload: serde_json::Value,
}

impl Command for FileRequest {
    type Output = Filed;
    fn family(&self) -> &'static Family {
        &OUTSIDE
    }
    fn verb(&self) -> &'static str {
        match self.kind {
            "ask" => "ask",
            _ => "request_scope",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        match island::anchor_caller(tx, b).await? {
            island::Caller::Agent { .. } => Ok(()),
            _ => island::refuse("forbidden", "only an agent files a request"),
        }
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Filed) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Filed>, CmdError> {
        let org = b.op.org;
        let Principal::Agent { id, generation } = b.principal else { return island::refuse("forbidden", "only an agent files a request") };
        decided(async {
            if !controls::fire(&tx.scope(), "Q-C12.filing_skips_epoch_bump") {
                let bumped = tx.exec("request.bump", REQUEST_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Int(generation)]).await?;
                if bumped.is_empty() {
                    return island::refuse("not_live", "the asking agent is not live");
                }
            }
            let batch = Uuid::new_v4();
            tx.exec("request.file", FILE_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::Uuid(id), Val::text(self.kind), Val::Json(self.payload.clone())]).await?;
            Ok(Filed { batch })
        }
        .await)
    }
}
