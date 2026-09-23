//! The funding rules of `orgtree.ledger.Org`, evaluated on a private copy of
//! a [`Snapshot`].
//!
//! Each function here is a line-by-line port of the Python method of the
//! same name, in the same evaluation order, over the same Python number
//! semantics ([`PyNum`]). Nothing is written back to the caller's snapshot:
//! the evaluator mutates its own copy exactly as Python mutates its document,
//! so a later step sees what Python's later step saw, and the plan is read
//! off the difference.
//!
//! While recording is on, every access Python makes to the node table, a
//! node field, the tier table or a document setting is logged with the same
//! key the oracle's recording dictionaries use (`scan`, `n:<id>`,
//! `f:<id>:<field>`, `t:<tier>`, `d:<key>`, `w:<id>:<field>`). That is the
//! honest read set of the Python code, not a lock set.

use crate::fmt::{py_g, py_repr_str};
use crate::pynum::{py_sum, q_with, Outside, PyNum, Round2, SumModel, R};
use crate::snapshot::{Node, Setting, Snapshot};
use std::cmp::Ordering;
use std::collections::BTreeSet;

pub const USER: &str = "@user";
pub const SYSTEM: &str = "@system";

/// Which rules to apply. [`Rules::LEGACY`] is the Python ledger; every other
/// setting is a deliberate mistake used only as a negative control.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub round: Round2,
    pub sum: SumModel,
    /// `format(x, 'g')` rounds exact ties to even (CPython).
    pub fmt_half_even: bool,
    /// `children()` sorts by `(ui_order, created)`.
    pub sort_children: bool,
    /// Contributions are taken payer-first, walking up.
    pub local_first: bool,
    /// USER-actor cascades round every inflated grant up to a whole credit,
    /// carrying the rounding upward.
    pub user_carry: bool,
    /// Stranding compares the pre-inflation snapshot with snapshot minus the
    /// contribution, rather than re-reading free after the writes.
    pub strand_from_snapshot: bool,
    /// The D-014 top-grant check runs inside the chain acquisition.
    pub acquire_cap_check: bool,
    /// The D-014 check refuses only a grant strictly above the cap.
    pub cap_strictly_above: bool,
    /// `reallocate` snaps its target grant up to a whole credit.
    pub snap_up: bool,
    /// Stranding counts a cost equal to the old free as affordable before.
    pub strand_upper_inclusive: bool,
    /// The `cascade_hire` / `cascade_alloc` settings are honoured.
    pub honor_cascade: bool,
    /// `children()` reports what Python reads: a whole-table scan and every
    /// node's `parent`. `false` records only the matching children, the
    /// narrower set a future lock design might want; it is a control.
    pub whole_scan_reads: bool,
    /// A rehire refused part-way keeps what Python had already changed in
    /// memory (superiors made live, grants inflated). `false` rolls it back,
    /// i.e. pretends the step is atomic; it is a control.
    pub partial_effects: bool,
}

impl Rules {
    pub const LEGACY: Rules = Rules {
        round: Round2::HalfEven,
        sum: SumModel::CPYTHON_313_WIN64,
        fmt_half_even: true,
        sort_children: true,
        local_first: true,
        user_carry: true,
        strand_from_snapshot: true,
        acquire_cap_check: true,
        cap_strictly_above: true,
        snap_up: true,
        strand_upper_inclusive: true,
        honor_cascade: true,
        whole_scan_reads: true,
        partial_effects: true,
    };
}

/// The exception Python raised.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PyExc {
    LedgerError,
    KeyError,
}

impl PyExc {
    pub fn as_str(self) -> &'static str {
        match self {
            PyExc::LedgerError => "LedgerError",
            PyExc::KeyError => "KeyError",
        }
    }
}

/// Why Python refused, classified. The message is Python's own text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalKind {
    /// `node()` of a missing id.
    NoSuchNode,
    /// A raw `nodes[id]` of a missing id (a dangling parent): `KeyError`.
    DanglingReference,
    /// A node's tier has no price: `KeyError` from the tier table.
    UnknownTierPrice,
    UnknownActor,
    NoAuthority,
    NotLive,
    NotOnChain,
    ChainShort,
    CascadeDisabledShort,
    TopGrantCap,
    ReductionExceedsFree,
    BadHireGrant,
    TopLevelHireByAgent,
    HireOutsideSubtree,
    LostGeneration,
    UnrecoverableAbove,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub kind: RefusalKind,
    pub exc: PyExc,
    pub message: String,
}

