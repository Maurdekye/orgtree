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
    /// a project node (docs/rust-engine/PROJECT-NODES.md), with the mail
    /// waiting in its mailbox
    project: bool,
    waiting: i64,
    peer_mail: bool,
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
                    (SELECT coalesce(sum(c.seat + c.grant_credits), 0)::float8 FROM ot.agents c WHERE c.parent_id = a.id AND c.state = 'live'),
                    a.kind = 'project',
                    CASE WHEN a.kind = 'project' THEN (SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = a.id AND m.state = 'pending') ELSE 0 END, a.scope
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
            project: r.get(14),
            waiting: r.get(15),
            peer_mail: crate::domain::peer_mail::enabled(&r.get::<_,Value>(16)),
        })
        .collect())
}

fn line(r: &Row, busy: bool) -> String {
    let mut s = r.name.clone();
    s.push_str(if r.peer_mail { " ? subordinate peer mail ON" } else { " ? subordinate peer mail OFF (audiences required)" });
    if !r.title.is_empty() {
        s.push_str(&format!(" — {}", r.title));
    }
    if r.project {
        // provisional: how a project appears in the chart is still the user's to settle
        s.push_str(&format!(" · PROJECT node (runs no turns, holds no credits) · {} mail waiting", r.waiting));
    } else {
        s.push_str(&format!(" · {} · grant {} (seat {}, free {})", r.tier, r.grant, r.seat, crate::util::round2(r.grant - r.hold)));
    }
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

/// The user's own `orgtree_chart` (the standalone user MCP endpoint): the
/// whole org, no visibility narrowing and no "you are" header.
#[logged]
pub async fn chart_as_user(engine: &Arc<Engine>, org: &crate::orgs::OrgHandle, args: &Value) -> Result<Done> {
    let archived = args["include_archived"].as_bool().unwrap_or(false);
    let charters = args["include_standing_charter"].as_bool().unwrap_or(true);
    let all = rows(engine, org.id, archived).await?;
    let mut kids: HashMap<Option<i64>, Vec<&Row>> = HashMap::new();
    for r in all.iter() {
        kids.entry(r.parent).or_default().push(r);
    }
    let mut out = format!(
        "Organization {} ({}), as the user. Credits and seats are each agent's own.\n\nuser\n",
        org.name.load(), org.slug
    );
    let mut lines = 0usize;
    fn walk(
        out: &mut String,
        kids: &HashMap<Option<i64>, Vec<&Row>>,
        at: Option<i64>,
        prefix: &str,
        lines: &mut usize,
        charters: bool,
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
            out.push_str(&format!("{prefix}{}{}\n", if last { "└─ " } else { "├─ " }, line(r, r.busy)));
            *lines += 1;
            let child_prefix = format!("{prefix}{}", if last { "   " } else { "│  " });
            if charters {
                if let Some(tc) = r.team_charter.as_deref().filter(|t| !t.trim().is_empty()) {
                    out.push_str(&format!("{child_prefix}  team charter: {}\n", gist(tc, 300)));
                }
            }
            walk(out, kids, Some(r.id), &child_prefix, lines, charters);
        }
    }
    walk(&mut out, &kids, None, "", &mut lines, charters);
    Done::text(out)
}

/// Read-only scope evaluation over one coherent, paged structural snapshot.
#[logged]
fn inspection_scope(id: i64, rows: &HashMap<i64, (Option<i64>, Value)>, ceiling: &Value) -> Result<Value> {
    let mut chain = Vec::new();
    let mut next = Some(id);
    let mut seen = std::collections::HashSet::new();
    while let Some(at) = next {
        if chain.len() >= 1024 || !seen.insert(at) {
            crate::refuse!(Conflict, "invalid scope ancestry");
        }
        let Some((parent, sc)) = rows.get(&at) else {
            crate::refuse!(Conflict, "missing scope ancestor");
        };
        chain.push(sc);
        next = *parent;
    }
    let mut effective = ceiling.clone();
    for sc in chain.into_iter().rev() {
        effective = crate::domain::scope::clamp(sc, &effective);
    }
    Ok(effective)
}

