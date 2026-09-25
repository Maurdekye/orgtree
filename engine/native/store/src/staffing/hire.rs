//! `staffing.hire` (`orgtree_hire`) and the seat half of every hire-shaped
//! door: `operator.hire`, the seat of `orgtree_staff` and the immediate
//! quick-staff modes (S3 §4.8 "hire" row; §4.9; §4.10).
//!
//! **Isolation.** SERIALIZABLE, in the island (r7 C2a; v6 "atomic
//! staffing"). The declared read set is S3 §4.8's; each island-side lock
//! below is named by the pair it serves.
//!
//! **Lock order (C4), one attempt:**
//! 1. `anchor`: the caller's authority-epoch row `FOR SHARE` and the
//!    killswitch (C3, via WS3b's `island::anchor_caller`); for an operator
//!    acting as agent A, A's authority-epoch row `FOR SHARE` (E5);
//! 2. the destination resolved by name INSIDE the transaction (plan
//!    decision 8, WS3b's `island::resolve_name`), then its chain's edge rows
//!    `FOR SHARE` leaf upward (C3: the caller is the destination or a strict
//!    ancestor; depth), the destination's authority-epoch row `FOR SHARE`
//!    (live);
//! 3. the catalog version row and the org control rows read (`caps`,
//!    `cascade`, `defaults`, `kiosk`) `FOR SHARE` (P2, P6);
//! 4. the scope rows of the destination's WHOLE chain `FOR SHARE`, top-down
//!    (P3; S3 §4.8: a narrowing of any ancestor lists the subtree beneath it
//!    after locking its own row, so a hire that share-locked only its
//!    destination could escape the clamp — Q-ST5);
//! 5. the payer capacity rows on the acquisition path `FOR NO KEY UPDATE`
//!    (P2, [`super::fund`]); the kiosk pool row last (E8);
//! 6. the new rows. The name's key is the lowest free suffix, probed inside
//!    this transaction; the unique name index is the conflict detector
//!    (`agent_names_active` is on the island's retry allowlist).
//!
//! **Refusals** are checked in legacy's order (`Org.hire`) and commit
//! nothing (E-D5).
//!
//! **Effects.** The `lifecycle.hired` notices to the parent and the new
//! seat's peers (never the actor) and the kickoff are Sent intents in this
//! transaction (WS5's `record_sent`); delivery and the first drive are
//! post-commit (v6). A seat with a kickoff is `started`.
//!
//! **P03 narrowings (disclosed; each is a D-/E-D row at stage 2):**
//! `audiences`, `work_item`, `review_items`, the `set_scope` fields
//! (`permission_mode`, `effort`, `team_charter`, `prefer_reserve`,
//! `account_fallback`) and `hire_type='superior'` are not accepted by this
//! verb yet and refuse with code `p03.not_in_slice` (they are later WS3a
//! increments); the fable lock is one `defaults.fable_lock` key (the
//! per-node `limit_locked` flags have no P03 column); the account and the
//! OpenRouter harness are chosen BEFORE the transaction by the adapter
//! (external observations, r7 §6.2 step 2) and arrive resolved.

use std::collections::BTreeSet;
use std::sync::Mutex;

use orgtree_funding_core::pynum::PyNum;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{fund, scope, STAFFING, STAFFING_RC};
use crate::exec::{Binding, CmdError, Command, Decided, Family, Refusal};
use crate::funding::{self, Actor};
use crate::hooks::controls;
use crate::island::{self, Caller, Lock};
use crate::mail::mailbox;
use crate::sent::{self, Destination, MailSource, SendError, SendRequest};
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

/// Legacy `MAX_DEPTH` / `MAX_CHILDREN` (runaway insurance defaults).
pub const MAX_DEPTH: i64 = 1024;
pub const MAX_CHILDREN: i64 = 1024;

/// Legacy `HANDLES_RETIRED`.
pub const HANDLES_RETIRED: &str = "external_handles are retired with the @mcp: address form — outside chats reach orgs through the mail hub (@net:<slug>)";

const TOOL_KEYS: [&str; 4] = ["bash", "web", "edit", "subagents"];

