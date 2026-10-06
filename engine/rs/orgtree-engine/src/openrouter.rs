//! The OpenRouter lane: one stored key (never returned once stored), the
//! model catalog the picker searches, favorites that become hireable tiers
//! (`or-<model>`), the credit standing, and which CLI drives OpenRouter
//! agents (Claude Code against OpenRouter's Anthropic-compatible endpoint,
//! or Codex with OpenRouter as its model provider).

use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use arc_swap::ArcSwap;
use serde_json::{json, Map, Value};

use crate::engine::Engine;
use crate::util::iso;

/// the hidden registry row whose secret is the key
pub const ACCOUNT_ID: &str = "openrouter-key";
pub const API_BASE: &str = "https://openrouter.ai/api/v1";
/// what Claude Code is pointed at (it appends /v1/messages)
pub const ANTHROPIC_BASE: &str = "https://openrouter.ai/api";
pub const TIER_PREFIX: &str = "or-";
const CATALOG_TTL: Duration = Duration::from_secs(3600);
const USER_AGENT: &str = concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"));

type Catalog = Option<(Instant, Arc<Vec<Value>>)>;
static CATALOG: LazyLock<ArcSwap<Catalog>> = LazyLock::new(|| ArcSwap::from_pointee(None));

/// The stored key (a secret: never logged, never returned to a window).
pub async fn key(engine: &Engine) -> Option<String> {
    let client = engine.db.get().await.ok()?;
    client
        .query_opt("SELECT secret FROM ot.account_secrets WHERE account_id = $1", &[&ACCOUNT_ID])
        .await
        .ok()
        .flatten()
        .map(|r| r.get(0))
}

/// Store a pasted key (store first: it is the user's only copy here).
pub async fn set_key(engine: &Engine, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        crate::refuse!(BadRequest, "paste an OpenRouter API key");
    }
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    tx.execute(
        "INSERT INTO ot.accounts (id, provider, kind, label, auth, enabled) VALUES ($1, 'openrouter', 'apikey', 'OpenRouter', 'unobserved', true)
         ON CONFLICT (id) DO NOTHING",
        &[&ACCOUNT_ID],
    )
    .await?;
    tx.execute(
        "INSERT INTO ot.account_secrets (account_id, secret) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET secret = EXCLUDED.secret",
        &[&ACCOUNT_ID, &key],
    )
    .await?;
    tx.commit().await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "key_set": true } })).await?;
    Ok(())
}

#[logged]
pub async fn clear_key(engine: &Engine) -> Result<()> {
    let mut client = engine.db.get().await?;
    client.execute("DELETE FROM ot.accounts WHERE id = $1", &[&ACCOUNT_ID]).await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "key_set": false, "label": null } })).await?;
    Ok(())
}

/// The `or-<model>` tier of a catalog model.
#[logged]
pub fn tier_name(model: &str) -> String {
    let mut out = String::from(TIER_PREFIX);
    let mut dash = false;
    for c in model.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if dash && out.len() > TIER_PREFIX.len() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out
}

/// The seat rule: dollars per million input tokens, floored at or above $1,
/// two decimals below it, never under 0.10 (a free model is not free to seat).
#[logged]
pub fn seat_for(prompt_per_m: f64) -> f64 {
    if prompt_per_m >= 1.0 {
        (prompt_per_m + 1e-9).floor()
    } else {
        ((prompt_per_m * 100.0).round() / 100.0).max(0.10)
    }
}

fn hue_of(vendor: &str) -> f64 {
    match vendor {
        "anthropic" => 40.0,
        "openai" => 175.0,
        "google" => 262.0,
        "mistralai" => 54.0,
        "nvidia" => 131.0,
        "perplexity" => 209.0,
        "meta-llama" => 238.0,
        "moonshotai" => 246.0,
        "amazon" => 254.0,
        "cohere" => 272.0,
        "deepseek" => 282.0,
        "qwen" => 292.0,
        "x-ai" => -1.0,
        "microsoft" => 190.0,
        _ => (vendor.bytes().fold(7u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32)) % 360) as f64,
    }
}

/// The card color: the vendor's hue (xAI is black).
fn color_of(vendor: &str) -> String {
    let h = hue_of(vendor);
    if h < 0.0 {
        return "#111111".into();
    }
    let (s, l) = (0.55f64, 0.45f64);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h / 60.0) as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    format!("#{:02x}{:02x}{:02x}", ((r + m) * 255.0) as u8, ((g + m) * 255.0) as u8, ((b + m) * 255.0) as u8)
}