#[logged]
fn inspection_visible(id: i64, caller: i64, visibility: &str, rows: &HashMap<i64, (Option<i64>, Value)>) -> bool {
    if id == caller || visibility == "full" { return true; }
    let (Some((parent, _)), Some((caller_parent, _))) = (rows.get(&id), rows.get(&caller)) else {
        return false;
    };
    // Match chart's superior/peer rows, including other top-level agents.
    // Reports at every depth are inspectable even with self visibility.
    if visibility != "self" && (Some(id) == *caller_parent || parent == caller_parent) {
        return true;
    }
    let mut next = Some(id);
    for _ in 0..=1024 {
        let Some(at) = next else { return false; };
        if at == caller { return true; }
        next = rows.get(&at).and_then(|r| r.0);
    }
    false
}

#[logged]
pub async fn state_inspect(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let archived = args["include_archived"].as_bool().unwrap_or(false);
    let mut names: Vec<String> = args["nodes"].as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    if let Some(n) = arg_str(args, "node") { names.push(n.to_string()); }
    for n in &mut names { *n = n.trim().trim_start_matches('@').to_string(); }
    names.retain(|n| !n.is_empty());
    let mut client = engine.db.get().await?;
    let tx = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::RepeatableRead).read_only(true).start().await?;
    let settings: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1", &[&caller.org_id]).await?.get(0);
    let settings = crate::feed::groups::effective_settings(&settings, &engine.settings.defaults());
    let ceiling = crate::domain::scope::org_ceiling(&settings["dirs"]);
    let mut scopes = HashMap::new();
    let mut records = Vec::new();
    let mut after = 0i64;
    loop {
        let page = tx.query(
            "SELECT a.id, a.parent_id, a.scope, jsonb_build_object(
              'id', a.name, 'name', a.name, 'parent', (SELECT name FROM ot.agents p WHERE p.id=a.parent_id),
              'title', a.title, 'state', a.state, 'generation', a.generation, 'model', a.tier, 'tier', a.tier,
              'sibling_order', a.sibling_order,
              'grant', a.grant_credits, 'seat_cost', a.seat, 'seat', a.seat, 'archived_at', a.archived_at,
              'free', CASE WHEN a.state='live' THEN a.grant_credits - (SELECT coalesce(sum(c.seat+c.grant_credits),0) FROM ot.agents c WHERE c.parent_id=a.id AND c.state='live') END,
              'account_binding', jsonb_build_object('present', coalesce(a.account,'')<>'', 'missing', coalesce(a.account,'') LIKE 'missing:%'),
              'frozen', CASE WHEN a.frozen IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('provider', a.frozen->'provider', 'cause', a.frozen->'cause', 'pool', a.frozen->'pool', 'until_ts', a.frozen->'until_ts')) END,
              'last_status', CASE WHEN a.last_status IS NOT NULL THEN jsonb_build_object('status', a.last_status->'status', 'at', a.last_status->'at') END,
              'pending_switch', CASE WHEN a.pending_switch IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('from', a.pending_switch->'from', 'tier', a.pending_switch->'tier', 'crossing', a.pending_switch->'crossing', 'at', a.pending_switch->'at')) END,
              'mid_turn', a.inflight_at IS NOT NULL, 'halted', a.halt IS NOT NULL,
              'limit_locked', a.limit_locked, 'occupancy', a.occupancy, 'context_window', a.context_window,
              'mail_waiting', (SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id=a.id AND m.state='pending'
                AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
                  AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable'
                  AND m.extra->>'transfer_failure' IS NULL)
                  OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id
                    AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb))))
              -- an OpenRouter seat: the harness its session runs on, and whether
              -- it is pinned to it (an explicit hire choice its key's changes skip)
              -- a project node (docs/rust-engine/PROJECT-NODES.md) says so
              || CASE WHEN a.kind='project' THEN jsonb_build_object('kind', 'project') ELSE '{}'::jsonb END
              || CASE WHEN a.provider='openrouter' AND a.extra ? 'harness' THEN jsonb_build_object('harness', a.extra->'harness',
                   'harness_pinned', coalesce((a.extra->>'harness_pin')::boolean, false)) ELSE '{}'::jsonb END
             FROM ot.agents a WHERE a.org_id=$1 AND a.state<>'deleted' AND a.id>$2 ORDER BY a.id LIMIT 256",
            &[&caller.org_id, &after]).await?;
        if page.is_empty() { break; }
        for r in page {
            let id: i64 = r.get(0);
            scopes.insert(id, (r.get(1), r.get(2)));
            records.push((id, r.get::<_, Value>(3)));
            after = id;
        }
    }
    tx.commit().await?;
    // Rank the complete live sibling set before visibility/name filtering.
    // Archived rows have no live index and do not consume an insertion slot.
    let mut siblings: HashMap<Option<i64>, Vec<(i64, f64)>> = HashMap::new();
    for (id, row) in &records {
        if row["state"] == "live" {
            siblings.entry(scopes[id].0).or_default().push((*id, row["sibling_order"].as_f64().unwrap_or(0.0)));
        }
    }
    let mut positions = HashMap::new();
    for list in siblings.values_mut() {
        list.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        for (index, (id, _)) in list.iter().enumerate() { positions.insert(*id, (index, list.len())); }
    }
    let own_scope = inspection_scope(caller.agent_id, &scopes, &ceiling)?;
    // the effective (ancestor-clamped) visibility decides what is shown, as
    // chart's (3.x capability_scope)
    let visibility = own_scope["org_visibility"].as_str().unwrap_or("team");
    let mut out = Vec::new();
    for (id, mut row) in records {
        if (!archived && row["state"] != "live") || !inspection_visible(id, caller.agent_id, visibility, &scopes) { continue; }
        if !names.is_empty() && !names.iter().any(|n| row["name"] == *n) { continue; }
        row["sibling_index"] = positions.get(&id).map(|p| json!(p.0)).unwrap_or(Value::Null);
        row["live_sibling_count"] = json!(siblings.get(&scopes[&id].0).map(Vec::len).unwrap_or(0));
        row["live_child_count"] = json!(siblings.get(&Some(id)).map(Vec::len).unwrap_or(0));
        let effective = inspection_scope(id, &scopes, &ceiling)?;
        let provider = catalog::provider_of(row["tier"].as_str().unwrap_or("")).to_string();
        row["provider"] = json!(provider);
        row["account_binding"]["provider"] = json!(provider);
        // the folders are the effective ones, as its CLI is started with them
        row["scope"] = json!({"org_visibility":effective["org_visibility"], "permission_mode":effective["permission_mode"],
            "tools": {"bash":effective["tools"]["bash"],"web":effective["tools"]["web"],"edit":effective["tools"]["edit"],"subagents":effective["tools"]["subagents"],"orgtree":effective["tools"]["orgtree"]}, "mcp":effective["tools"]["mcp"],
            "add_dirs": effective["add_dirs"]});
        row["visibility"] = effective["org_visibility"].clone();
        out.push(row);
    }
    for name in &names {
        if !out.iter().any(|r| r["name"] == *name) {
            crate::refuse!(Forbidden, "state inspection is outside your visible scope: {name}");
        }
    }
    Done::json(&json!({"actor":caller.name,"visibility":visibility,"nodes":out}))
}