pub const INSERT_AGENT_SQL: &str = "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ($1, $2, $3, $4, $5, $6)";
pub const INSERT_NAME_SQL: &str = "INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ($1, $2, $3, 'active')";
pub const INSERT_EPOCH_SQL: &str = "INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ($1, $2, 'live', 0)";
pub const NEXT_ORD_SQL: &str = "SELECT coalesce(max(ord), -1) + 1 FROM topology_edges WHERE org_id = $1 AND parent_id = $2";
pub const NEXT_TOP_ORD_SQL: &str = "SELECT coalesce(max(ord), -1) + 1 FROM topology_edges WHERE org_id = $1 AND parent_id IS NULL";
pub const INSERT_EDGE_SQL: &str = "INSERT INTO topology_edges (org_id, principal_id, parent_id, ord) VALUES ($1, $2, $3, $4)";
pub const INSERT_SCOPE_SQL: &str = "INSERT INTO scope_rows (org_id, principal_id, depth, tools, folders, visibility, permission_mode) VALUES ($1, $2, $3, $4, $5, $6, $7)";
/// Legacy `_new_node`: "a new hire is IDLE, not stateless" (user ruling
/// 2026-08-02) — the seat's status row (WS4's narrow row, 0200).
pub const INSERT_STATUS_SQL: &str = "INSERT INTO status_rows (org_id, principal_id, last_status)     VALUES ($1, $2, jsonb_build_object('status', 'idle', 'summary', 'hired — awaiting work', 'at', $3::timestamptz))";
pub const INSERT_RUNTIME_SQL: &str = "INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ($1, $2, $3)";
pub const INSERT_CONFIG_SQL: &str = "INSERT INTO seat_config (org_id, principal_id, tier, account_id, account_primary, harness) VALUES ($1, $2, $3, $4, $5, $6)";
pub const INSERT_FUNDING_EDGE_SQL: &str = "INSERT INTO funding_edges (org_id, child_id, issuer_id, tier, grant_centi) VALUES ($1, $2, $3, $4, $5)";
pub const INSERT_CAPACITY_SQL: &str = "INSERT INTO issuer_capacity (org_id, principal_id) VALUES ($1, $2)";
pub const INSERT_CHARTER_VERSION_SQL: &str = "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) \
    VALUES ($1, $2, 'role', 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4)";
pub const INSERT_CHARTER_HEAD_SQL: &str = "INSERT INTO charter_heads (org_id, principal_id, charter_kind, current_version) VALUES ($1, $2, 'role', 1)";
pub const PRICE_OF_SQL: &str = "SELECT p.seat_centi FROM price_catalog p JOIN catalog_current c ON c.org_id = p.org_id AND c.catalog_version = p.catalog_version \
    WHERE p.org_id = $1 AND p.tier = $2";
pub const TIERS_SQL: &str = "SELECT p.tier FROM price_catalog p JOIN catalog_current c ON c.org_id = p.org_id AND c.catalog_version = p.catalog_version \
    WHERE p.org_id = $1 ORDER BY p.tier";
/// Peers for the `lifecycle.hired` notices: the parent's non-archived
/// children (legacy `children(parent)`, live_only), in legacy's order.
pub const PEERS_SQL: &str = "SELECT t.principal_id FROM topology_edges t JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id = $2 AND e.lifecycle <> 'archived' ORDER BY t.ord, a.created_at";
pub const TOP_PEERS_SQL: &str = "SELECT t.principal_id FROM topology_edges t JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id IS NULL AND e.lifecycle <> 'archived' ORDER BY t.ord, a.created_at";
/// The children cap's count: legacy `org_children` (every child except an
/// ARCHIVED lineage bearer).
pub const ORG_CHILDREN_SQL: &str = "SELECT count(*)::bigint FROM topology_edges t JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id = $2 \
    AND NOT (e.lifecycle = 'archived' AND EXISTS (SELECT 1 FROM lineage_bearers b WHERE b.org_id = t.org_id AND b.bearer_id = t.principal_id))";
pub const CLEAR_FABLE_SQL: &str = "UPDATE org_controls SET value = value - 'fable_lock', version = version + 1 WHERE org_id = $1 AND family = 'defaults'";

/// Which door the call came through (the placement check and its words
/// differ: the agent door's `check_placement`, the operator door's ledger
/// check).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Door {
    Agent,
    Operator,
}

/// The adapter's account decision, made before the transaction
/// (`registry.validate_selection` is an external observation).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountChoice {
    pub account_id: Option<String>,
    pub primary: bool,
    /// The wire's `account` field (legacy `registry.account_name`).
    pub display: Option<String>,
}

/// A hire as the door hands it over (legacy argument names).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HireSpec {
    /// A pre-minted principal (harness-driven schedule writers; the
    /// stand-in shape `NamesakeHire { principal, name, parent }`). `None` =
    /// minted here.
    #[serde(default)]
    pub principal: Option<Uuid>,
    /// The destination's NAME (`target`/`parent`); `None` = the caller
    /// (an agent) or the top level (the user).
    #[serde(default)]
    pub target: Option<String>,
    pub name: String,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub grant: Option<Value>,
    #[serde(default)]
    pub add_dirs: Option<Value>,
    #[serde(default)]
    pub tools: Option<Value>,
    #[serde(default)]
    pub org_visibility: Option<String>,
    #[serde(default)]
    pub charter: Option<String>,
    #[serde(default)]
    pub kickoff: Option<String>,
    #[serde(default)]
    pub kickoff_kind: Option<String>,
    #[serde(default)]
    pub external_handles: Vec<String>,
    #[serde(default)]
    pub raise_ceiling: bool,
    #[serde(default)]
    pub account: AccountChoice,
    #[serde(default)]
    pub harness: Option<String>,
    /// Fields this increment does not take (refused, `p03.not_in_slice`).
    #[serde(default)]
    pub unsupported: Vec<String>,
}

