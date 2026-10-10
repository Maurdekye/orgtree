//! The Language Server lane: models on the user's own local or self-hosted
//! model servers (Ollama, LM Studio, llama.cpp, vLLM, or any server that
//! speaks the Anthropic Messages or the OpenAI Responses API), driven by one
//! of the installed harnesses: Claude Code against the server's
//! Anthropic-compatible `/v1/messages`, or Codex with the server as its model
//! provider (`/v1/responses`; Codex refuses Chat Completions).
//!
//! Each server the user adds (App settings › Providers › Language Server)
//! lists the models it offers; every offered model is a hireable tier
//! `ls-<server>-<model>`. Nothing is metered: a server has no usage limit,
//! only an agents-at-once cap, because one GPU serves only a few agents.
//!
//! Servers live in the app settings document under `language_servers.servers`
//! (a map by server id, so one server's patch never rewrites another). An API
//! key, when a server needs one, is a secret in `ot.langserver_secrets`:
//! never returned to a window and never logged.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::engine::Engine;
use crate::util::iso;

pub const TIER_PREFIX: &str = "ls-";
/// The `model_providers.<KEY>` block a Codex launch reaches a server
/// through: passed with `-c`, never written to the user's config.toml.
pub const CODEX_PROVIDER: &str = "orgtree_langserver";
/// The lane's own Codex home (under the data folder's `profiles`): no login
/// ever lives there, and each server's model catalog is written below it.
pub const CODEX_HOME_DIR: &str = "langserver-codex";
/// The variable that block tells Codex to read the server's key from.
pub const KEY_ENV: &str = "ORGTREE_LANGSERVER_KEY";
/// What a harness sends as its key to a server that needs none (both CLIs
/// insist on sending one; local servers ignore it).
pub const NO_KEY: &str = "orgtree-local";
/// A model's window when neither the server nor the user names one.
pub const DEFAULT_CONTEXT: i64 = 65_536;
/// Below this an agent has almost no room to work. MEASURED in the GPU
/// spike (2026-10-10, llama.cpp): a turn starts at 35.5K tokens on Claude
/// Code and 28.6K on Codex (identity, tools, the turn envelope), and one
/// small ticket peaked at 38.9K and 34.7K (coordinator ruling: 64K).
pub const MIN_CONTEXT: i64 = 65_536;
/// Output tokens a local model may write per reply: Claude Code assumes
/// 32000 for a model it does not know, which a 64K window cannot spare.
pub const MAX_OUTPUT: i64 = 8_192;
/// How long a harness waits for a slow local server (a cold prefill of a
/// long prompt on a partly offloaded model can take minutes).
pub const SLOW_MS: i64 = 30 * 60 * 1000;
/// The seat price of a language-server tier (the floor every free model
/// pays; the coordinator decides the final figure).
pub const SEAT: f64 = crate::providers::catalog::SEAT_FLOOR;
/// The window of the Ollama variant the settings button makes ("Create a
/// 64K version of this model", coordinator ruling 2026-10-10).
pub const VARIANT_CONTEXT: i64 = 65_536;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Making a variant writes only a manifest and a small parameters blob.
const CREATE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the installed Codex may take to read a catalog back.
const CATALOG_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"));

/// A kind of server the add form offers. A preset knows its default
/// address, which harnesses its APIs can carry, and how to list its models.
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub address: &'static str,
    /// serves an Anthropic-compatible `/v1/messages` (Claude Code)
    pub claude: bool,
    /// serves a usable OpenAI `/v1/responses` (Codex)
    pub codex: bool,
    /// why a harness is not offered, shown in the form
    pub note: &'static str,
}

pub static PRESETS: &[Preset] = &[
    Preset { id: "ollama", label: "Ollama", address: "http://127.0.0.1:11434", claude: true, codex: true,
             note: "Ollama 0.14 or later serves both harnesses." },
    Preset { id: "lmstudio", label: "LM Studio", address: "http://127.0.0.1:1234", claude: true, codex: true,
             note: "LM Studio 0.4.1 or later serves both harnesses." },
    Preset { id: "llamacpp", label: "llama.cpp", address: "http://127.0.0.1:9931", claude: true, codex: true,
             note: "Codex was tested with llama-server b11540; older builds' Responses API lacked fields Codex reads. Builds before b11521 listen on port 8080." },
    Preset { id: "vllm", label: "vLLM", address: "http://127.0.0.1:8000", claude: true, codex: true,
             note: "Serve each model under a name without \"/\" (--served-model-name): Claude Code cannot use names that contain one. With Codex, a reasoning model may fail: vLLM refuses the reasoning items Codex sends back." },
    Preset { id: "custom", label: "Custom…", address: "", claude: true, codex: true,
             note: "Any server with an Anthropic-compatible Messages API (Claude Code) or an OpenAI-compatible Responses API (Codex)." },
];

#[logged]
pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// The API a server's harness speaks: Claude Code needs Anthropic Messages,
/// Codex needs OpenAI Responses.
#[logged]
pub fn api_of(harness: &str) -> &'static str {
    if harness == "codex-cli" { "responses" } else { "anthropic" }
}

/// Every server, in the order they were added.
#[logged]
pub fn servers(engine: &Engine) -> Vec<Value> {
    let doc = engine.settings.get();
    let mut out: Vec<Value> = doc
        .pointer("/language_servers/servers")
        .and_then(Value::as_object)
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    out.sort_by(|a, b| {
        let k = |v: &Value| (v["created_at"].as_str().unwrap_or("").to_string(), v["id"].as_str().unwrap_or("").to_string());
        k(a).cmp(&k(b))
    });
    out
}

#[logged]
pub fn server(engine: &Engine, id: &str) -> Option<Value> {
    engine.settings.get().pointer("/language_servers/servers").and_then(|m| m.get(id)).cloned()
}

