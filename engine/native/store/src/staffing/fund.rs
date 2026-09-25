//! The hire's funding step (S3 §4.8 "funding"; r7 C2a P2 island side;
//! S3 E8). The decision is the reviewed `orgtree-funding-core` planner
//! (`hire`: the grant check, the top-level and subtree refusals, the D-014
//! top-grant cap and `_chain_acquire` with its bubbling and whole-credit
//! carry). The frame, the read set and the application of grant inflations
//! are WS4's `funding.rs` (`open_frame`, `load`, `apply`), used, not copied.
//!
//! **P2, the island side.** Every payer capacity row the acquisition may
//! spend from is taken `FOR NO KEY UPDATE` before `free` is computed, and
//! every payer whose obligations change is UPDATED (the new seat's payer
//! gains a seat and a grant; an inflated node's payer gains the inflation),
//! so an outside writer that committed after this snapshot makes the lock
//! raise `40001`, and one that comes second waits and then sees this
//! commit. Like WS4's `plan_locked`, an attempt locks ONE set, all at once
//! (funding edges then capacity rows, primary-key order): first the payer
//! (a user actor's `_chain_acquire` takes the payer's own free first) or
//! the whole path up to an acting agent; if the plan then touches a node
//! outside the set, the set is recorded in `hint` and the attempt is re-run
//! with the larger set locked from the start.
//!
//! **E8.** In a kiosk organization a top-level hire changes the top-level
//! holdings (a seat and a grant): the kiosk pool row is taken
//! `FOR NO KEY UPDATE` LAST and updated. A deep user hire whose acquisition
//! inflates a top-level node reaches the pool through WS4's `apply`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use orgtree_funding_core::pynum::PyNum;
use orgtree_funding_core::snapshot::{Setting, Snapshot};
use orgtree_funding_core::{Rules, USER};
use serde_json::Value;
use uuid::Uuid;

use crate::exec::{CmdError, Refusal};
use crate::funding::{self, Actor, Loaded, Plan, ReadMode};
use crate::hooks::controls;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

/// The new seat's payer gains one seat of `tier` and `grant` hundredths.
pub const PAYER_ADD_SQL: &str = "UPDATE issuer_capacity SET child_grants_centi = child_grants_centi + $3, \
    child_seats = jsonb_set(child_seats, ARRAY[$4::text], to_jsonb(coalesce((child_seats->>$4::text)::bigint, 0) + 1)), version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";
pub const KIOSK_ADD_SEAT_SQL: &str = "UPDATE kiosk_pool SET top_grants_centi = top_grants_centi + $2, \
    top_seats = jsonb_set(top_seats, ARRAY[$3::text], to_jsonb(coalesce((top_seats->>$3::text)::bigint, 0) + 1)), version = version + 1 \
    WHERE org_id = $1";

/// What the funding step decided and must apply.
pub struct Funded {
    /// The new seat's grant, hundredths (`int(grant)`).
    pub grant_centi: i64,
    /// Warnings from the chain acquisition (bubbling), legacy text.
    pub warnings: Vec<String>,
    /// Loaded read set and the inflation plan (None at the top level).
    inner: Option<(Loaded, Plan)>,
    /// Top-level hire: the kiosk pool check happens at apply.
    top_level: bool,
    prices: BTreeMap<String, i64>,
}

fn refusal_of(f: orgtree_funding_core::ledger::Fail) -> Result<Refusal, CmdError> {
    match f {
        orgtree_funding_core::ledger::Fail::Refused(r) => Ok(Refusal::new(format!("funding.{:?}", r.kind).to_lowercase(), r.message)),
        orgtree_funding_core::ledger::Fail::Outside(o) => Err(CmdError::Defect(format!("funding decide outside its parity domain: {o:?}"))),
    }
}

async fn lock_payers<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, ids: &BTreeSet<Uuid>) -> Result<(), CmdError> {
    for id in ids {
        tx.exec("funding.lock_edge", funding::LOCK_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(*id)]).await?;
    }
    for id in ids {
        tx.exec("funding.lock_capacity", funding::LOCK_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(*id)]).await?;
    }
    Ok(())
}