/// The hire's result (legacy `orgtree_hire` wire keys).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hired {
    /// The new seat's key (legacy `node`).
    pub node: String,
    pub principal: Uuid,
    pub warnings: Vec<String>,
    pub started: bool,
    pub next_step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge: Option<Value>,
}

fn refuse<T>(code: &str, msg: impl Into<String>) -> Result<Result<T, Refusal>, CmdError> {
    Ok(Err(Refusal::new(code, msg)))
}

/// Python `repr` of a str list, as `sorted(...)` prints in legacy texts.
fn py_list(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))).collect();
    format!("[{}]", inner.join(", "))
}

/// The acting identity for the decide step (E5): an agent caller acts as
/// itself; the operator acts as the user unless it names an agent.
pub fn actor_of(c: &Caller) -> Actor {
    match c {
        Caller::Agent { id, .. } => Actor::Agent(*id),
        Caller::Operator { acting: Some(a), .. } => Actor::Agent(*a),
        _ => Actor::User,
    }
}

/// E5: the acting identity's authority-epoch row `FOR SHARE`, exactly as a
/// caller's (C3), so a retire or move of A either commits first (and the
/// hire sees it) or waits for the hire. Legacy's operator door does not
/// refuse a HALTED acting agent (only the agent door checks halt): kept.
pub async fn anchor_acting<S: Session>(tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
    if let Some(a) = b.acting {
        match island::lock_epoch(tx, "staffing.acting_anchor", b.op.org, a, Lock::Share).await? {
            None => return Err(CmdError::Refused(Refusal::new("no_such_node", format!("no such node: '{a}'")))),
            Some(e) if !e.live() => return Err(CmdError::Refused(Refusal::new("not_live", format!("the acting agent is {}, not live", e.lifecycle)))),
            Some(_) => {}
        }
    }
    Ok(())
}