fn per_m(v: &Value) -> Option<f64> {
    v.as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| v.as_f64())
        .map(|p| (p * 1e6 * 1e4).round() / 1e4)
        .filter(|p| p.is_finite() && *p >= 0.0)
}

/// Whether a harness can run the entry: no batch variants, text out, priced.
fn runnable(m: &Value) -> bool {
    let id = m["id"].as_str().unwrap_or("");
    let outs = m.pointer("/architecture/output_modalities").and_then(Value::as_array);
    !id.is_empty()
        && !id.ends_with(":batch")
        && outs.map(|o| o.is_empty() || o.iter().any(|x| x == "text")).unwrap_or(true)
        && m["pricing"].as_object().map(|p| !p.is_empty()).unwrap_or(false)
}

/// One catalog record as the picker (and a favorite's tier) shows it.
fn card(raw: &Value, favorites: &[String]) -> Value {
    let id = raw["id"].as_str().unwrap_or("").to_string();
    let vendor = id.split('/').next().unwrap_or("").to_string();
    let label = id.split_once('/').map(|(_, m)| m.to_string()).unwrap_or_else(|| id.clone());
    let name = raw["name"].as_str().map(|n| n.split_once(": ").map(|(_, r)| r.to_string()).unwrap_or_else(|| n.to_string())).unwrap_or_else(|| label.clone());
    let p = &raw["pricing"];
    let prompt = per_m(&p["prompt"]);
    let completion = per_m(&p["completion"]);
    let cache_read = per_m(&p["input_cache_read"]);
    let mut unknown = Vec::new();
    if prompt.is_none() {
        unknown.push("prompt");
    }
    if completion.is_none() {
        unknown.push("completion");
    }
    let params: Vec<&str> = raw["supported_parameters"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let declared = raw["supported_parameters"].is_array();
    let tools = if declared { Some(params.contains(&"tools")) } else { None };
    let reasoning = if declared { Some(params.contains(&"reasoning")) } else { None };
    let image = raw.pointer("/architecture/input_modalities").and_then(Value::as_array).map(|a| a.iter().any(|m| m == "image"));
    let first = label.split([':', '-', '_', '.', '/', ' ']).find(|t| !t.is_empty()).unwrap_or("?");
    let mut out = json!({
        "id": id, "name": name, "label": label, "vendor": vendor,
        "prompt": prompt.unwrap_or(0.0), "completion": completion.unwrap_or(0.0), "cache_read": cache_read.unwrap_or(0.0),
        "context": raw["context_length"].as_i64().unwrap_or(0), "tools": tools, "image": image, "reasoning": reasoning,
        "free": id.ends_with(":free") || (prompt == Some(0.0) && completion == Some(0.0)),
        "created": raw["created"].as_i64().unwrap_or(0),
        "letter": first.chars().next().map(|c| c.to_ascii_uppercase().to_string()).unwrap_or_else(|| "?".into()),
        "color": color_of(&vendor), "accent": null, "selected": favorites.contains(&id),
    });
    if !unknown.is_empty() {
        out["price_unknown"] = json!(unknown);
    }
    out
}

/// The catalog (cached an hour; a failed refresh keeps the last one).
#[logged]
pub async fn catalog(force: bool) -> Result<Arc<Vec<Value>>> {
    if let Some((at, models)) = CATALOG.load().as_ref() {
        if !force && at.elapsed() < CATALOG_TTL {
            return Ok(models.clone());
        }
    }
    let fetched: Result<Vec<Value>> = async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent(USER_AGENT).build()?;
        let body: Value = client.get(format!("{API_BASE}/models")).send().await?.error_for_status()?.json().await?;
        Ok(body["data"].as_array().map(|a| a.iter().filter(|m| runnable(m)).cloned().collect()).unwrap_or_default())
    }
    .await;
    match fetched {
        Ok(models) if !models.is_empty() => {
            let models = Arc::new(models);
            CATALOG.store(Arc::new(Some((Instant::now(), models.clone()))));
            Ok(models)
        }
        Ok(_) | Err(_) => match CATALOG.load().as_ref() {
            Some((_, models)) => Ok(models.clone()),
            None => Err(anyhow!("the OpenRouter catalog could not be read")),
        },
    }
}