/// A step either refused the way Python refuses, or is outside the parity
/// domain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fail {
    Refused(Refusal),
    Outside(Outside),
}

impl From<Outside> for Fail {
    fn from(o: Outside) -> Fail {
        Fail::Outside(o)
    }
}

pub type F<T> = Result<T, Fail>;

fn refuse<T>(kind: RefusalKind, message: String) -> F<T> {
    Err(Fail::Refused(Refusal {
        kind,
        exc: PyExc::LedgerError,
        message,
    }))
}

fn key_error<T>(kind: RefusalKind, key: &str) -> F<T> {
    Err(Fail::Refused(Refusal {
        kind,
        exc: PyExc::KeyError,
        message: py_repr_str(key)?,
    }))
}

/// One contribution to a chain acquisition: `amount` of `node`'s free
/// credits, `hop` steps above the payer.
#[derive(Clone, Debug)]
pub struct Contribution {
    pub hop: usize,
    pub node: String,
    pub amount: PyNum,
}

/// One `_chain_acquire` call and what it decided.
#[derive(Clone, Debug)]
pub struct Acquisition {
    pub actor: String,
    pub payer: String,
    pub need: PyNum,
    pub cascade: bool,
    /// The payer and every node walked above it (empty when nothing was
    /// needed or bubbling is off).
    pub chain: Vec<String>,
    pub contributions: Vec<Contribution>,
    /// What the USER pool supplied beyond the chain (USER actor only).
    pub user_pool: Option<PyNum>,
    /// Grant increases in application order (after any whole-credit carry).
    pub inflations: Vec<(String, PyNum)>,
}

/// One `_stranding_warnings` call, as the oracle records it.
#[derive(Clone, Debug)]
pub struct StrandCall {
    pub payer: String,
    pub before: PyNum,
    pub after: PyNum,
    pub warnings: Vec<String>,
}

/// An archived dependent that could be rehired before and cannot now.
#[derive(Clone, Debug)]
pub struct Stranded {
    pub payer: String,
    pub node: String,
    pub predecessor: bool,
    pub cost: PyNum,
    pub free_after: PyNum,
}

/// An `access.grant_changed` event as reallocate mints it.
#[derive(Clone, Debug)]
pub struct GrantEvent {
    pub to: Vec<Option<String>>,
    pub relation: &'static str,
    pub node: String,
    pub delta: f64,
    pub now: f64,
    pub free: f64,
    pub by: String,
}

/// Everything observed while evaluating, apart from the grants themselves.
#[derive(Clone, Debug, Default)]
pub struct Trace {
    pub reads: BTreeSet<String>,
    pub writes: BTreeSet<String>,
    pub notices: Vec<(Vec<String>, String)>,
    pub strand: Vec<StrandCall>,
    pub stranded: Vec<Stranded>,
    pub events: Vec<GrantEvent>,
    pub logs: Vec<(String, Vec<String>)>,
    pub acquisitions: Vec<Acquisition>,
    /// Warnings produced inside chain acquisitions, in order.
    pub acquire_warnings: Vec<String>,
    /// Nodes rehired (made live), in order, with the grant they got: the
    /// target and any archived superiors rehired before it.
    pub rehired: Vec<(String, PyNum)>,
}

pub struct Ledger<'r> {
    rules: &'r Rules,
    pub nodes: Vec<Node>,
    tiers: Vec<(String, PyNum)>,
    settings: Vec<(String, Setting)>,
    rec: bool,
    pub trace: Trace,
}

impl<'r> Ledger<'r> {
    /// A private working copy. `record` starts the recorder on (whole-call
    /// recording) or off (hire/rehire, where only the funding window is
    /// recorded).
    pub fn new(snap: &Snapshot, rules: &'r Rules, record: bool) -> Ledger<'r> {
        Ledger {
            rules,
            nodes: snap.nodes.clone(),
            tiers: snap.tiers.clone(),
            settings: snap.settings.clone(),
            rec: record,
            trace: Trace::default(),
        }
    }

    // ------------------------------------------------------------ recording
    fn note(&mut self, key: impl FnOnce() -> String) {
        if self.rec {
            self.trace.reads.insert(key());
        }
    }

    fn g(&self, x: PyNum) -> String {
        py_g(x, self.rules.fmt_half_even)
    }

    fn q(&self, x: PyNum) -> R<PyNum> {
        q_with(x, self.rules.round)
    }

    fn find(&self, id: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.id == id)
    }

