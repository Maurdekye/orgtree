//! Read-only views: chart, state, tiers, orgs, transcripts, scratch folders.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::{arg_str, downward, me, need_str, target, visible, Done};
use crate::engine::Engine;
use crate::providers::catalog;
use crate::runtime::Caller;
use crate::util::{gist, parse_ts};

struct Row {
    id: i64,
    name: String,
    parent: Option<i64>,
    title: String,
    tier: String,
    state: String,
    status: Value,
    grant: f64,
    seat: f64,
    halted: bool,
    frozen: bool,
    busy: bool,
    team_charter: Option<String>,
    hold: f64,
}

fn age(at: Option<DateTime<Utc>>) -> String {
    let Some(at) = at else { return String::new() };
    let s = (Utc::now() - at).num_seconds().max(0);
    if s < 90 {
        format!("{s}s ago")
    } else if s < 5400 {
        format!("{}m ago", s / 60)
    } else if s < 172_800 {
        format!("{}h ago", s / 3600)
    } else {
        format!("{}d ago", s / 86_400)
    }
}

#[logged]
async fn rows(engine: &Engine, org_id: i64, archived: bool) -> Result<Vec<Row>> {
    let client = engine.db.get().await?;
    let rs = client
        .query(
            "SELECT a.id, a.name, a.parent_id, a.title, a.tier, a.state, a.last_status, a.grant_credits::float8, a.seat::float8,
                    a.halt IS NOT NULL, a.frozen IS NOT NULL, a.inflight_at IS NOT NULL, a.team_charter,
                    (SELECT coalesce(sum(c.seat + c.grant_credits), 0)::float8 FROM ot.agents c WHERE c.parent_id = a.id AND c.state = 'live')
               FROM ot.agents a
              WHERE a.org_id = $1 AND (a.state = 'live' OR ($2 AND a.state IN ('archived', 'unrecoverable')))
              ORDER BY a.sibling_order, a.id",
            &[&org_id, &archived],
        )
        .await?;
    Ok(rs
        .iter()
        .map(|r| Row {
            id: r.get(0),
            name: r.get(1),
            parent: r.get(2),
            title: r.get(3),
            tier: r.get(4),
            state: r.get(5),
            status: r.get::<_, Option<Value>>(6).unwrap_or(Value::Null),
            grant: r.get(7),
            seat: r.get(8),
            halted: r.get(9),
            frozen: r.get(10),
            busy: r.get(11),
            team_charter: r.get(12),
            hold: r.get(13),
        })
        .collect())
}

fn line(r: &Row, busy: bool) -> String {
    let mut s = r.name.clone();
    if !r.title.is_empty() {
        s.push_str(&format!(" — {}", r.title));
    }
    s.push_str(&format!(" · {} · grant {} (seat {}, free {})", r.tier, r.grant, r.seat, crate::util::round2(r.grant - r.hold)));
    if r.state != "live" {
        s.push_str(&format!(" · {}", r.state));
    }
    if let Some(st) = r.status.get("status").and_then(Value::as_str) {
        let at = r.status.get("at").and_then(Value::as_str).and_then(parse_ts);
        let summary = r.status.get("summary").and_then(Value::as_str).unwrap_or("");
        s.push_str(&format!(" · {st} ({}): {}", age(at), gist(summary, 140)));
    }
    if busy {
        s.push_str(" · ▶ mid-turn");
    }
    if r.halted {
        s.push_str(" · halted");
    }
    if r.frozen {
        s.push_str(" · frozen (usage limit)");
    }
    s
}

