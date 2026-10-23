//! One bounded stage per sweep, with finite high-water marks. Keep only the
//! displayed rows plus a count per recipient, not every outstanding work row.
use std::collections::{HashMap, HashSet};
use anyhow::Result;
use tokio_postgres::GenericClient;
use super::{docket, Agents, WorkRow, MAX_ITEMS};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod reminder_history_tests;

pub(super) const AGENTS: i64 = 200;
const PAGE: i64 = 5000;
const UNFINISHED: &str = "archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean,false)
    AND status NOT IN ('done','superseded','dropped','backlogged')";

#[derive(Debug, Default, Clone)]
pub(super) struct Items {
    pub shown: Vec<WorkRow>,
    pub total: usize,
}

#[logged]
impl Items {
    #[nolog]
    fn push(&mut self, row: WorkRow) {
        self.total += 1;
        if self.shown.len() < MAX_ITEMS { self.shown.push(row); }
    }
}

#[derive(Default)]
pub(super) struct Sweep {
    initialized: bool,
    pub upper: i64,
    pub after: i64,
    docket_needed: bool,
    everyone: Agents,
    #[cfg(test)]
    routing_rows: usize,
    work_upper: Option<String>,
    work_after: Option<String>,
    work_done: bool,
    actionable: HashMap<String, Items>,
    blocked: HashMap<String, Items>,
}