fn favorites_doc(engine: &Engine) -> Vec<Value> {
    engine.settings.get().pointer("/openrouter/favorites").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// A page of the picker: search, sort and optional vendor grouping.
#[logged]
pub async fn search(engine: &Engine, q: &str, offset: usize, limit: usize, sort: &str, order: &str, group: bool) -> Result<Value> {
    let models = catalog(false).await?;
    let favs: Vec<String> = favorites_doc(engine).iter().filter_map(|f| f["model"].as_str().map(str::to_string)).collect();
    let ql = q.trim().to_lowercase();
    let mut rows: Vec<(i32, Value)> = models
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str().unwrap_or("").to_lowercase();
            let name = m["name"].as_str().unwrap_or("").to_lowercase();
            let rank = if ql.is_empty() {
                0
            } else if id == ql || id.split('/').nth(1) == Some(ql.as_str()) {
                0
            } else if id.contains(&ql) {
                1
            } else if name.contains(&ql) {
                2
            } else {
                return None;
            };
            Some((rank, card(m, &favs)))
        })
        .collect();
    let sort = match sort {
        "input" | "output" | "recency" => sort,
        _ => "relevance",
    };
    let desc = match order {
        "asc" => false,
        "desc" => true,
        _ => sort == "recency",
    };
    let key = |v: &Value| -> f64 {
        match sort {
            "input" => v["prompt"].as_f64().unwrap_or(0.0),
            "output" => v["completion"].as_f64().unwrap_or(0.0),
            "recency" => v["created"].as_f64().unwrap_or(0.0),
            _ => 0.0,
        }
    };
    if sort == "relevance" {
        rows.sort_by(|a, b| a.0.cmp(&b.0));
    } else {
        rows.sort_by(|a, b| {
            let o = key(&a.1).partial_cmp(&key(&b.1)).unwrap_or(std::cmp::Ordering::Equal);
            if desc { o.reverse() } else { o }
        });
    }
    let mut items: Vec<Value> = rows.into_iter().map(|(_, v)| v).collect();
    if group {
        // stable: vendors in their first appearance order
        let mut order_of: Vec<String> = Vec::new();
        for v in &items {
            let vendor = v["vendor"].as_str().unwrap_or("").to_string();
            if !order_of.contains(&vendor) {
                order_of.push(vendor);
            }
        }
        items.sort_by_key(|v| order_of.iter().position(|o| v["vendor"].as_str() == Some(o.as_str())).unwrap_or(usize::MAX));
    }
    let total = items.len();
    let prev_vendor = if group && offset > 0 { items.get(offset - 1).map(|v| v["vendor"].clone()) } else { None };
    let page: Vec<Value> = items.into_iter().skip(offset).take(limit.clamp(1, 100)).collect();
    Ok(json!({
        "query": q, "offset": offset, "limit": limit, "total": total, "items": page, "sort": sort,
        "order": if desc { "desc" } else { "asc" }, "group_by_vendor": group,
        "relevance_displaced": !ql.is_empty() && sort != "relevance", "prev_vendor": prev_vendor,
    }))
}

/// Make a catalog model a hireable tier, or stop offering it.
#[logged]
pub async fn set_favorite(engine: &Engine, id: &str, selected: bool) -> Result<()> {
    let mut favs = favorites_doc(engine);
    favs.retain(|f| f["model"].as_str() != Some(id));
    if selected {
        let models = catalog(false).await?;
        let Some(raw) = models.iter().find(|m| m["id"].as_str() == Some(id)) else {
            crate::refuse!(NotFound, "{id} is not in the OpenRouter catalog");
        };
        let c = card(raw, &[]);
        let prompt = c["prompt"].as_f64().unwrap_or(0.0);
        favs.push(json!({
            "tier": tier_name(id), "seat": seat_for(prompt), "model": id, "label": c["label"], "name": c["name"],
            "vendor": c["vendor"], "color": c["color"], "letter": c["letter"], "prompt": prompt,
            "completion": c["completion"], "cache_read": c["cache_read"], "context": c["context"], "tools": c["tools"],
            "image": c["image"], "reasoning": c["reasoning"],
        }));
    }
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "favorites": favs } })).await?;
    Ok(())
}

/// A favorite's record by its tier (model id, prices per million).
#[logged]
pub fn favorite(engine: &Engine, tier: &str) -> Option<Value> {
    favorites_doc(engine).into_iter().find(|f| f["tier"].as_str() == Some(tier))
}