#[logged]
pub async fn chart(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let archived = args["include_archived"].as_bool().unwrap_or(false);
    let charters = args["include_standing_charter"].as_bool().unwrap_or(true);
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let vis = visible(&client, &me).await?;
    drop(client);
    let all = rows(engine, me.org_id, archived).await?;
    let by_id: HashMap<i64, &Row> = all.iter().map(|r| (r.id, r)).collect();
    let shown = |id: i64| vis.as_ref().map(|v| v.contains(&id)).unwrap_or(true);
    // a shown agent hangs under its nearest shown ancestor
    let mut kids: HashMap<Option<i64>, Vec<&Row>> = HashMap::new();
    for r in all.iter().filter(|r| shown(r.id)) {
        let mut p = r.parent;
        while let Some(pid) = p {
            if shown(pid) && by_id.contains_key(&pid) {
                break;
            }
            p = by_id.get(&pid).and_then(|x| x.parent);
        }
        kids.entry(p).or_default().push(r);
    }
    let mut out = String::new();
    let mine = by_id.get(&me.id);
    if let Some(m) = mine {
        out.push_str(&format!(
            "You are {} (visibility: {}). Credits: grant {}, seat {}, free {}.\n\n",
            m.name, me.visibility, m.grant, m.seat, crate::util::round2(m.grant - m.hold)
        ));
    }
    out.push_str("user\n");
    let mut lines = 0usize;
    fn walk(
        out: &mut String,
        kids: &HashMap<Option<i64>, Vec<&Row>>,
        at: Option<i64>,
        prefix: &str,
        lines: &mut usize,
        charters: bool,
        me: i64,
    ) {
        let Some(list) = kids.get(&at) else { return };
        for (i, r) in list.iter().enumerate() {
            if *lines >= 600 {
                if *lines == 600 {
                    out.push_str(&format!("{prefix}… (more agents not shown)\n"));
                    *lines += 1;
                }
                return;
            }
            let last = i + 1 == list.len();
            let marker = if r.id == me { " ← you" } else { "" };
            out.push_str(&format!("{prefix}{}{}{}\n", if last { "└─ " } else { "├─ " }, line(r, r.busy), marker));
            *lines += 1;
            let child_prefix = format!("{prefix}{}", if last { "   " } else { "│  " });
            if charters {
                if let Some(tc) = r.team_charter.as_deref().filter(|t| !t.trim().is_empty()) {
                    out.push_str(&format!("{child_prefix}  team charter: {}\n", gist(tc, 300)));
                }
            }
            walk(out, kids, Some(r.id), &child_prefix, lines, charters, me);
        }
    }
    walk(&mut out, &kids, None, "", &mut lines, charters, me.id);
    if !archived {
        let client = engine.db.get().await?;
        let n: i64 = client
            .query_one(
                "SELECT count(*) FROM ot.agents WHERE org_id = $1 AND state IN ('archived', 'unrecoverable')",
                &[&me.org_id],
            )
            .await?
            .get(0);
        if n > 0 {
            out.push_str(&format!("\n{n} retired agents (include_archived: true lists them; rehiring restores their context).\n"));
        }
    }
    Done::text(out)
}

#[logged]
pub async fn state_inspect(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let archived = args["include_archived"].as_bool().unwrap_or(false);
    let mut names: Vec<String> = args["nodes"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if let Some(n) = arg_str(args, "node") {
        names.push(n.to_string());
    }
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let vis = visible(&client, &me).await?;
    let rs = client
        .query(
            "SELECT id, name, parent_id, state, tier, account, title, last_status, halt, frozen, limit_locked,
                    inflight_at IS NOT NULL, grant_credits::float8, seat::float8, occupancy, context_window, generation,
                    coalesce(scope->>'org_visibility', 'subtree'), (SELECT name FROM ot.agents p WHERE p.id = a.parent_id),
                    (SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = a.id AND m.state = 'pending')
               FROM ot.agents a WHERE org_id = $1 AND (state = 'live' OR ($2 AND state IN ('archived','unrecoverable')))
              ORDER BY id",
            &[&me.org_id, &archived],
        )
        .await?;
    let mut out = Vec::new();
    for r in rs {
        let id: i64 = r.get(0);
        let name: String = r.get(1);
        if vis.as_ref().map(|v| !v.contains(&id)).unwrap_or(false) {
            continue;
        }
        if !names.is_empty() && !names.iter().any(|n| n.trim_start_matches('@') == name) {
            continue;
        }
        let running = engine.agents.get(id).map(|h| h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false));
        out.push(json!({
            "name": name, "parent": r.get::<_, Option<String>>(18), "state": r.get::<_, String>(3),
            "tier": r.get::<_, String>(4), "account": r.get::<_, Option<String>>(5), "title": r.get::<_, String>(6),
            "last_status": r.get::<_, Option<Value>>(7), "halt": r.get::<_, Option<Value>>(8),
            "frozen": r.get::<_, Option<Value>>(9), "limit_locked": r.get::<_, bool>(10),
            "mid_turn": running.unwrap_or(r.get::<_, bool>(11)), "grant": r.get::<_, f64>(12), "seat": r.get::<_, f64>(13),
            "occupancy": r.get::<_, Option<i32>>(14), "context_window": r.get::<_, Option<i32>>(15),
            "generation": r.get::<_, i32>(16), "visibility": r.get::<_, String>(17), "mail_waiting": r.get::<_, i64>(19),
        }));
    }
    Done::json(&json!({ "agents": out }))
}