// Hot page accumulator contains private work titles; log the enclosing sweep,
// never the accumulated payload on every step.
#[logged]
impl Sweep {
    #[nolog]
    pub async fn prepare(&mut self, client: &impl GenericClient, org: i64, docket_needed: bool) -> Result<bool> {
        if self.initialized && self.docket_needed != docket_needed { *self = Self::default(); }
        if !self.initialized {
            self.upper = client.query_one("SELECT coalesce(max(id),0) FROM ot.agents WHERE org_id=$1 AND state='live'", &[&org]).await?.get(0);
            self.docket_needed = docket_needed;
            if docket_needed {
                self.work_upper = client.query_one(&format!("SELECT max(slug) FROM ot.work_items WHERE org_id=$1 AND {UNFINISHED}"), &[&org]).await?.get(0);
            }
            self.initialized = true;
        }
        // Checkups (including sign-in checks) need no docket/reporting scan.
        if !docket_needed { return Ok(true); }
        if !self.work_done {
            if let Some(upper) = &self.work_upper {
                let rows = client.query(
                    &format!("SELECT w.slug,w.title,w.status,w.owner,w.owner_agent_id,w.reviewer,w.reviewer_agent_id,
                            w.manual_attention IS NOT NULL,
                            EXISTS (SELECT 1 FROM ot.asks k WHERE k.org_id=w.org_id AND k.status='open' AND w.slug=ANY(k.work_items))
                        FROM ot.work_items w WHERE org_id=$1 AND {UNFINISHED}
                          AND ($2::text IS NULL OR slug>$2) AND slug<=$3 ORDER BY slug LIMIT $4"),
                    &[&org,&self.work_after,&upper,&PAGE],
                ).await?;
                self.load_routing(client, org, &rows).await?;
                for r in &rows {
                    let status: String = r.get(2);
                    let owner: Option<serde_json::Value> = r.get(3);
                    let reviewer: Option<serde_json::Value> = r.get(5);
                    let (to,role) = docket::next_recipient(&status,owner.as_ref(),r.get(4),reviewer.as_ref(),r.get(6),&self.everyone);
                    let row = WorkRow {slug:r.get(0),title:r.get(1),status,to,role,attention:r.get::<_,bool>(7)||r.get::<_,bool>(8)};
                    self.work_after = Some(row.slug.clone());
                    self.add(row);
                }
                self.everyone.clear();
                if rows.len() == PAGE as usize { return Ok(false); }
            }
            self.work_done = true;
            self.everyone.clear();
        }
        Ok(true)
    }

    // Resolve only identities named by this active work page. Deployment
    // follows their contracted agent chain only as far as the first live
    // superior; unrelated retired history is never read or retained.
    #[nolog]
    async fn load_routing(&mut self, client: &impl GenericClient, org: i64, work: &[tokio_postgres::Row]) -> Result<()> {
        self.everyone.clear();
        let mut names = HashSet::new();
        for row in work {
            for column in [3, 5] {
                let reference: Option<serde_json::Value> = row.get(column);
                if let Some(name) = reference.as_ref().and_then(|v| v["node"].as_str()) { names.insert(name.to_owned()); }
            }
        }
        if names.is_empty() { return Ok(()); }
        let names: Vec<String> = names.into_iter().collect();
        let rows = client.query("SELECT name,id,state,superior_id FROM ot.agent_reporting
            WHERE org_id=$1 AND state<>'deleted' AND name=ANY($2)", &[&org,&names]).await?;
        self.record_routing(&rows);
        let mut pending = HashSet::new();
        for row in work {
            if row.get::<_,String>(2) != "deploy_ready" { continue; }
            let owner: Option<serde_json::Value> = row.get(3);
            let owner_id: Option<i64> = row.get(4);
            let Some(reference) = owner.as_ref().filter(|v| v["deleted"].as_bool() != Some(true)) else { continue };
            if let Some((id,state,Some(up))) = reference["node"].as_str().and_then(|name| self.everyone.get(name)) {
                if state == "live" && owner_id.is_none_or(|recorded| recorded == *id) { pending.insert(*up); }
            }
        }
        let mut visited = HashSet::new();
        while !pending.is_empty() {
            let ids: Vec<i64> = pending.drain().filter(|id| visited.insert(*id)).collect();
            if ids.is_empty() { break; }
            let rows = client.query("SELECT name,id,state,superior_id FROM ot.agent_reporting
                WHERE org_id=$1 AND state<>'deleted' AND id=ANY($2)", &[&org,&ids]).await?;
            for row in &rows {
                if row.get::<_,String>(2) != "live" {
                    if let Some(up) = row.get::<_,Option<i64>>(3) { pending.insert(up); }
                }
            }
            self.record_routing(&rows);
        }
        Ok(())
    }

    #[nolog]
    fn record_routing(&mut self, rows: &[tokio_postgres::Row]) {
        #[cfg(test)]
        { self.routing_rows += rows.len(); }
        for row in rows { self.everyone.insert(row.get(0),(row.get(1),row.get(2),row.get(3))); }
    }

    #[nolog]
    fn add(&mut self, row: WorkRow) {
        let Some(to) = row.to.clone() else { return };
        if row.status == "blocked" {
            self.blocked.entry(to).or_default().push(row);
        } else if !row.attention {
            self.actionable.entry(to).or_default().push(row);
        }
    }

    #[nolog]
    pub fn items(&self, name: &str, blocked: bool) -> Items {
        self.actionable.get(name).or_else(|| blocked.then(|| self.blocked.get(name)).flatten()).cloned().unwrap_or_default()
    }
}

/// A whole-org test, independent of page position and freshly checked before
/// the optional blocked wake. An empty unfinished set is never all blocked.
#[logged]
pub(super) async fn all_blocked(client: &impl GenericClient, org: i64) -> Result<bool> {
    Ok(client.query_one(&format!(
        "SELECT EXISTS(SELECT 1 FROM ot.work_items WHERE org_id=$1 AND {UNFINISHED})
            AND NOT EXISTS(SELECT 1 FROM ot.work_items WHERE org_id=$1 AND {UNFINISHED} AND status<>'blocked')"
    ), &[&org]).await?.get(0))
}

/// The same admission predicates as before, advanced through a finite ID range.
#[logged]
pub(super) async fn agent_rows(client: &impl GenericClient, org: i64, early: bool, after: i64, upper: i64) -> Result<Vec<tokio_postgres::Row>> {
    Ok(client
        .query(
            "SELECT a.id, a.name, a.generation, a.last_status, a.extra,
                    (SELECT greatest(t.started_at, t.ended_at) FROM ot.turns t WHERE t.agent_id = a.id ORDER BY t.id DESC LIMIT 1)
               FROM ot.agents a
              WHERE a.org_id = $1 AND a.state = 'live' AND a.kind = 'agent' AND a.halt IS NULL AND a.frozen IS NULL AND NOT a.limit_locked
                AND a.inflight_at IS NULL
                AND (NOT $3 OR coalesce(a.extra->>'session', 'session0') <> 'signed-in')
                AND NOT EXISTS (SELECT 1 FROM ot.turns t WHERE t.agent_id = a.id AND t.ended_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND m.recipient_agent_id = a.id
                                 AND (m.state = 'delivering' OR (m.state = 'pending' AND NOT m.notice)))
              AND a.id > $4 AND a.id <= $5 ORDER BY a.id LIMIT $2",
            &[&org, &AGENTS, &early, &after, &upper],
        )
        .await?)
}

#[nolog]
impl std::fmt::Debug for Sweep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReminderSweep").field("after",&self.after).field("upper",&self.upper)
            .field("docket_needed",&self.docket_needed).field("work_after",&self.work_after).finish_non_exhaustive()
    }
}
