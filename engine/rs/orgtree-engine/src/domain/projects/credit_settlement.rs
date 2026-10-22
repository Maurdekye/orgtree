//! Aggregate each live project once; actual agents are credit-frontier leaves.
use std::collections::HashMap;
use anyhow::{anyhow, Result};
use rust_decimal::Decimal;

// Hot pure aggregation: do not log the complete active ledger as arguments.
#[nolog]
pub(super) fn totals(nodes: Vec<(i64, Option<i64>, bool, Decimal)>) -> Result<Vec<(i64, Decimal)>> {
    // parent, unfinished child projects, direct-agent/finished-project stake.
    let mut projects: HashMap<_, _> = nodes.iter().filter(|n| n.2)
        .map(|n| (n.0, (n.1, 0_usize, Decimal::ZERO))).collect();
    for (_, parent, project, stake) in &nodes {
        if let Some(p) = parent.and_then(|id| projects.get_mut(&id)) {
            if *project { p.1 += 1; }
            else { p.2 = p.2.checked_add(*stake).ok_or_else(|| anyhow!("project credit total overflow"))?; }
        }
    }
    let mut ready: Vec<_> = projects.iter().filter(|(_, p)| p.1 == 0).map(|(id, _)| *id).collect();
    let mut out = Vec::with_capacity(projects.len());
    while let Some(id) = ready.pop() {
        let (parent, _, stake) = projects[&id];
        out.push((id, stake));
        if let Some(p) = parent.and_then(|id| projects.get_mut(&id)) {
            p.2 = p.2.checked_add(stake).ok_or_else(|| anyhow!("project credit total overflow"))?;
            p.1 -= 1;
            if p.1 == 0 { ready.push(parent.unwrap()); }
        }
    }
    if out.len() != projects.len() {
        crate::refuse!(Conflict, "project credit hierarchy contains a cycle; settlement was not applied");
    }
    out.sort_unstable_by_key(|p| p.0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[nolog]
    fn deep_projects_ignore_stale_mirrors_and_preserve_exact_fractions() {
        let mut nodes = vec![(0, None, false, Decimal::from(100))];
        for id in 1..=5000 { nodes.push((id, Some(id-1), true, Decimal::from(999))); }
        nodes.push((5001, Some(5000), false, Decimal::new(123, 2)));
        nodes.push((5002, Some(2500), false, Decimal::new(77, 2)));
        let actual = totals(nodes).unwrap();
        assert_eq!(actual.len(), 5000);
        for (id, stake) in actual {
            assert_eq!(stake, if id <= 2500 { Decimal::from(2) } else { Decimal::new(123, 2) });
        }
    }

    #[test]
    #[nolog]
    fn agents_stop_the_frontier_and_empty_projects_have_zero_stake() {
        let actual = totals(vec![(1,None,true,Decimal::from(99)),
            (2,Some(1),false,Decimal::new(125,2)),(3,Some(2),true,Decimal::from(99)),
            (4,Some(3),false,Decimal::from(8)),(5,Some(1),true,Decimal::from(99))]).unwrap();
        assert_eq!(actual, vec![(1,Decimal::new(125,2)),(3,Decimal::from(8)),(5,Decimal::ZERO)]);
    }

    #[test]
    #[nolog]
    fn project_cycles_refuse_without_partial_totals() {
        for nodes in [vec![(1,Some(1),true,Decimal::ZERO)],
            vec![(1,Some(2),true,Decimal::ZERO),(2,Some(1),true,Decimal::ZERO),
                 (3,None,true,Decimal::ZERO)]] {
            assert!(totals(nodes).unwrap_err().to_string().contains("cycle"));
        }
    }
}
