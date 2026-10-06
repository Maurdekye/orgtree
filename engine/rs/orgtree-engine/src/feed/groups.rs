//! The twelve org header groups of the tree (`treeOrgGroups` in the
//! renderer). Their fields are disjoint; together they make the TreePayload
//! header.

use anyhow::Result;
use serde_json::{json, Map, Value};
use tokio_postgres::Client;

use crate::engine::Engine;
use crate::feed::compute;
use crate::providers::catalog;
use crate::util::iso_opt;

pub const GROUPS: &[&str] = &[
    "settings", "tiers", "cost", "audit", "foreground", "asks", "audiences", "watchdogs", "inbox_summary",
    "org_inbox", "net", "work_summary",
];

/// Org setting defaults (also what `/api/defaults` starts from).
#[logged]
pub fn setting_defaults() -> Value {
    json!({
        "max_top_grant": 1000,
        "default_top_grant": 20,
        "compact_at": 80,
        "default_tools": { "bash": true, "web": true, "edit": true, "subagents": true, "mcp": [] },
        "default_visibility": "subtree",
        "default_account": null,
        "permission_mode": "acceptEdits",
        "default_effort": "",
        "auto_resume": true,
        "auto_resume_compact": false,
        "auto_cheap_compact": { "enabled": false, "occ": 0.5 },
        "account_fallback_default": false,
        "cascade_hire": true,
        "cascade_alloc": true,
        "fable_limit_policy": "wait",
        "fable_filter_policy": "off",
        "fable_filter_model": null,
        "headless": false,
        "dirs": [],
        "org_inbox_multi_holder": false,
    })
}

/// The org's settings with every default filled in.
#[logged]
pub fn effective_settings(org_settings: &Value, app_defaults: &Map<String, Value>) -> Value {
    let mut out = setting_defaults();
    let obj = out.as_object_mut().unwrap();
    for (k, v) in app_defaults {
        obj.insert(k.clone(), v.clone());
    }
    if let Some(s) = org_settings.as_object() {
        for (k, v) in s {
            obj.insert(k.clone(), v.clone());
        }
    }
    out
}