/// The tier a server's model is hired on (`ls-<server>-<model>`).
#[logged]
pub fn tier_name(server: &str, model: &str) -> String {
    let mut out = format!("{TIER_PREFIX}{server}");
    let mut dash = true;
    for c in model.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if dash {
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

/// What a tier runs on: its server and the model record (`id` = the model
/// id the server knows it by). None when the server or model was removed.
#[logged]
pub fn route_of(engine: &Engine, tier: &str) -> Option<(Value, Value)> {
    for s in servers(engine) {
        if let Some(models) = s["models"].as_object() {
            if let Some(m) = models.values().find(|m| m["tier"].as_str() == Some(tier)) {
                let m = m.clone();
                return Some((s, m));
            }
        }
    }
    None
}

/// The hireable tiers: every offered model of every enabled server, as
/// (tier, seat, model id, label, server label).
#[logged]
pub fn tiers(engine: &Engine) -> Vec<(String, f64, String, String, String)> {
    let mut out = Vec::new();
    for s in servers(engine) {
        if s["enabled"].as_bool() == Some(false) {
            continue;
        }
        let server_label = s["label"].as_str().unwrap_or("").to_string();
        let mut models: Vec<&Value> = s["models"].as_object().map(|m| m.values().collect()).unwrap_or_default();
        models.sort_by(|a, b| a["tier"].as_str().cmp(&b["tier"].as_str()));
        for m in models {
            if m["offered"].as_bool() != Some(true) {
                continue;
            }
            let (Some(tier), Some(id)) = (m["tier"].as_str(), m["id"].as_str()) else { continue };
            let label = m["label"].as_str().filter(|l| !l.is_empty()).unwrap_or(id).to_string();
            out.push((tier.to_string(), SEAT, id.to_string(), label, server_label.clone()));
        }
    }
    out
}

/// The base URL a harness is pointed at. Claude Code appends
/// `/v1/messages` itself; Codex appends `/responses` to its provider's
/// `base_url`, so a preset's Codex base ends in `/v1`. A custom server's
/// base path replaces the preset's suffix.
#[logged]
pub fn base_url(server: &Value) -> String {
    let address = server["address"].as_str().unwrap_or("").trim().trim_end_matches('/').to_string();
    let harness = server["harness"].as_str().unwrap_or("claude-code");
    if server["preset"].as_str() == Some("custom") {
        let path = server["base_path"].as_str().unwrap_or("").trim().trim_matches('/');
        return if path.is_empty() { address } else { format!("{address}/{path}") };
    }
    if harness == "codex-cli" { format!("{address}/v1") } else { address }
}

/// The window an agent on this model gets: the user's figure, else what
/// the server reported, else DEFAULT_CONTEXT.
#[logged]
pub fn context_of(model: &Value) -> i64 {
    model["context"]
        .as_i64()
        .filter(|c| *c > 0)
        .or_else(|| model["detected_context"].as_i64().filter(|c| *c > 0))
        .unwrap_or(DEFAULT_CONTEXT)
}

/// The stored key of a server, if it has one (a secret: not logged).
pub async fn key(engine: &Engine, server: &str) -> Option<String> {
    let client = engine.db.get().await.ok()?;
    client
        .query_opt("SELECT secret FROM ot.langserver_secrets WHERE server_id = $1", &[&server])
        .await
        .ok()
        .flatten()
        .map(|r| r.get(0))
}

/// Store or clear a server's key (a secret: not logged).
async fn set_key(engine: &Engine, server: &str, key: Option<&str>) -> Result<()> {
    let client = engine.db.get().await?;
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => {
            client
                .execute(
                    "INSERT INTO ot.langserver_secrets (server_id, secret) VALUES ($1, $2)
                     ON CONFLICT (server_id) DO UPDATE SET secret = EXCLUDED.secret",
                    &[&server, &k],
                )
                .await?;
        }
        None => {
            client.execute("DELETE FROM ot.langserver_secrets WHERE server_id = $1", &[&server]).await?;
        }
    }
    Ok(())
}

/// Which installed harnesses can drive a server of this preset.
#[logged]
pub fn harnesses(engine: &Engine, preset_id: &str) -> Vec<Value> {
    let p = preset(preset_id);
    // discovery runs in the background after start: before it has, look
    // for the CLI the way a launch does
    let claude = engine.providers.claude_path().is_some() || crate::providers::locate_claude().is_some();
    let codex = engine.providers.codex_path().is_some() || crate::providers::locate_codex().is_some();
    let opt = |id: &str, label: &str, installed: bool, served: bool| {
        let why = if !installed {
            format!("{label} is not installed on this machine")
        } else if !served {
            p.map(|p| p.note.to_string()).unwrap_or_default()
        } else {
            String::new()
        };
        json!({ "id": id, "label": label, "available": installed && served, "installed": installed, "why": why })
    };
    vec![
        opt("claude-code", "Claude Code", claude, p.map(|p| p.claude).unwrap_or(false)),
        opt("codex-cli", "Codex", codex, p.map(|p| p.codex).unwrap_or(false)),
    ]
}

/// A new server's id: the preset's, made unique (`ollama`, `ollama-2`, …).
#[logged]
fn new_id(engine: &Engine, preset_id: &str) -> String {
    let taken: Vec<String> = servers(engine).iter().filter_map(|s| s["id"].as_str().map(str::to_string)).collect();
    if !taken.iter().any(|t| t == preset_id) {
        return preset_id.to_string();
    }
    (2..).map(|n| format!("{preset_id}-{n}")).find(|c| !taken.contains(c)).unwrap_or_else(|| preset_id.to_string())
}

/// Check and normalise a server address: an http(s) URL with a host and no
/// query or fragment.
#[logged]
pub fn normalize_address(raw: &str) -> Result<String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        crate::refuse!(BadRequest, "enter the server address, for example http://127.0.0.1:11434");
    }
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let url = reqwest::Url::parse(&with_scheme).map_err(|e| anyhow!(crate::domain::UserError::BadRequest(format!("{raw} is not a server address ({e})"))))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        crate::refuse!(BadRequest, "a language server address starts with http:// or https://");
    }
    if url.host_str().unwrap_or("").is_empty() {
        crate::refuse!(BadRequest, "{raw} names no host");
    }
    if url.query().is_some() || url.fragment().is_some() {
        crate::refuse!(BadRequest, "a server address has no query or fragment");
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// What the add form sends (the key, when present, is a secret).
pub struct NewServer {
    pub preset: String,
    pub label: Option<String>,
    pub address: String,
    pub harness: String,
    pub base_path: Option<String>,
    pub max_agents: Option<i64>,
    pub key: Option<String>,
    /// models to offer at once: (model id, context or 0)
    pub models: Vec<(String, i64)>,
}

impl std::fmt::Debug for NewServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewServer")
            .field("preset", &self.preset)
            .field("label", &self.label)
            .field("address", &self.address)
            .field("harness", &self.harness)
            .field("base_path", &self.base_path)
            .field("max_agents", &self.max_agents)
            .field("key", &self.key.as_ref().map(|_| "*****"))
            .field("models", &self.models)
            .finish()
    }
}