/// The seat half, composable inside any island transaction (hire, staff,
/// operator hire, quick staff). `hint` survives the command's attempts
/// (the P2 lock-set extension).
pub async fn hire_in<S: Session>(
    tx: &mut Tx<'_, S>,
    b: &Binding,
    door: Door,
    spec: &HireSpec,
    hint: &Mutex<BTreeSet<Uuid>>,
    unsafe_rc: Option<&'static str>,
) -> Result<Result<Hired, Refusal>, CmdError> {
    let org = b.op.org;
    let caller = island::caller_of(b);
    let actor = actor_of(&caller);
    let user_actor = actor == Actor::User;
    if let Some(f) = spec.unsupported.first() {
        return refuse("p03.not_in_slice", format!("{f} is not accepted by the P03 hire yet"));
    }
    // ---- destination (door): resolved inside this transaction (decision 8)
    let dest: Option<Uuid> = match (&spec.target, &caller) {
        (Some(t), _) if t == "user" && user_actor => None,
        (Some(t), _) => match island::resolve_name(tx, org, t).await? {
            Some(p) => Some(p),
            None => return refuse("no_such_node", format!("no such node: '{t}'")),
        },
        (None, _) => match actor {
            Actor::Agent(a) => Some(a),
            Actor::User => None,
        },
    };
    // Q-ST1's unsafe control: the destination's children are counted
    // BEFORE any lock, at READ COMMITTED, and that count decides the cap.
    let early_kids: Option<i64> = match (unsafe_rc, dest) {
        (Some("Q-ST1.rc_count_first"), Some(d)) => {
            let k = tx.exec("staffing.org_children", ORG_CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(d)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
            tx.pause("children_counted").await?;
            Some(k)
        }
        _ => None,
    };
    // Q-OP3's control is legacy's pre-guard: every authority and liveness
    // fact is a plain read, done before the racing retire commits, and
    // nothing is anchored. Everywhere else the facts are anchored (C3).
    let anchored = unsafe_rc != Some("Q-OP3.rc_acting_prechecked");
    // C3: the destination's chain, edge rows FOR SHARE leaf upward.
    let chain: Vec<Uuid> = match dest {
        Some(d) => island::chain_up(tx, org, d, anchored).await?,
        None => Vec::new(),
    };
    let dest_epoch = match dest {
        Some(d) => island::lock_epoch(tx, "staffing.dest_epoch", org, d, if anchored { Lock::Share } else { Lock::Read }).await?,
        None => None,
    };
    let dname = match dest {
        Some(d) => island::name_of(tx, org, d).await?.unwrap_or_else(|| d.to_string()),
        None => String::new(),
    };
    let actor_name = match actor {
        Actor::Agent(a) => island::name_of(tx, org, a).await?.unwrap_or_else(|| a.to_string()),
        Actor::User => orgtree_funding_core::USER.to_string(),
    };
    let dest_live = dest_epoch.as_ref().map(|e| e.live()).unwrap_or(true);
    let dest_state = dest_epoch.as_ref().map(|e| e.lifecycle.clone()).unwrap_or_default();
    let within = |a: Uuid| chain.contains(&a);
    if door == Door::Agent && dest.is_some() {
        // check_placement: live, and the caller itself or a descendant.
        if !dest_live {
            return refuse("not_live", format!("{dname} is {dest_state}, not live"));
        }
        if let Actor::Agent(a) = actor {
            if !within(a) {
                return refuse(
                    "outside_subtree",
                    format!("\"{dname}\" is outside your subtree — a destination is yourself or one of your own descendants (§7.1)"),
                );
            }
        }
    }
    if door == Door::Agent && !user_actor {
        let missing: Vec<&str> = [("add_dirs", spec.add_dirs.is_none()), ("tools", spec.tools.is_none()), ("org_visibility", spec.org_visibility.is_none())]
            .iter()
            .filter(|(_, m)| *m)
            .map(|(f, _)| *f)
            .collect();
        if !missing.is_empty() {
            return refuse(
                "invalid",
                format!(
                    "an ordinary hire (hire_type='subordinate', the default) has no defaults — state {} explicitly ([] is a valid add_dirs). Only hire_type='superior' takes them from the target instead",
                    missing.join(", ")
                ),
            );
        }
    }
    if door == Door::Operator && controls::fire(&tx.scope(), "Q-OP1.document_lock") {
        // Q-OP1's control: legacy's whole-document lock at the operator door
        // (DOC_LOCK serialises every writer of the org). Modelled as a SHARE
        // lock on the Sent table, which every mail source transaction
        // inserts into, so an unrelated agent send must wait for this hire.
        tx.exec("staffing.q_op1_document_lock", "LOCK TABLE mail_sent IN SHARE MODE", &[]).await?;
    }
    // ---- Org.hire, in legacy's order
    let Some(tier) = spec.tier.clone() else { return refuse("invalid", "hire needs tier and name") };
    // P2/P6: catalog and controls FOR SHARE (the catalog row via WS4's SQL).
    tx.exec("funding.catalog", funding::CATALOG_SQL, &[Val::Uuid(org)]).await?;
    let tiers: Vec<String> = tx.exec("staffing.tiers", TIERS_SQL, &[Val::Uuid(org)]).await?.0.iter().filter_map(|r| r.first().and_then(Val::as_text).map(str::to_string)).collect();
    if !tiers.contains(&tier) {
        return refuse("invalid", format!("unknown tier '{tier}'; know {}", py_list(&tiers)));
    }
    let ctl = island::share_controls(tx, org, &["caps", "cascade", "defaults", "kiosk"]).await?;
    let ctl_get = |fam: &str, k: &str| ctl.get(fam).and_then(|(_, v)| v.get(k)).cloned();
    let kiosk_ceiling = ctl_get("kiosk", "max_scope").filter(|v| !v.is_null());
    {
        let max_tier = kiosk_ceiling.as_ref().and_then(|c| c.get("max_tier")).map(scope::py);
        let doc_tiers: Vec<(orgtree_scope_clamp::pystr::PyStr, orgtree_scope_clamp::val::Val)> = Vec::new();
        if let Err(f) = orgtree_scope_clamp::clamp::check_tier_ceiling(max_tier.as_ref(), &orgtree_scope_clamp::pystr::PyStr::from(tier.as_str()), &doc_tiers, &orgtree_scope_clamp::clamp::Rules::LEGACY) {
            return match f {
                orgtree_scope_clamp::clamp::Fail::Refused(t) => refuse("invalid", t.to_text()),
                orgtree_scope_clamp::clamp::Fail::Outside(o) => Err(CmdError::Defect(format!("tier ceiling outside its domain: {}", o.0))),
            };
        }
    }
    let grant_v = spec.grant.clone().unwrap_or(json!(0));
    let Some(grant) = funding::json_py(&grant_v) else { return refuse("invalid", "grant must be a non-negative integer (№7)") };
    let whole_ok = grant.trunc_int().ok().is_some_and(|w| grant.ge(PyNum::Int(0)).unwrap_or(false) && grant.eq_py(PyNum::Int(w)));
    if !whole_ok {
        return refuse("invalid", "grant must be a non-negative integer (№7)");
    }
    let slug = match island::slugify(&spec.name) {
        Ok(s) => s,
        Err(r) => return Ok(Err(r)),
    };
    match dest {
        None => {
            if !user_actor {
                return refuse("invalid", "only the user hires at top level (§7.4)");
            }
        }
        Some(_) => {
            if !dest_live {
                return refuse("not_live", format!("{dname} is {dest_state}, not live"));
            }
            if let Actor::Agent(a) = actor {
                if Some(a) != dest && !within(a) {
                    return refuse("outside_subtree", format!("{actor_name} may hire only within its own subtree (§4.6)"));
                }
            }
        }
    }
    let mut warnings: Vec<String> = Vec::new();
    let fable_locked = ctl_get("defaults", "fable_lock").is_some_and(|v| !v.is_null() && v != json!(false));
    let mut clear_fable = false;
    if tier == "fable" && fable_locked {
        if user_actor {
            clear_fable = true;
        } else {
            warnings.push("the weekly Fable usage limit is exhausted — this agent will not be able to run yet; hiring it now is futile".into());
        }
    }
    if !user_actor {
        let mut missing: Vec<&str> = Vec::new();
        if spec.add_dirs.is_none() {
            missing.push("add_dirs (explicit list of {path, mode}; [] is valid)");
        }
        let tools_ok = spec.tools.as_ref().is_some_and(|t| TOOL_KEYS.iter().all(|k| t.get(*k).is_some()) && t.get("mcp").is_some());
        if !tools_ok {
            missing.push("tools (bash, web, edit, subagents, mcp — each stated explicitly)");
        }
        if spec.org_visibility.is_none() {
            missing.push("org_visibility (self|team|subtree|full)");
        }
        if !spec.charter.as_deref().is_some_and(|c| !c.trim().is_empty()) {
            missing.push("charter (the hire's role and standing instructions — write it in full)");
        }
        if !missing.is_empty() {
            return refuse("invalid", format!("agent hires have no defaults — specify exactly: {}", missing.join("; ")));
        }
    }
    let vis = spec
        .org_visibility
        .clone()
        .or_else(|| ctl_get("defaults", "default_visibility").and_then(|v| v.as_str().map(str::to_string)))
        .unwrap_or_else(|| "full".into());
    if !scope::vis_known(&vis) {
        return refuse("invalid", "org_visibility must be one of ('self', 'team', 'subtree', 'full')");
    }
    if !spec.external_handles.is_empty() {
        return refuse("invalid", format!("{HANDLES_RETIRED} (refused on hire)"));
    }
    // №34 caps: depth over the chain, children over the org children range.
    if let Some(d) = dest {
        let max_depth = island::cap(&ctl, "max_depth").unwrap_or(MAX_DEPTH);
        let depth = chain.len() as i64 - 1 + 1;
        if depth >= max_depth {
            return refuse("invalid", format!("max org depth {max_depth} reached"));
        }
        let max_children = island::cap(&ctl, "max_children").unwrap_or(MAX_CHILDREN);
        let kids = match early_kids {
            Some(k) => k,
            None => tx.exec("staffing.org_children", ORG_CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(d)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0),
        };
        if kids >= max_children {
            return refuse("invalid", format!("{dname} already has {max_children} reports (cap)"));
        }
    }
    // P3: the scope rows of the whole chain FOR SHARE, top-down; the parent's
    // is the one the clamps read.
    let top_down: Vec<Uuid> = chain.iter().rev().copied().collect();
    let scope_lock = if !anchored || controls::fire(&tx.scope(), "Q-ST5.share_destination_only") { Lock::Read } else { Lock::Share };
    let mut scopes = Vec::new();
    for (i, x) in top_down.iter().enumerate() {
        // Q-ST5's control: only the destination's row is share-locked.
        let lk = if i + 1 == top_down.len() && anchored { Lock::Share } else { scope_lock };
        scopes.extend(island::lock_scope_rows(tx, "staffing.scope_chain", org, &[*x], lk).await?);
    }
    let parent_scope = match dest {
        Some(d) => {
            let s = scopes.iter().find(|(x, _)| *x == d).and_then(|(_, s)| s.clone()).ok_or_else(|| CmdError::Defect("destination has no scope row".into()))?;
            Some(scope::ParentScope { tools: s.tools, folders: s.folders, visibility: s.visibility, permission_mode: s.permission_mode })
        }
        None => None,
    };
    let org_dirs = ctl_get("defaults", "dirs");
    let default_tools = ctl_get("defaults", "default_tools");
    let org_pm = ctl_get("defaults", "permission_mode").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "acceptEdits".into());
    let req = scope::Request {
        user_actor,
        add_dirs: spec.add_dirs.as_ref(),
        tools: spec.tools.as_ref(),
        vis: &vis,
        vis_explicit: spec.org_visibility.is_some(),
        org_dirs: org_dirs.as_ref(),
        default_tools: default_tools.as_ref(),
        org_permission_mode: &org_pm,
        ceiling: kiosk_ceiling.as_ref(),
        raise_ceiling: spec.raise_ceiling,
    };
    let (dirs, tools, vis, scope_warn) = match scope::clamp_before_funding(&req, parent_scope.as_ref())? {
        Ok(x) => x,
        Err(r) => return Ok(Err(r)),
    };
    // ---- the funding step (P2): top-grant cap or the chain acquisition
    let funded = match fund::plan(tx, org, actor, dest, &tier, grant, hint).await? {
        Ok(f) => f,
        Err(r) => return Ok(Err(r)),
    };
    // legacy appends the acquisition's warnings before the scope ones
    warnings.extend(funded.warnings.iter().cloned());
    warnings.extend(scope_warn);
    let derived = match scope::after_funding(&req, parent_scope.as_ref(), dirs, tools, vis, &mut warnings)? {
        Ok(d) => d,
        Err(r) => return Ok(Err(r)),
    };
    // ---- the new seat
    tx.pause("name_probe.before").await?;
    let key = island::free_name_suffix(tx, org, &slug).await?;
    tx.pause("name_probe.after").await?;
    let principal = spec.principal.unwrap_or_else(Uuid::new_v4);
    let now = tx.now().await?;
    let depth = chain.len() as i64;
    tx.exec("staffing.insert_agent", INSERT_AGENT_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::text(key.clone()), Val::Uuid(Uuid::new_v4()), Val::text(tier.clone()), Val::Ts(now)]).await?;
    tx.exec("staffing.insert_name", INSERT_NAME_SQL, &[Val::Uuid(org), Val::text(key.clone()), Val::Uuid(principal)]).await?;
    tx.exec("staffing.insert_epoch", INSERT_EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    let ord = match dest {
        Some(d) => tx.exec("staffing.next_ord", NEXT_ORD_SQL, &[Val::Uuid(org), Val::Uuid(d)]).await?,
        None => tx.exec("staffing.next_top_ord", NEXT_TOP_ORD_SQL, &[Val::Uuid(org)]).await?,
    }
    .first()
    .and_then(|r| r.first())
    .and_then(Val::as_int)
    .unwrap_or(0);
    tx.exec("staffing.insert_edge", INSERT_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::opt_uuid(dest), Val::Int(ord)]).await?;
    tx.exec(
        "staffing.insert_scope",
        INSERT_SCOPE_SQL,
        &[Val::Uuid(org), Val::Uuid(principal), Val::Int(depth), Val::Json(derived.tools), Val::Json(derived.folders), Val::text(derived.visibility), Val::text(derived.permission_mode)],
    )
    .await?;
    tx.exec("staffing.insert_runtime", INSERT_RUNTIME_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::Ts(now)]).await?;
    tx.exec("staffing.insert_status", INSERT_STATUS_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::Ts(now)]).await?;
    tx.exec(
        "staffing.insert_config",
        INSERT_CONFIG_SQL,
        &[Val::Uuid(org), Val::Uuid(principal), Val::text(tier.clone()), spec.account.account_id.clone().map(Val::text).unwrap_or(Val::Null), Val::Bool(spec.account.primary || spec.account.account_id.is_none()), spec.harness.clone().map(Val::text).unwrap_or(Val::Null)],
    )
    .await?;
    tx.exec("staffing.insert_funding_edge", INSERT_FUNDING_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::opt_uuid(dest), Val::text(tier.clone()), Val::Int(funded.grant_centi)]).await?;
    tx.exec("staffing.insert_capacity", INSERT_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    if let Some(c) = spec.charter.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        tx.exec("staffing.insert_charter_version", INSERT_CHARTER_VERSION_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::text(c), Val::Ts(now)]).await?;
        tx.exec("staffing.insert_charter_head", INSERT_CHARTER_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    }
    let (mailbox_id, mailbox_inc) = mailbox::create_mailbox(tx, org, principal).await?;
    if clear_fable {
        tx.exec("staffing.clear_fable", CLEAR_FABLE_SQL, &[Val::Uuid(org)]).await?;
    }
    // ---- P2 / E8: apply the funding
    if let Err(r) = fund::apply(tx, org, dest, &tier, &funded).await? {
        return Ok(Err(r));
    }
    // ---- effects: lifecycle.hired notices (parent, peers; never the actor)
    let gist = spec.charter.as_deref().and_then(|c| c.trim().lines().next()).map(|l| l.chars().take(120).collect::<String>()).unwrap_or_default();
    let mut notify: Vec<(Uuid, &str)> = Vec::new();
    if let Some(d) = dest {
        if actor != Actor::Agent(d) {
            notify.push((d, "report"));
        }
    }
    let peers = match dest {
        Some(d) => tx.exec("staffing.peers", PEERS_SQL, &[Val::Uuid(org), Val::Uuid(d)]).await?,
        None => tx.exec("staffing.top_peers", TOP_PEERS_SQL, &[Val::Uuid(org)]).await?,
    };
    for r in &peers.0 {
        if let Some(p) = r.first().and_then(Val::as_uuid) {
            if p != principal && actor != Actor::Agent(p) {
                notify.push((p, "peer"));
            }
        }
    }
    for (to, relation) in notify {
        let body = json!({
            "event": "lifecycle.hired", "node": key, "by": actor_name, "relation": relation,
            "tier": tier, "grant": funded.grant_centi as f64 / 100.0, "parent": if dest.is_some() { Value::String(dname.clone()) } else { Value::Null },
            "why": if gist.is_empty() { Value::Null } else { Value::String(gist.clone()) },
        })
        .to_string();
        system_notice(tx, org, to, "lifecycle.hired", &body).await?;
    }
    // ---- the kickoff: strictly last (legacy _seat_finish ①)
    let mut started = false;
    if let Some(k) = spec.kickoff.as_deref().filter(|k| !k.trim().is_empty()) {
        let kkind = spec.kickoff_kind.clone().unwrap_or_else(|| "request".into());
        if kkind == "notice" {
            return refuse(
                "invalid",
                "kickoff_kind 'notice' contradicts a kickoff — a notice is mail that deliberately never wakes anyone, and the whole point of kickoff is to start the hire's first turn. Use 'request' (the default), or drop kickoff and send an orgtree_send_notice afterwards",
            );
        }
        let source = match actor {
            Actor::Agent(a) => MailSource::Agent { principal: a },
            Actor::User => MailSource::User,
        };
        let id = kickoff_message_id(b, principal);
        let req = SendRequest::message(source, Destination::Resolved { principal, mailbox: mailbox_id, mailbox_incarnation: mailbox_inc }, id, kkind, k.to_string(), format!("kickoff:{id}"));
        match sent::record_sent(tx, &req).await {
            Ok(_) => {}
            Err(SendError::Refused(r)) => return Ok(Err(r)),
            Err(e) => return Err(e.into()),
        }
        started = true;
    }
    let next_step = if started {
        format!("\"{key}\" is hired and RUNNING — its first turn starts on your kickoff. Nothing further needed.")
    } else {
        format!("\"{key}\" is hired and IDLE. Hiring does not start it — send it an orgtree_message now saying what to do (or pass `kickoff` to this tool next time), or it will never run.")
    };
    Ok(Ok(Hired {
        node: key,
        principal,
        warnings,
        started,
        next_step,
        account: spec.account.display.clone(),
        bridge: derived.bridged.then(|| json!({"raise_ceiling": true})),
    }))
}