    /// `id in self.nodes` / `self.nodes.get(id)`.
    fn has(&mut self, id: &str) -> Option<usize> {
        self.note(|| format!("n:{id}"));
        self.find(id)
    }

    /// `self.nodes[id]`: a miss is a `KeyError`.
    fn raw(&mut self, id: &str) -> F<usize> {
        match self.has(id) {
            Some(i) => Ok(i),
            None => key_error(RefusalKind::DanglingReference, id),
        }
    }

    /// `self.node(id)`: a miss is a `LedgerError`.
    fn node(&mut self, id: &str) -> F<usize> {
        match self.has(id) {
            Some(i) => Ok(i),
            None => refuse(
                RefusalKind::NoSuchNode,
                format!("no such node: {}", py_repr_str(id)?),
            ),
        }
    }

    fn field(&mut self, i: usize, f: &str) {
        let id = &self.nodes[i].id;
        if self.rec {
            self.trace.reads.insert(format!("f:{id}:{f}"));
        }
    }

    fn parent_of(&mut self, i: usize) -> Option<String> {
        self.field(i, "parent");
        self.nodes[i].parent.clone()
    }

    fn state_of(&mut self, i: usize) -> String {
        self.field(i, "state");
        self.nodes[i].state.clone()
    }

    fn grant_of(&mut self, i: usize) -> PyNum {
        self.field(i, "grant");
        self.nodes[i].grant
    }

    fn set_grant(&mut self, i: usize, v: PyNum) {
        if self.rec {
            let id = &self.nodes[i].id;
            self.trace.writes.insert(format!("w:{id}:grant"));
        }
        self.nodes[i].grant = v;
    }

    fn tier_price(&mut self, model: &str) -> F<PyNum> {
        self.note(|| format!("t:{model}"));
        match self.tiers.iter().find(|(t, _)| t == model) {
            Some((_, p)) => Ok(*p),
            None => key_error(RefusalKind::UnknownTierPrice, model),
        }
    }

    pub fn tier_known(&mut self, tier: &str) -> bool {
        self.note(|| format!("t:{tier}"));
        self.tiers.iter().any(|(t, _)| t == tier)
    }

    fn setting(&mut self, key: &str) -> Option<Setting> {
        self.note(|| format!("d:{key}"));
        self.settings
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    /// Run `f` with recording on, restoring the previous state (the oracle's
    /// `windowed`).
    fn windowed<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
        let prev = self.rec;
        self.rec = true;
        let out = f(self);
        self.rec = prev;
        out
    }

    // -------------------------------------------------------------- queries
    /// `seat_cost(nid)`: `self.d["tiers"][self.node(nid)["model"]]`.
    fn seat_cost(&mut self, id: &str) -> F<PyNum> {
        let i = self.node(id)?;
        self.field(i, "model");
        let model = self.nodes[i].model.clone();
        self.tier_price(&model)
    }

    /// `children(nid, live_only)`: scan the whole table for the parent,
    /// filter archived (when `live_only`), sort by `(ui_order, created)`.
    pub fn children(&mut self, nid: Option<&str>, live_only: bool) -> F<Vec<String>> {
        let wide = self.rules.whole_scan_reads;
        if wide {
            self.note(|| "scan".to_owned());
        }
        let mut cand = Vec::new();
        for i in 0..self.nodes.len() {
            let hit = self.nodes[i].parent.as_deref() == nid;
            if wide || hit {
                self.field(i, "parent");
            }
            if hit {
                cand.push(self.nodes[i].id.clone());
            }
        }
        let mut kids = Vec::new();
        for k in cand {
            let i = self.raw(&k)?;
            if self.state_of(i) != "archived" || !live_only {
                kids.push(k);
            }
        }
        // list.sort(key=...) calls the key once per element, even for one.
        let mut keyed = Vec::with_capacity(kids.len());
        for k in kids {
            let i = self.raw(&k)?;
            self.field(i, "ui_order");
            let ui = self.nodes[i].ui_order.unwrap_or(PyNum::Int(0));
            let i = self.raw(&k)?;
            self.field(i, "created");
            keyed.push((ui, self.nodes[i].created.clone(), k));
        }
        if self.rules.sort_children {
            let mut bad = false;
            keyed.sort_by(|a, b| match a.0.cmp_py(b.0) {
                Some(Ordering::Equal) => a.1.cmp(&b.1),
                Some(o) => o,
                None => {
                    bad = true;
                    Ordering::Equal
                }
            });
            if bad {
                return Err(Outside("unorderable children() sort key").into());
            }
        }
        Ok(keyed.into_iter().map(|(_, _, k)| k).collect())
    }