/// Add a server. Its harness is fixed for its life: an agent's session
/// cannot move between Claude Code and Codex, so the other harness is
/// another server entry (the same address may appear twice).
#[logged]
pub async fn add_server(engine: &Engine, b: NewServer) -> Result<Value> {
    let Some(p) = preset(&b.preset) else { crate::refuse!(BadRequest, "unknown server kind {}", b.preset) };
    let address = normalize_address(&b.address)?;
    let h = harnesses(engine, p.id);
    let Some(choice) = h.iter().find(|o| o["id"].as_str() == Some(b.harness.as_str())) else {
        crate::refuse!(BadRequest, "the harness is claude-code or codex-cli")
    };
    if choice["available"] != json!(true) {
        crate::refuse!(Conflict, "{}", choice["why"].as_str().unwrap_or("that harness cannot drive this server"));
    }
    let max_agents = b.max_agents.unwrap_or(1);
    if !(1..=64).contains(&max_agents) {
        crate::refuse!(BadRequest, "agents at once is between 1 and 64");
    }
    let id = new_id(engine, p.id);
    let label = b.label.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).unwrap_or_else(|| {
        let n = servers(engine).iter().filter(|s| s["preset"].as_str() == Some(p.id)).count();
        let base = if p.id == "custom" { "Custom server".to_string() } else { p.label.to_string() };
        if n == 0 { base } else { format!("{base} {}", n + 1) }
    });
    let mut models = Map::new();
    for (mid, ctx) in &b.models {
        add_model(&id, &mut models, mid, *ctx, true);
    }
    let rec = json!({
        "id": id, "preset": p.id, "label": label, "address": address, "harness": b.harness,
        "api": api_of(&b.harness), "base_path": b.base_path.as_deref().map(str::trim).unwrap_or(""),
        "max_agents": max_agents, "enabled": true, "key_set": b.key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false),
        "models": models, "created_at": iso(chrono::Utc::now()),
    });
    if b.key.is_some() {
        set_key(engine, &id, b.key.as_deref()).await?;
    }
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "language_servers": { "servers": { id.clone(): rec.clone() } } })).await?;
    Ok(rec)
}

/// Add one model to a server's model map, under a tier name no other model
/// of that server holds.
#[logged]
fn add_model(server: &str, models: &mut Map<String, Value>, id: &str, context: i64, offered: bool) {
    let id = id.trim();
    if id.is_empty() || models.contains_key(id) {
        return;
    }
    let base = tier_name(server, id);
    let taken = |t: &str| models.values().any(|m| m["tier"].as_str() == Some(t));
    let tier = if !taken(&base) { base.clone() } else { (2..).map(|n| format!("{base}-{n}")).find(|t| !taken(t)).unwrap_or(base) };
    models.insert(
        id.to_string(),
        json!({ "id": id, "tier": tier, "label": id, "offered": offered,
                "context": if context > 0 { json!(context) } else { Value::Null } }),
    );
}

/// What the edit form may change. The harness and kind stay as created.
#[derive(Debug, Default)]
pub struct ServerPatch {
    pub label: Option<String>,
    pub address: Option<String>,
    pub base_path: Option<String>,
    pub max_agents: Option<i64>,
    pub enabled: Option<bool>,
    /// per model id: offered, the window to use (0 = the detected one), a new label
    pub models: Vec<(String, Option<bool>, Option<i64>, Option<String>)>,
}

#[logged]
pub async fn update_server(engine: &Engine, id: &str, patch: ServerPatch) -> Result<Value> {
    let Some(cur) = server(engine, id) else { crate::refuse!(NotFound, "no language server {id}") };
    let mut p = Map::new();
    if let Some(l) = patch.label.as_deref().map(str::trim) {
        if l.is_empty() {
            crate::refuse!(BadRequest, "a server needs a name");
        }
        p.insert("label".into(), json!(l));
    }
    if let Some(a) = &patch.address {
        p.insert("address".into(), json!(normalize_address(a)?));
    }
    if let Some(bp) = &patch.base_path {
        p.insert("base_path".into(), json!(bp.trim()));
    }
    if let Some(n) = patch.max_agents {
        if !(1..=64).contains(&n) {
            crate::refuse!(BadRequest, "agents at once is between 1 and 64");
        }
        p.insert("max_agents".into(), json!(n));
    }
    if let Some(e) = patch.enabled {
        p.insert("enabled".into(), json!(e));
    }
    if !patch.models.is_empty() {
        let mut models = cur["models"].as_object().cloned().unwrap_or_default();
        let mut mp = Map::new();
        for (mid, offered, ctx, label) in patch.models {
            if !models.contains_key(&mid) {
                add_model(id, &mut models, &mid, ctx.unwrap_or(0), offered.unwrap_or(true));
                mp.insert(mid.clone(), models[&mid].clone());
                continue;
            }
            let mut m = Map::new();
            if let Some(o) = offered {
                m.insert("offered".into(), json!(o));
            }
            if let Some(c) = ctx {
                if c < 0 || c > 10_000_000 {
                    crate::refuse!(BadRequest, "a context window is a token count");
                }
                m.insert("context".into(), if c == 0 { Value::Null } else { json!(c) });
            }
            if let Some(l) = label.as_deref().map(str::trim) {
                m.insert("label".into(), json!(if l.is_empty() { mid.as_str() } else { l }));
            }
            mp.insert(mid, Value::Object(m));
        }
        p.insert("models".into(), Value::Object(mp));
    }
    let mut client = engine.db.get().await?;
    let doc = engine.settings.merge(&mut client, json!({ "language_servers": { "servers": { id: p } } })).await?;
    Ok(doc.pointer("/language_servers/servers").and_then(|m| m.get(id)).cloned().unwrap_or(Value::Null))
}

