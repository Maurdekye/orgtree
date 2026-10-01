//! A pure, non-authoritative Rust planner for the legacy credit-funding
//! rules of the Python ledger (`engine/backend/orgtree/ledger.py`).
//!
//! Given a synthetic snapshot of an organization (node parents, states,
//! tiers, grants and sort keys; tier prices; the `max_top_grant`,
//! `cascade_hire` and `cascade_alloc` settings), it answers what the Python
//! ledger would do for the funding step of `hire`, `rehire` and
//! `reallocate`, and for `committed`, `free` and `_chain_acquire`: either
//! Python's refusal, classified, or a plan of grant changes, chain
//! contributions, the USER-pool remainder, stranded dependents and the
//! warnings and notices Python produces, together with the nodes, fields,
//! tiers and settings the Python code actually read and wrote.
//!
//! It mutates nothing it is given, emits no events or notices, mints no
//! identities, writes no SQL and opens no connections. It is NOT the
//! authoritative runtime and makes no transaction or locking claim: the read
//! set it reports is what Python touched, which for every step that asks
//! `children()` includes a scan of the whole node table. See the README for
//! the parity domain and the exclusions.

pub mod fmt;
pub mod ledger;
pub mod pynum;
pub mod snapshot;
pub mod vectors;

use ledger::{Acquisition, Fail, GrantEvent, Ledger, StrandCall, Stranded, Trace};
use pynum::PyNum;
use snapshot::Snapshot;
use std::collections::BTreeSet;

pub use ledger::{Refusal, RefusalKind, Rules, SYSTEM, USER};
pub use pynum::Outside;

/// What the Python code touched, grouped. Derived from the raw read and
/// write keys; `whole_table_scan` is true whenever `children()` ran, which
/// means every node's `parent` field was read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Participants {
    pub whole_table_scan: bool,
    pub nodes_read: BTreeSet<String>,
    pub nodes_written: BTreeSet<String>,
    pub tiers_read: BTreeSet<String>,
    pub settings_read: BTreeSet<String>,
}

impl Participants {
    pub fn of(trace: &Trace) -> Participants {
        let mut p = Participants::default();
        for r in &trace.reads {
            if r == "scan" {
                p.whole_table_scan = true;
            } else if let Some(x) = r.strip_prefix("n:") {
                p.nodes_read.insert(x.to_owned());
            } else if let Some(x) = r.strip_prefix("f:") {
                if let Some((id, _)) = x.rsplit_once(':') {
                    p.nodes_read.insert(id.to_owned());
                }
            } else if let Some(x) = r.strip_prefix("t:") {
                p.tiers_read.insert(x.to_owned());
            } else if let Some(x) = r.strip_prefix("d:") {
                p.settings_read.insert(x.to_owned());
            }
        }
        for w in &trace.writes {
            if let Some(x) = w.strip_prefix("w:") {
                if let Some((id, _)) = x.rsplit_once(':') {
                    p.nodes_written.insert(id.to_owned());
                }
            }
        }
        p
    }
}

/// The answer for one funding step.
#[derive(Clone, Debug)]
pub struct Outcome<T> {
    /// Python's value, or its refusal, or `Outside`.
    pub result: Result<T, Fail>,
    /// Every existing node whose stored grant differs afterwards (value or
    /// int/float kind), in document order, with its new value. On a refusal
    /// this is what Python had already changed in memory before raising.
    pub grants_changed: Vec<(String, PyNum)>,
    /// Every existing node whose state differs afterwards, in document
    /// order, with its new state (rehire makes archived nodes live).
    pub states_changed: Vec<(String, String)>,
    /// Each `_chain_acquire` call with its chain, contributions, USER-pool
    /// remainder and inflations.
    pub acquisitions: Vec<Acquisition>,
    pub stranded: Vec<Stranded>,
    pub strand_calls: Vec<StrandCall>,
    /// Warnings produced inside chain acquisitions.
    pub acquire_warnings: Vec<String>,
    /// Passive notices Python would send (recipients, text). Not sent.
    pub notices: Vec<(Vec<String>, String)>,
    /// `access.grant_changed` events reallocate would mint. Not minted.
    pub events: Vec<GrantEvent>,
    /// Event-log rows Python would append (op, warnings). Not written.
    pub logs: Vec<(String, Vec<String>)>,
    /// Nodes made live, with their grants (rehire only).
    pub rehired: Vec<(String, PyNum)>,
    /// Raw read and write keys in the oracle's notation.
    pub reads: BTreeSet<String>,
    pub writes: BTreeSet<String>,
    pub participants: Participants,
}

