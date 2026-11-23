//! What an imported team costs, and how its spare credits shrink to fit
//! (docs/rust-engine/agent-export.md, "Credits").
//!
//! USER 2026-11-23 10:43Z m3c072bcdc19a: grants are saved in the export and
//! reused; when the seats fit but the grants do not, a shrink strategy takes
//! spare credits away: `bottom-up` from the lowest nodes first, `top-down`
//! from the topmost agent first, `even` evenly from all agents, keeping whole
//! numbers. Nothing here reads or writes: the import plan gives it the tree.

/// How spare credits are taken away when a team's saved grants do not fit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shrink {
    BottomUp,
    TopDown,
    Even,
}

#[nolog]
impl Shrink {
    pub fn parse(raw: &str) -> Option<Shrink> {
        match raw {
            "bottom-up" | "bottom_up" => Some(Shrink::BottomUp),
            "top-down" | "top_down" => Some(Shrink::TopDown),
            "even" => Some(Shrink::Even),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Shrink::BottomUp => "bottom-up",
            Shrink::TopDown => "top-down",
            Shrink::Even => "even",
        }
    }
}

/// The three names, for a refusal that lists them.
pub const SHRINKS: &str = "bottom-up, top-down or even";

/// One node of the team, in tree order: a parent comes before its children.
#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    /// Its parent's place in the list; `None` for a node that goes under the destination.
    pub parent: Option<usize>,
    /// A project holds no credits: what is under it is paid by the agent above it.
    pub project: bool,
    /// Imported retired: it and everything under it cost nothing.
    pub retired: bool,
    /// The seat's price on this machine.
    pub seat: f64,
    /// The grant saved in the export.
    pub grant: f64,
}

/// The team with its grants settled: each agent's saved grant, raised to what its reports
/// hold here when this machine's seats cost more than the exporting one's.
#[derive(Clone, Debug, PartialEq)]
pub struct Costed {
    /// One per node; 0 for a project and for a retired node.
    pub grants: Vec<f64>,
    /// The part of each grant its reports do not hold.
    pub spare: Vec<f64>,
    /// What the destination pays: the stake (seat and grant) of every agent directly under it,
    /// through projects.
    pub full: f64,
    /// The same team with no spare credit at all: the sum of its seats.
    pub seats: f64,
}

#[nolog]
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Whether node `i` holds or costs credits: a live agent with no retired node above it.
#[nolog]
fn live(nodes: &[Seat], i: usize) -> bool {
    let mut at = Some(i);
    while let Some(n) = at {
        if nodes[n].retired {
            return false;
        }
        at = nodes[n].parent;
    }
    true
}

/// The grants a set of spare credits gives, and the two costs. `spare[i]` is what agent `i`
/// keeps free; a grant is that plus the stakes of its reports, through projects.
#[nolog]
fn settle(nodes: &[Seat], spare: &[f64]) -> Costed {
    let n = nodes.len();
    let alive: Vec<bool> = (0..n).map(|i| live(nodes, i)).collect();
    // what each node hands up to the node above it: an agent its stake, a project what it holds
    let mut up = vec![0.0f64; n];
    let mut held = vec![0.0f64; n];
    let mut grants = vec![0.0f64; n];
    let (mut full, mut seats) = (0.0, 0.0);
    // children come after their parents, so walking backwards meets every child first
    for i in (0..n).rev() {
        if !alive[i] {
            continue;
        }
        if nodes[i].project {
            up[i] = held[i];
        } else {
            grants[i] = round2(held[i] + spare[i]);
            up[i] = nodes[i].seat + grants[i];
            seats += nodes[i].seat;
        }
        match nodes[i].parent {
            Some(p) => held[p] += up[i],
            None => full += up[i],
        }
    }
    let spare: Vec<f64> = (0..n).map(|i| if alive[i] && !nodes[i].project { round2(spare[i]) } else { 0.0 }).collect();
    Costed { grants, spare, full: round2(full), seats: round2(seats) }
}