/// Replace or clear a server's key (`None` or blank clears it). Not logged:
/// it holds the key.
pub async fn update_key(engine: &Engine, id: &str, key: Option<&str>) -> Result<()> {
    if server(engine, id).is_none() {
        crate::refuse!(NotFound, "no language server {id}");
    }
    set_key(engine, id, key).await?;
    let set = key.map(|k| !k.trim().is_empty()).unwrap_or(false);
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "language_servers": { "servers": { id: { "key_set": set } } } })).await?;
    Ok(())
}

/// Remove a server. Agents hired on its models stay, and their next turn
/// says the model is gone (switch them to another tier).
#[logged]
pub async fn remove_server(engine: &Engine, id: &str) -> Result<()> {
    if server(engine, id).is_none() {
        crate::refuse!(NotFound, "no language server {id}");
    }
    set_key(engine, id, None).await?;
    let mut client = engine.db.get().await?;
    engine.settings.merge(&mut client, json!({ "language_servers": { "servers": { id: Value::Null } } })).await?;
    prune_catalogs(&engine.cfg.path("profiles").join(CODEX_HOME_DIR).join("catalogs"), id, 0);
    Ok(())
}

/// The lane's document for App settings (secret-free).
#[logged]
pub fn doc(engine: &Engine) -> Value {
    let presets: Vec<Value> = PRESETS
        .iter()
        .map(|p| json!({ "id": p.id, "label": p.label, "address": p.address, "claude": p.claude, "codex": p.codex,
                         "note": p.note, "harnesses": harnesses(engine, p.id) }))
        .collect();
    let list: Vec<Value> = servers(engine)
        .into_iter()
        .map(|mut s| {
            s["base_url"] = json!(base_url(&s));
            if let Some(models) = s["models"].as_object_mut() {
                for m in models.values_mut() {
                    let ctx = context_of(m);
                    m["context_in_use"] = json!(ctx);
                    m["too_small"] = json!(ctx < MIN_CONTEXT);
                }
            }
            s
        })
        .collect();
    json!({
        "servers": list, "presets": presets, "seat": SEAT, "min_context": MIN_CONTEXT, "default_context": DEFAULT_CONTEXT,
        "user_enabled": engine.settings.provider_enabled(crate::providers::catalog::LANGSERVER),
    })
}

/// Push the lane's document and the providers list to every window, and
/// tell every org its hireable tiers changed (after any change to a server).
#[logged]
pub fn publish(engine: &Engine) {
    engine.app.set_value("langservers", doc(engine));
    crate::providers::publish(engine);
    for o in engine.orgs.all() {
        crate::changes::notify(engine, &o, vec![crate::changes::Change::Tiers]);
    }
}

// ------------------------------------------------------------------ probing

/// Ask a server what it is and which models it offers, without loading
/// any model: reachable, version, and per model its id, size, the window it
/// was trained for and, when loaded, the window it runs with. Not logged:
/// the key may be part of the request.
pub async fn probe(preset_id: &str, address: &str, key: Option<&str>, harness: &str, base_path: Option<&str>) -> Value {
    let address = match normalize_address(address) {
        Ok(a) => a,
        Err(e) => return json!({ "reachable": false, "error": format!("{e:#}"), "models": [] }),
    };
    let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).user_agent(USER_AGENT).build() {
        Ok(c) => c,
        Err(e) => return json!({ "reachable": false, "error": format!("{e:#}"), "models": [] }),
    };
    let token = key.map(str::trim).filter(|k| !k.is_empty());
    let get = |url: String| {
        let mut r = client.get(url);
        if let Some(k) = token {
            r = r.bearer_auth(k).header("x-api-key", k);
        }
        r
    };
    let result: std::result::Result<Value, String> = match preset_id {
        "ollama" => probe_ollama(&client, &address, &get).await,
        "lmstudio" => probe_lmstudio(&address, &get).await,
        "llamacpp" => probe_llamacpp(&address, &get).await,
        _ => {
            // vLLM and custom servers: the OpenAI model list (vLLM adds max_model_len)
            let base = if preset_id == "custom" {
                let p = base_path.unwrap_or("").trim().trim_matches('/');
                if p.is_empty() { address.clone() } else { format!("{address}/{p}") }
            } else {
                format!("{address}/v1")
            };
            let base = if preset_id == "custom" && harness != "codex-cli" && !base.ends_with("/v1") { format!("{base}/v1") } else { base };
            probe_openai_models(&format!("{base}/models"), &get).await
        }
    };
    match result {
        Ok(mut v) => {
            v["reachable"] = json!(true);
            v
        }
        Err(e) => json!({ "reachable": false, "error": e, "models": [] }),
    }
}

/// `GET <url>` as JSON, with a short error naming what failed.
async fn fetch_json(req: reqwest::RequestBuilder) -> std::result::Result<Value, String> {
    let res = req.send().await.map_err(|e| short_error(&e))?;
    let status = res.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(format!("the server refused the request ({status}): check its API key"));
    }
    if !status.is_success() {
        return Err(format!("the server answered {status}"));
    }
    res.json::<Value>().await.map_err(|e| format!("the server's answer is not JSON ({e})"))
}

#[nolog]
fn short_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the server did not answer in time".to_string()
    } else if e.is_connect() {
        "nothing is answering at that address (is the server running?)".to_string()
    } else {
        format!("{e}")
    }
}