/// The kickoff's original message id: stable across the attempts of one
/// operation (E1: the original message id is part of the op identity).
fn kickoff_message_id(b: &Binding, principal: Uuid) -> Uuid {
    stable_id(&format!("kickoff|{}|{}|{}|{}|{}", b.op.org, b.op.ns.kind(), b.op.ns.id(), b.op.key, principal))
}

/// The operator door's operation identity (E4, decision E-D9): with a
/// caller key, the key under `(organization, operator, key)`; without one, a
/// key minted once for this request (a retry is a new operation: legacy).
/// Q-OP4's unsafe control accepts the key but does not bind it at all.
pub fn operator_identity(hooks: &crate::hooks::Hooks, org: Uuid, operator: Uuid, key: Option<&str>, fingerprint: &str) -> crate::exec::OpIdentity {
    use crate::exec::{KeyNamespace, OpIdentity};
    let minted = OpIdentity::minted(org, fingerprint, "legacy-1");
    let Some(k) = key else { return minted };
    let scope = crate::hooks::Scope { hooks, family: STAFFING.name, verb: "operator_hire", op: Some(&minted), op_tag: None, attempt: 0 };
    if controls::fire(&scope, "Q-OP4.key_unbound") {
        return minted;
    }
    OpIdentity { org, ns: KeyNamespace::Operator { operator }, key: k.to_string(), fingerprint: fingerprint.to_string(), fingerprint_codec: "legacy-1", caller_keyed: true }
}

