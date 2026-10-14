//! Team workspaces: one shared folder per subtree, keyed to the agent at its
//! root (docket team-workspaces-a-shared-folder-per-subtree-visi). An agent
//! holds the workspace of every subtree it is inside, from its own team up
//! to the top ("full upward workspace access", user 2026-10-14 13:28Z),
//! beside the org-wide `_shared` folder; agents outside a subtree never hold
//! its workspace. Like the org folder, nothing is stored: the set is read
//! from the tree at each launch, so a move takes effect at the next CLI.

use std::path::PathBuf;

use anyhow::Result;

use crate::engine::Engine;

/// One team workspace an agent holds.
#[derive(Clone, Debug, PartialEq)]
pub struct Team {
    pub dir: PathBuf,
    /// the agent at the subtree's root, by id (rename-safe) and by name (for the prompt)
    pub root_id: i64,
    pub root: String,
    /// the subtree rooted at the agent itself
    pub own: bool,
}

/// The workspaces of `chain` (the agent first, then each ancestor up to the
/// top, as `(id, name)`), nearest first: its own subtree's, reports or not
/// (user 2026-10-14 13:55Z), then every ancestor's, whose subtree contains it.
#[logged]
pub fn workspaces(teams_root: &std::path::Path, chain: &[(i64, String)]) -> Vec<Team> {
    chain
        .iter()
        .enumerate()
        .map(|(i, (id, name))| Team { dir: teams_root.join(id.to_string()), root_id: *id, root: name.clone(), own: i == 0 })
        .collect()
}

/// The team workspaces `agent` holds right now.
#[logged]
pub async fn held(engine: &Engine, org_slug: &str, agent: i64) -> Result<Vec<Team>> {
    let client = engine.db.get().await?;
    let rows = client
        .query(
            "WITH RECURSIVE chain(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $1
               UNION ALL SELECT a.id, a.parent_id, c.depth + 1 FROM ot.agents a JOIN chain c ON a.id = c.parent_id
                WHERE c.depth < 1024)
             SELECT c.id, a.name FROM chain c JOIN ot.agents a ON a.id = c.id ORDER BY c.depth",
            &[&agent],
        )
        .await?;
    let chain: Vec<(i64, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    Ok(workspaces(&engine.cfg.teams_dir(org_slug), &chain))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain() -> Vec<(i64, String)> {
        vec![(7, "ivy".into()), (3, "lead".into()), (1, "boss".into())]
    }

    #[test]
    fn every_ancestor_subtree_nearest_first_keyed_by_id() {
        let root = std::path::Path::new("D:/data/scratch/org/_teams");
        let got = workspaces(root, &chain());
        assert_eq!(got.iter().map(|t| (t.root_id, t.root.as_str(), t.own)).collect::<Vec<_>>(),
                   vec![(7, "ivy", true), (3, "lead", false), (1, "boss", false)]);
        assert_eq!(got[1].dir, root.join("3"));
    }

    #[test]
    fn every_agent_has_its_own_workspace_reports_or_not() {
        // a top-level agent with no reports holds exactly its own
        let got = workspaces(std::path::Path::new("D:/t"), &chain()[2..]);
        assert_eq!(got.iter().map(|t| (t.root_id, t.own)).collect::<Vec<_>>(), vec![(1, true)]);
    }

    #[test]
    fn agents_outside_a_subtree_never_hold_it() {
        // a sibling under lead holds lead's and boss's, never ivy's
        let sibling = vec![(8, "oak".to_string()), (3, "lead".into()), (1, "boss".into())];
        let got = workspaces(std::path::Path::new("D:/t"), &sibling);
        assert!(!got.iter().any(|t| t.root_id == 7));
    }
}