async fn probe_ollama<F>(client: &reqwest::Client, address: &str, get: &F) -> std::result::Result<Value, String>
where
    F: Fn(String) -> reqwest::RequestBuilder,
{
    let version = fetch_json(get(format!("{address}/api/version"))).await?;
    let tags = fetch_json(get(format!("{address}/api/tags"))).await?;
    // the windows of the models loaded right now (OLLAMA_CONTEXT_LENGTH or a Modelfile's num_ctx)
    let running: Vec<(String, i64)> = fetch_json(get(format!("{address}/api/ps")))
        .await
        .ok()
        .and_then(|ps| ps["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| Some((m["name"].as_str()?.to_string(), m["context_length"].as_i64()?)))
        .collect();
    let mut models = Vec::new();
    for m in tags["models"].as_array().cloned().unwrap_or_default() {
        let Some(name) = m["name"].as_str().or_else(|| m["model"].as_str()) else { continue };
        // the trained window and the capabilities, from the model's own metadata
        let show = client.post(format!("{address}/api/show")).json(&json!({ "model": name })).send().await;
        let show: Value = match show {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
            _ => Value::Null,
        };
        let trained = show["model_info"]
            .as_object()
            .and_then(|info| info.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, v)| v.as_i64()));
        let caps: Vec<Value> = show["capabilities"].as_array().cloned().unwrap_or_default();
        // an embedding model cannot drive an agent
        if !caps.is_empty() && !caps.iter().any(|c| c == "completion") {
            continue;
        }
        let loaded = running.iter().find(|(n, _)| n == name).map(|(_, c)| *c);
        models.push(json!({
            "id": name, "size": m["size"], "family": m["details"]["family"], "parameters": m["details"]["parameter_size"],
            "quantization": m["details"]["quantization_level"], "max_context": trained, "loaded_context": loaded,
            // the window its Modelfile sets: what every request that names no window gets
            "configured_context": show["parameters"].as_str().and_then(num_ctx_of),
            "tools": caps.iter().any(|c| c == "tools"), "capabilities": caps,
        }));
    }
    Ok(json!({
        "version": version["version"], "models": models,
        "note": "Ollama runs a model with the window its Modelfile sets (num_ctx), else with OLLAMA_CONTEXT_LENGTH (4096 by default on cards under 24 GB), and silently cuts longer prompts: set it to at least 65536, or create a 64K version of a model below.",
    }))
}

/// The `num_ctx` of an Ollama model's parameters, as `/api/show` lists them
/// (one `name value` line per parameter).
#[logged]
fn num_ctx_of(parameters: &str) -> Option<i64> {
    parameters.lines().find_map(|l| {
        let mut w = l.split_whitespace();
        (w.next() == Some("num_ctx")).then(|| w.next().and_then(|v| v.trim_matches('"').parse::<i64>().ok())).flatten()
    })
}

/// The name of an Ollama model's variant with its own window: the same
/// name with the window added to its tag (`qwen3.8:27b` → `qwen3.8:27b-64k`;
/// a name without a tag is `:latest`). Ollama allows tags of 80 characters.
#[logged]
pub fn variant_name(model: &str, context: i64) -> String {
    let model = model.trim();
    let name_at = model.rfind('/').map(|i| i + 1).unwrap_or(0);
    let (base, tag) = match model[name_at..].rfind(':') {
        Some(i) => (&model[..name_at + i], &model[name_at + i + 1..]),
        None => (model, "latest"),
    };
    let suffix = format!("-{}k", context / 1024);
    let keep: String = tag.chars().take(80 - suffix.len()).collect();
    format!("{base}:{keep}{suffix}")
}

/// Make a variant of an Ollama model that runs with `context` tokens: a new
/// entry in the user's Ollama (`POST /api/create` from the model, with a
/// `num_ctx` parameter) that shares the original's weights, so nothing is
/// downloaded. Only ever on the user's click (coordinator ruling
/// 2026-10-10: never automatically). Returns the new model's name. Not
/// logged: the key may be part of the request.
pub async fn create_ollama_variant(address: &str, key: Option<&str>, model: &str, context: i64) -> Result<String> {
    let address = normalize_address(address)?;
    let model = model.trim();
    if model.is_empty() {
        crate::refuse!(BadRequest, "name the model to make a version of");
    }
    let name = variant_name(model, context);
    let client = reqwest::Client::builder().timeout(CREATE_TIMEOUT).user_agent(USER_AGENT).build()?;
    let mut req = client
        .post(format!("{address}/api/create"))
        .json(&json!({ "model": name, "from": model, "parameters": { "num_ctx": context }, "stream": false }));
    if let Some(k) = key.map(str::trim).filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => crate::refuse!(Conflict, "Ollama could not be asked: {}", short_error(&e)),
    };
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = body["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("it answered {status}"));
        crate::refuse!(Conflict, "Ollama did not create {name}: {why}");
    }
    if let Some(why) = body["error"].as_str() {
        crate::refuse!(Conflict, "Ollama did not create {name}: {why}");
    }
    tracing::info!(from = model, model = %name, context, "made an Ollama model variant");
    Ok(name)
}

async fn probe_lmstudio<F>(address: &str, get: &F) -> std::result::Result<Value, String>
where
    F: Fn(String) -> reqwest::RequestBuilder,
{
    // 0.4+: /api/v1/models (max_context_length, loaded instances); older: /api/v0/models
    let v1 = fetch_json(get(format!("{address}/api/v1/models"))).await;
    let (list, newer) = match v1 {
        Ok(v) => (v, true),
        Err(_) => (fetch_json(get(format!("{address}/api/v0/models"))).await?, false),
    };
    let items = list["models"].as_array().or_else(|| list["data"].as_array()).cloned().unwrap_or_default();
    let mut models = Vec::new();
    for m in items {
        let kind = m["type"].as_str().unwrap_or("llm");
        if kind == "embeddings" || kind == "embedding" {
            continue;
        }
        let Some(id) = m["key"].as_str().or_else(|| m["id"].as_str()) else { continue };
        let loaded = m["loaded_instances"]
            .as_array()
            .and_then(|a| a.iter().filter_map(|i| i["config"]["context_length"].as_i64().or_else(|| i["context_length"].as_i64())).max())
            .or_else(|| if m["state"].as_str() == Some("loaded") { m["loaded_context_length"].as_i64() } else { None });
        models.push(json!({
            "id": id, "max_context": m["max_context_length"], "loaded_context": loaded,
            "quantization": m["quantization"].get("name").cloned().unwrap_or_else(|| m["quantization"].clone()),
            "tools": m["capabilities"].as_array().map(|c| c.iter().any(|x| x == "tool_use")).or_else(|| m["trained_for_tool_use"].as_bool()),
        }));
    }
    Ok(json!({ "version": Value::Null, "models": models, "api": if newer { "v1" } else { "v0" },
               "note": "LM Studio loads a model with the context length set for it in My Models (or lms load --context-length)." }))
}