fn finish<T>(snap: &Snapshot, lg: Ledger<'_>, result: Result<T, Fail>) -> Outcome<T> {
    let mut grants_changed = Vec::new();
    let mut states_changed = Vec::new();
    for n in &snap.nodes {
        if let Some(after) = lg.nodes.iter().find(|x| x.id == n.id) {
            if !after.grant.identical(n.grant) {
                grants_changed.push((n.id.clone(), after.grant));
            }
            if after.state != n.state {
                states_changed.push((n.id.clone(), after.state.clone()));
            }
        }
    }
    let participants = Participants::of(&lg.trace);
    let t = lg.trace;
    Outcome {
        result,
        grants_changed,
        states_changed,
        acquisitions: t.acquisitions,
        stranded: t.stranded,
        strand_calls: t.strand,
        acquire_warnings: t.acquire_warnings,
        notices: t.notices,
        events: t.events,
        logs: t.logs,
        rehired: t.rehired,
        reads: t.reads,
        writes: t.writes,
        participants,
    }
}

/// `Org.committed(nid)`.
pub fn committed(snap: &Snapshot, nid: &str, rules: &Rules) -> Outcome<PyNum> {
    let mut lg = Ledger::new(snap, rules, true);
    let r = lg.committed(nid);
    finish(snap, lg, r)
}

/// `Org.free(nid)`.
pub fn free(snap: &Snapshot, nid: &str, rules: &Rules) -> Outcome<PyNum> {
    let mut lg = Ledger::new(snap, rules, true);
    let r = lg.free(nid);
    finish(snap, lg, r)
}

/// `Org._chain_acquire(actor, payer, need, warnings, cascade=cascade)`.
/// The value is the warnings list it filled.
pub fn chain_acquire(
    snap: &Snapshot,
    actor: &str,
    payer: &str,
    need: PyNum,
    cascade: bool,
    rules: &Rules,
) -> Outcome<Vec<String>> {
    let mut lg = Ledger::new(snap, rules, true);
    let mut warnings = Vec::new();
    let r = lg
        .chain_acquire(actor, payer, need, &mut warnings, cascade)
        .map(|()| warnings);
    finish(snap, lg, r)
}

/// `Org.reallocate(actor, nid, delta)`: the new grant and the returned
/// warnings.
pub fn reallocate(
    snap: &Snapshot,
    actor: &str,
    nid: &str,
    delta: PyNum,
    rules: &Rules,
) -> Outcome<(PyNum, Vec<String>)> {
    let mut lg = Ledger::new(snap, rules, true);
    let r = lg.reallocate(actor, nid, delta);
    finish(snap, lg, r)
}

/// The funding step of `Org.hire(actor, parent, tier, grant, ...)`: the new
/// node's grant. Reads and writes are those of the whole Python call except
/// the non-funding helpers, fields and settings the README lists under "Hire
/// and rehire read sets" (scopes, tools, dirs, visibility, caps on depth and
/// width, the tier ceiling, the Fable lock, and the new node itself).
pub fn hire(
    snap: &Snapshot,
    actor: &str,
    parent: Option<&str>,
    tier: &str,
    grant: PyNum,
    rules: &Rules,
) -> Outcome<PyNum> {
    let mut lg = Ledger::new(snap, rules, rules.whole_step_reads);
    let r = lg.hire(actor, parent, tier, grant);
    finish(snap, lg, r)
}

/// The funding step of `Org.rehire(actor, nid, grant)`: `None` when the node
/// is already live (Python's no-op), else the grant it is rehired at. Reads
/// and writes cover the whole call, including the rehire of archived
/// superiors and the `state`/`grant` writes that make nodes live, with the
/// same listed exclusions as [`hire`].
pub fn rehire(
    snap: &Snapshot,
    actor: &str,
    nid: &str,
    grant: Option<PyNum>,
    rules: &Rules,
) -> Outcome<Option<PyNum>> {
    let mut lg = Ledger::new(snap, rules, rules.whole_step_reads);
    let r = lg.rehire(actor, nid, grant);
    if r.is_err() && !rules.partial_effects {
        lg.nodes = snap.nodes.clone();
    }
    finish(snap, lg, r)
}
