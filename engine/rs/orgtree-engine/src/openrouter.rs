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
/// The `model_providers.<KEY>` block a Codex launch reaches OpenRouter
/// through: passed with `-c`, never written to the user's config.toml.
pub const CODEX_PROVIDER: &str = "orgtree_openrouter";
/// The variable that block tells Codex to read the key from.
pub const KEY_ENV: &str = "ORGTREE_OPENROUTER_KEY";
const CATALOG_TTL: Duration = Duration::from_secs(3600);
const USER_AGENT: &str = concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"));

type Catalog = Option<(Instant, Arc<Vec<Value>>)>;
static CATALOG: LazyLock<ArcSwap<Catalog>> = LazyLock::new(|| ArcSwap::from_pointee(None));

// ------------------------------------------------------------ the keys
//
// Several keys at once (ruling 2026-10-11, docket
// use-several-openrouter-keys-at-once): each key is a hidden registry row
// (provider `openrouter`, kind `apikey`) with its secret in
// `ot.account_secrets`. The original key keeps its row `openrouter-key` and
// its lane `openrouter`; an added key is `openrouter-N` and its lane is its
// id. An OpenRouter seat with no binding bills the original key.

/// The lane the original key is named by wherever a lane is named (the org
/// account list, the usage board, the usage cache and its history).
pub const LANE: &str = "openrouter";
/// The longest name a key may be given.
const KEY_LABEL_MAX: usize = 80;

/// The lane of an OpenRouter key row: the original key keeps `openrouter`,
/// an added key is its own id.
#[nolog]
pub fn lane(id: &str) -> String {
    if id == ACCOUNT_ID { LANE.to_string() } else { id.to_string() }
}

#[cfg(test)]
mod lane_tests {
    /// The compatibility mapping the coordinator approved: the original row
    /// keeps the `openrouter` lane, an added key's lane is its id, both ways.
    #[test]
    fn the_original_key_keeps_its_lane() {
        assert_eq!(super::lane(super::ACCOUNT_ID), "openrouter");
        assert_eq!(super::lane("openrouter-2"), "openrouter-2");
        assert_eq!(super::id_of_lane("openrouter"), super::ACCOUNT_ID);
        assert_eq!(super::id_of_lane("openrouter-3"), "openrouter-3");
        for id in [super::ACCOUNT_ID, "openrouter-2"] {
            assert_eq!(super::id_of_lane(&super::lane(id)), id);
        }
    }
}

/// The key row behind a lane name (`lane`'s inverse).
#[nolog]
pub fn id_of_lane(lane: &str) -> String {
    if lane == LANE { ACCOUNT_ID.to_string() } else { lane.to_string() }
}

/// The key row an OpenRouter seat bills: an OpenRouter key it is bound to
/// (an id the registry no longer holds included, so the launch says so
/// rather than billing another key), else the original key (no binding,
/// `primary`, or a binding to another provider's login).
#[nolog]
pub fn seat_key(engine: &Engine, account: Option<&str>) -> String {
    match crate::accounts::choice(account) {
        crate::accounts::Choice::Account(id) if id == LANE => ACCOUNT_ID.to_string(),
        crate::accounts::Choice::Account(id) => match engine.accounts.view().get(&id) {
            Some(a) if a.provider != crate::providers::catalog::OPENROUTER => ACCOUNT_ID.to_string(),
            _ => id,
        },
        _ => ACCOUNT_ID.to_string(),
    }
}

/// Every stored key row: the original first, then the added ones in the
/// order they were added.
#[nolog]
pub fn keys(engine: &Engine) -> Vec<crate::accounts::AccountInfo> {
    let view = engine.accounts.view();
    let mut out: Vec<_> = view.all().into_iter().filter(|a| a.provider == crate::providers::catalog::OPENROUTER).cloned().collect();
    out.sort_by_key(|a| (a.id != ACCOUNT_ID, a.ord, a.id.clone()));
    out
}

/// Whether any key is stored (the lane is offered).
#[nolog]
pub fn any_key(engine: &Engine) -> bool {
    engine.accounts.view().all().iter().any(|a| a.provider == crate::providers::catalog::OPENROUTER)
}

/// The name the user gave a key, if any (the original row was created with
/// the placeholder "OpenRouter", which is no name).
#[nolog]
pub fn user_label(a: &crate::accounts::AccountInfo) -> Option<String> {
    let l = a.label.trim();
    (!l.is_empty() && !(a.id == ACCOUNT_ID && l == "OpenRouter")).then(|| l.to_string())
}