#[logged]
pub async fn list_tiers(engine: &Arc<Engine>) -> Result<Done> {
    let mut out = Vec::new();
    for t in catalog::TIERS.iter().filter(|t| !t.legacy) {
        if !engine.settings.provider_enabled(t.provider) {
            continue;
        }
        out.push(json!({ "tier": t.tier, "provider": catalog::provider_label(t.provider), "seat": t.seat,
                         "model": t.model, "context": t.context }));
    }
    for (tier, seat, model) in engine.providers.openrouter_tiers() {
        out.push(json!({ "tier": tier, "provider": "OpenRouter", "seat": seat, "model": model }));
    }
    Done::json(&json!({ "tiers": out, "seat_floor": catalog::SEAT_FLOOR }))
}

#[logged]
pub async fn list_orgs(engine: &Arc<Engine>, caller: &Caller) -> Result<Done> {
    let orgs: Vec<Value> = engine
        .orgs
        .all()
        .into_iter()
        .filter(|o| o.id != caller.org_id)
        .map(|o| json!({ "slug": o.slug, "name": o.name.load().as_str(), "address": format!("@org:{}", o.slug) }))
        .collect();
    let remote = crate::net::remote_peers(engine);
    Done::json(&json!({ "orgs": orgs, "remote": remote }))
}

#[logged]
pub async fn read_transcript(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let last = args["last"].as_i64().unwrap_or(20).clamp(1, 80);
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let t = target(&client, me.org_id, node).await?;
    if t.id != me.id {
        downward(&client, &me, &t, "read the transcript of").await?;
    }
    if let Err(err) = crate::runtime::history::ensure(engine, t.id).await {
        tracing::warn!(agent = t.id, error = %format!("{err:#}"), "earlier history could not be imported");
    }
    let page = crate::runtime::convo::read(&client, t.id, last, None, None).await?;
    let mut out = String::new();
    for m in page.messages {
        let role = m["role"].as_str().unwrap_or("?");
        let ts = m["ts"].as_str().unwrap_or("");
        let text = m["text"].as_str().unwrap_or("");
        out.push_str(&format!("[{ts}] {role}: {}\n", gist(text, 1500)));
        for tool in m["tools"].as_array().cloned().unwrap_or_default() {
            out.push_str(&format!(
                "    · {} {}{}\n",
                tool["name"].as_str().unwrap_or("tool"),
                tool["arg"].as_str().unwrap_or(""),
                tool.get("error").and_then(Value::as_str).map(|e| format!(" ⊘ {}", gist(e, 200))).unwrap_or_default()
            ));
        }
    }
    if out.is_empty() {
        out = format!("{} has no conversation yet.", t.name);
    }
    Done::text(out)
}

#[logged]
pub async fn read_scratch(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let t = target(&client, me.org_id, node).await?;
    if t.id != me.id {
        downward(&client, &me, &t, "read the folder of").await?;
    }
    let root = super::mailtools::scratch_of(engine, &client, caller, t.id).await?;
    drop(client);
    let rel = arg_str(args, "path").unwrap_or("");
    let path = root.join(rel.trim_start_matches(['/', '\\']));
    let canon_root = std::fs::canonicalize(&root).unwrap_or(root.clone());
    let canon = std::fs::canonicalize(&path).unwrap_or(path.clone());
    if !canon.starts_with(&canon_root) {
        crate::refuse!(Forbidden, "that path is outside {}'s folder", t.name);
    }
    if canon.is_dir() {
        let mut entries: Vec<String> = std::fs::read_dir(&canon)?
            .flatten()
            .map(|e| {
                let dir = e.file_type().map(|f| f.is_dir()).unwrap_or(false);
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                if dir {
                    format!("{}/", e.file_name().to_string_lossy())
                } else {
                    format!("{} ({size} bytes)", e.file_name().to_string_lossy())
                }
            })
            .collect();
        entries.sort();
        return Done::text(format!("{}:\n{}", canon.display(), entries.join("\n")));
    }
    let bytes = match std::fs::read(&canon) {
        Ok(b) => b,
        Err(_) => crate::refuse!(NotFound, "{rel} does not exist in {}'s folder", t.name),
    };
    let text = String::from_utf8_lossy(&bytes);
    let (clipped, cut) = crate::runtime::convo::clip(&text, 60_000);
    Done::text(if cut { format!("{clipped}\n… (file continues; {} bytes in all)", bytes.len()) } else { clipped })
}