/// The top-level frame: prices and the funding settings, no node.
async fn top_frame<S: Session>(tx: &mut Tx<'_, S>, org: Uuid) -> Result<(BTreeMap<String, i64>, Vec<(String, Setting)>), CmdError> {
    let version = tx
        .exec("funding.catalog", funding::CATALOG_SQL, &[Val::Uuid(org)])
        .await?
        .first()
        .and_then(|r| r.first())
        .and_then(Val::as_int)
        .ok_or_else(|| CmdError::Defect("no catalog_current row".into()))?;
    let mut prices = BTreeMap::new();
    for r in tx.exec("funding.prices", funding::PRICES_SQL, &[Val::Uuid(org), Val::Int(version)]).await?.0 {
        if let (Some(t), Some(c)) = (r.first().and_then(Val::as_text), r.get(1).and_then(Val::as_int)) {
            prices.insert(t.to_string(), c);
        }
    }
    let mut settings = Vec::new();
    for r in tx.exec("funding.controls", funding::CONTROLS_SQL, &[Val::Uuid(org)]).await?.0 {
        let fam = r.first().and_then(Val::as_text).unwrap_or("");
        let Some(Value::Object(v)) = r.get(1).and_then(Val::as_json) else { continue };
        let keys: &[&str] = match fam {
            "caps" => &["max_top_grant"],
            "cascade" => &["cascade_alloc", "cascade_hire"],
            _ => &[],
        };
        for k in keys {
            if let Some(x) = v.get(*k) {
                let s = match x {
                    Value::Null => Setting::Null,
                    Value::Bool(b) => Setting::Bool(*b),
                    Value::Number(_) => Setting::Num(funding::json_py(x).unwrap_or(PyNum::Int(0))),
                    Value::String(s) => Setting::Str(s.clone()),
                    _ => continue,
                };
                settings.push((k.to_string(), s));
            }
        }
    }
    Ok((prices, settings))
}

/// Decide the hire's funding under the P2 locks. `parent` None = a
/// top-level hire (the user's). Refusals carry legacy's text.
#[allow(clippy::too_many_arguments)]
pub async fn plan<S: Session>(
    tx: &mut Tx<'_, S>,
    org: Uuid,
    actor: Actor,
    parent: Option<Uuid>,
    tier: &str,
    grant: PyNum,
    hint: &Mutex<BTreeSet<Uuid>>,
) -> Result<Result<Funded, Refusal>, CmdError> {
    let Some(p) = parent else {
        let (prices, settings) = top_frame(tx, org).await?;
        let snap = Snapshot {
            nodes: Vec::new(),
            tiers: prices.iter().map(|(t, c)| (t.clone(), funding::centi_to_py(*c))).collect(),
            settings,
        };
        let out = orgtree_funding_core::hire(&snap, USER, None, tier, grant, &Rules::LEGACY);
        return match out.result {
            Ok(g) => Ok(Ok(Funded { grant_centi: funding::py_to_centi(g)?, warnings: out.acquire_warnings, inner: None, top_level: true, prices })),
            Err(f) => Ok(Err(refusal_of(f)?)),
        };
    };
    // Steps 2-3 (C4): the payer's chain FOR SHARE leaf upward, the catalog
    // version and the funding controls FOR SHARE.
    let Some(f) = funding::open_frame(tx, org, p, ReadMode { lock: true }).await? else {
        return Ok(Err(Refusal::new("funding.nosuchnode", format!("no such node {p}"))));
    };
    let path: BTreeSet<Uuid> = match actor {
        Actor::Agent(a) => match f.chain.iter().position(|x| *x == a) {
            Some(i) => f.chain[..=i].iter().copied().collect(),
            None => BTreeSet::new(),
        },
        Actor::User => f.chain.iter().copied().collect(),
    };
    let mut locked: BTreeSet<Uuid> = match actor {
        Actor::Agent(_) => path.clone(),
        Actor::User => BTreeSet::from([p]),
    };
    locked.extend(hint.lock().unwrap().iter().filter(|id| f.chain.contains(id)).copied());
    // Q-ST2's unsafe control is WS4's `Q-C8.lock_not_update` (the capacity
    // row locked but not updated), armed inside `apply` and at the payer
    // update below; the locks themselves are always taken.
    lock_payers(tx, org, &locked).await?;
    let l = funding::load(tx, org, p, ReadMode { lock: true }).await?.ok_or_else(|| CmdError::Defect("payer vanished under its lock".into()))?;
    tx.pause("after_funding_locks").await?;
    let pname = l.name(p).ok_or_else(|| CmdError::Defect("payer not loaded".into()))?.to_string();
    let out = orgtree_funding_core::hire(&l.snap, &l.actor_str(actor), Some(&pname), tier, grant, &Rules::LEGACY);
    let extend = |more: &BTreeSet<Uuid>| -> CmdError {
        hint.lock().unwrap().extend(locked.union(more).copied());
        CmdError::RetryAttempt { cause: "funding.lockset_extended" }
    };
    let g = match out.result {
        Err(fl) => {
            if path.is_subset(&locked) {
                return Ok(Err(refusal_of(fl)?));
            }
            return Err(extend(&path));
        }
        Ok(g) => g,
    };
    let mut changes = Vec::new();
    let mut need: BTreeSet<Uuid> = BTreeSet::from([p]);
    for (name, v) in &out.grants_changed {
        let id = l.id(name).ok_or_else(|| CmdError::Defect(format!("planner changed unknown node {name}")))?;
        let old = l.grant(id).unwrap_or(0);
        let new = funding::py_to_centi(*v)?;
        if new != old {
            changes.push((id, old, new));
            need.insert(id);
            if let Some(pp) = f.chain.iter().position(|x| *x == id).and_then(|i| f.chain.get(i + 1)) {
                need.insert(*pp);
            }
        }
    }
    if !need.is_subset(&locked) {
        return Err(extend(&need));
    }
    let plan = Plan { new_grant: g, warnings: Vec::new(), changes, notices: Vec::new() };
    let prices = l.prices.clone();
    Ok(Ok(Funded { grant_centi: funding::py_to_centi(g)?, warnings: out.acquire_warnings, inner: Some((l, plan)), top_level: false, prices }))
}