/// Which CLIs can drive an OpenRouter agent, and the one new hires get.
#[logged]
pub fn harness(engine: &Engine) -> Value {
    let claude = engine.providers.claude_path();
    let codex = engine.providers.codex_path();
    let opt = |id: &str, label: &str, path: Option<std::path::PathBuf>| {
        let available = path.is_some();
        json!({ "id": id, "label": label, "state": if available { "available" } else { "missing" }, "available": available,
                "why": if available { "installed".to_string() } else { format!("{label} is not installed on this machine") },
                "path": path.map(|p| p.to_string_lossy().to_string()) })
    };
    let options = vec![opt("claude-code", "Claude Code", claude.clone()), opt("codex-cli", "Codex", codex.clone())];
    let stored = engine
        .settings
        .get()
        .pointer("/openrouter/harness")
        .and_then(Value::as_str)
        .unwrap_or("claude-code")
        .to_string();
    let avail: Vec<&str> = options.iter().filter(|o| o["available"] == json!(true)).filter_map(|o| o["id"].as_str()).collect();
    let selected = if avail.contains(&stored.as_str()) { Some(stored.clone()) } else { avail.first().map(|s| s.to_string()) };
    let explain = match avail.len() {
        0 => "Neither Claude Code nor Codex is installed, so no CLI can drive OpenRouter agents.".to_string(),
        1 => format!("Only {} is installed, so it drives OpenRouter agents.", if avail[0] == "claude-code" { "Claude Code" } else { "Codex" }),
        _ => String::new(),
    };
    json!({ "harnesses": options, "stored": stored, "default": "claude-code", "enabled": avail.len() > 1,
            "unavailable": avail.is_empty(), "selected": selected, "explain": explain })
}

#[logged]
pub async fn set_harness(engine: &Engine, h: &str) -> Result<()> {
    if h != "claude-code" && h != "codex-cli" {
        crate::refuse!(BadRequest, "the harness is claude-code or codex-cli");
    }
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "harness": h } })).await?;
    Ok(())
}

/// The lane's document for App settings (secret-free).
#[logged]
pub async fn doc(engine: &Engine, force: bool) -> Value {
    let key_set = key(engine).await.is_some();
    let mut credits = json!({ "limit": null, "limit_remaining": null, "usage": null, "usage_daily": null, "usage_weekly": null,
                              "usage_monthly": null, "is_free_tier": null, "checked_at": null });
    let mut connected = false;
    let mut reason = Value::Null;
    let mut label = engine.settings.get().pointer("/openrouter/label").cloned().unwrap_or(Value::Null);
    if key_set {
        match key_info(engine, force).await {
            Ok(d) => {
                connected = true;
                for k in ["limit", "limit_remaining", "usage", "usage_daily", "usage_weekly", "usage_monthly", "is_free_tier"] {
                    credits[k] = d[k].clone();
                }
                credits["checked_at"] = json!(iso(chrono::Utc::now()));
                if let Some(l) = d["label"].as_str() {
                    label = json!(l);
                }
            }
            Err(e) => reason = json!(format!("{e:#}")),
        }
    }
    let favs = favorites_doc(engine);
    let tiers: Vec<Value> = favs
        .iter()
        .map(|f| {
            json!({ "tier": f["tier"], "provider": "openrouter", "seat": f["seat"], "model": f["model"], "letter": f["letter"],
                    "color": f["color"], "accent": null, "name": f["name"], "label": f["label"], "vendor": f["vendor"],
                    "prompt": f["prompt"], "completion": f["completion"], "context": f["context"], "tools": f["tools"],
                    "image": f["image"] })
        })
        .collect();
    json!({
        "installed": key_set, "connected": connected, "key_set": key_set, "kind": if key_set { json!("api-key") } else { Value::Null },
        "label": label, "credits": credits, "reason": reason, "favorites": favs.len(), "favorites_max": 0, "tiers": tiers,
        "user_enabled": engine.settings.provider_enabled("openrouter"), "harness": harness(engine),
    })
}

/// `GET /api/v1/key` for the stored key: its label, limits and spend.
async fn key_info(engine: &Engine, _force: bool) -> Result<Map<String, Value>> {
    let k = key(engine).await.ok_or_else(|| anyhow!("no key is stored"))?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(USER_AGENT).build()?;
    let r = client.get(format!("{API_BASE}/key")).bearer_auth(&k).send().await?;
    if r.status().as_u16() == 401 || r.status().as_u16() == 403 {
        return Err(anyhow!("openrouter.ai refused the stored key"));
    }
    let body: Value = r.error_for_status()?.json().await?;
    Ok(body["data"].as_object().cloned().unwrap_or_default())
}