/// What a key is called: the user's name for it, else the label
/// openrouter.ai reports for it (its last reading), else "OpenRouter key N"
/// by its place in the list.
#[nolog]
pub fn display(engine: &Engine, a: &crate::accounts::AccountInfo) -> String {
    if let Some(l) = user_label(a) {
        return l;
    }
    if let Some(l) = crate::usage::openrouter_reading(engine, &lane(&a.id))
        .and_then(|v| v["key_label"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
    {
        return l;
    }
    let n = keys(engine).iter().position(|k| k.id == a.id).map(|i| i + 1).unwrap_or(1);
    format!("OpenRouter key {n}")
}

/// A key row's secret (never logged, never returned to a window).
pub async fn key_of(engine: &Engine, id: &str) -> Option<String> {
    let client = engine.db.get().await.ok()?;
    client
        .query_opt(
            "SELECT s.secret FROM ot.account_secrets s JOIN ot.accounts a ON a.id = s.account_id
              WHERE s.account_id = $1 AND a.provider = 'openrouter'",
            &[&id],
        )
        .await
        .ok()
        .flatten()
        .map(|r| r.get(0))
}

/// The original key (a secret: never logged, never returned to a window).
pub async fn key(engine: &Engine) -> Option<String> {
    key_of(engine, ACCOUNT_ID).await
}

/// A key row's secret with its replacement generation, read together, so a
/// usage read can tell afterwards whether the key it used is still the one
/// stored (never logged: it returns the secret).
pub async fn key_with_generation(engine: &Engine, id: &str) -> Option<(String, i64)> {
    let client = engine.db.get().await.ok()?;
    client
        .query_opt(
            "SELECT s.secret, coalesce((a.extra->>'credential_gen')::bigint, 0)
               FROM ot.account_secrets s JOIN ot.accounts a ON a.id = s.account_id
              WHERE s.account_id = $1 AND a.provider = 'openrouter'",
            &[&id],
        )
        .await
        .ok()
        .flatten()
        .map(|r| (r.get(0), r.get(1)))
}

/// A key row's replacement generation as stored now (None: the row is gone
/// or the database cannot be read).
#[logged]
pub async fn generation(engine: &Engine, id: &str) -> Option<i64> {
    let client = engine.db.get().await.ok()?;
    client
        .query_opt(
            "SELECT coalesce((extra->>'credential_gen')::bigint, 0) FROM ot.accounts WHERE id = $1 AND provider = 'openrouter'",
            &[&id],
        )
        .await
        .ok()
        .flatten()
        .map(|r| r.get(0))
}

#[nolog]
fn clean_label(label: Option<&str>) -> Result<Option<String>> {
    let Some(l) = label.map(str::trim) else { return Ok(None) };
    if l.chars().count() > KEY_LABEL_MAX {
        crate::refuse!(BadRequest, "a key's name is at most {KEY_LABEL_MAX} characters");
    }
    Ok(Some(l.to_string()))
}

/// The key row already holding this secret, other than `except`. Not
/// logged: it takes the key.
async fn holder_of(client: &impl tokio_postgres::GenericClient, key: &str, except: Option<&str>) -> Result<Option<String>> {
    Ok(client
        .query_opt(
            "SELECT a.id FROM ot.account_secrets s JOIN ot.accounts a ON a.id = s.account_id
              WHERE a.provider = 'openrouter' AND s.secret = $1 AND a.id IS DISTINCT FROM $2 LIMIT 1",
            &[&key, &except],
        )
        .await?
        .map(|r| r.get(0)))
}

/// Inside a key write's transaction: lock every OpenRouter key row (in id
/// order, a handful at most) so concurrent writes of the same secret are
/// serialized, then refuse a secret another row already holds. The check
/// sees every write committed before the lock was granted. Not logged: it
/// takes the key.
async fn admit_secret(tx: &tokio_postgres::Transaction<'_>, key: &str, except: Option<&str>) -> Result<()> {
    tx.query("SELECT id FROM ot.accounts WHERE provider = 'openrouter' ORDER BY id LIMIT 1000 FOR UPDATE", &[]).await?;
    if let Some(other) = holder_of(tx, key, except).await? {
        crate::refuse!(Conflict, "this key is already stored as {}", lane(&other));
    }
    Ok(())
}

/// Replace a key row's stored secret, counting the replacement (a new
/// secret only) so a warm CLI and a usage read started on the old one know.
/// Not logged: it takes the key.
async fn store_secret(tx: &tokio_postgres::Transaction<'_>, id: &str, key: &str) -> Result<()> {
    tx.execute(
        "UPDATE ot.accounts SET extra = jsonb_set(extra, '{credential_gen}', to_jsonb(coalesce((extra->>'credential_gen')::bigint, 0) + 1))
          WHERE id = $1 AND EXISTS (SELECT 1 FROM ot.account_secrets WHERE account_id = $1 AND secret <> $2)",
        &[&id, &key],
    )
    .await?;
    tx.execute(
        "INSERT INTO ot.account_secrets (account_id, secret) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET secret = EXCLUDED.secret",
        &[&id, &key],
    )
    .await?;
    Ok(())
}

/// After a key row was added, replaced or removed: the registry snapshot
/// and `openrouter.key_set` (whether any key is stored) follow.
async fn keys_changed(engine: &Engine) -> Result<()> {
    engine.accounts.reload(engine).await?;
    let any = any_key(engine);
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "key_set": any } })).await?;
    Ok(())
}