#[logged]
pub async fn list_tiers(engine: &Arc<Engine>) -> Result<Done> {
    let mut out = Vec::new();
    for t in catalog::listed().iter().copied().filter(|t| !t.legacy) {
        if catalog::antigravity_claude(t.tier) && !engine.settings.antigravity_claude_enabled() { continue; }
        // Argon, Barium, Carbon: only while the account's `agy models` lists them
        if t.provider == catalog::GOOGLE && !crate::providers::agy_offered(engine, t.tier) { continue; }
        if !engine.settings.provider_enabled(t.provider) {
            continue;
        }
        out.push(json!({ "tier": t.tier, "provider": catalog::provider_label(t.provider), "seat": t.seat,
                         "model": t.model, "context": t.context }));
    }
    for (tier, seat, model) in engine.providers.openrouter_tiers() {
        out.push(json!({ "tier": tier, "provider": "OpenRouter", "seat": seat, "model": model }));
    }
    // the models offered on the user's own servers: local, nothing billed
    if engine.settings.provider_enabled(catalog::LANGSERVER) {
        for (tier, seat, model, _, server) in crate::langserver::tiers(engine) {
            let context = crate::langserver::route_of(engine, &tier).map(|(_, m)| crate::langserver::context_of(&m));
            out.push(json!({ "tier": tier, "provider": "Language Server", "seat": seat, "model": model,
                             "server": server, "context": context }));
        }
    }
    Done::json(&json!({ "tiers": out, "seat_floor": catalog::SEAT_FLOOR }))
}