/// A deterministic id from a seed (the same on every attempt of one
/// operation, E1: an original message id is part of the op identity). Two
/// SipHash-1-3 halves with fixed keys (`DefaultHasher::new()`); stable for
/// one build, which is all an operation's attempts span.
pub fn stable_id(seed: &str) -> Uuid {
    use std::hash::{Hash, Hasher};
    let half = |salt: u8| {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        salt.hash(&mut h);
        seed.hash(&mut h);
        h.finish()
    };
    Uuid::from_u64_pair(half(1), half(2))
}

/// A System notice into `to`'s notice box (Sent, E1; no pair, no wake).
pub async fn system_notice<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, to: Uuid, kind: &str, body: &str) -> Result<(), CmdError> {
    let mb = tx.exec("staffing.notice_mailbox", sent::RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(to)]).await?;
    let Some(row) = mb.first() else { return Ok(()) };
    let Some(mailbox) = row.first().and_then(Val::as_uuid) else { return Ok(()) };
    let incarnation = row.get(1).and_then(Val::as_int).unwrap_or(1);
    let id = stable_id(&format!("{kind}|{}|{}|{}|{}|{to}", tx.op().org, tx.op().ns.kind(), tx.op().ns.id(), tx.op().key));
    let req = SendRequest::notice(MailSource::System, Destination::Resolved { principal: to, mailbox, mailbox_incarnation: incarnation }, id, kind.to_string(), body.to_string(), format!("{kind}:{id}"));
    match sent::record_sent(tx, &req).await {
        Ok(_) | Err(SendError::Refused(_)) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// `orgtree_hire` (agent door) and `operator.hire` (operator door) as one
/// command: the door decides the placement rule; the binding says who acts.
pub struct Hire {
    pub door: Door,
    pub spec: HireSpec,
    /// `Some(control)` = the READ COMMITTED unsafe variant, outside the
    /// island (Q-ST1, Q-ST4, Q-OP3). It refuses to run unless that control
    /// is armed, and the control records that it executed.
    rc_control: Option<&'static str>,
    hint: Mutex<BTreeSet<Uuid>>,
}

/// The unsafe controls that run the hire READ COMMITTED outside the island.
pub const RC_CONTROLS: &[&str] = &["Q-ST1.rc_count_first", "Q-ST4.probe_outside_no_index", "Q-OP3.rc_acting_prechecked"];

impl Hire {
    pub fn new(door: Door, spec: HireSpec) -> Hire {
        Hire { door, spec, rc_control: None, hint: Mutex::new(BTreeSet::new()) }
    }
    /// The READ COMMITTED unsafe variant (only for an armed control in
    /// [`RC_CONTROLS`]).
    pub fn unsafe_rc(door: Door, spec: HireSpec, control: &'static str) -> Hire {
        assert!(RC_CONTROLS.contains(&control), "not an RC control: {control}");
        Hire { door, spec, rc_control: Some(control), hint: Mutex::new(BTreeSet::new()) }
    }
    /// The stand-in shape (`stand_ins.rs::Island::NamesakeHire`,
    /// `common_ws4::Racer::Hire`): a pre-minted principal under a parent,
    /// hired by the user.
    pub fn namesake(principal: Uuid, name: &str, parent: Option<String>, tier: &str, grant_centi: i64) -> Hire {
        Hire::new(
            Door::Operator,
            HireSpec {
                principal: Some(principal),
                target: parent,
                name: name.to_string(),
                tier: Some(tier.to_string()),
                grant: Some(json!(grant_centi / 100)),
                ..HireSpec::default()
            },
        )
    }
}

impl Command for Hire {
    type Output = Hired;
    fn family(&self) -> &'static Family {
        if self.rc_control.is_some() {
            return &STAFFING_RC;
        }
        &STAFFING
    }
    fn verb(&self) -> &'static str {
        match self.door {
            Door::Agent => "hire",
            Door::Operator => "operator_hire",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await?;
        if self.rc_control == Some("Q-OP3.rc_acting_prechecked") {
            // Q-OP3's control: A's authority and liveness were checked only
            // before the transaction (legacy's pre-guard); nothing anchored.
            return Ok(());
        }
        anchor_acting(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Hired) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Hired>, CmdError> {
        if let Some(c) = self.rc_control {
            if !controls::fire(&tx.scope(), c) {
                return Err(CmdError::Defect(format!("the READ COMMITTED hire variant ran without its control {c} armed")));
            }
        }
        Ok(match hire_in(tx, b, self.door, &self.spec, &self.hint, self.rc_control).await? {
            Ok(h) => Decided::Applied(h),
            Err(r) => Decided::Refused(r),
        })
    }
}