/// Add a pasted key beside the others (store first: it is the user's only
/// copy here). With no original key stored it becomes the original (lane
/// `openrouter`); otherwise it is the next `openrouter-N` (N from 2, never
/// an id used before). Returns its id. Not logged: it takes the key.
pub async fn add_key(engine: &Engine, key: &str, label: Option<&str>) -> Result<String> {
    let key = key.trim();
    if key.is_empty() {
        crate::refuse!(BadRequest, "paste an OpenRouter API key");
    }
    let label = clean_label(label)?.unwrap_or_default();
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    admit_secret(&tx, key, None).await?;
    let original = tx.query_opt("SELECT 1 FROM ot.accounts WHERE id = $1", &[&ACCOUNT_ID]).await?.is_none();
    let id = if original {
        ACCOUNT_ID.to_string()
    } else {
        let n: i64 = tx
            .query_one(
                "SELECT greatest(coalesce(max(substring(id FROM '^openrouter-([0-9]+)$')::bigint), 1), 1) + 1 FROM
                   (SELECT id FROM ot.accounts WHERE provider = 'openrouter'
                    UNION ALL SELECT id FROM ot.removed_accounts WHERE provider = 'openrouter') ids",
                &[],
            )
            .await?
            .get(0);
        format!("openrouter-{n}")
    };
    let row_label = if original && label.is_empty() { "OpenRouter".to_string() } else { label };
    let inserted = tx.execute(
        "INSERT INTO ot.accounts (id, provider, kind, label, auth, enabled, ord)
         VALUES ($1, 'openrouter', 'apikey', $2, 'unobserved', true,
                 (SELECT coalesce(max(ord), 0) + 1 FROM ot.accounts WHERE provider = 'openrouter'))",
        &[&id, &row_label],
    )
    .await;
    if let Err(e) = inserted {
        // two first keys at once: there were no rows to lock yet
        if e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) {
            crate::refuse!(Conflict, "another OpenRouter key was added at the same moment; add this one again");
        }
        return Err(e.into());
    }
    tx.execute("INSERT INTO ot.account_secrets (account_id, secret) VALUES ($1, $2)", &[&id, &key]).await?;
    tx.commit().await?;
    drop(client);
    keys_changed(engine).await?;
    Ok(id)
}

/// Rename a key row (an empty name clears it) and/or replace its secret.
/// Not logged: it takes the key.
pub async fn update_key(engine: &Engine, id: &str, key: Option<&str>, label: Option<&str>) -> Result<()> {
    let key = key.map(str::trim).filter(|k| !k.is_empty());
    let label = clean_label(label)?;
    let mut client = engine.db.get().await?;
    if client.query_opt("SELECT 1 FROM ot.accounts WHERE id = $1 AND provider = 'openrouter'", &[&id]).await?.is_none() {
        crate::refuse!(NotFound, "no OpenRouter key {id}");
    }
    let tx = client.transaction().await?;
    if let Some(k) = key {
        admit_secret(&tx, k, Some(id)).await?;
    }
    if let Some(l) = &label {
        let l = if l.is_empty() && id == ACCOUNT_ID { "OpenRouter" } else { l.as_str() };
        tx.execute("UPDATE ot.accounts SET label = $2 WHERE id = $1", &[&id, &l]).await?;
    }
    if let Some(k) = key {
        store_secret(&tx, id, k).await?;
    }
    tx.commit().await?;
    drop(client);
    keys_changed(engine).await
}