#[logged]
pub async fn list_orgs(engine: &Arc<Engine>, caller: &Caller) -> Result<Done> {
    let client = engine.db.get().await?;
    // Public metadata only: never select the identity secret or full net blob.
    let rows = client.query("SELECT slug, name, net->'identity'->>'slug' FROM ot.orgs WHERE state='active' ORDER BY slug", &[]).await?;
    let locals: Vec<(String, String, Option<String>)> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();
    Done::json(&crate::net::discovery_rows(&caller.org_slug, &locals, crate::net::remote_peers(engine)))
}

#[logged]
pub async fn read_transcript(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let last = transcript_last(args)?;
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
    // The same persisted turn/occupancy fields used by chart and node views.
    // Reading an idle or archived transcript must never start its actor.
    let state = client.query_one(
        "SELECT inflight_at IS NOT NULL, occupancy, occupancy_est FROM ot.agents WHERE id = $1",
        &[&t.id],
    ).await?;
    let access = if t.id == me.id { json!({"via":"self"}) } else {
        json!({"via":"chart", "note":format!("{} is your descendant — the ordinary downward read (§7.6)", t.name)})
    };
    Done::json(&transcript_result(node, access, state.get(0), state.get(1), state.get(2), page.messages))
}

/// Match 3.x's numeric coercion, default and bounded recent-row argument.
#[logged]
fn transcript_last(args: &Value) -> Result<i64> {
    let raw = &args["last"];
    let number = match raw {
        Value::Null => return Ok(30),
        Value::String(s) if s.is_empty() => return Ok(30),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => raw.as_f64(),
    };
    match number.filter(|n| n.is_finite()) {
        Some(n) => Ok(n.clamp(1.0, 80.0) as i64),
        None => crate::refuse!(BadRequest, "last must be a number"),
    }
}

/// Text alone is capped; preserve the complete stored tool objects/cards.
#[logged]
fn transcript_result(node: &str, access: Value, busy: bool, occupancy: Option<i32>, occupancy_estimated: bool,
                     messages: Vec<Value>) -> Value {
    let messages: Vec<Value> = messages.into_iter().map(|m| json!({
        "role": m["role"],
        "text": m["text"].as_str().unwrap_or("").chars().take(1200).collect::<String>(),
        "tools": m.get("tools").cloned().unwrap_or_else(|| json!([])),
    })).collect();
    json!({"node":node, "access":access, "busy":busy, "occupancy":occupancy,
           "occupancy_estimated":occupancy_estimated, "messages":messages})
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