fn kiosk_refusal(pool_centi: i64, held_centi: i64) -> Refusal {
    Refusal::new(
        "kiosk_cap",
        format!(
            "kiosk credit cap: the org may hold at most {} credits (this would make it {})",
            pool_centi / 100,
            orgtree_funding_core::fmt::py_g(funding::centi_to_py(held_centi), true)
        ),
    )
}

fn priced(seats: &Value, prices: &BTreeMap<String, i64>) -> i64 {
    seats.as_object().map_or(0, |m| m.iter().map(|(t, n)| n.as_i64().unwrap_or(0) * prices.get(t).copied().unwrap_or(0)).sum())
}

/// Apply: the inflations (WS4 `apply`: edges, their payers' capacity rows,
/// the kiosk pool if a top-level grant rose), then the new seat's payer
/// (P2), or at the top level the kiosk pool (E8, last).
pub async fn apply<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, parent: Option<Uuid>, tier: &str, f: &Funded) -> Result<Result<(), Refusal>, CmdError> {
    if let Some((l, plan)) = &f.inner {
        if let Err(r) = funding::apply(tx, org, l, plan).await? {
            return Ok(Err(r));
        }
    }
    let lock_only = controls::fire(&tx.scope(), "Q-C8.lock_not_update");
    match parent {
        Some(p) => {
            if !lock_only {
                tx.exec("staffing.payer_add", PAYER_ADD_SQL, &[Val::Uuid(org), Val::Uuid(p), Val::Int(f.grant_centi), Val::text(tier)]).await?;
            }
        }
        None if f.top_level => {
            let rows = tx.exec("funding.kiosk_lock", funding::KIOSK_LOCK_SQL, &[Val::Uuid(org)]).await?;
            if let Some(r) = rows.first() {
                let pool = r.first().and_then(Val::as_int).unwrap_or(0);
                let grants = r.get(1).and_then(Val::as_int).unwrap_or(0) + f.grant_centi;
                let mut seats = r.get(2).and_then(Val::as_json).cloned().unwrap_or(Value::Null);
                if let Some(m) = seats.as_object_mut() {
                    let n = m.get(tier).and_then(Value::as_i64).unwrap_or(0) + 1;
                    m.insert(tier.to_string(), Value::from(n));
                }
                let held = grants + priced(&seats, &f.prices);
                if pool > 0 && held > pool {
                    return Ok(Err(kiosk_refusal(pool, held)));
                }
                tx.exec("staffing.kiosk_add", KIOSK_ADD_SEAT_SQL, &[Val::Uuid(org), Val::Int(f.grant_centi), Val::text(tier)]).await?;
            }
        }
        None => {}
    }
    Ok(Ok(()))
}