/// Remove a key row through the reassignment-or-freeze path (ruling
/// 2026-10-11): an added key through the registry's removal, which first
/// moves every agent and default bound to it onto the original key; the
/// original through `clear_key`.
#[logged]
pub async fn remove_key(engine: &Arc<Engine>, id: &str) -> Result<Value> {
    if id == ACCOUNT_ID || id == LANE {
        return clear_key(engine).await;
    }
    if !keys(engine).iter().any(|k| k.id == id) {
        crate::refuse!(NotFound, "no OpenRouter key {id}");
    }
    let out = crate::domain::account_removal::remove(engine, id).await?;
    keys_changed(engine).await?;
    Ok(out)
}

/// Store a pasted key as the original key (store first: it is the user's
/// only copy here). `PUT /api/openrouter/key`, as before several keys.
pub async fn set_key(engine: &Engine, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        crate::refuse!(BadRequest, "paste an OpenRouter API key");
    }
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    admit_secret(&tx, key, Some(ACCOUNT_ID)).await?;
    tx.execute(
        "INSERT INTO ot.accounts (id, provider, kind, label, auth, enabled) VALUES ($1, 'openrouter', 'apikey', 'OpenRouter', 'unobserved', true)
         ON CONFLICT (id) DO NOTHING",
        &[&ACCOUNT_ID],
    )
    .await?;
    store_secret(&tx, ACCOUNT_ID, key).await?;
    tx.commit().await?;
    drop(client);
    keys_changed(engine).await
}

/// 3.x kept the key and the favorites in `<data>/openrouter/state.json`,
/// which the first-start import never read. Carry them over once, on any
/// start (installs imported before this existed included): the key only when
/// none is stored yet, and favorites this build does not know yet. Not
/// logged: it holds the key.
pub async fn import_legacy(engine: &Engine) {
    const MARK: &str = "openrouter_state_v1";
    let done = async {
        let client = engine.db.get().await.ok()?;
        client.query_opt("SELECT 1 FROM ot.meta WHERE key = $1", &[&MARK]).await.ok()
    }
    .await;
    match done {
        Some(None) => {}
        // done before, or the database cannot be read now (the next start retries)
        _ => return,
    }
    let path = engine.cfg.path("openrouter").join("state.json");
    let doc: Value = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let mut carried = json!({ "at": iso(chrono::Utc::now()), "found": !doc.is_null(), "key": false, "favorites": 0 });
    let legacy_key = doc["key"].as_str().map(str::trim).filter(|k| !k.is_empty());
    if let Some(k) = legacy_key {
        if key(engine).await.is_none() {
            match set_key(engine, k).await {
                Ok(()) => carried["key"] = json!(true),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "the 3.x OpenRouter key could not be carried over");
                    return;
                }
            }
        }
    }
    let mut favs = favorites_doc(engine);
    let mut known = Map::new();
    for f in doc["favorites"].as_array().cloned().unwrap_or_default() {
        let Some(id) = f["id"].as_str().filter(|s| !s.is_empty()) else { continue };
        let tier = f["tier"].as_str().map(str::to_string).unwrap_or_else(|| tier_name(id));
        let prompt = f["prompt"].as_f64().unwrap_or(0.0);
        let rec = json!({
            "tier": tier, "seat": f["seat"].as_f64().unwrap_or_else(|| seat_for(prompt)), "model": id,
            "label": f["label"], "name": f["name"], "vendor": f["vendor"], "color": f["color"], "letter": f["letter"],
            "prompt": prompt, "completion": f["completion"].as_f64().unwrap_or(0.0),
            "cache_read": f["cache_read"].as_f64().unwrap_or(0.0), "context": f["context"], "tools": f["tools"],
            "image": f["image"], "reasoning": f["reasoning"],
        });
        known.insert(tier, rec.clone());
        if !favs.iter().any(|x| x["model"].as_str() == Some(id)) {
            favs.push(rec);
            carried["favorites"] = json!(carried["favorites"].as_i64().unwrap_or(0) + 1);
        }
    }
    let Ok(mut client) = engine.db.get().await else { return };
    if !known.is_empty() {
        if let Err(e) = engine.settings.merge(&mut client, json!({ "openrouter": { "favorites": favs, "known": known } })).await {
            tracing::warn!(error = %format!("{e:#}"), "the 3.x OpenRouter favorites could not be carried over");
            return;
        }
    }
    let _ = client
        .execute("INSERT INTO ot.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", &[&MARK, &carried])
        .await;
    drop(client);
    tracing::info!(found = carried["found"].as_bool().unwrap_or(false), key = carried["key"].as_bool().unwrap_or(false),
                   favorites = carried["favorites"].as_i64().unwrap_or(0), "3.x OpenRouter settings checked");
    if carried["key"] == json!(true) || carried["favorites"].as_i64().unwrap_or(0) > 0 {
        crate::providers::publish(engine);
        publish(engine).await;
    }
}