    /// `committed(nid)`: `_q(sum(seat_cost(c) + nodes[c]["grant"] for c in
    /// children(nid)))`.
    pub fn committed(&mut self, nid: &str) -> F<PyNum> {
        let kids = self.children(Some(nid), true)?;
        let mut items = Vec::with_capacity(kids.len());
        for c in kids {
            let seat = self.seat_cost(&c)?;
            let i = self.raw(&c)?;
            let g = self.grant_of(i);
            items.push(seat.py_add(g)?);
        }
        Ok(self.q(py_sum(&items, self.rules.sum)?)?)
    }

    /// `free(nid)`: infinite for USER, else `_q(grant - committed)`.
    pub fn free(&mut self, nid: &str) -> F<PyNum> {
        if nid == USER {
            return Ok(PyNum::Float(f64::INFINITY));
        }
        let i = self.node(nid)?;
        let g = self.grant_of(i);
        let c = self.committed(nid)?;
        Ok(self.q(g.py_sub(c)?)?)
    }

    /// `ancestors(nid)`: parent chain up to USER, stopping at a repeat.
    fn ancestors(&mut self, nid: &str) -> F<Vec<String>> {
        if nid == USER {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut seen = vec![nid.to_owned()];
        let i = self.node(nid)?;
        let mut cur = self.parent_of(i);
        while let Some(c) = cur {
            if seen.contains(&c) {
                break;
            }
            out.push(c.clone());
            seen.push(c.clone());
            let j = self.raw(&c)?;
            cur = self.parent_of(j);
        }
        out.push(USER.to_owned());
        Ok(out)
    }

    fn is_ancestor(&mut self, a: &str, nid: &str) -> F<bool> {
        if nid == USER {
            return Ok(false);
        }
        if a == USER {
            return Ok(true);
        }
        Ok(self.ancestors(nid)?.iter().any(|x| x == a))
    }

    fn require_authority(&mut self, actor: &str, nid: &str) -> F<()> {
        if actor == USER || actor == SYSTEM {
            return Ok(());
        }
        if self.has(actor).is_none() {
            return refuse(
                RefusalKind::UnknownActor,
                format!("unknown actor: {}", py_repr_str(actor)?),
            );
        }
        if !self.is_ancestor(actor, nid)? {
            return refuse(
                RefusalKind::NoAuthority,
                format!("{actor} has no authority over {nid} \u{2014} authority is downward only (\u{a7}7.1)"),
            );
        }
        Ok(())
    }

    fn require_live(&mut self, nid: &str) -> F<()> {
        let i = self.node(nid)?;
        if self.state_of(i) != "live" {
            let i = self.node(nid)?;
            let st = self.state_of(i);
            return refuse(RefusalKind::NotLive, format!("{nid} is {st}, not live"));
        }
        Ok(())
    }

    /// `_check_top_grant`: `int(self.d.get("max_top_grant") or 0)`; refuse a
    /// grant strictly above a nonzero cap.
    fn check_top_grant(&mut self, new_grant: PyNum, ctx: &str) -> F<()> {
        let cap: i128 = match self.setting("max_top_grant") {
            None | Some(Setting::Null) => 0,
            Some(Setting::Bool(b)) => i128::from(b),
            Some(Setting::Num(n)) if !n.truthy() => 0,
            Some(Setting::Num(n)) => n.trunc_int()?,
            Some(Setting::Str(s)) if s.is_empty() => 0,
            Some(Setting::Str(_)) => return Err(Outside("int() of a string max_top_grant").into()),
        };
        let over = if self.rules.cap_strictly_above {
            new_grant.gt(PyNum::Int(cap))?
        } else {
            new_grant.ge(PyNum::Int(cap))?
        };
        if cap != 0 && over {
            return refuse(
                RefusalKind::TopGrantCap,
                format!(
                    "{ctx} would put a top-level grant at {}, past the org's top-level grant cap of {cap} \u{2014} raise the cap in the org settings, or lower the ask",
                    self.g(new_grant)
                ),
            );
        }
        Ok(())
    }

    fn cascade_setting(&mut self, key: &str) -> bool {
        let v = self.setting(key);
        if !self.rules.honor_cascade {
            return true;
        }
        match v {
            None => true,
            Some(s) => s.truthy(),
        }
    }

    // ------------------------------------------------------------ stranding
    /// `_stranding_warnings(payer, free_before, free_after, actor=actor)`.
    fn stranding(
        &mut self,
        payer: &str,
        before: PyNum,
        after: PyNum,
        actor: &str,
    ) -> F<Vec<String>> {
        let mut warns = Vec::new();
        if !(payer == USER || after.ge(before)?) {
            for c in self.children(Some(payer), false)? {
                let i = self.raw(&c)?;
                if self.state_of(i) != "archived" {
                    continue;
                }
                let seat = self.seat_cost(&c)?;
                let g = self.grant_of(i);
                let cost = self.q(seat.py_add(g)?)?;
                let upper = if self.rules.strand_upper_inclusive {
                    cost.le(before)?
                } else {
                    cost.lt(before)?
                };
                if after.lt(cost)? && upper {
                    self.field(i, "bearer_state");
                    let pred = self.nodes[i]
                        .bearer_state
                        .as_deref()
                        .is_some_and(|s| !s.is_empty());
                    let kind = if pred { "predecessor" } else { "report" };
                    warns.push(format!(
                        "{payer} can no longer afford to rehire archived {kind} {c} (needs {}, free now {}) \u{2014} stranded (\u{a7}4.4)",
                        self.g(cost),
                        self.g(after)
                    ));
                    self.trace.stranded.push(Stranded {
                        payer: payer.to_owned(),
                        node: c.clone(),
                        predecessor: pred,
                        cost,
                        free_after: after,
                    });
                }
            }
            if !warns.is_empty() && actor != payer {
                if let Some(p) = self.has(payer) {
                    if self.state_of(p) == "live" {
                        let lead = if warns.len() > 1 {
                            "some of your archived reports: "
                        } else {
                            "an archived report: "
                        };
                        let body: Vec<&str> = warns
                            .iter()
                            .map(|w| w.split(" \u{2014} stranded").next().unwrap_or(w))
                            .collect();
                        self.trace.notices.push((
                            vec![payer.to_owned()],
                            format!(
                                "Your free credits dropped and you can no longer afford to rehire {lead}{}. Reallocate more credits to yourself (or ask your superior) if you need to bring them back.",
                                body.join("; ")
                            ),
                        ));
                    }
                }
            }
        }
        self.trace.strand.push(StrandCall {
            payer: payer.to_owned(),
            before,
            after,
            warnings: warns.clone(),
        });
        Ok(warns)
    }

    // -------------------------------------------------------- chain acquire
    /// `_chain_acquire(actor, payer, need, warnings, cascade=cascade)`.
    pub fn chain_acquire(
        &mut self,
        actor: &str,
        payer: &str,
        need: PyNum,
        warnings: &mut Vec<String>,
        cascade: bool,
    ) -> F<()> {
        let mut acq = Acquisition {
            actor: actor.to_owned(),
            payer: payer.to_owned(),
            need,
            cascade,
            chain: Vec::new(),
            contributions: Vec::new(),
            user_pool: None,
            inflations: Vec::new(),
        };
        let n0 = warnings.len();
        let r = self.chain_acquire_inner(&mut acq, warnings);
        self.trace
            .acquire_warnings
            .extend(warnings[n0..].iter().cloned());
        self.trace.acquisitions.push(acq);
        r
    }

    fn chain_acquire_inner(&mut self, acq: &mut Acquisition, warnings: &mut Vec<String>) -> F<()> {
        let (actor, payer, need) = (acq.actor.clone(), acq.payer.clone(), acq.need);
        if need.le(PyNum::Int(0))? {
            return Ok(());
        }
        if !acq.cascade {
            let free = self.free(&payer)?;
            if free.lt(need)? {
                return refuse(
                    RefusalKind::CascadeDisabledShort,
                    format!(
                        "{payer} has only {} free of the {} needed, and cost-bubbling is disabled for this action (org setting) \u{2014} free credits on {payer} first, or re-enable bubbling in the org settings",
                        self.g(free),
                        self.g(need)
                    ),
                );
            }
            return Ok(());
        }
        let mut chain = vec![payer.clone()];
        while chain.last().map(String::as_str) != Some(actor.as_str()) {
            let last = chain.last().cloned().unwrap_or_default();
            let i = self.node(&last)?;
            match self.parent_of(i) {
                None => {
                    if actor != USER {
                        return refuse(
                            RefusalKind::NotOnChain,
                            format!("{actor} is not on {payer}'s chain"),
                        );
                    }
                    break;
                }
                Some(p) => {
                    if p != actor && chain.contains(&p) {
                        return Err(Outside(
                            "parent cycle: Python's chain walk does not terminate",
                        )
                        .into());
                    }
                    chain.push(p);
                }
            }
        }
        acq.chain = chain.clone();
        let mut frees = Vec::with_capacity(chain.len());
        for k in &chain {
            frees.push(self.free(k)?);
        }
        let mut remaining = need;
        let mut contrib: Vec<(usize, String, PyNum)> = Vec::new();
        let order: Vec<usize> = if self.rules.local_first {
            (0..chain.len()).collect()
        } else {
            (0..chain.len()).rev().collect()
        };
        for i in order {
            if remaining.le(PyNum::Int(0))? {
                break;
            }
            let c = frees[i].py_min(remaining)?;
            if c.gt(PyNum::Int(0))? {
                contrib.push((i, chain[i].clone(), c));
                remaining = remaining.py_sub(c)?;
            }
        }
        acq.contributions = contrib
            .iter()
            .map(|(i, k, c)| Contribution {
                hop: *i,
                node: k.clone(),
                amount: *c,
            })
            .collect();
        if remaining.gt(PyNum::Int(0))? && actor != USER {
            let got = need.py_sub(remaining)?;
            return refuse(
                RefusalKind::ChainShort,
                format!(
                    "not enough free credits on the chain: {} needed, only {} free between {payer} and {actor} (\u{a7}4.6)",
                    self.g(need),
                    self.g(got)
                ),
            );
        }
        // D-014 pre-check input: the planned inflation per node, in the
        // insertion order of Python's dict.
        let mut adds: Vec<(String, PyNum)> = Vec::new();
        fn bump(adds: &mut Vec<(String, PyNum)>, k: &str, dflt: PyNum, v: PyNum) -> R<()> {
            match adds.iter_mut().find(|(x, _)| x == k) {
                Some(e) => e.1 = e.1.py_add(v)?,
                None => adds.push((k.to_owned(), dflt.py_add(v)?)),
            }
            Ok(())
        }
        for (i, _, c) in &contrib {
            for k in &chain[..*i] {
                bump(&mut adds, k, PyNum::Int(0), *c)?;
            }
        }
        if remaining.gt(PyNum::Int(0))? {
            acq.user_pool = Some(remaining);
            for k in &chain {
                bump(&mut adds, k, PyNum::Int(0), remaining)?;
            }
        }
        if actor == USER && self.rules.user_carry {
            let mut carry = PyNum::Float(0.0);
            for k in &chain {
                let have = adds
                    .iter()
                    .find(|(x, _)| x == k)
                    .map(|e| e.1)
                    .unwrap_or(PyNum::Float(0.0));
                let want = self.q(have.py_add(carry)?)?;
                if want.le(PyNum::Int(0))? {
                    carry = PyNum::Float(0.0);
                    continue;
                }
                let i = self.raw(k)?;
                let g = self.grant_of(i);
                let whole = self.q(self.q(g.py_add(want)?)?.ceil()?.py_sub(g)?)?;
                carry = self.q(whole.py_sub(want)?)?;
                match adds.iter_mut().find(|(x, _)| x == k) {
                    Some(e) => e.1 = whole,
                    None => adds.push((k.clone(), whole)),
                }
            }
        }
        if self.rules.acquire_cap_check {
            for (k, extra) in adds.clone() {
                let i = self.raw(&k)?;
                if self.parent_of(i).is_none() {
                    let i = self.raw(&k)?;
                    let g = self.grant_of(i);
                    self.windowed(|s| {
                        s.check_top_grant(g.py_add(extra)?, "carrying these credits down the chain")
                    })?;
                }
            }
        }
        for (k, extra) in &adds {
            let i = self.raw(k)?;
            let g = self.grant_of(i);
            let v = self.q(g.py_add(*extra)?)?;
            self.set_grant(i, v);
        }
        acq.inflations = adds;
        for (i, k, c) in &contrib {
            let after = if self.rules.strand_from_snapshot {
                frees[*i].py_sub(*c)?
            } else {
                self.free(k)?
            };
            let w = self.stranding(k, frees[*i], after, &actor)?;
            warnings.extend(w);
            if *i > 0 {
                warnings.push(format!(
                    "\u{a7}4.6: {} credit(s) bubbled up to {k}; grants below it were inflated to carry them down \u{2014} reclaim with reallocate",
                    self.g(*c)
                ));
            }
        }
        if remaining.gt(PyNum::Int(0))? {
            warnings.push(format!(
                "\u{a7}4.6: {} credit(s) drawn from your pool \u{2014} the chain's grants inflated to carry them down; reclaim with reallocate when done",
                self.g(remaining)
            ));
        }
        Ok(())
    }

    /// The oracle's funding window around `_chain_acquire` for hire and
    /// rehire: recorded, whatever the surrounding state.
    fn acquire_windowed(
        &mut self,
        actor: &str,
        payer: &str,
        need: PyNum,
        warnings: &mut Vec<String>,
        cascade: bool,
    ) -> F<()> {
        self.windowed(|s| s.chain_acquire(actor, payer, need, warnings, cascade))
    }

    // ------------------------------------------------------------ reallocate
    /// `reallocate(actor, nid, delta)`: returns the new grant and warnings.
    pub fn reallocate(&mut self, actor: &str, nid: &str, delta: PyNum) -> F<(PyNum, Vec<String>)> {
        self.require_authority(actor, nid)?;
        self.require_live(nid)?;
        let i = self.node(nid)?;
        let mut delta = self.q(delta)?;
        if self.rules.snap_up {
            let g = self.grant_of(i);
            let snapped = self.q(g.py_add(delta)?)?.ceil()?;
            let g = self.grant_of(i);
            delta = self.q(snapped.py_sub(g)?)?;
        }
        let mut warnings = Vec::new();
        let mut strand = Vec::new();
        if delta.gt(PyNum::Int(0))? {
            match self.parent_of(i) {
                None => {
                    let g = self.grant_of(i);
                    self.check_top_grant(g.py_add(delta)?, "this allocation")?;
                }
                Some(p) => {
                    let cascade = self.cascade_setting("cascade_alloc");
                    self.chain_acquire(actor, &p, delta, &mut warnings, cascade)?;
                }
            }
        } else if delta.lt(PyNum::Int(0))? {
            let neg = delta.py_neg()?;
            if self.free(nid)?.lt(neg)? {
                let f = self.free(nid)?;
                return refuse(
                    RefusalKind::ReductionExceedsFree,
                    format!("{nid} has only {} unused; the rest is committed", self.g(f)),
                );
            }
            let before = self.free(nid)?;
            let after = self.free(nid)?.py_add(delta)?;
            strand = self.stranding(nid, before, after, actor)?;
        }
        let g = self.grant_of(i);
        let v = self.q(g.py_add(delta)?)?;
        self.set_grant(i, v);
        if !delta.eq_py(PyNum::Int(0)) {
            let fr = self.free(nid)?;
            let now = self.grant_of(i);
            let to_self: Vec<Option<String>> = [nid]
                .iter()
                .filter(|x| **x != actor)
                .map(|x| Some((*x).to_owned()))
                .collect();
            self.trace.events.push(GrantEvent {
                to: to_self,
                relation: "self",
                node: nid.to_owned(),
                delta: delta.to_f64(),
                now: now.to_f64(),
                free: fr.to_f64(),
                by: actor.to_owned(),
            });
            let parent = self.parent_of(i);
            let now = self.grant_of(i);
            let to_parent: Vec<Option<String>> = if parent.as_deref() == Some(actor) {
                Vec::new()
            } else {
                vec![parent]
            };
            self.trace.events.push(GrantEvent {
                to: to_parent,
                relation: "report",
                node: nid.to_owned(),
                delta: delta.to_f64(),
                now: now.to_f64(),
                free: fr.to_f64(),
                by: actor.to_owned(),
            });
        }
        let mut logged = warnings.clone();
        logged.extend(strand);
        self.trace.logs.push(("reallocate".to_owned(), logged));
        let out = self.grant_of(i);
        Ok((out, warnings))
    }

    // ------------------------------------------------------------------ hire
    /// The funding step of `hire(actor, parent, tier, grant, name, ...)`:
    /// every check that precedes it and can refuse, the D-014 check for a
    /// top-level hire and the chain acquisition. Returns the new node's
    /// grant, `int(grant)`. Recording covers only the two funding calls, as
    /// in the oracle.
    pub fn hire(
        &mut self,
        actor: &str,
        parent: Option<&str>,
        tier: &str,
        grant: PyNum,
    ) -> F<PyNum> {
        if !self.tier_known(tier) {
            return Err(Outside(
                "hire of a tier with no price: tier validation is outside the funding step",
            )
            .into());
        }
        if !grant.to_f64().is_finite() {
            return Err(Outside("non-finite hire grant").into());
        }
        let whole = grant.trunc_int()?;
        if grant.lt(PyNum::Int(0))? || !grant.eq_py(PyNum::Int(whole)) {
            return refuse(
                RefusalKind::BadHireGrant,
                "grant must be a non-negative integer (\u{2116}7)".to_owned(),
            );
        }
        let price = self.tier_price(tier)?;
        let need = self.q(price.py_add(PyNum::Int(whole))?)?;
        match parent {
            None => {
                if actor != USER {
                    return refuse(
                        RefusalKind::TopLevelHireByAgent,
                        "only the user hires at top level (\u{a7}7.4)".to_owned(),
                    );
                }
            }
            Some(p) => {
                self.require_live(p)?;
                if actor != USER && actor != p && !self.is_ancestor(actor, p)? {
                    return refuse(
                        RefusalKind::HireOutsideSubtree,
                        format!("{actor} may hire only within its own subtree (\u{a7}4.6)"),
                    );
                }
            }
        }
        if self.nodes.len() >= 1023 {
            return Err(
                Outside("hire depth/width caps are not modelled for tables this large").into(),
            );
        }
        let mut warnings = Vec::new();
        match parent {
            None => self.windowed(|s| s.check_top_grant(PyNum::Int(whole), "this hire"))?,
            Some(p) => {
                let cascade = self.cascade_setting("cascade_hire");
                self.acquire_windowed(actor, p, need, &mut warnings, cascade)?;
            }
        }
        Ok(PyNum::Int(whole))
    }

    // ---------------------------------------------------------------- rehire
    /// The funding step of `rehire(actor, nid, grant)`, including the
    /// rehire of archived superiors it performs first. `Ok(None)` is the
    /// already-live no-op; otherwise the grant the node is rehired at.
    pub fn rehire(&mut self, actor: &str, nid: &str, grant: Option<PyNum>) -> F<Option<PyNum>> {
        // own_bearer is `nodes[nid].successor == actor`; every successor is
        // null in the parity domain, so it is false.
        self.require_authority(actor, nid)?;
        let i = self.node(nid)?;
        if self.nodes[i].bearer_state.as_deref() == Some("lost") {
            return refuse(
                RefusalKind::LostGeneration,
                format!(
                    "{nid} is a LOST generation \u{2014} its transcript is gone, so there is nothing to consult or resume; its successor carries the role forward"
                ),
            );
        }
        match self.nodes[i].state.as_str() {
            "live" => return Ok(None),
            "unrecoverable" => {
                return Err(Outside("rehire of an unrecoverable node is a re-seed").into())
            }
            _ => {}
        }
        let mut chain: Vec<String> = Vec::new();
        let mut p = self.nodes[i].parent.clone();
        while let Some(k) = p {
            let Some(j) = self.find(&k) else {
                return key_error(RefusalKind::DanglingReference, &k);
            };
            match self.nodes[j].state.as_str() {
                "live" => break,
                "unrecoverable" => {
                    return refuse(
                        RefusalKind::UnrecoverableAbove,
                        format!(
                            "\"{k}\" above {nid} is UNRECOVERABLE \u{2014} rehiring {nid} would silently re-seed it (its dead session would be archived as a lost generation). Re-seed or retire \"{k}\" first, then rehire {nid}."
                        ),
                    );
                }
                _ => {}
            }
            if chain.contains(&k) || k == nid {
                return Err(Outside(
                    "archived parent cycle: Python's rehire walk does not terminate",
                )
                .into());
            }
            chain.push(k);
            p = self.nodes[j].parent.clone();
        }
        let mut warnings: Vec<String> = Vec::new();
        for k in chain.iter().rev() {
            self.rehire(actor, k, None)?;
        }
        let i = self.node(nid)?;
        let parent = self.nodes[i].parent.clone();
        let grant = match grant {
            None => self.nodes[i].grant,
            Some(g) => {
                if !g.to_f64().is_finite() {
                    return Err(Outside("non-finite rehire grant").into());
                }
                self.q(g)?.ceil()?
            }
        };
        if parent.is_none() && grant.gt(self.nodes[i].grant)? {
            self.windowed(|s| s.check_top_grant(grant, "this rehire"))?;
        }
        let seat = self.seat_cost(nid)?;
        let need = self.q(seat.py_add(grant)?)?;
        if let Some(p) = &parent {
            let cascade = self.cascade_setting("cascade_hire");
            self.acquire_windowed(actor, p, need, &mut warnings, cascade)?;
        }
        let i = self.node(nid)?;
        self.nodes[i].state = "live".to_owned();
        self.nodes[i].grant = grant;
        self.trace.rehired.push((nid.to_owned(), grant));
        Ok(Some(grant))
    }
}