/// The team as it would be imported with its saved grants.
#[nolog]
pub fn cost(nodes: &[Seat]) -> Costed {
    let n = nodes.len();
    let alive: Vec<bool> = (0..n).map(|i| live(nodes, i)).collect();
    // what each agent's reports hold with the saved grants, raised bottom-up where they must be
    let mut up = vec![0.0f64; n];
    let mut held = vec![0.0f64; n];
    let mut spare = vec![0.0f64; n];
    for i in (0..n).rev() {
        if !alive[i] {
            continue;
        }
        if nodes[i].project {
            up[i] = held[i];
        } else {
            let grant = nodes[i].grant.max(held[i]).max(0.0);
            spare[i] = grant - held[i];
            up[i] = nodes[i].seat + grant;
        }
        if let Some(p) = nodes[i].parent {
            held[p] += up[i];
        }
    }
    settle(nodes, &spare)
}

/// How deep node `i` lies in the team.
#[nolog]
fn depth(nodes: &[Seat], i: usize) -> usize {
    let (mut d, mut at) = (0, nodes[i].parent);
    while let Some(p) = at {
        d += 1;
        at = nodes[p].parent;
    }
    d
}

/// Take `missing` credits of spare away from `costed` by `strategy`. `None` when all the spare
/// there is does not cover it: then not even the seats fit. Whole credits are taken, so whole
/// grants stay whole; an agent whose whole spare goes may give a fraction.
#[nolog]
pub fn shrink(nodes: &[Seat], costed: &Costed, missing: f64, strategy: Shrink) -> Option<Costed> {
    let mut spare = costed.spare.clone();
    if missing <= 1e-9 {
        return Some(settle(nodes, &spare));
    }
    let total: f64 = spare.iter().sum();
    if total + 1e-9 < missing {
        return None;
    }
    let agents: Vec<usize> = (0..nodes.len()).filter(|i| spare[*i] > 1e-9).collect();
    let mut left = missing;
    match strategy {
        Shrink::BottomUp | Shrink::TopDown => {
            let mut order: Vec<(usize, usize)> = agents.iter().map(|i| (depth(nodes, *i), *i)).collect();
            if strategy == Shrink::BottomUp {
                // the lowest first; among those of one depth, the last in the tree first
                order.sort_by(|a, b| b.cmp(a));
            } else {
                order.sort();
            }
            for (_, i) in order {
                if left <= 1e-9 {
                    break;
                }
                let whole = left.ceil();
                let take = if spare[i] <= whole + 1e-9 { spare[i] } else { whole };
                spare[i] -= take;
                left -= take;
            }
        }
        Shrink::Even => {
            // one credit from each agent that still has one, in tree order, round after round
            while left > 1e-9 && agents.iter().any(|i| spare[*i] >= 1.0 - 1e-9) {
                for i in &agents {
                    if left <= 1e-9 {
                        break;
                    }
                    if spare[*i] >= 1.0 - 1e-9 {
                        spare[*i] -= 1.0;
                        left -= 1.0;
                    }
                }
            }
            // whole credits did not suffice: what is left of the fractions, in the same order
            for i in &agents {
                if left <= 1e-9 {
                    break;
                }
                let take = spare[*i].min(left).max(0.0);
                spare[*i] -= take;
                left -= take;
            }
        }
    }
    for s in &mut spare {
        if *s < 1e-9 {
            *s = 0.0;
        }
    }
    Some(settle(nodes, &spare))
}

/// Whether node `i` is `top` or lies under it.
#[nolog]
fn under(nodes: &[Seat], i: usize, top: usize) -> bool {
    let mut at = Some(i);
    while let Some(n) = at {
        if n == top {
            return true;
        }
        at = nodes[n].parent;
    }
    false
}

/// The agents of the team that have no agent of the team above them: where the team lands
/// with no agent above it, each of them is a top-level agent of the organization.
#[nolog]
pub fn top_agents(nodes: &[Seat]) -> Vec<usize> {
    (0..nodes.len())
        .filter(|i| {
            if nodes[*i].project || !live(nodes, *i) {
                return false;
            }
            let mut at = nodes[*i].parent;
            while let Some(p) = at {
                if !nodes[p].project {
                    return false;
                }
                at = nodes[p].parent;
            }
            true
        })
        .collect()
}