/// Remove the original key: every seat it bills moves to another key it
/// may run on, or freezes saying none is left
/// (`account_removal::remove_original`).
#[logged]
pub async fn clear_key(engine: &Arc<Engine>) -> Result<Value> {
    // none stored: nothing to move (clearing stays idempotent, as before)
    let out = if engine.accounts.view().get(ACCOUNT_ID).is_some() {
        crate::domain::account_removal::remove_original(engine).await?
    } else {
        json!({ "removed": null, "rebound": [], "frozen": [] })
    };
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "label": null } })).await?;
    drop(client);
    // another key may still be stored: `key_set` says whether any is
    keys_changed(engine).await?;
    Ok(out)
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
    let vendor = id.split('/').next().unwrap_or("").trim_start_matches('~').to_string();
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
    let mut out = json!({
        "id": id, "name": name, "label": label, "vendor": vendor,
        "prompt": prompt.unwrap_or(0.0), "completion": completion.unwrap_or(0.0), "cache_read": cache_read.unwrap_or(0.0),
        "context": raw["context_length"].as_i64().unwrap_or(0), "tools": tools, "image": image, "reasoning": reasoning,
        "free": id.ends_with(":free") || (prompt == Some(0.0) && completion == Some(0.0)),
        "created": raw["created"].as_i64().unwrap_or(0),
        "letter": crate::providers::catalog::monogram(&label),
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
        // rig mode: the canned catalog, else no network
        let body: Value = if let Some(canned) = crate::rig::openrouter_models() {
            canned.map_err(|e| anyhow!(e))?
        } else {
            let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent(USER_AGENT).build()?;
            client.get(format!("{API_BASE}/models")).send().await?.error_for_status()?.json().await?
        };
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

/// How a favorite's price stands for ordering: 0 priced, 1 free, 2 unknown.
/// A catalog row whose price could not be read (`price_unknown`) is unknown,
/// never counted as $0.
#[nolog]
fn price_class(f: &Value) -> u8 {
    let rate = |k: &str| f[k].as_f64().filter(|p| p.is_finite() && *p >= 0.0);
    let unknown = f["price_unknown"].as_array().is_some_and(|u| !u.is_empty());
    match (unknown, rate("prompt"), rate("completion")) {
        (true, _, _) | (_, None, _) | (_, _, None) => 2,
        (_, Some(p), Some(c)) if p == 0.0 && c == 0.0 => 1,
        _ => 0,
    }
}

/// The order the chosen models are listed in wherever they are listed
/// together (user 2026-10-13): the dearest first, by output price per
/// million tokens, then input price, then name; free models after the priced
/// ones and models of unknown price last. The catalog browser keeps its own
/// sort. A stable sort over this makes the order the same everywhere.
#[nolog]
pub fn by_price_desc(a: &Value, b: &Value) -> std::cmp::Ordering {
    let rate = |f: &Value, k: &str| f[k].as_f64().unwrap_or(0.0);
    let name = |f: &Value| f["name"].as_str().or(f["label"].as_str()).or(f["model"].as_str()).unwrap_or("").to_lowercase();
    price_class(a).cmp(&price_class(b))
        .then_with(|| rate(b, "completion").total_cmp(&rate(a, "completion")))
        .then_with(|| rate(b, "prompt").total_cmp(&rate(a, "prompt")))
        .then_with(|| name(a).cmp(&name(b)))
}

/// The favorites, dearest first (`by_price_desc`).
#[nolog]
pub fn favorites_listed(engine: &Engine) -> Vec<Value> {
    let mut favs = favorites_doc(engine);
    favs.sort_by(by_price_desc);
    favs
}

#[cfg(test)]
mod order_tests {
    use super::*;

    fn fav(tier: &str, name: &str, prompt: f64, completion: f64) -> Value {
        json!({ "tier": tier, "name": name, "label": name, "model": format!("v/{name}"), "prompt": prompt, "completion": completion })
    }

    fn tiers(mut v: Vec<Value>) -> Vec<String> {
        v.sort_by(by_price_desc);
        v.iter().map(|f| f["tier"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn chosen_models_list_dearest_output_first_then_input_then_name() {
        let got = tiers(vec![
            fav("or-cheap", "Cheap", 0.1, 0.4),
            fav("or-dear", "Dear", 5.0, 25.0),
            fav("or-mid-b", "Mid B", 1.0, 5.0),
            fav("or-mid-a", "Mid A", 1.0, 5.0),
            fav("or-mid-in", "Mid In", 3.0, 5.0),
        ]);
        // output 25, then the three at 5 (input 3, then 1 by name), then 0.4
        assert_eq!(got, ["or-dear", "or-mid-in", "or-mid-a", "or-mid-b", "or-cheap"]);
    }

    #[test]
    fn free_models_follow_priced_ones_and_unknown_prices_come_last() {
        let mut unknown = fav("or-unknown", "Unknown", 0.0, 0.0);
        unknown["price_unknown"] = json!(["prompt", "completion"]);
        let mut half = fav("or-half", "Half", 2.0, 0.0);
        half["price_unknown"] = json!(["completion"]);
        let got = tiers(vec![
            unknown,
            fav("or-free-b", "Free B", 0.0, 0.0),
            fav("or-tiny", "Tiny", 0.0, 0.01),
            half,
            fav("or-free-a", "Free A", 0.0, 0.0),
            fav("or-dear", "Dear", 1.0, 2.0),
        ]);
        // priced (dear, tiny), then free by name, then the unknown ones - never as $0
        assert_eq!(got, ["or-dear", "or-tiny", "or-free-a", "or-free-b", "or-half", "or-unknown"]);
        // a record with no rate at all is unknown, not free
        assert_eq!(price_class(&json!({ "tier": "or-x" })), 2);
        assert_eq!(price_class(&fav("or-f", "F", 0.0, 0.0)), 1);
    }

    #[test]
    fn equal_models_keep_their_places() {
        let a = fav("or-first", "Same", 1.0, 2.0);
        let b = fav("or-second", "Same", 1.0, 2.0);
        assert_eq!(tiers(vec![a.clone(), b.clone()]), ["or-first", "or-second"]);
        assert_eq!(tiers(vec![b, a]), ["or-second", "or-first"]);
    }
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
    let mut known = Map::new();
    favs.retain(|f| f["model"].as_str() != Some(id));
    if selected {
        let models = catalog(false).await?;
        let Some(raw) = models.iter().find(|m| m["id"].as_str() == Some(id)) else {
            crate::refuse!(NotFound, "{id} is not in the OpenRouter catalog");
        };
        let c = card(raw, &[]);
        let prompt = c["prompt"].as_f64().unwrap_or(0.0);
        let mut rec = json!({
            "tier": tier_name(id), "seat": seat_for(prompt), "model": id, "label": c["label"], "name": c["name"],
            "vendor": c["vendor"], "color": c["color"], "letter": c["letter"], "prompt": prompt,
            "completion": c["completion"], "cache_read": c["cache_read"], "context": c["context"], "tools": c["tools"],
            "image": c["image"], "reasoning": c["reasoning"],
        });
        // a price the catalog did not state stays unknown (the order lists it last, never as $0)
        if let Some(unknown) = c.get("price_unknown") {
            rec["price_unknown"] = unknown.clone();
        }
        known.insert(tier_name(id), rec.clone());
        favs.push(rec);
    }
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "openrouter": { "favorites": favs, "known": known } })).await?;
    Ok(())
}

/// A favorite's record by its tier (model id, prices per million). A
/// deselected favorite is no longer offered but stays known: seats hired on
/// it keep running on it.
#[logged]
pub fn favorite(engine: &Engine, tier: &str) -> Option<Value> {
    favorites_doc(engine).into_iter().find(|f| f["tier"].as_str() == Some(tier)).or_else(|| {
        engine.settings.get().get("openrouter").and_then(|o| o.get("known")).and_then(|k| k.get(tier)).cloned()
    })
}

/// A tier's rates per million tokens: (prompt, cache read, completion). An
/// unstated cache-read rate is priced as a prompt token.
#[logged]
pub fn prices(engine: &Engine, tier: &str) -> Option<(f64, f64, f64)> {
    let f = favorite(engine, tier)?;
    let prompt = f["prompt"].as_f64()?;
    let cached = f["cache_read"].as_f64().filter(|c| *c > 0.0).unwrap_or(prompt);
    Some((prompt, cached, f["completion"].as_f64().unwrap_or(0.0)))
}

/// `-c` overrides pointing one Codex launch at OpenRouter's Responses API.
#[logged]
pub fn codex_overrides(model: &str) -> Vec<String> {
    let q = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    let p = format!("model_providers.{CODEX_PROVIDER}");
    let mut out = Vec::new();
    for kv in [
        format!("model_provider={}", q(CODEX_PROVIDER)),
        format!("{p}.name={}", q("OpenRouter")),
        format!("{p}.base_url={}", q(API_BASE)),
        format!("{p}.env_key={}", q(KEY_ENV)),
        // the CLI refuses "chat"
        format!("{p}.wire_api={}", q("responses")),
        // a launch that never names the model would fall back to an OpenAI id
        format!("model={}", q(model)),
    ] {
        out.push("-c".to_string());
        out.push(kv);
    }
    out
}

/// The harness new OpenRouter hires get.
#[logged]
pub fn selected_harness(engine: &Engine) -> String {
    harness(engine)["selected"].as_str().unwrap_or("claude-code").to_string()
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

/// The lane's document for App settings (secret-free). Not logged: its
/// `keys` carry each key's reading and error text (`keys_doc`); one safe
/// summary line is logged instead.
#[nolog]
pub async fn doc(engine: &Engine, force: bool) -> Value {
    let key_set = key(engine).await.is_some();
    let mut credits = json!({ "limit": null, "limit_remaining": null, "limit_reset": null, "usage": null, "usage_daily": null,
                              "usage_weekly": null, "usage_monthly": null, "is_free_tier": null, "total_credits": null,
                              "total_usage": null, "checked_at": null });
    let mut connected = false;
    let mut reason = Value::Null;
    let mut label = engine.settings.get().pointer("/openrouter/label").cloned().unwrap_or(Value::Null);
    if key_set {
        match key_info(engine, force).await {
            Ok(d) => {
                connected = true;
                // a field the key check did not answer stays null (indexing a
                // Map panics on a missing key: /credits may refuse a key, and
                // openrouter.ai decides which /key fields it sends)
                for k in ["limit", "limit_remaining", "limit_reset", "usage", "usage_daily", "usage_weekly", "usage_monthly",
                          "is_free_tier", "total_credits", "total_usage"] {
                    credits[k] = d.get(k).cloned().unwrap_or(Value::Null);
                }
                credits["checked_at"] = json!(iso(chrono::Utc::now()));
                if let Some(l) = d.get("label").and_then(Value::as_str) {
                    label = json!(l);
                }
            }
            Err(e) => reason = json!(format!("{e:#}")),
        }
    }
    let favs = favorites_listed(engine);
    let tiers: Vec<Value> = favs
        .iter()
        .map(|f| {
            let mut row = json!({ "tier": f["tier"], "provider": "openrouter", "seat": f["seat"], "model": f["model"], "letter": f["letter"],
                    "color": f["color"], "accent": null, "name": f["name"], "label": f["label"], "vendor": f["vendor"],
                    "prompt": f["prompt"], "completion": f["completion"], "context": f["context"], "tools": f["tools"],
                    "image": f["image"] });
            if let Some(unknown) = f.get("price_unknown") {
                row["price_unknown"] = unknown.clone();
            }
            row
        })
        .collect();
    let keys = keys_doc(engine, connected, &reason);
    let any = !keys.is_empty();
    tracing::info!(force, key_set, connected, keys = keys.len(), favorites = favs.len(), "OpenRouter document");
    json!({
        "installed": any, "connected": connected, "key_set": key_set, "kind": if key_set { json!("api-key") } else { Value::Null },
        "label": label, "credits": credits, "reason": reason, "favorites": favs.len(), "favorites_max": 0, "tiers": tiers,
        "user_enabled": engine.settings.provider_enabled("openrouter"), "harness": harness(engine),
        "keys": keys, "any_key": any,
    })
}

/// Every stored key as the panel lists it (secret-free): its id and lane,
/// the user's name for it and what it is called, and its standing. The
/// original key's standing is the check `doc` just made; an added key's is
/// its last usage reading (the usage loop reads every key). Not logged:
/// it carries each reading's error text.
#[nolog]
fn keys_doc(engine: &Engine, original_connected: bool, original_reason: &Value) -> Vec<Value> {
    keys(engine)
        .iter()
        .map(|a| {
            let lane = lane(&a.id);
            let reading = crate::usage::openrouter_reading(engine, &lane);
            let (connected, reason) = if a.id == ACCOUNT_ID {
                (json!(original_connected), original_reason.clone())
            } else {
                match &reading {
                    Some(v) if v["available"] == json!(true) => (json!(true), Value::Null),
                    Some(v) => (json!(false), v["error"].clone()),
                    None => (Value::Null, Value::Null),
                }
            };
            json!({
                "id": a.id, "lane": lane, "original": a.id == ACCOUNT_ID, "label": user_label(a), "name": display(engine, a),
                "key_label": reading.as_ref().map(|v| v["key_label"].clone()).unwrap_or(Value::Null),
                "enabled": a.enabled, "connected": connected, "reason": reason,
                "limits": reading.as_ref().map(|v| v["limits"].clone()).unwrap_or(json!([])),
                "observed_at": reading.as_ref().map(|v| v["observed_at"].clone()).unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// What the key check says when openrouter.ai refuses the stored key.
pub const KEY_REFUSED: &str = "the stored key was rejected by openrouter.ai; replace it in App settings › Providers";

/// A turn on the OpenRouter lane was refused with a 401: check the key again
/// now and push the lane's document and usage, so the providers panel stops
/// saying "connected" beside an agent the gateway just refused (3.x
/// `forget_key_status`). Off the caller's path: the check is a request.
#[logged]
pub fn key_refused(engine: &Arc<Engine>) {
    let eng = engine.clone();
    crate::trace::spawn(async move {
        crate::usage::refresh_openrouter(&eng, true).await;
    });
}

/// A key's standing, as 3.x read it: `GET /api/v1/key` (label, spend, the
/// optional spend cap and its renewal) plus `GET /api/v1/credits` (the
/// prepaid balance, `total_credits` − `total_usage`; it answers a normal
/// inference key, measured in 3.x). Err((true, _)): openrouter.ai refused the
/// key. Not logged: it holds the key.
pub async fn key_standing(lane: &str, key: &str) -> std::result::Result<Map<String, Value>, (bool, String)> {
    if let Some(canned) = crate::rig::openrouter_key(lane) {
        if let Some(wait) = crate::rig::openrouter_key_delay(lane) {
            tokio::time::sleep(wait).await;
        }
        return canned;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| (false, e.to_string()))?;
    let r = client
        .get(format!("{API_BASE}/key"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| (false, format!("could not reach openrouter.ai: {e}")))?;
    let status = r.status().as_u16();
    if status == 401 || status == 403 {
        return Err((true, KEY_REFUSED.into()));
    }
    if status != 200 {
        return Err((false, format!("openrouter.ai answered {status} for the key check")));
    }
    let body: Value = r.json().await.map_err(|e| (false, e.to_string()))?;
    let mut d = body["data"]
        .as_object()
        .cloned()
        .ok_or_else(|| (false, "the key check answered without a `data` record".to_string()))?;
    if let Ok(c) = client.get(format!("{API_BASE}/credits")).bearer_auth(key).send().await {
        if c.status().as_u16() == 200 {
            if let Ok(cb) = c.json::<Value>().await {
                for k in ["total_credits", "total_usage"] {
                    if let Some(v) = cb["data"].get(k) {
                        d.insert(k.into(), v.clone());
                    }
                }
            }
        }
    }
    Ok(d)
}

/// The stored key's standing (see `key_standing`).
async fn key_info(engine: &Engine, _force: bool) -> Result<Map<String, Value>> {
    let k = key(engine).await.ok_or_else(|| anyhow!("no key is stored"))?;
    key_standing(LANE, &k).await.map_err(|(_, e)| anyhow!(e))
}

/// Push the lane's document (the OpenRouter panel reads it).
#[logged]
pub async fn publish(engine: &Engine) {
    let d = doc(engine, false).await;
    engine.app.set_value("openrouter", d);
}
