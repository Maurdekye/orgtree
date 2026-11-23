//! What an import would do, worked out before anything is created
//! (docs/rust-engine/agent-export.md, "Import": the plan).
//!
//! Nothing here reads or writes. `domain::ops::import` gathers the facts under
//! the import's own transaction (the names taken, what this computer can
//! staff, the scope the destination holds, the credits that can be drawn
//! there) and creates exactly what the plan says. The preview and the import
//! run the same function, and an import that was previewed carries the
//! preview's digest: when the plan has changed since, it is refused rather
//! than done differently from what was shown.
//!
//! Rulings (USER 2026-11-23): names are numbered as at a hire (10:43Z); grants
//! are saved and reused, and spare credits shrink by a strategy when they do
//! not fit (10:43Z); an agent on a tier this computer cannot staff comes in
//! retired (20:30Z, question 11); tools, visibility, permission mode and
//! folders are clamped to what the destination holds, with a warning, never
//! refused and never raised (design, "Identity").

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::credits::{self, Seat, Shrink};
use crate::domain::scope;

/// One node of the file, as far as the plan reads it.
#[derive(Clone, Debug)]
pub struct Wanted {
    pub name: String,
    /// Its parent's place in the list; `None` for the root.
    pub parent: Option<usize>,
    pub project: bool,
    /// Retired when it was exported.
    pub retired: bool,
    pub tier: String,
    /// The account it ran on: an account's id, or `None` for the provider's own sign-in.
    pub account: Option<String>,
    pub grant: f64,
    /// Its stored scope; a project's holds its settings.
    pub scope: Value,
    /// What was already dropped from its settings because this computer cannot keep it.
    pub notes: Vec<String>,
}

/// A tier this computer can staff now.
#[derive(Clone, Debug, Default)]
pub struct Tier {
    pub seat: f64,
    /// The accounts this organization may put it on.
    pub accounts: Vec<String>,
    /// The provider's own sign-in can run it for this organization.
    pub default_ok: bool,
    /// False for a language model server, which bills nobody: its seats name no account.
    pub billed: bool,
}

/// What the plan needs to know of the organization and of this computer.
#[derive(Clone, Debug)]
pub struct Facts {
    /// Every name a node of the organization has, in lower case.
    pub taken: HashSet<String>,
    pub tiers: HashMap<String, Tier>,
    /// Tiers that are missing only because their sign-in has not been checked yet.
    pub checking: Vec<String>,
    /// The scope the root is clamped to: what the destination holds, or the organization's ceiling.
    pub ceiling: Value,
    /// What the destination is called in a warning: its name, or "the organization".
    pub above: String,
    /// The credits that can be drawn under the destination; infinite when nothing bounds them.
    pub available: f64,
    /// Set when no agent stands at or above the destination: every top agent of the import is a
    /// top-level agent, whose grant the organization's cap bounds (infinite: no cap).
    pub top_cap: Option<f64>,
    /// The importer is an agent: it must name a strategy itself.
    pub by_agent: bool,
}

/// One node as it will be created.
#[derive(Clone, Debug, PartialEq)]
pub struct Planned {
    /// The name it had in the file.
    pub was: String,
    pub name: String,
    pub parent: Option<usize>,
    pub project: bool,
    pub retired: bool,
    /// Why it comes in retired, when the file did not say so itself.
    pub retired_why: Option<String>,
    pub tier: String,
    /// `primary`, an account's id, or `None`: the hire chooses, as for any hire that names none.
    pub account: Option<String>,
    pub seat: f64,
    pub grant: f64,
    pub saved_grant: f64,
    pub scope: Value,
    pub warnings: Vec<String>,
}

/// The whole plan.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub nodes: Vec<Planned>,
    /// What the destination pays for the team as planned.
    pub cost: f64,
    /// What it would pay with every saved grant.
    pub full: f64,
    /// The seats alone.
    pub seats: f64,
    pub available: f64,
    /// The strategy that took spare credits away, when one had to.
    pub shrunk: Option<Shrink>,
    /// Why nothing can be imported as asked. A plan with a refusal creates nothing.
    pub refusal: Option<String>,
}

