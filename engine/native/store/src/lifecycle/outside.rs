//! The READ COMMITTED writers WS3b owns outside the island (r7 C2a):
//!
//! * **halt / unhalt** (`control.halt`, `control.unhalt`, `control.op-halt`,
//!   `control.op-unhalt`): the authority-epoch row, which holds halt (P5,
//!   RN6), `FOR NO KEY UPDATE` and updated for the node and its subtree,
//!   top-down. Every island writer share-locks the epoch rows it relies on,
//!   so a halt committed after its snapshot raises `40001` there. A halt
//!   narrows authority: a restriction obligation is recorded (C5). Unhalt
//!   starts nothing (v6 I10).
//! * **the org settings folder downgrade** (`org-admin.settings`, r7 P3/P6,
//!   RN2): an org-wide narrowing FIRST updates the `directories` control row
//!   (every island scope writer share-locks it), THEN lists every node whose
//!   scope holds the folder `rw`, locks them top-down and rewrites the grant
//!   to `ro`. Unsafe control `Q-C11.settings_no_control_update` (r7 Q-C11
//!   (e)): the nodes are listed before the control row is updated.
//! * **kiosk disable / token rotation** (`control.kiosk`): the `kiosk`
//!   control row `FOR NO KEY UPDATE` and updated, and a restriction recorded
//!   (kiosk visitors' in-flight reads are revoked).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::hooks::controls;
use crate::island::{self, Lock};
use crate::lifecycle::topo::decided;
use crate::lifecycle::{require_authority, OUTSIDE};
use crate::restrict;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub const HALT_SQL: &str = "UPDATE authority_epoch SET halted = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const CONTROL_LOCK_SQL: &str = "SELECT version, value FROM org_controls WHERE org_id = $1 AND family = $2 FOR NO KEY UPDATE";
pub const CONTROL_WRITE_SQL: &str = "UPDATE org_controls SET value = $3, version = version + 1 WHERE org_id = $1 AND family = $2";
pub const CONTROL_INSERT_SQL: &str = "INSERT INTO org_controls (org_id, family, value) VALUES ($1, $2, $3)";
/// Every scope row, top-down (depth, then key): the org-wide narrowing's list.
pub const ALL_SCOPES_SQL: &str = "SELECT principal_id, folders FROM scope_rows WHERE org_id = $1 ORDER BY depth, principal_id";
pub const FOLDERS_WRITE_SQL: &str = "UPDATE scope_rows SET folders = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutsideKind {
    Halt { node: Uuid },
    Unhalt { node: Uuid },
    /// The org's mode for `path` drops from `rw` to `ro`.
    FolderDowngrade { path: String },
    KioskDisable,
    KioskRotate { token_sha256: String },
}

#[derive(Clone, Debug)]
pub struct Outside(pub OutsideKind);

