//! App settings › Providers › Language Server: the user's own model
//! servers. List, add, edit, remove, set a key, and ask a server which
//! models it offers. A key crosses the wire once, inward; no response ever
//! carries one.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::langserver::{self, NewServer, ServerPatch};

/// `GET /api/langservers`: servers, presets and harness availability.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(langserver::doc(&e))
}

#[derive(Deserialize, Debug)]
pub struct ModelPick {
    id: String,
    #[serde(default)]
    context: Option<i64>,
    #[serde(default)]
    offered: Option<bool>,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
pub struct AddBody {
    preset: String,
    #[serde(default)]
    label: Option<String>,
    address: String,
    harness: String,
    #[serde(default)]
    base_path: Option<String>,
    #[serde(default)]
    max_agents: Option<i64>,
    #[serde(default)]
    seat: Option<f64>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    models: Vec<ModelPick>,
}

impl std::fmt::Debug for AddBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddBody")
            .field("preset", &self.preset)
            .field("label", &self.label)
            .field("address", &self.address)
            .field("harness", &self.harness)
            .field("base_path", &self.base_path)
            .field("max_agents", &self.max_agents)
            .field("seat", &self.seat)
            .field("key", &self.key.as_ref().map(|_| "*****"))
            .field("models", &self.models)
            .finish()
    }
}

/// `POST /api/langservers`: add a server (its key, if any, stored apart).
#[logged]
pub async fn add(State(e): State<Arc<Engine>>, Json(b): Json<AddBody>) -> ApiResult<Json<Value>> {
    let rec = langserver::add_server(
        &e,
        NewServer {
            preset: b.preset,
            label: b.label,
            address: b.address,
            harness: b.harness,
            base_path: b.base_path,
            max_agents: b.max_agents,
            seat: b.seat,
            key: b.key,
            models: b.models.into_iter().map(|m| (m.id, m.context.unwrap_or(0))).collect(),
        },
    )
    .await?;
    langserver::publish(&e);
    Ok(Json(serde_json::json!({ "server": rec, "doc": langserver::doc(&e) })))
}

#[derive(Deserialize, Debug, Default)]
pub struct PatchBody {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    base_path: Option<String>,
    #[serde(default)]
    max_agents: Option<i64>,
    #[serde(default)]
    seat: Option<f64>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    models: Vec<ModelPick>,
}

/// `PATCH /api/langservers/{id}`: rename, move, cap, switch on or off, and
/// pick which models are offered and with which window.
#[logged]
pub async fn update(State(e): State<Arc<Engine>>, Path(id): Path<String>, Json(b): Json<PatchBody>) -> ApiResult<Json<Value>> {
    let rec = langserver::update_server(
        &e,
        &id,
        ServerPatch {
            label: b.label,
            address: b.address,
            base_path: b.base_path,
            max_agents: b.max_agents,
            seat: b.seat,
            enabled: b.enabled,
            models: b.models.into_iter().map(|m| (m.id, m.offered, m.context, m.label)).collect(),
        },
    )
    .await?;
    // a new price reaches the agents already on this server's models
    let repriced = if b.seat.is_some() { langserver::reprice_everywhere(&e).await } else { Vec::new() };
    langserver::publish(&e);
    Ok(Json(serde_json::json!({ "server": rec, "doc": langserver::doc(&e), "repriced": repriced })))
}

#[derive(Deserialize)]
pub struct KeyBody {
    #[serde(default)]
    key: Option<String>,
}

impl std::fmt::Debug for KeyBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyBody { key: ***** }")
    }
}

/// `PUT /api/langservers/{id}/key` (the body is a secret: not logged); an
/// empty or missing key clears it.
pub async fn set_key(State(e): State<Arc<Engine>>, Path(id): Path<String>, Json(b): Json<KeyBody>) -> ApiResult<Json<Value>> {
    langserver::update_key(&e, &id, b.key.as_deref()).await?;
    langserver::publish(&e);
    Ok(Json(langserver::doc(&e)))
}

/// `DELETE /api/langservers/{id}`
#[logged]
pub async fn remove(State(e): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    langserver::remove_server(&e, &id).await?;
    langserver::publish(&e);
    Ok(Json(langserver::doc(&e)))
}

#[derive(Deserialize)]
pub struct ProbeBody {
    /// an existing server: probe it with its stored address and key
    #[serde(default)]
    server: Option<String>,
    #[serde(default)]
    preset: Option<String>,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    harness: Option<String>,
    #[serde(default)]
    base_path: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

impl std::fmt::Debug for ProbeBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProbeBody")
            .field("server", &self.server)
            .field("preset", &self.preset)
            .field("address", &self.address)
            .field("harness", &self.harness)
            .field("base_path", &self.base_path)
            .field("key", &self.key.as_ref().map(|_| "*****"))
            .finish()
    }
}

#[derive(Deserialize)]
pub struct VariantBody {
    /// a stored server: its address and key
    #[serde(default)]
    server: Option<String>,
    /// or the server the add form describes
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    key: Option<String>,
    model: String,
}

impl std::fmt::Debug for VariantBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VariantBody")
            .field("server", &self.server)
            .field("address", &self.address)
            .field("key", &self.key.as_ref().map(|_| "*****"))
            .field("model", &self.model)
            .finish()
    }
}

/// `POST /api/langservers/ollama-variant`: the "Create a 64K version of this
/// model" button. Adds `<model>-64k` to the user's Ollama (same weights, its
/// own 64K window; only on that click), then lists the server's models again.
#[logged]
pub async fn ollama_variant(State(e): State<Arc<Engine>>, Json(b): Json<VariantBody>) -> ApiResult<Json<Value>> {
    let (address, key) = match b.server.as_deref() {
        Some(id) => {
            let Some(s) = langserver::server(&e, id) else { return Err(ApiError::not_found(format!("no language server {id}"))) };
            if s["preset"].as_str() != Some("ollama") {
                return Err(ApiError::bad_request("only an Ollama server makes model versions"));
            }
            (s["address"].as_str().unwrap_or("").to_string(), langserver::key(&e, id).await)
        }
        None => (b.address.clone().unwrap_or_default(), b.key.clone()),
    };
    let name = langserver::create_ollama_variant(&address, key.as_deref(), &b.model, langserver::VARIANT_CONTEXT).await?;
    let probe = langserver::probe("ollama", &address, key.as_deref(), "claude-code", None).await;
    Ok(Json(serde_json::json!({ "created": name, "context": langserver::VARIANT_CONTEXT, "probe": probe })))
}

/// `POST /api/langservers/probe`: ask a server (a stored one, or the one the
/// add form describes) what it is and which models it offers. Loads no model.
#[logged]
pub async fn probe(State(e): State<Arc<Engine>>, Json(b): Json<ProbeBody>) -> ApiResult<Json<Value>> {
    if let Some(id) = b.server.as_deref() {
        let Some(s) = langserver::server(&e, id) else { return Err(ApiError::not_found(format!("no language server {id}"))) };
        let key = langserver::key(&e, id).await;
        let v = langserver::probe(
            s["preset"].as_str().unwrap_or("custom"),
            s["address"].as_str().unwrap_or(""),
            key.as_deref(),
            s["harness"].as_str().unwrap_or("claude-code"),
            s["base_path"].as_str(),
        )
        .await;
        return Ok(Json(v));
    }
    let v = langserver::probe(
        b.preset.as_deref().unwrap_or("custom"),
        b.address.as_deref().unwrap_or(""),
        b.key.as_deref(),
        b.harness.as_deref().unwrap_or("claude-code"),
        b.base_path.as_deref(),
    )
    .await;
    Ok(Json(v))
}