async fn probe_llamacpp<F>(address: &str, get: &F) -> std::result::Result<Value, String>
where
    F: Fn(String) -> reqwest::RequestBuilder,
{
    let list = fetch_json(get(format!("{address}/v1/models"))).await?;
    // the running window and the slots of a single-model server
    let props = fetch_json(get(format!("{address}/props"))).await.unwrap_or(Value::Null);
    let n_ctx = props["default_generation_settings"]["n_ctx"].as_i64().or_else(|| props["n_ctx"].as_i64());
    let slots = props["total_slots"].as_i64();
    let mut models = Vec::new();
    for m in list["data"].as_array().cloned().unwrap_or_default() {
        let Some(id) = m["id"].as_str() else { continue };
        models.push(json!({ "id": id, "max_context": m["meta"]["n_ctx_train"], "loaded_context": n_ctx }));
    }
    Ok(json!({ "version": props["build_info"], "models": models, "slots": slots,
               "note": "llama-server runs with the window set by -c; with several slots (-np) each slot may get only a share of it." }))
}

async fn probe_openai_models<F>(url: &str, get: &F) -> std::result::Result<Value, String>
where
    F: Fn(String) -> reqwest::RequestBuilder,
{
    let list = fetch_json(get(url.to_string())).await?;
    let mut models = Vec::new();
    for m in list["data"].as_array().cloned().unwrap_or_default() {
        let Some(id) = m["id"].as_str() else { continue };
        models.push(json!({ "id": id, "max_context": m["max_model_len"].as_i64().or_else(|| m["context_length"].as_i64()),
                            "loaded_context": m["max_model_len"] }));
    }
    Ok(json!({ "version": Value::Null, "models": models }))
}

// ------------------------------------------------------------------ launching

/// What a language-server seat needs before it can launch.
pub struct Route {
    pub server: String,
    pub base_url: String,
    /// the server's key, or NO_KEY (a secret: never logged)
    pub key: String,
    pub model: String,
    pub context: i64,
    pub codex: bool,
    pub max_agents: i64,
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Route")
            .field("server", &self.server)
            .field("base_url", &self.base_url)
            .field("key", &"*****")
            .field("model", &self.model)
            .field("context", &self.context)
            .field("codex", &self.codex)
            .field("max_agents", &self.max_agents)
            .finish()
    }
}

/// Resolve a tier to its launch route: the lane on, the server and model
/// still configured, the server enabled.
#[logged]
pub async fn route(engine: &Engine, tier: &str) -> Result<Route> {
    if !engine.settings.provider_enabled(crate::providers::catalog::LANGSERVER) {
        anyhow::bail!("Language Server models are turned off in App settings");
    }
    let (s, m) = route_of(engine, tier).ok_or_else(|| {
        anyhow!("{tier} is not a model of any language server this app knows (App settings › Providers › Language Server); switch this agent to another tier")
    })?;
    let id = s["id"].as_str().unwrap_or("").to_string();
    if s["enabled"].as_bool() == Some(false) {
        anyhow::bail!("the language server {} is turned off in App settings › Providers", s["label"].as_str().unwrap_or(&id));
    }
    let key = key(engine, &id).await.unwrap_or_else(|| NO_KEY.to_string());
    Ok(Route {
        base_url: base_url(&s),
        key,
        model: m["id"].as_str().unwrap_or("").to_string(),
        context: context_of(&m),
        codex: s["harness"].as_str() == Some("codex-cli"),
        max_agents: s["max_agents"].as_i64().unwrap_or(1).max(1),
        server: id,
    })
}

/// Variables a Claude Code launch on this lane must not inherit: each would
/// pick another credential or another backend than the server (auth
/// precedence: cloud provider, AUTH_TOKEN, API_KEY, apiKeyHelper,
/// OAUTH_TOKEN, profile, saved login).
pub const CLAUDE_ENV_REMOVE: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_PROFILE",
];