impl Command for Outside {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &OUTSIDE
    }
    fn verb(&self) -> &'static str {
        match self.0 {
            OutsideKind::Halt { .. } => "halt",
            OutsideKind::Unhalt { .. } => "unhalt",
            OutsideKind::FolderDowngrade { .. } => "settings",
            OutsideKind::KioskDisable | OutsideKind::KioskRotate { .. } => "kiosk",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let c = island::anchor_caller(tx, b).await?;
        if !matches!(self.0, OutsideKind::Halt { .. } | OutsideKind::Unhalt { .. }) && !c.is_user_level() {
            return island::refuse("forbidden", "only the user changes organization settings");
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        let caller = island::caller_of(b);
        decided(async {
            match &self.0 {
                OutsideKind::Halt { node } | OutsideKind::Unhalt { node } => {
                    let halt = matches!(self.0, OutsideKind::Halt { .. });
                    require_authority(tx, org, &caller, *node, false).await?;
                    let sub = island::subtree(tx, org, &[*node]).await?;
                    let mut n = 0;
                    for (x, _) in &sub {
                        let Some(e) = island::lock_epoch(tx, "halt.lock_epoch", org, *x, Lock::Update).await? else { continue };
                        if e.live() && e.halted != halt {
                            tx.exec("halt.write", HALT_SQL, &[Val::Uuid(org), Val::Uuid(*x), Val::Bool(halt)]).await?;
                            n += 1;
                        }
                    }
                    if halt && n > 0 {
                        restrict::record(tx, org, "halt").await?;
                    }
                    Ok(n)
                }
                OutsideKind::FolderDowngrade { path } => {
                    let skip_first = controls::fire(&tx.scope(), "Q-C11.settings_no_control_update");
                    if !skip_first {
                        write_directories(tx, org, path).await?;
                    }
                    // list AFTER the control row's update (a later statement)
                    let rows = tx.exec("settings.list", ALL_SCOPES_SQL, &[Val::Uuid(org)]).await?;
                    let holders: Vec<Uuid> = rows
                        .0
                        .iter()
                        .filter(|r| r.get(1).and_then(Val::as_json).is_some_and(|f| holds_rw(f, path)))
                        .filter_map(|r| r.first().and_then(Val::as_uuid))
                        .collect();
                    tx.pause("after_list").await?;
                    let mut n = 0;
                    for x in holders {
                        let locked = island::lock_scope_rows(tx, "settings.scope_lock", org, &[x], Lock::Update).await?;
                        let Some(Some(s)) = locked.into_iter().next().map(|x| x.1) else { continue };
                        if holds_rw(&s.folders, path) {
                            tx.exec("settings.downgrade", FOLDERS_WRITE_SQL, &[Val::Uuid(org), Val::Uuid(x), Val::Json(downgrade(&s.folders, path))]).await?;
                            n += 1;
                        }
                    }
                    if skip_first {
                        write_directories(tx, org, path).await?;
                    }
                    restrict::record(tx, org, "settings").await?;
                    Ok(n)
                }
                OutsideKind::KioskDisable | OutsideKind::KioskRotate { .. } => {
                    let rows = tx.exec("kiosk.lock", CONTROL_LOCK_SQL, &[Val::Uuid(org), Val::text("kiosk")]).await?;
                    let mut v = rows.first().and_then(|r| r.get(1)).and_then(Val::as_json).cloned().unwrap_or_else(|| serde_json::json!({}));
                    match &self.0 {
                        OutsideKind::KioskDisable => v["enabled"] = Value::Bool(false),
                        OutsideKind::KioskRotate { token_sha256 } => v["token_sha256"] = Value::String(token_sha256.clone()),
                        _ => {}
                    }
                    if rows.is_empty() {
                        tx.exec("kiosk.insert", CONTROL_INSERT_SQL, &[Val::Uuid(org), Val::text("kiosk"), Val::Json(v)]).await?;
                    } else {
                        tx.exec("kiosk.write", CONTROL_WRITE_SQL, &[Val::Uuid(org), Val::text("kiosk"), Val::Json(v)]).await?;
                    }
                    restrict::record(tx, org, "kiosk").await?;
                    Ok(1)
                }
            }
        }
        .await)
    }
}

/// The org's directory control: `{"folders": [{"path", "mode"}]}`; the
/// folder's mode becomes `ro`.
async fn write_directories<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, path: &str) -> Result<(), CmdError> {
    let rows = tx.exec("settings.control_lock", CONTROL_LOCK_SQL, &[Val::Uuid(org), Val::text("directories")]).await?;
    let mut v = rows.first().and_then(|r| r.get(1)).and_then(Val::as_json).cloned().unwrap_or_else(|| serde_json::json!({}));
    let folders = v.get("folders").cloned().unwrap_or(Value::Array(vec![]));
    v["folders"] = downgrade(&folders, path);
    if rows.is_empty() {
        tx.exec("settings.control_insert", CONTROL_INSERT_SQL, &[Val::Uuid(org), Val::text("directories"), Val::Json(v)]).await?;
    } else {
        tx.exec("settings.control_write", CONTROL_WRITE_SQL, &[Val::Uuid(org), Val::text("directories"), Val::Json(v)]).await?;
    }
    Ok(())
}

pub fn holds_rw(folders: &Value, path: &str) -> bool {
    folders.as_array().is_some_and(|a| a.iter().any(|f| f.get("path").and_then(Value::as_str) == Some(path) && f.get("mode").and_then(Value::as_str) == Some("rw")))
}

fn downgrade(folders: &Value, path: &str) -> Value {
    let a = folders.as_array().cloned().unwrap_or_default();
    Value::Array(
        a.into_iter()
            .map(|mut f| {
                if f.get("path").and_then(Value::as_str) == Some(path) {
                    f["mode"] = Value::from("ro");
                }
                f
            })
            .collect(),
    )
}