#[nolog]
fn credits_text(x: f64) -> String {
    if (x - x.round()).abs() < 0.005 { format!("{x:.0}") } else { format!("{x:.2}") }
}

/// The names of what `wanted` holds and `kept` does not, by `list`.
#[nolog]
fn lost(wanted: &Value, kept: &Value, list: &[&str]) -> Vec<String> {
    list.iter().filter(|k| wanted[**k] == json!(true) && kept[**k] != json!(true)).map(|k| k.to_string()).collect()
}

/// `stored` as it may be kept under a superior whose effective scope is `above`, and what
/// that took away, in words.
#[nolog]
fn clamp(stored: &Value, above: &Value, held_by: &str) -> (Value, Vec<String>) {
    let wanted = scope::normalize(stored);
    let kept = scope::clamp(stored, above);
    let mut notes = Vec::new();
    let tools = lost(&wanted["tools"], &kept["tools"], &["bash", "web", "edit", "subagents"]);
    if !tools.is_empty() {
        notes.push(format!("tools switched off, as {held_by} does not hold them: {}", tools.join(", ")));
    }
    let servers = |v: &Value| -> Vec<String> { v["tools"]["mcp"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect() };
    let (want, keep) = (servers(&wanted), servers(&kept));
    if want.iter().any(|s| s == "*") && !keep.iter().any(|s| s == "*") {
        notes.push(format!("every MCP server became the ones {held_by} holds: {}", if keep.is_empty() { "none".to_string() } else { keep.join(", ") }));
    } else {
        let dropped: Vec<String> = want.into_iter().filter(|s| !keep.contains(s)).collect();
        if !dropped.is_empty() {
            notes.push(format!("MCP servers dropped, as {held_by} does not hold them: {}", dropped.join(", ")));
        }
    }
    let groups = lost(&wanted["tools"]["orgtree"], &kept["tools"]["orgtree"], crate::domain::tool_groups::GROUPS);
    if !groups.is_empty() {
        notes.push(format!("Orgtree tool groups switched off, as {held_by} does not hold them: {}", groups.join(", ")));
    }
    for (key, what) in [("org_visibility", "visibility"), ("permission_mode", "permission mode")] {
        if wanted[key] != kept[key] {
            notes.push(format!("{what} lowered from {} to {}, the level {held_by} holds", wanted[key].as_str().unwrap_or("?"), kept[key].as_str().unwrap_or("?")));
        }
    }
    let diff = scope::dirs_diff(wanted["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default(), kept["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default());
    let paths = |list: &Value, key: &str| -> Vec<String> { list.as_array().into_iter().flatten().filter_map(|d| d[key].as_str().map(str::to_string)).collect() };
    let gone = paths(&diff["removed"], "path");
    if !gone.is_empty() {
        notes.push(format!("folders dropped, as {held_by} does not hold them: {}", gone.join(", ")));
    }
    let narrowed = paths(&diff["changed"], "path");
    if !narrowed.is_empty() {
        notes.push(format!("folders now read-only, as {held_by} holds them read-only: {}", narrowed.join(", ")));
    }
    (kept, notes)
}

/// Work the plan out.
#[nolog]
pub fn build(wanted: &[Wanted], facts: &Facts, strategy: Option<Shrink>) -> Plan {
    let n = wanted.len();
    let mut taken = facts.taken.clone();
    let mut nodes: Vec<Planned> = Vec::with_capacity(n);
    // the effective scope of each node, which clamps the nodes under it
    let mut effective: Vec<Value> = Vec::with_capacity(n);
    let mut refusal: Option<String> = None;
    for (at, want) in wanted.iter().enumerate() {
        let parent = want.parent.filter(|p| *p < at);
        let offer = facts.tiers.get(&want.tier);
        let mut warnings = want.notes.clone();
        // retired: said by the file, taken along by a retired node above it, or a tier nobody can staff here
        let above_retired = parent.is_some_and(|p| nodes[p].retired);
        let mut retired_why = None;
        if !want.retired {
            if above_retired {
                let p = &nodes[parent.unwrap()];
                retired_why = Some(format!("{} above it comes in retired, and a retired node takes its team with it", p.name));
            } else if !want.project && offer.is_none() {
                if facts.checking.contains(&want.tier) && refusal.is_none() {
                    refusal = Some(format!("this computer is still checking the sign-in that runs {}; try again in a moment", want.tier));
                }
                retired_why = Some(format!("this computer cannot staff {} now; rehire it on another model", want.tier));
            }
        }
        let retired = want.retired || retired_why.is_some();
        let name = super::names::free_name(&want.name, &mut taken);
        // the account: the saved one when this computer has it for this tier, else the hire's own choice
        let account = match offer.filter(|_| !retired && !want.project) {
            Some(tier) if tier.billed => match &want.account {
                Some(id) if tier.accounts.contains(id) => Some(id.clone()),
                None if tier.default_ok => Some("primary".to_string()),
                saved => {
                    warnings.push(match saved {
                        Some(id) => format!("the account it ran on ({id}) cannot run {} here; it is placed as a new hire is", want.tier),
                        None => format!("the provider's own sign-in cannot run {} for this organization; it is placed as a new hire is", want.tier),
                    });
                    None
                }
            },
            _ => None,
        };
        let (held, held_by) = match parent {
            Some(p) => (&effective[p], nodes[p].name.clone()),
            None => (&facts.ceiling, facts.above.clone()),
        };
        let (stored, own) = if want.project {
            // a project passes what is above it through; its stored scope holds its settings
            (want.scope.clone(), scope::normalize(held))
        } else {
            let (kept, notes) = clamp(&want.scope, held, &held_by);
            warnings.extend(notes);
            (kept.clone(), kept)
        };
        effective.push(own);
        nodes.push(Planned {
            was: want.name.clone(),
            name,
            parent,
            project: want.project,
            retired,
            retired_why,
            tier: want.tier.clone(),
            account,
            seat: if retired || want.project { 0.0 } else { offer.map(|t| t.seat).unwrap_or(0.0) },
            grant: 0.0,
            saved_grant: want.grant,
            scope: stored,
            warnings,
        });
    }

    // credits: the saved grants, raised where this computer's seats cost more, then shrunk to what can be drawn
    let seats: Vec<Seat> = nodes.iter().map(|p| Seat { parent: p.parent, project: p.project, retired: p.retired, seat: p.seat, grant: p.saved_grant }).collect();
    let saved = credits::cost(&seats);
    let mut settled = saved.clone();
    let mut shrunk = None;
    if let Some(cap) = facts.top_cap {
        let over: Vec<usize> = credits::top_agents(&seats).into_iter().filter(|a| saved.grants[*a] > cap + 1e-9).collect();
        if let Some(first) = over.first() {
            match strategy {
                None => {
                    refusal.get_or_insert(format!(
                        "{} would need a grant of {}, over this organization's top-level cap of {}; name a shrink strategy ({}) to take spare credits away",
                        nodes[*first].name, credits_text(saved.grants[*first]), credits_text(cap), credits::SHRINKS));
                }
                Some(strategy) => match credits::cap_top(&seats, &saved, cap, strategy) {
                    Ok(fits) => {
                        settled = fits;
                        shrunk = Some(strategy);
                    }
                    Err(top) => {
                        refusal.get_or_insert(format!(
                            "the seats under {} alone need a grant over this organization's top-level cap of {}; raise the cap in Org settings, or import a smaller team",
                            nodes[top].name, credits_text(cap)));
                    }
                },
            }
        }
    } else if saved.full > facts.available + 1e-9 {
        let missing = saved.full - facts.available;
        let short = |what: &str| format!(
            "{what} {} credits and {} can be drawn under {}", credits_text(if what.starts_with("the seats") { saved.seats } else { saved.full }),
            credits_text(facts.available.max(0.0)), facts.above);
        match strategy {
            None if saved.seats > facts.available + 1e-9 => {
                refusal.get_or_insert(format!("{}; ask for credits first", short("the seats alone cost")));
            }
            None => {
                refusal.get_or_insert(format!(
                    "{}; name a shrink strategy ({}) to take spare credits away, or ask for credits first", short("this needs"), credits::SHRINKS));
            }
            Some(strategy) => match credits::shrink(&seats, &saved, missing, strategy) {
                Some(fits) => {
                    settled = fits;
                    shrunk = Some(strategy);
                }
                None => {
                    refusal.get_or_insert(format!("{}; no strategy can make it fit", short("the seats alone cost")));
                }
            },
        }
    }
    for (at, node) in nodes.iter_mut().enumerate() {
        node.grant = settled.grants[at];
        if !node.retired && !node.project {
            if node.grant + 1e-9 < node.saved_grant {
                node.warnings.push(format!("grant shrunk from {} to {} to fit the credits there are", credits_text(node.saved_grant), credits_text(node.grant)));
            } else if node.grant > node.saved_grant + 1e-9 {
                node.warnings.push(format!("grant raised from {} to {}: the seats under it cost more on this computer", credits_text(node.saved_grant), credits_text(node.grant)));
            }
        }
    }
    Plan { nodes, cost: settled.full, full: saved.full, seats: saved.seats, available: facts.available, shrunk, refusal }
}

#[nolog]
impl Plan {
    /// What identifies this plan: an import that was previewed is done only when its plan
    /// still comes to this.
    pub fn digest(&self) -> String {
        let mut sha = Sha256::new();
        for node in &self.nodes {
            let line = json!([node.was, node.name, node.parent, node.project, node.retired, node.tier, node.account, node.seat, node.grant, node.scope]);
            sha.update(line.to_string().as_bytes());
            sha.update(b"\n");
        }
        sha.update(self.refusal.as_deref().unwrap_or("").as_bytes());
        hex::encode(sha.finalize())
    }

    /// The plan for whoever reads it: a window or an agent.
    pub fn json(&self) -> Value {
        let count = |pick: &dyn Fn(&Planned) -> bool| self.nodes.iter().filter(|p| pick(p)).count();
        let renamed: Vec<Value> = self.nodes.iter().filter(|p| p.was != p.name).map(|p| json!({ "from": p.was, "to": p.name })).collect();
        json!({
            "nodes": self.nodes.iter().map(|p| json!({
                "was": p.was,
                "name": p.name,
                "parent": p.parent.map(|at| self.nodes[at].name.clone()),
                "kind": if p.project { "project" } else { "agent" },
                "tier": p.tier,
                "retired": p.retired,
                "retired_why": p.retired_why,
                "account": p.account,
                "seat": p.seat,
                "grant": p.grant,
                "saved_grant": p.saved_grant,
                "warnings": p.warnings,
            })).collect::<Vec<_>>(),
            "agents": count(&|p| !p.project && !p.retired),
            "projects": count(&|p| p.project && !p.retired),
            "retired": count(&|p| p.retired),
            "renamed": renamed,
            "cost": self.cost,
            "full_cost": self.full,
            "seats_cost": self.seats,
            // null: nothing bounds what can be drawn there
            "available": self.available.is_finite().then_some(self.available),
            "shrunk_by": self.shrunk.map(Shrink::as_str),
            "warnings": self.nodes.iter().map(|p| p.warnings.len()).sum::<usize>(),
            "refusal": self.refusal,
            "ok": self.refusal.is_none(),
            "digest": self.digest(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, parent: Option<usize>, tier: &str, grant: f64) -> Wanted {
        Wanted { name: name.into(), parent, project: false, retired: false, tier: tier.into(), account: None, grant,
                 scope: json!({ "permission_mode": "acceptEdits", "org_visibility": "subtree", "add_dirs": [],
                                "tools": { "bash": true, "web": true, "edit": true, "subagents": false, "mcp": [] } }), notes: Vec::new() }
    }

    fn project(name: &str, parent: Option<usize>) -> Wanted {
        Wanted { name: name.into(), parent, project: true, retired: false, tier: "project".into(), account: None, grant: 0.0,
                 scope: json!({ "transparent": true, "slots": 2 }), notes: Vec::new() }
    }

    fn facts() -> Facts {
        let tier = |seat: f64| Tier { seat, accounts: vec!["second".into()], default_ok: true, billed: true };
        Facts {
            taken: ["lead", "worker"].iter().map(|n| n.to_string()).collect(),
            tiers: [("big".to_string(), tier(4.0)), ("small".to_string(), tier(2.0))].into_iter().collect(),
            checking: Vec::new(),
            ceiling: scope::org_ceiling(&json!([{ "path": "C:\\work", "mode": "rw" }])),
            above: "the organization".into(),
            available: f64::INFINITY,
            top_cap: None,
            by_agent: false,
        }
    }

    /// The design's team: a lead (grant 20) over A (grant 5) and B (grant 3).
    fn team() -> Vec<Wanted> {
        vec![agent("lead", None, "big", 20.0), agent("A", Some(0), "small", 5.0), agent("B", Some(0), "small", 3.0)]
    }

    #[test]
    fn a_team_that_fits_keeps_its_grants_and_a_taken_name_is_numbered() {
        let plan = build(&team(), &facts(), None);
        assert_eq!(plan.refusal, None);
        assert_eq!(plan.nodes.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["lead-2", "A", "B"]);
        assert_eq!(plan.nodes.iter().map(|p| p.grant).collect::<Vec<_>>(), [20.0, 5.0, 3.0]);
        assert_eq!(plan.nodes.iter().map(|p| p.seat).collect::<Vec<_>>(), [4.0, 2.0, 2.0]);
        assert_eq!((plan.cost, plan.full, plan.seats, plan.shrunk), (24.0, 24.0, 8.0, None));
        assert!(plan.nodes.iter().all(|p| !p.retired && p.account.as_deref() == Some("primary") && p.warnings.is_empty()), "{plan:?}");
        let shown = plan.json();
        assert_eq!(shown["renamed"], json!([{ "from": "lead", "to": "lead-2" }]));
        assert_eq!((shown["available"].clone(), shown["ok"].clone(), shown["agents"].clone()), (Value::Null, json!(true), json!(3)));
        assert_eq!(shown["nodes"][1]["parent"], "lead-2");
    }

    #[test]
    fn grants_that_do_not_fit_need_a_strategy_and_shrink_by_it() {
        let mut f = facts();
        f.available = 14.0;
        f.above = "boss".into();
        f.by_agent = true;
        // no strategy: refused, and the refusal says what would help
        let refused = build(&team(), &f, None);
        let why = refused.refusal.clone().unwrap();
        assert!(why.contains("this needs 24 credits and 14 can be drawn under boss") && why.contains("bottom-up, top-down or even"), "{why}");
        assert_eq!(refused.json()["ok"], false);
        // the design's three answers
        for (strategy, grants) in [(Shrink::BottomUp, [10.0, 0.0, 0.0]), (Shrink::TopDown, [10.0, 3.0, 3.0]), (Shrink::Even, [10.0, 2.0, 0.0])] {
            let plan = build(&team(), &f, Some(strategy));
            assert_eq!(plan.refusal, None, "{strategy:?}");
            assert_eq!(plan.nodes.iter().map(|p| p.grant).collect::<Vec<_>>(), grants, "{strategy:?}");
            assert_eq!((plan.cost, plan.full, plan.shrunk), (14.0, 24.0, Some(strategy)));
            assert!(plan.nodes.iter().any(|p| p.warnings.iter().any(|w| w.starts_with("grant shrunk from"))));
        }
        // not even the seats: no strategy helps, and none is asked for
        f.available = 7.0;
        for strategy in [None, Some(Shrink::Even)] {
            let why = build(&team(), &f, strategy).refusal.unwrap();
            assert!(why.contains("the seats alone cost 8 credits and 7 can be drawn under boss"), "{why}");
            assert!(!why.contains("name a shrink strategy"), "{why}");
        }
        // exactly the seats: every spare credit goes
        f.available = 8.0;
        assert_eq!(build(&team(), &f, Some(Shrink::TopDown)).nodes.iter().map(|p| p.grant).collect::<Vec<_>>(), [4.0, 0.0, 0.0]);
    }

    #[test]
    fn a_top_level_team_is_bounded_by_the_cap_on_each_top_agent() {
        let mut f = facts();
        f.top_cap = Some(15.0);
        let plan = build(&team(), &f, Some(Shrink::BottomUp));
        assert_eq!(plan.refusal, None);
        assert_eq!(plan.nodes.iter().map(|p| p.grant).collect::<Vec<_>>(), [15.0, 3.0, 0.0]);
        assert_eq!((plan.cost, plan.shrunk), (19.0, Some(Shrink::BottomUp)));
        // under the cap nothing is taken, whatever the strategy
        f.top_cap = Some(20.0);
        assert_eq!(build(&team(), &f, Some(Shrink::Even)).shrunk, None);
        // the seats under the lead need a grant of 4
        f.top_cap = Some(3.0);
        let why = build(&team(), &f, Some(Shrink::Even)).refusal.unwrap();
        assert!(why.contains("the seats under lead-2 alone need a grant over this organization's top-level cap of 3"), "{why}");
        // no cap at all
        f.top_cap = Some(f64::INFINITY);
        assert_eq!(build(&team(), &f, None).cost, 24.0);
    }

    #[test]
    fn an_agent_nobody_can_staff_here_comes_in_retired_with_its_team() {
        let mut nodes = team();
        nodes[1].tier = "gone".into();
        nodes.push(agent("C", Some(1), "small", 1.0));
        nodes.push(project("P", Some(1)));
        let plan = build(&nodes, &facts(), None);
        assert_eq!(plan.refusal, None);
        assert_eq!(plan.nodes.iter().map(|p| p.retired).collect::<Vec<_>>(), [false, true, false, true, true]);
        assert!(plan.nodes[1].retired_why.as_deref().unwrap().contains("cannot staff gone"));
        assert!(plan.nodes[3].retired_why.as_deref().unwrap().contains("A above it comes in retired"));
        // retired nodes cost nothing; the lead keeps its saved grant
        assert_eq!(plan.nodes.iter().map(|p| p.grant).collect::<Vec<_>>(), [20.0, 0.0, 3.0, 0.0, 0.0]);
        assert_eq!((plan.cost, plan.seats), (24.0, 6.0));
        assert_eq!((plan.json()["agents"].clone(), plan.json()["retired"].clone()), (json!(2), json!(3)));
        // while the sign-in is still being checked, nothing is decided
        let mut f = facts();
        f.checking = vec!["gone".into()];
        assert!(build(&nodes, &f, None).refusal.unwrap().contains("still checking the sign-in that runs gone"));
        // a node the file calls retired stays retired, and says nothing more
        let mut old = team();
        old[2].retired = true;
        let plan = build(&old, &facts(), None);
        assert_eq!((plan.nodes[2].retired, plan.nodes[2].retired_why.clone(), plan.nodes[2].seat), (true, None, 0.0));
    }

    #[test]
    fn settings_are_clamped_to_what_the_destination_holds_and_say_so() {
        let mut nodes = team();
        nodes[0].scope = json!({ "permission_mode": "bypassPermissions", "org_visibility": "full", "effort": "high",
            "add_dirs": [{ "path": "C:\\work\\a", "mode": "rw" }, { "path": "D:\\elsewhere", "mode": "rw" }],
            "tools": { "bash": true, "web": true, "edit": true, "subagents": true, "mcp": ["files", "mail"] } });
        nodes[1].scope["tools"]["bash"] = json!(true);
        let mut f = facts();
        f.above = "boss".into();
        f.ceiling = json!({ "permission_mode": "acceptEdits", "org_visibility": "subtree", "add_dirs": [{ "path": "C:\\work", "mode": "ro" }],
            "tools": { "bash": false, "web": true, "edit": true, "subagents": true, "mcp": ["files"], "orgtree": { "team": false } } });
        let plan = build(&nodes, &f, None);
        let lead = &plan.nodes[0];
        assert_eq!(lead.scope["permission_mode"], "acceptEdits");
        assert_eq!(lead.scope["org_visibility"], "subtree");
        assert_eq!(lead.scope["add_dirs"], json!([{ "path": "C:\\work\\a", "mode": "ro" }]));
        assert_eq!(lead.scope["tools"]["bash"], false);
        assert_eq!(lead.scope["tools"]["mcp"], json!(["files"]));
        assert_eq!(lead.scope["tools"]["orgtree"]["team"], false);
        // what is not a matter of what the superior holds is kept
        assert_eq!(lead.scope["effort"], "high");
        let said = lead.warnings.join(" | ");
        for part in ["tools switched off, as boss does not hold them: bash", "MCP servers dropped, as boss does not hold them: mail",
                     "Orgtree tool groups switched off, as boss does not hold them: team", "visibility lowered from full to subtree",
                     "permission mode lowered from bypassPermissions to acceptEdits", "folders dropped, as boss does not hold them: D:\\elsewhere",
                     "folders now read-only, as boss holds them read-only: C:\\work\\a"] {
            assert!(said.contains(part), "{part}: {said}");
        }
        // a report is clamped by what the imported node above it ends up holding, and the warning names that node
        let report = &plan.nodes[1];
        assert_eq!(report.scope["tools"]["bash"], false);
        assert!(report.warnings.iter().any(|w| w == "tools switched off, as lead-2 does not hold them: bash"), "{:?}", report.warnings);
        // every MCP server, under a superior that holds some
        let mut all = team();
        all[0].scope["tools"]["mcp"] = json!(["*"]);
        let plan = build(&all, &f, None);
        assert_eq!(plan.nodes[0].scope["tools"]["mcp"], json!(["files"]));
        assert!(plan.nodes[0].warnings.iter().any(|w| w.contains("every MCP server became the ones boss holds: files")));
    }

    #[test]
    fn a_project_passes_what_is_above_it_through_and_keeps_its_settings() {
        let mut nodes = vec![project("P", None), agent("lead", Some(0), "big", 20.0), agent("A", Some(1), "small", 5.0)];
        nodes[1].scope["tools"]["bash"] = json!(true);
        let mut f = facts();
        f.ceiling["tools"]["bash"] = json!(false);
        let plan = build(&nodes, &f, None);
        assert_eq!(plan.nodes[0].scope, json!({ "transparent": true, "slots": 2 }));
        assert!(plan.nodes[0].warnings.is_empty());
        assert_eq!((plan.nodes[0].seat, plan.nodes[0].grant, plan.nodes[0].account.clone()), (0.0, 0.0, None));
        // the agent under the project is clamped by what stands above the project
        assert_eq!(plan.nodes[1].scope["tools"]["bash"], false);
        assert!(plan.nodes[1].warnings.iter().any(|w| w.contains("as P does not hold them: bash")), "{:?}", plan.nodes[1].warnings);
        assert_eq!(plan.cost, 24.0);
    }

    #[test]
    fn an_account_is_kept_only_where_this_computer_has_it_for_the_tier() {
        let mut nodes = team();
        nodes[0].account = Some("second".into());
        nodes[1].account = Some("elsewhere".into());
        let mut f = facts();
        f.tiers.get_mut("small").unwrap().default_ok = false;
        f.tiers.insert("local".into(), Tier { seat: 1.0, accounts: Vec::new(), default_ok: false, billed: false });
        nodes.push(agent("L", Some(0), "local", 0.0));
        let plan = build(&nodes, &f, None);
        assert_eq!(plan.nodes.iter().map(|p| p.account.as_deref()).collect::<Vec<_>>(), [Some("second"), None, None, None]);
        assert!(plan.nodes[1].warnings[0].contains("the account it ran on (elsewhere) cannot run small here"));
        assert!(plan.nodes[2].warnings[0].contains("the provider's own sign-in cannot run small for this organization"));
        // a language model server bills nobody: nothing to say
        assert!(plan.nodes[3].warnings.is_empty());
    }

    #[test]
    fn a_plan_is_the_same_plan_only_while_nothing_it_decides_changes() {
        let base = build(&team(), &facts(), None);
        assert_eq!(base.digest(), build(&team(), &facts(), None).digest());
        // a name was taken meanwhile
        let mut f = facts();
        f.taken.insert("a".into());
        assert_ne!(base.digest(), build(&team(), &f, None).digest());
        // a seat's price moved
        let mut f = facts();
        f.tiers.get_mut("small").unwrap().seat = 3.0;
        assert_ne!(base.digest(), build(&team(), &f, None).digest());
        // credits ran short
        let mut f = facts();
        f.available = 20.0;
        assert_ne!(base.digest(), build(&team(), &f, Some(Shrink::Even)).digest());
        assert_ne!(base.digest(), build(&team(), &f, None).digest());
    }
}