/// Bring the grant of every top agent down to `cap`, the organization's cap on a top-level
/// grant, by taking spare credits from that agent's own team with `strategy`. `Err` names the
/// first top agent whose team's seats alone need a grant over the cap.
#[nolog]
pub fn cap_top(nodes: &[Seat], costed: &Costed, cap: f64, strategy: Shrink) -> Result<Costed, usize> {
    let mut spare = costed.spare.clone();
    for top in top_agents(nodes) {
        if costed.grants[top] <= cap + 1e-9 {
            continue;
        }
        // the team under this agent, as a list of its own
        let members: Vec<usize> = (top..nodes.len()).filter(|i| under(nodes, *i, top)).collect();
        let place = |i: usize| members.iter().position(|m| *m == i);
        let team: Vec<Seat> = members.iter().map(|i| Seat { parent: if *i == top { None } else { nodes[*i].parent.and_then(place) }, ..nodes[*i].clone() }).collect();
        let own: Vec<f64> = members.iter().map(|i| spare[*i]).collect();
        let Some(shrunk) = shrink(&team, &settle(&team, &own), costed.grants[top] - cap, strategy) else { return Err(top) };
        for (k, i) in members.iter().enumerate() {
            spare[*i] = shrunk.spare[k];
        }
    }
    Ok(settle(nodes, &spare))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(parent: Option<usize>, seat: f64, grant: f64) -> Seat {
        Seat { parent, project: false, retired: false, seat, grant }
    }

    /// The example of the design: a lead (seat 4, grant 20) over A (seat 2, grant 5) and B (seat 2, grant 3).
    fn example() -> Vec<Seat> {
        vec![agent(None, 4.0, 20.0), agent(Some(0), 2.0, 5.0), agent(Some(0), 2.0, 3.0)]
    }

    #[test]
    fn the_names_of_the_three_strategies() {
        for s in [Shrink::BottomUp, Shrink::TopDown, Shrink::Even] {
            assert_eq!(Shrink::parse(s.as_str()), Some(s));
        }
        assert_eq!(Shrink::parse("bottom_up"), Some(Shrink::BottomUp));
        assert_eq!(Shrink::parse("none"), None);
        assert_eq!(Shrink::parse(""), None);
    }

    #[test]
    fn a_team_costs_its_top_seat_and_grant_and_at_least_its_seats() {
        let c = cost(&example());
        assert_eq!(c.grants, [20.0, 5.0, 3.0]);
        assert_eq!(c.spare, [8.0, 5.0, 3.0]);
        assert_eq!((c.full, c.seats), (24.0, 8.0));
    }

    #[test]
    fn the_three_strategies_on_the_example() {
        let (nodes, c) = (example(), cost(&example()));
        // the importer has 14 free: 10 must go
        let bottom = shrink(&nodes, &c, 10.0, Shrink::BottomUp).unwrap();
        assert_eq!((bottom.spare.clone(), bottom.grants.clone(), bottom.full), (vec![6.0, 0.0, 0.0], vec![10.0, 0.0, 0.0], 14.0));
        let top = shrink(&nodes, &c, 10.0, Shrink::TopDown).unwrap();
        assert_eq!((top.spare.clone(), top.grants.clone(), top.full), (vec![0.0, 3.0, 3.0], vec![10.0, 3.0, 3.0], 14.0));
        let even = shrink(&nodes, &c, 10.0, Shrink::Even).unwrap();
        assert_eq!((even.spare.clone(), even.grants.clone(), even.full), (vec![4.0, 2.0, 0.0], vec![10.0, 2.0, 0.0], 14.0));
        // the seats never change
        for s in [&bottom, &top, &even] {
            assert_eq!(s.seats, 8.0);
        }
    }

    #[test]
    fn nothing_missing_changes_nothing_and_more_than_the_spare_cannot_be_taken() {
        let (nodes, c) = (example(), cost(&example()));
        for s in [Shrink::BottomUp, Shrink::TopDown, Shrink::Even] {
            assert_eq!(shrink(&nodes, &c, 0.0, s).unwrap(), c);
            // all 16 spare credits: the team at its seats
            let bare = shrink(&nodes, &c, 16.0, s).unwrap();
            assert_eq!((bare.full, bare.grants.clone()), (8.0, vec![4.0, 0.0, 0.0]));
            assert_eq!(shrink(&nodes, &c, 16.01, s), None);
        }
    }

    #[test]
    fn bottom_up_takes_the_deepest_first_and_top_down_the_shallowest() {
        // lead -> manager -> worker, each with 4 spare
        let nodes = vec![agent(None, 1.0, 10.0), agent(Some(0), 1.0, 5.0 + 4.0), agent(Some(1), 1.0, 4.0)];
        let c = cost(&nodes);
        assert_eq!(c.spare, [0.0, 4.0, 4.0], "the lead's 10 are all held by the manager's stake");
        let nodes = vec![agent(None, 1.0, 14.0), agent(Some(0), 1.0, 9.0), agent(Some(1), 1.0, 4.0)];
        let c = cost(&nodes);
        assert_eq!(c.spare, [4.0, 4.0, 4.0]);
        assert_eq!(shrink(&nodes, &c, 5.0, Shrink::BottomUp).unwrap().spare, [4.0, 3.0, 0.0]);
        assert_eq!(shrink(&nodes, &c, 5.0, Shrink::TopDown).unwrap().spare, [0.0, 3.0, 4.0]);
        assert_eq!(shrink(&nodes, &c, 5.0, Shrink::Even).unwrap().spare, [2.0, 2.0, 3.0]);
    }

    #[test]
    fn whole_grants_stay_whole_when_a_fraction_is_missing() {
        // a haiku seat costs half a credit, so the importer can be short of a fraction
        let nodes = vec![agent(None, 0.5, 10.0), agent(Some(0), 0.5, 3.0)];
        let c = cost(&nodes);
        assert_eq!((c.spare.clone(), c.full), (vec![6.5, 3.0], 10.5));
        for s in [Shrink::BottomUp, Shrink::TopDown, Shrink::Even] {
            let got = shrink(&nodes, &c, 1.5, s).unwrap();
            assert!(got.full <= 9.0 + 1e-9, "{s:?}: at least the 1.5 are gone ({})", got.full);
            assert!(got.full >= 8.5 - 1e-9, "{s:?}: and no more than the next whole credit ({})", got.full);
            assert_eq!(got.grants[1].fract(), 0.0, "{s:?}: the report's grant is whole");
        }
        // a spare below one credit is taken whole when nothing else is left
        let nodes = vec![agent(None, 1.0, 0.4)];
        assert_eq!(shrink(&nodes, &cost(&nodes), 0.3, Shrink::Even).unwrap().spare, [0.1]);
        assert_eq!(shrink(&nodes, &cost(&nodes), 0.3, Shrink::BottomUp).unwrap().spare, [0.0]);
    }

    #[test]
    fn a_project_holds_nothing_and_passes_costs_up() {
        // lead -> project -> two workers; and a project at the top with one agent under it
        let nodes = vec![
            agent(None, 4.0, 12.0),
            Seat { parent: Some(0), project: true, retired: false, seat: 0.0, grant: 0.0 },
            agent(Some(1), 2.0, 1.0),
            agent(Some(1), 2.0, 2.0),
            Seat { parent: None, project: true, retired: false, seat: 0.0, grant: 99.0 },
            agent(Some(4), 1.0, 3.0),
        ];
        let c = cost(&nodes);
        assert_eq!(c.grants, [12.0, 0.0, 1.0, 2.0, 0.0, 3.0]);
        assert_eq!(c.spare, [5.0, 0.0, 1.0, 2.0, 0.0, 3.0]);
        // the lead's stake and, through the top project, its agent's
        assert_eq!((c.full, c.seats), (16.0 + 4.0, 9.0));
        let got = shrink(&nodes, &c, 6.0, Shrink::BottomUp).unwrap();
        // depth 2: the last worker (2), then the first (1); then depth 1: the top project's agent (3)
        assert_eq!(got.spare, [5.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(got.full, 14.0);
    }

    #[test]
    fn a_grant_too_small_for_this_machines_seats_is_raised() {
        // exported where the reports' seats cost 1 each; here they cost 4
        let nodes = vec![agent(None, 4.0, 5.0), agent(Some(0), 4.0, 0.0), agent(Some(0), 4.0, 1.0)];
        let c = cost(&nodes);
        assert_eq!(c.grants, [9.0, 0.0, 1.0]);
        assert_eq!(c.spare, [0.0, 0.0, 1.0]);
        assert_eq!((c.full, c.seats), (13.0, 12.0));
    }

    #[test]
    fn a_retired_node_and_what_is_under_it_cost_nothing() {
        let mut nodes = example();
        nodes[1].retired = true;
        nodes.push(agent(Some(1), 2.0, 7.0));
        let c = cost(&nodes);
        assert_eq!(c.grants, [20.0, 0.0, 3.0, 0.0]);
        // the lead keeps its saved grant: 5 of it are held by B, the rest is spare
        assert_eq!(c.spare, [15.0, 0.0, 3.0, 0.0]);
        assert_eq!((c.full, c.seats), (24.0, 6.0));
        // a single exported agent keeps its saved grant whole, though its reports are not in the file
        let alone = cost(&[agent(None, 4.0, 20.0)]);
        assert_eq!((alone.spare.clone(), alone.full), (vec![20.0], 24.0));
    }

    #[test]
    fn even_takes_from_everyone_in_turn() {
        let nodes: Vec<Seat> = std::iter::once(agent(None, 1.0, 100.0)).chain((0..4).map(|i| agent(Some(0), 1.0, i as f64))).collect();
        let c = cost(&nodes);
        assert_eq!(c.spare, [90.0, 0.0, 1.0, 2.0, 3.0]);
        // 7: the first round takes 4 (one from each that has spare), the second the 3 still missing
        assert_eq!(shrink(&nodes, &c, 7.0, Shrink::Even).unwrap().spare, [88.0, 0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn a_top_agents_grant_comes_down_to_the_cap_out_of_its_own_team() {
        // a project over two leads: the first (grant 20) over A and B, the second (grant 6) alone
        let project = Seat { parent: None, project: true, retired: false, seat: 0.0, grant: 0.0 };
        let nodes = vec![project, agent(Some(0), 4.0, 20.0), agent(Some(1), 2.0, 5.0), agent(Some(1), 2.0, 3.0), agent(Some(0), 4.0, 6.0)];
        assert_eq!(top_agents(&nodes), [1, 4]);
        let c = cost(&nodes);
        assert_eq!(c.grants, [0.0, 20.0, 5.0, 3.0, 6.0]);
        // cap 15: the first lead's team gives 5; the second is under the cap and keeps what it has
        assert_eq!(cap_top(&nodes, &c, 15.0, Shrink::BottomUp).unwrap().grants, [0.0, 15.0, 3.0, 0.0, 6.0]);
        assert_eq!(cap_top(&nodes, &c, 15.0, Shrink::TopDown).unwrap().grants, [0.0, 15.0, 5.0, 3.0, 6.0]);
        // no cap, and a cap nobody reaches: nothing changes
        assert_eq!(cap_top(&nodes, &c, f64::INFINITY, Shrink::Even).unwrap(), c);
        assert_eq!(cap_top(&nodes, &c, 20.0, Shrink::Even).unwrap(), c);
        // the seats of its reports alone need a grant of 4
        assert_eq!(cap_top(&nodes, &c, 3.0, Shrink::BottomUp), Err(1));
        assert_eq!(cap_top(&nodes, &c, 4.0, Shrink::BottomUp).unwrap().grants, [0.0, 4.0, 0.0, 0.0, 4.0]);
        // a retired top agent is nobody's top agent, and an agent under an agent is not one either
        let mut retired = nodes.clone();
        retired[1].retired = true;
        assert_eq!(top_agents(&retired), [4]);
    }
}