/// The environment that points one Claude Code launch at a server. The key
/// goes in as the auth token with ANTHROPIC_API_KEY empty (a set key wins
/// over the token); an auth token also keeps any saved claude.ai login from
/// being sent to the server. Every model the CLI could reach for is pinned
/// to the server's model, and the CLI is told the model's real window (it
/// assumes 200K for a model it does not know), a reply size the window can
/// spare, to leave out request fields a local server may refuse, and to
/// wait for a slow server.
#[logged]
pub fn claude_env(r: &Route) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = vec![
        ("ANTHROPIC_BASE_URL".into(), r.base_url.clone()),
        ("ANTHROPIC_AUTH_TOKEN".into(), r.key.clone()),
        ("ANTHROPIC_API_KEY".into(), String::new()),
        ("ANTHROPIC_MODEL".into(), r.model.clone()),
        ("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), r.context.to_string()),
        ("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), MAX_OUTPUT.min(r.context / 4).max(1024).to_string()),
        // context_management, beta tool fields, output_config.format
        ("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".into(), "1".into()),
        // a stable system prompt, so the server's own prompt cache can hit
        ("CLAUDE_CODE_ATTRIBUTION_HEADER".into(), "0".into()),
        ("API_TIMEOUT_MS".into(), SLOW_MS.to_string()),
        ("CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS".into(), SLOW_MS.to_string()),
        ("CLAUDE_STREAM_IDLE_TIMEOUT_MS".into(), SLOW_MS.to_string()),
    ];
    for var in [
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        env.push((var.into(), r.model.clone()));
    }
    env
}

/// A TOML basic string, for a `-c key=value` override.
#[nolog]
fn toml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `-c` overrides pointing one Codex launch at a server's Responses API,
/// with the server's model catalog when there is one. Codex's hosted web
/// search is off: it runs only on OpenAI's servers, and a local server can
/// only refuse or ignore the tool.
#[logged]
pub fn codex_overrides(r: &Route, compact_at: f64, catalog: Option<&Path>) -> Vec<String> {
    let q = |s: &str| toml_str(s);
    let p = format!("model_providers.{CODEX_PROVIDER}");
    let mut out = Vec::new();
    let mut kvs = vec![
        format!("model_provider={}", q(CODEX_PROVIDER)),
        format!("{p}.name={}", q("Language Server")),
        format!("{p}.base_url={}", q(&r.base_url)),
        format!("{p}.env_key={}", q(KEY_ENV)),
        format!("{p}.wire_api={}", q("responses")),
        // a slow server may think for minutes before its first event
        format!("{p}.stream_idle_timeout_ms={SLOW_MS}"),
        format!("{p}.request_max_retries=2"),
        format!("{p}.stream_max_retries=2"),
        format!("model={}", q(&r.model)),
        format!("model_context_window={}", r.context),
        format!("model_auto_compact_token_limit={}", ((r.context as f64) * compact_at) as i64),
        format!("web_search={}", q("disabled")),
    ];
    if let Some(c) = catalog {
        kvs.push(format!("model_catalog_json={}", q(&c.to_string_lossy())));
    }
    for kv in kvs {
        out.push("-c".to_string());
        out.push(kv);
    }
    out
}

// ------------------------------------------------------------------ Codex's model catalog

/// The instructions Codex sends for a model missing from its catalog (its
/// built-in default prompt, as Codex 0.160.0 sends it; Apache-2.0, see
/// THIRD_PARTY_NOTICES.md). A catalog entry must carry instructions, and a
/// language server's entries carry these, so an entry changes nothing but
/// what it is for.
const CODEX_DEFAULT_INSTRUCTIONS: &str = include_str!("../assets/codex-default-instructions.md");

/// A server's models as a Codex model catalog (`model_catalog_json`). Each
/// entry is what Codex assumes for a model it does not know (its default
/// prompt, its unified shell, no patch tool, output cut at 10,000 bytes,
/// text and images), plus the model's real window. Codex then knows the
/// model: it stops warning "model metadata not found" and plans with the
/// window the server gives it. Measured against Codex 0.160.0: with such an
/// entry it sends the same request as without one.
#[logged]
pub fn codex_catalog(server: &Value) -> Value {
    let instructions = CODEX_DEFAULT_INSTRUCTIONS.replace("\r\n", "\n");
    let mut models: Vec<&Value> = server["models"].as_object().map(|m| m.values().collect()).unwrap_or_default();
    models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let label = server["label"].as_str().unwrap_or("a language server");
    let entries: Vec<Value> = models
        .into_iter()
        .filter_map(|m| {
            let id = m["id"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
            let window = context_of(m);
            Some(json!({
                "slug": id,
                "display_name": m["label"].as_str().filter(|l| !l.trim().is_empty()).unwrap_or(id),
                "description": format!("{id} on {label} (Language Server)"),
                "default_reasoning_level": Value::Null,
                "supported_reasoning_levels": [],
                "shell_type": "unified_exec",
                "visibility": "list",
                "supported_in_api": true,
                "priority": 99,
                "base_instructions": instructions,
                "default_reasoning_summary": "auto",
                "support_verbosity": false,
                "default_verbosity": Value::Null,
                "apply_patch_tool_type": Value::Null,
                "truncation_policy": { "mode": "bytes", "limit": 10_000 },
                "context_window": window,
                "max_context_window": window,
                "effective_context_window_percent": 95,
                "experimental_supported_tools": [],
                "input_modalities": ["text", "image"],
            }))
        })
        .collect();
    json!({ "models": entries })
}

/// Which Codex binary read a catalog: its path, size and modification time.
#[logged]
fn exe_print(exe: &Path) -> String {
    let meta = std::fs::metadata(exe).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hex::encode(&Sha256::digest(format!("{}|{len}|{modified}", exe.to_string_lossy()).as_bytes())[..6])
}

/// Keep a server's newest `keep` catalogs (and their markers), remove the
/// rest. A file is `<server>-<12 hex>.json`, its marker
/// `<server>-<12 hex>.<print>.ok`. Best effort.
#[logged]
fn prune_catalogs(dir: &Path, server: &str, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let prefix = format!("{server}-");
    let mut catalogs: Vec<(std::time::SystemTime, String)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(&prefix) else { continue };
        // the hash, then a dot: `ollama-` must not take `ollama-2-…`
        let (Some(hash), Some(tail)) = (rest.get(..12), rest.get(12..)) else { continue };
        if !hash.bytes().all(|b| b.is_ascii_hexdigit()) || !tail.starts_with('.') {
            continue;
        }
        if tail == ".json" {
            let at = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            catalogs.push((at, hash.to_string()));
        }
        files.push((hash.to_string(), e.path()));
    }
    catalogs.sort_by(|a, b| b.0.cmp(&a.0));
    let kept: Vec<&String> = catalogs.iter().take(keep).map(|(_, h)| h).collect();
    for (hash, path) in files {
        if !kept.contains(&&hash) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Write a server's Codex catalog where a launch can point at it, and make
/// sure the installed Codex reads it: Codex's catalog schema is strict and
/// changes between versions (0.160 refuses a missing field and knows only a
/// "freeform" patch tool), and a catalog it cannot read would stop every
/// launch. So each catalog is checked once per Codex binary with `codex
/// debug models` (about 0.1 s), which leaves a marker. The file is named by
/// its content, so a launch never reads a half-written one. None: launch
/// without a catalog (Codex then assumes its defaults, and warns).
#[logged]
pub async fn codex_catalog_file(exe: &Path, home: &Path, server: &Value) -> Option<PathBuf> {
    let id = server["id"].as_str().filter(|s| !s.is_empty())?;
    let body = serde_json::to_vec_pretty(&codex_catalog(server)).ok()?;
    let hash = hex::encode(&Sha256::digest(&body)[..6]);
    let dir = home.join("catalogs");
    let file = dir.join(format!("{id}-{hash}.json"));
    let marker = dir.join(format!("{id}-{hash}.{}.ok", exe_print(exe)));
    if file.is_file() && marker.is_file() {
        return Some(file);
    }
    if !file.is_file() {
        let tmp = dir.join(format!("{id}-{hash}.{}.tmp", std::process::id()));
        let written = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(&tmp, &body))
            .and_then(|_| std::fs::rename(&tmp, &file));
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            if !file.is_file() {
                tracing::warn!(server = id, error = %e, "could not write the language server's Codex catalog; launching without it");
                return None;
            }
        }
        prune_catalogs(&dir, id, 3);
    }
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(["debug", "models", "-c", &format!("model_catalog_json={}", toml_str(&file.to_string_lossy()))])
        .env("CODEX_HOME", home)
        .env_remove("OPENAI_API_KEY")
        .env_remove("OPENAI_BASE_URL")
        .env_remove("CODEX_API_KEY")
        .current_dir(home)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    let out = tokio::time::timeout(CATALOG_CHECK_TIMEOUT, cmd.output()).await;
    let ok = match &out {
        Ok(Ok(o)) if o.status.success() => serde_json::from_slice::<Value>(&o.stdout)
            .ok()
            .and_then(|v| v["models"].as_array().map(|m| m.len()))
            .is_some_and(|n| n > 0),
        _ => false,
    };
    if !ok {
        let why = match out {
            Ok(Ok(o)) => String::from_utf8_lossy(&o.stderr).trim().chars().take(400).collect::<String>(),
            Ok(Err(e)) => e.to_string(),
            Err(_) => "Codex did not answer in time".to_string(),
        };
        tracing::warn!(server = id, why = %why, "the installed Codex cannot read the language server's model catalog; launching without it");
        return None;
    }
    let _ = std::fs::write(&marker, b"");
    Some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_variant_keeps_the_name_and_marks_the_tag() {
        assert_eq!(variant_name("qwen3.8:27b", 65_536), "qwen3.8:27b-64k");
        assert_eq!(variant_name("qwen3.8", 65_536), "qwen3.8:latest-64k");
        assert_eq!(variant_name("hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ3_XXS", 65_536), "hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ3_XXS-64k");
        // a host with a port is not a tag
        assert_eq!(variant_name("registry.local:5000/team/model", 65_536), "registry.local:5000/team/model:latest-64k");
        let long = format!("m:{}", "t".repeat(90));
        assert_eq!(variant_name(&long, 65_536).split(':').nth(1).unwrap().len(), 80);
    }

    #[test]
    fn num_ctx_is_read_from_the_parameter_lines() {
        let p = "num_ctx                        65536\nstop                           \"<|im_end|>\"";
        assert_eq!(num_ctx_of(p), Some(65_536));
        assert_eq!(num_ctx_of("stop \"x\""), None);
        assert_eq!(num_ctx_of(""), None);
    }

    fn server() -> Value {
        json!({ "id": "ollama", "label": "Ollama", "models": {
            "qwen3.8:27b-64k": { "id": "qwen3.8:27b-64k", "tier": "ls-ollama-qwen3-8-27b-64k", "label": "qwen3.8:27b-64k", "offered": true, "context": 65536 },
            "small:latest": { "id": "small:latest", "tier": "ls-ollama-small-latest", "label": "", "offered": false, "context": null } } })
    }

    #[test]
    fn a_catalog_lists_every_model_with_its_window_and_codex_s_own_prompt() {
        let c = codex_catalog(&server());
        let m = c["models"].as_array().unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["slug"], "qwen3.8:27b-64k");
        assert_eq!(m[0]["context_window"], 65_536);
        assert_eq!(m[1]["slug"], "small:latest");
        assert_eq!(m[1]["display_name"], "small:latest");
        assert_eq!(m[1]["context_window"], DEFAULT_CONTEXT);
        let text = m[0]["base_instructions"].as_str().unwrap();
        assert!(text.starts_with("You are a coding agent running in the Codex CLI"));
        assert!(!text.contains('\r'));
        assert!(m[0]["apply_patch_tool_type"].is_null() && m[0]["shell_type"] == "unified_exec");
    }

    #[test]
    fn overrides_name_the_catalog_and_turn_hosted_search_off() {
        let r = Route { server: "ollama".into(), base_url: "http://127.0.0.1:11434/v1".into(), key: NO_KEY.into(),
                        model: "qwen3.8:27b-64k".into(), context: 65_536, codex: true, max_agents: 1 };
        let o = codex_overrides(&r, 0.8, Some(Path::new(r"C:\data\profiles\langserver-codex\catalogs\ollama-0123456789ab.json")));
        assert!(o.contains(&r#"web_search="disabled""#.to_string()));
        assert!(o.contains(&r#"model_catalog_json="C:\\data\\profiles\\langserver-codex\\catalogs\\ollama-0123456789ab.json""#.to_string()));
        assert!(!codex_overrides(&r, 0.8, None).iter().any(|kv| kv.starts_with("model_catalog_json")));
    }

    #[test]
    fn pruning_keeps_the_newest_and_never_touches_another_server() {
        let dir = std::env::temp_dir().join(format!("orgtree-ls-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |name: &str| std::fs::write(dir.join(name), b"{}").unwrap();
        mk("ollama-aaaaaaaaaaaa.json");
        mk("ollama-aaaaaaaaaaaa.0123456789ab.ok");
        std::thread::sleep(Duration::from_millis(30));
        mk("ollama-bbbbbbbbbbbb.json");
        mk("ollama-2-cccccccccccc.json");
        mk("notes.txt");
        prune_catalogs(&dir, "ollama", 1);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        left.sort();
        assert_eq!(left, ["notes.txt", "ollama-2-cccccccccccc.json", "ollama-bbbbbbbbbbbb.json"]);
        prune_catalogs(&dir, "ollama-2", 0);
        assert!(!dir.join("ollama-2-cccccccccccc.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