#[logged]
pub async fn group(engine: &Engine, client: &Client, org: &Value, name: &str) -> Result<Value> {
    let org_id = org["id"].as_i64().unwrap_or(0);
    let slug = org["slug"].as_str().unwrap_or("");
    let settings = effective_settings(&org["settings"], &engine.settings.defaults());
    Ok(match name {
        "settings" => {
            let workspace = engine.cfg.workspace_dir(slug);
            json!({
                "slug": slug,
                "name": org["name"],
                "workspace": workspace.to_string_lossy(),
                "dirs": settings["dirs"],
                "max_top_grant": settings["max_top_grant"],
                "default_top_grant": settings["default_top_grant"],
                "compact_at": settings["compact_at"],
                "default_tools": settings["default_tools"],
                "default_visibility": settings["default_visibility"],
                "default_account": settings["default_account"],
                "permission_mode": settings["permission_mode"],
                "default_effort": settings["default_effort"],
                "effort_default": catalog::DEFAULT_EFFORT,
                "prefer_reserve_default": engine.settings.get().get("prefer_reserve_default").and_then(Value::as_bool).unwrap_or(true),
                "auto_resume": settings["auto_resume"],
                "auto_resume_compact": settings["auto_resume_compact"],
                "auto_cheap_compact": settings["auto_cheap_compact"],
                "account_fallback_default": settings["account_fallback_default"],
                "cascade_hire": settings["cascade_hire"],
                "cascade_alloc": settings["cascade_alloc"],
                "fable_limit_policy": settings["fable_limit_policy"],
                "fable_filter_policy": settings["fable_filter_policy"],
                "fable_filter_model": settings["fable_filter_model"],
                "fable_lock": Value::Null,
                "killswitch": org.get("killswitch").cloned().unwrap_or(Value::Null),
                "headless": settings["headless"],
                "primed_restart": Value::Null,
                "capabilities": { "record_changes_v1": true },
            })
        }
        "tiers" => {
            let mut tiers = Map::new();
            let mut models = Map::new();
            for t in catalog::TIERS {
                tiers.insert(t.tier.into(), json!(t.seat));
                models.insert(t.tier.into(), json!(t.model));
            }
            for (tier, seat, model) in engine.providers.openrouter_tiers() {
                tiers.insert(tier.clone(), json!(seat));
                models.insert(tier, json!(model));
            }
            json!({ "tiers": tiers, "models": models })
        }
        "cost" => {
            let r = client
                .query_one(
                    "SELECT coalesce(sum(cost_usd),0)::float8, bool_or(cost_unknown), coalesce(sum(api_cost_usd),0)::float8
                       FROM ot.agents WHERE org_id = $1",
                    &[&org_id],
                )
                .await?;
            json!({
                "cost_usd_total": r.get::<_, f64>(0),
                "cost_usd_unknown": r.get::<_, Option<bool>>(1).unwrap_or(false),
                "api_cost_usd_total": r.get::<_, f64>(2),
            })
        }
        "audit" => {
            let r = client
                .query_one(
                    "SELECT count(*) FILTER (WHERE state = 'live'),
                            coalesce(sum(seat + grant_credits) FILTER (WHERE state = 'live' AND parent_id IS NULL), 0)::float8
                       FROM ot.agents WHERE org_id = $1 AND state = 'live'",
                    &[&org_id],
                )
                .await?;
            let over: i64 = client
                .query_one(
                    "SELECT count(*) FROM ot.agents p
                      WHERE p.org_id = $1 AND p.state = 'live'
                        AND p.grant_credits < (SELECT coalesce(sum(c.seat + c.grant_credits),0) FROM ot.agents c
                                                WHERE c.parent_id = p.id AND c.state = 'live')",
                    &[&org_id],
                )
                .await?
                .get(0);
            json!({ "audit": {
                "live_nodes": r.get::<_, i64>(0),
                "top_level_holds": r.get::<_, f64>(1),
                "no_overdraft": over == 0,
                "problems": if over == 0 { json!([]) } else { json!([format!("{over} agents hold less than their reports")]) },
            }})
        }
        "foreground" => {
            let r = client
                .query_one(
                    "SELECT count(*), count(*) FILTER (WHERE parent_id IS NULL)
                       FROM ot.agents WHERE org_id = $1 AND state IN ('archived','unrecoverable')",
                    &[&org_id],
                )
                .await?;
            json!({ "retired_total": r.get::<_, i64>(0), "retired_roots_total": r.get::<_, i64>(1) })
        }
        "asks" => {
            let asks = compute::asks(client, org_id).await?;
            let open = asks.iter().filter(|a| a["status"] == "open").count();
            let credit_requests: Vec<Value> = asks
                .iter()
                .filter(|a| a["status"] == "open" && (a["kind"] == "credit" || a.get("credit").is_some()))
                .map(|a| {
                    json!({ "id": a["id"], "node": a["node"], "status": "pending",
                            "old": a.get("old").cloned().unwrap_or(Value::Null),
                            "new": a.get("new").cloned().unwrap_or(Value::Null),
                            "reason": a.get("reason").cloned().unwrap_or(Value::Null) })
                })
                .collect();
            json!({ "asks": asks, "asks_open": open, "credit_requests": credit_requests })
        }
        "audiences" => {
            let grants = client
                .query(
                    "SELECT grantee, grantor, granted_at, reason FROM ot.audiences
                      WHERE org_id = $1 AND revoked_at IS NULL ORDER BY id",
                    &[&org_id],
                )
                .await?;
            let reqs = client
                .query(
                    "SELECT requester, target, reason, at, holder FROM ot.audience_requests
                      WHERE org_id = $1 AND status = 'pending' ORDER BY id",
                    &[&org_id],
                )
                .await?;
            json!({
                "audiences": grants.iter().map(|r| json!({
                    "grantee": r.get::<_, String>(0), "grantor": r.get::<_, String>(1),
                    "granted_at": iso_opt(r.get(2)), "reason": r.get::<_, String>(3),
                })).collect::<Vec<_>>(),
                "audience_requests": reqs.iter().map(|r| json!({
                    "node": r.get::<_, String>(0), "from": r.get::<_, String>(0), "target": r.get::<_, String>(1),
                    "reason": r.get::<_, String>(2), "at": iso_opt(r.get(3)),
                    "currently_at": r.get::<_, Option<String>>(4).unwrap_or_else(|| r.get::<_, String>(1)),
                })).collect::<Vec<_>>(),
            })
        }
        "watchdogs" => {
            let rows = client
                .query(
                    "SELECT to_jsonb(w), a.name FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
                      WHERE w.org_id = $1 AND (w.state IN ('armed','paused')
                         OR (w.spent_at IS NOT NULL AND w.spent_at > now() - interval '15 seconds'))
                      ORDER BY w.id",
                    &[&org_id],
                )
                .await?;
            json!({ "watchdogs": rows.iter().map(|r| crate::domain::watchdogs::view(&r.get::<_, Value>(0), &r.get::<_, String>(1))).collect::<Vec<_>>() })
        }
        "inbox_summary" => {
            let r = client
                .query_one(
                    "SELECT count(*), count(*) FILTER (WHERE urgent), max(created_at)
                       FROM ot.mail WHERE org_id = $1 AND recipient_kind = 'user' AND state = 'pending'",
                    &[&org_id],
                )
                .await?;
            json!({
                "user_inbox_count": r.get::<_, i64>(0),
                "urgent_unread": r.get::<_, i64>(1),
                "user_inbox_newest": iso_opt(r.get(2)),
            })
        }
        "org_inbox" => {
            let preview = client
                .query(
                    "SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id = $1 ORDER BY id DESC LIMIT 3",
                    &[&org_id],
                )
                .await?;
            let counts = client
                .query_one(
                    "SELECT count(*), count(*) FILTER (WHERE dir = 'in' AND NOT read) FROM ot.org_inbox WHERE org_id = $1",
                    &[&org_id],
                )
                .await?;
            let holders: Vec<String> = client
                .query(
                    "SELECT grantee FROM ot.audiences WHERE org_id = $1 AND grantor = '@extern' AND revoked_at IS NULL ORDER BY id",
                    &[&org_id],
                )
                .await?
                .iter()
                .map(|r| r.get(0))
                .collect();
            let mut entries: Vec<Value> = preview.iter().map(|r| crate::domain::orginbox::entry(&r.get::<_, Value>(0))).collect();
            entries.reverse();
            let total: i64 = counts.get(0);
            json!({ "org_inbox": {
                "entries": entries,
                "total": total,
                "unread": counts.get::<_, i64>(1),
                "holders": holders,
                "multi_holder_enabled": settings["org_inbox_multi_holder"].as_bool().unwrap_or(false),
                "visible": total > 0 || !holders.is_empty(),
            }})
        }
        "net" => {
            json!({ "net": engine.hub.net_block(org) })
        }
        "work_summary" => {
            let r = client
                .query_one(
                    "SELECT count(*) FILTER (WHERE manual_attention IS NOT NULL),
                            count(*) FILTER (WHERE status NOT IN ('done','superseded','dropped','backlogged'))
                       FROM ot.work_items WHERE org_id = $1 AND archived_at IS NULL",
                    &[&org_id],
                )
                .await?;
            let raises = client
                .query(
                    "SELECT slug, (manual_attention->>'set_rev')::bigint FROM ot.work_items
                      WHERE org_id = $1 AND archived_at IS NULL AND manual_attention IS NOT NULL",
                    &[&org_id],
                )
                .await?;
            let question_items: i64 = client
                .query_one(
                    "SELECT count(DISTINCT w) FROM ot.asks k, unnest(k.work_items) w
                      WHERE k.org_id = $1 AND k.status = 'open'",
                    &[&org_id],
                )
                .await?
                .get(0);
            json!({ "work_items_summary": {
                "attention": r.get::<_, i64>(0) + question_items,
                "active": r.get::<_, i64>(1),
                "raises": raises.iter().map(|x| json!([x.get::<_, String>(0), x.get::<_, Option<i64>>(1).unwrap_or(1)])).collect::<Vec<_>>(),
            }})
        }
        _ => json!({}),
    })
}
