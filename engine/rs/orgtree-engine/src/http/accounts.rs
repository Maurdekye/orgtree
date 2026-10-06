//! Accounts, usage and the OpenRouter lane: the registry (add, remove,
//! identity, marks), the legacy key readout, every usage readout and its
//! cache-only peek, and OpenRouter's key, catalog, favorites and harness.
//! No response ever carries a secret: a key crosses the wire once, inward.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::accounts::AccountInfo;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::usage;

#[derive(Deserialize, Debug, Default)]
pub struct Force {
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize, Debug, Default)]
pub struct OrgQuery {
    org: Option<String>,
}

/// Which agents run on each account: account → [{org, node, state}].
#[logged]
async fn bindings(e: &Engine) -> ApiResult<std::collections::HashMap<String, Vec<Value>>> {
    let client = e.db.get().await?;
    let rows = client
        .query(
            "SELECT a.account, o.slug, a.name, a.state FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
              WHERE a.account IS NOT NULL AND a.state <> 'deleted' AND o.state <> 'trashed'",
            &[],
        )
        .await?;
    let mut out: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    for r in rows {
        out.entry(r.get(0)).or_default().push(json!({ "org": r.get::<_, String>(1), "node": r.get::<_, String>(2), "state": r.get::<_, String>(3) }));
    }
    Ok(out)
}

fn host_identity() -> Value {
    let (_, claude) = crate::providers::claude_identity(None);
    let (_, codex, _) = crate::providers::codex_identity(None);
    json!({ "claude": { "email": claude }, "openai": { "email": codex }, "google": { "email": null } })
}

/// `GET /api/accounts`: the registry rows, with what runs on each.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>, Query(_q): Query<OrgQuery>) -> ApiResult<Json<Value>> {
    let bound = bindings(&e).await?;
    let view = e.accounts.view();
    let now = chrono::Utc::now();
    let rows: Vec<Value> = view
        .all()
        .into_iter()
        .filter(|a| a.provider != "openrouter")
        .map(|a| crate::accounts::row(a, bound.get(&a.id).cloned().unwrap_or_default(), now))
        .collect();
    Ok(Json(json!({ "accounts": rows, "primary": "claude/primary", "host_identity": host_identity() })))
}

#[derive(Deserialize)]
pub struct AddAccount {
    provider: String,
    kind: String,
    path: Option<String>,
    key: Option<String>,
}

impl std::fmt::Debug for AddAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AddAccount {{ provider: {:?}, kind: {:?}, path: {:?}, key: *****? }}", self.provider, self.kind, self.path)
    }
}

/// The next free `<provider>-<n>` id.
#[logged]
async fn next_id(e: &Engine, provider: &str) -> ApiResult<String> {
    let client = e.db.get().await?;
    let n: i64 = client
        .query_one(
            "SELECT coalesce(max(substring(id FROM '-([0-9]+)$')::bigint), 0) + 1 FROM ot.accounts WHERE provider = $1",
            &[&provider],
        )
        .await?
        .get(0);
    Ok(format!("{provider}-{n}"))
}

/// `POST /api/accounts`: a new managed profile, an imported config folder,
/// or an API key (stored first; only its row id comes back).
pub async fn add(State(e): State<Arc<Engine>>, Json(b): Json<AddAccount>) -> ApiResult<Json<Value>> {
    tracing::info!(request = ?b, "add account");
    if !["claude", "openai", "google"].contains(&b.provider.as_str()) {
        return Err(ApiError::bad_request("the provider is claude, openai or google"));
    }
    let id = next_id(&e, &b.provider).await?;
    let mut client = e.db.get().await?;
    match b.kind.as_str() {
        "apikey" => {
            let key = b.key.as_deref().map(str::trim).filter(|k| !k.is_empty()).ok_or_else(|| ApiError::bad_request("paste the API key"))?;
            let tx = client.transaction().await?;
            tx.execute(
                "INSERT INTO ot.accounts (id, provider, kind, label, auth, enabled, ord)
                 VALUES ($1, $2, 'apikey', 'API key', 'unobserved', true, (SELECT coalesce(max(ord), 0) + 1 FROM ot.accounts WHERE provider = $2))",
                &[&id, &b.provider],
            )
            .await?;
            tx.execute("INSERT INTO ot.account_secrets (account_id, secret) VALUES ($1, $2)", &[&id, &key]).await?;
            tx.commit().await?;
        }
        "imported" => {
            let path = b.path.as_deref().map(str::trim).filter(|p| !p.is_empty()).ok_or_else(|| ApiError::bad_request("choose the folder to import"))?;
            if !std::path::Path::new(path).is_dir() {
                return Err(ApiError::bad_request(format!("{path} is not a folder")));
            }
            let (signed_in, email) = identity_of(&b.provider, Some(path));
            client
                .execute(
                    "INSERT INTO ot.accounts (id, provider, kind, label, config_dir, identity, auth, enabled, ord)
                     VALUES ($1, $2, 'imported', $1, $3, $4, $5, true, (SELECT coalesce(max(ord), 0) + 1 FROM ot.accounts WHERE provider = $2))",
                    &[&id, &b.provider, &path, &json!({ "email": email }), &(if signed_in { "authenticated" } else { "unauthenticated" })],
                )
                .await?;
        }
        "managed" => {
            let dir = e.cfg.path("profiles").join(format!("{}-{}", b.provider, crate::util::random_hex(16)));
            std::fs::create_dir_all(&dir).map_err(|err| ApiError::internal(err.to_string()))?;
            let path = dir.to_string_lossy().to_string();
            client
                .execute(
                    "INSERT INTO ot.accounts (id, provider, kind, label, config_dir, auth, enabled, ord)
                     VALUES ($1, $2, 'managed', $1, $3, 'unobserved', true, (SELECT coalesce(max(ord), 0) + 1 FROM ot.accounts WHERE provider = $2))",
                    &[&id, &b.provider, &path],
                )
                .await?;
        }
        other => return Err(ApiError::bad_request(format!("unknown account kind {other}"))),
    }
    drop(client);
    refreshed(&e).await;
    let view = e.accounts.view();
    let row = view.get(&id).map(|a| crate::accounts::row(a, Vec::new(), chrono::Utc::now())).unwrap_or(Value::Null);
    Ok(Json(json!({ "account": row, "id": id })))
}

#[logged]
async fn refreshed(e: &Engine) {
    let _ = e.accounts.reload(e).await;
    crate::accounts::publish(e);
}

fn identity_of(provider: &str, dir: Option<&str>) -> (bool, Option<String>) {
    match provider {
        "claude" => crate::providers::claude_identity(dir.map(PathBuf::from).as_ref()),
        "openai" => {
            let (s, email, _) = crate::providers::codex_identity(dir.map(PathBuf::from).as_ref());
            (s, email)
        }
        _ => (false, None),
    }
}

/// `DELETE /api/accounts/{id}`: refused while a live agent runs on it.
#[logged]
pub async fn remove(State(e): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let client = e.db.get().await?;
    let users: Vec<String> = client
        .query("SELECT name FROM ot.agents WHERE account = $1 AND state = 'live' LIMIT 5", &[&id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    if !users.is_empty() {
        return Err(ApiError::conflict(format!("{} still run on {id}; move them to another account first", users.join(", "))));
    }
    let n = client.execute("DELETE FROM ot.accounts WHERE id = $1 AND id <> $2", &[&id, &crate::openrouter::ACCOUNT_ID]).await?;
    client.execute("DELETE FROM ot.account_marks WHERE account = $1", &[&id]).await?;
    drop(client);
    if n == 0 {
        return Err(ApiError::not_found(format!("no account {id}")));
    }
    refreshed(&e).await;
    Ok(Json(json!({ "removed": id })))
}

/// `GET /api/accounts/{id}/identity`: look again at who the account is signed in as.
#[logged]
pub async fn identity(State(e): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let view = e.accounts.view();
    let a = view.get(&id).cloned().ok_or_else(|| ApiError::not_found(format!("no account {id}")))?;
    if a.is_apikey() {
        return Ok(Json(json!({ "auth": a.auth })));
    }
    let (signed_in, email) = identity_of(&a.provider, a.config_dir.as_deref());
    let auth = if signed_in { "authenticated" } else { "unauthenticated" };
    let client = e.db.get().await?;
    client
        .execute(
            "UPDATE ot.accounts SET auth = $2, identity = identity || $3 WHERE id = $1",
            &[&id, &auth, &json!({ "email": email })],
        )
        .await?;
    drop(client);
    refreshed(&e).await;
    Ok(Json(json!({ "auth": auth, "email": email })))
}

/// `GET /api/accounts/{id}/marks`: its "limited until" marks.
#[logged]
pub async fn marks(State(e): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let client = e.db.get().await?;
    let rows = client
        .query("SELECT pool, until, provenance, win, at FROM ot.account_marks WHERE account = $1 ORDER BY until DESC", &[&id])
        .await?;
    let marks: Vec<Value> = rows
        .iter()
        .map(|r| {
            let until: chrono::DateTime<chrono::Utc> = r.get(1);
            json!({ "pool": r.get::<_, String>(0), "until": until.timestamp(), "until_iso": crate::util::iso(until),
                    "provenance": r.get::<_, String>(2), "window": r.get::<_, Option<String>>(3),
                    "at": crate::util::iso(r.get(4)) })
        })
        .collect();
    Ok(Json(json!({ "account": id, "marks": marks })))
}

#[derive(Deserialize, Debug, Default)]
pub struct ClearMarks {
    pool: Option<String>,
}

/// `POST /api/accounts/{id}/marks/clear`: the user says the account works again.
#[logged]
pub async fn clear_marks(State(e): State<Arc<Engine>>, Path(id): Path<String>, body: Option<Json<ClearMarks>>) -> ApiResult<Json<Value>> {
    let pool = body.and_then(|b| b.0.pool);
    let client = e.db.get().await?;
    let n = client
        .execute("DELETE FROM ot.account_marks WHERE account = $1 AND ($2::text IS NULL OR pool = $2)", &[&id, &pool])
        .await?;
    drop(client);
    refreshed(&e).await;
    Ok(Json(json!({ "cleared": n })))
}

// ------------------------------------------------------------ the legacy Claude key readout

#[logged]
fn claude_keys(e: &Engine) -> Vec<AccountInfo> {
    let view = e.accounts.view();
    let mut keys: Vec<AccountInfo> = view.all().into_iter().filter(|a| a.provider == "claude" && a.is_apikey()).cloned().collect();
    keys.sort_by_key(|a| (a.ord, a.id.clone()));
    keys
}

/// `GET /api/accounts/readout`: the machine's login, its key rows in order,
/// and where each Claude tier's prompts go.
#[logged]
pub async fn readout(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(readout_doc(&e)))
}

fn readout_doc(e: &Engine) -> Value {
    let (signed_in, email) = crate::providers::claude_identity(None);
    let now = chrono::Utc::now();
    let keys: Vec<Value> = claude_keys(e)
        .iter()
        .enumerate()
        .map(|(i, a)| {
            json!({ "id": a.id, "ordinal": i + 1, "account_uuid": null, "registered_at": null, "mint_config_dir": null,
                    "registered_from_config_dir": null,
                    "liveness": if a.limited(now).is_some() { json!("limited") } else { Value::Null },
                    "liveness_checked_at": null })
        })
        .collect();
    let mut assignments = serde_json::Map::new();
    for t in crate::providers::catalog::TIERS.iter().filter(|t| t.provider == "claude" && !t.legacy) {
        assignments.insert(t.tier.to_string(), json!({ "account": "primary", "available": true, "refresh_at": null }));
    }
    json!({ "version": 2, "primary": { "signed_in": signed_in, "email": email }, "keys": keys, "assignments": assignments })
}

#[derive(Deserialize)]
pub struct AddKey {
    token: String,
    mint_config_dir: Option<String>,
}

impl std::fmt::Debug for AddKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AddKey {{ token: *****, mint_config_dir: {:?} }}", self.mint_config_dir)
    }
}

/// `POST /api/accounts/keys`: a pasted `claude setup-token` (stored first).
pub async fn add_key(State(e): State<Arc<Engine>>, Json(b): Json<AddKey>) -> ApiResult<Json<Value>> {
    tracing::info!(mint_config_dir = ?b.mint_config_dir, "add Claude key");
    let token = b.token.trim();
    if token.is_empty() {
        return Err(ApiError::bad_request("paste the token `claude setup-token` printed"));
    }
    let client = e.db.get().await?;
    if let Some(r) = client
        .query_opt("SELECT s.account_id FROM ot.account_secrets s JOIN ot.accounts a ON a.id = s.account_id WHERE a.provider = 'claude' AND s.secret = $1", &[&token])
        .await?
    {
        let mut doc = readout_doc(&e);
        doc["registered"] = json!(r.get::<_, String>(0));
        return Ok(Json(doc));
    }
    drop(client);
    let id = next_id(&e, "claude").await?;
    let mut client = e.db.get().await?;
    let tx = client.transaction().await?;
    tx.execute(
        "INSERT INTO ot.accounts (id, provider, kind, label, auth, enabled, ord)
         VALUES ($1, 'claude', 'apikey', 'Claude key', 'unobserved', true, (SELECT coalesce(max(ord), 0) + 1 FROM ot.accounts WHERE provider = 'claude'))",
        &[&id],
    )
    .await?;
    tx.execute("INSERT INTO ot.account_secrets (account_id, secret) VALUES ($1, $2)", &[&id, &token]).await?;
    tx.commit().await?;
    drop(client);
    refreshed(&e).await;
    let mut doc = readout_doc(&e);
    doc["registered"] = json!(id);
    Ok(Json(doc))
}

/// `DELETE /api/accounts/keys/{id}`.
#[logged]
pub async fn remove_key(State(e): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let _ = remove(State(e.clone()), Path(id)).await?;
    let mut doc = readout_doc(&e);
    doc["removed"] = json!(true);
    Ok(Json(doc))
}

#[derive(Deserialize, Debug)]
pub struct KeyOrder {
    keys: Vec<String>,
}

/// `PUT /api/accounts/order`: the key rows' fallback order.
#[logged]
pub async fn order(State(e): State<Arc<Engine>>, Json(b): Json<KeyOrder>) -> ApiResult<Json<Value>> {
    let client = e.db.get().await?;
    for (i, id) in b.keys.iter().enumerate() {
        client.execute("UPDATE ot.accounts SET ord = $2 WHERE id = $1", &[id, &((i + 1) as i32)]).await?;
    }
    drop(client);
    refreshed(&e).await;
    Ok(Json(readout_doc(&e)))
}

// ------------------------------------------------------------ usage

#[logged]
pub async fn usage_claude(State(e): State<Arc<Engine>>, Query(q): Query<Force>) -> Json<Value> {
    Json(usage::claude(&e, None, q.force).await)
}

#[logged]
pub async fn peek_claude(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(e.usage.peek(&usage::claude_key(None), "claude"))
}

#[logged]
pub async fn usage_codex(State(e): State<Arc<Engine>>, Query(q): Query<Force>) -> Json<Value> {
    Json(usage::codex(&e, "openai/primary", None, q.force).await)
}

#[logged]
pub async fn peek_codex(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(e.usage.peek(&usage::codex_key(None), "openai"))
}

#[logged]
pub async fn usage_agy(State(e): State<Arc<Engine>>, Query(q): Query<Force>) -> Json<Value> {
    Json(usage::antigravity(&e, q.force).await)
}

#[logged]
pub async fn peek_agy(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(e.usage.peek("agy", "google"))
}

#[logged]
pub async fn usage_openrouter(State(e): State<Arc<Engine>>, Query(q): Query<Force>) -> Json<Value> {
    Json(usage::openrouter(&e, q.force).await)
}

#[logged]
pub async fn peek_openrouter(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(e.usage.peek("openrouter", "openrouter"))
}

/// The primary Claude login as an `AccountUsage` row.
#[logged]
async fn primary_row(e: &Engine) -> Value {
    let mut u = usage::claude(e, None, false).await;
    u["account"] = json!("primary");
    u["label"] = u["email"].clone();
    u
}

/// One key row's answer: a key can never report subscription bars.
#[logged]
async fn key_row(e: &Engine, a: &AccountInfo) -> Value {
    let now = chrono::Utc::now();
    let tiers: Vec<Value> = crate::providers::catalog::TIERS
        .iter()
        .filter(|t| t.provider == "claude" && !t.legacy)
        .map(|t| json!({ "tier": t.tier, "available": a.limited(now).is_none(),
                         "refresh_at": a.limited(now).map(crate::util::iso), "pool": null }))
        .collect();
    let mut row = usage::apikey_spend(e, &a.id).await;
    row["account"] = json!(a.id);
    row["label"] = json!(a.display());
    row["unsupported"] = json!(true);
    row["tiers"] = json!(tiers);
    row["enabled"] = json!(a.enabled);
    row
}

/// `GET /api/accounts/usage`: the primary, then the key rows in order.
#[logged]
pub async fn usage_all(State(e): State<Arc<Engine>>) -> Json<Value> {
    let mut rows = vec![primary_row(&e).await];
    for a in claude_keys(&e) {
        rows.push(key_row(&e, &a).await);
    }
    Json(json!({ "accounts": rows }))
}

/// `GET /api/accounts/usage/{account}`: "primary" or a key row.
#[logged]
pub async fn usage_one(State(e): State<Arc<Engine>>, Path(account): Path<String>) -> ApiResult<Json<Value>> {
    if account == "primary" || account.ends_with("/primary") {
        return Ok(Json(primary_row(&e).await));
    }
    let view = e.accounts.view();
    let a = view.get(&account).cloned().ok_or_else(|| ApiError::not_found(format!("no account {account}")))?;
    Ok(Json(key_row(&e, &a).await))
}

/// `GET /api/accounts/{id}/usage`: a registry account's own readout and standing.
#[logged]
pub async fn usage_registered(State(e): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let view = e.accounts.view();
    let a = view.get(&id).cloned().ok_or_else(|| ApiError::not_found(format!("no account {id}")))?;
    let mut u = if a.is_apikey() {
        usage::apikey_spend(&e, &a.id).await
    } else {
        match a.provider.as_str() {
            "claude" => usage::claude(&e, a.config_dir.as_deref(), false).await,
            "openai" => usage::codex(&e, &a.id, a.config_dir.as_deref(), false).await,
            "google" => usage::antigravity(&e, false).await,
            _ => json!({ "available": false }),
        }
    };
    let now = chrono::Utc::now();
    let row = crate::accounts::row(&a, Vec::new(), now);
    u["account"] = json!(a.id);
    u["label"] = json!(a.display());
    u["provider"] = json!(a.provider);
    u["standing"] = row["standing"].clone();
    u["enabled"] = json!(a.enabled);
    Ok(Json(u))
}

// ------------------------------------------------------------ OpenRouter

#[logged]
pub async fn openrouter_doc(State(e): State<Arc<Engine>>, Query(q): Query<Force>) -> Json<Value> {
    Json(crate::openrouter::doc(&e, q.force).await)
}

#[derive(Deserialize)]
pub struct KeyBody {
    key: String,
}

impl std::fmt::Debug for KeyBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyBody { key: ***** }")
    }
}

/// `PUT /api/openrouter/key` (the body is a secret: not logged).
pub async fn openrouter_key(State(e): State<Arc<Engine>>, Json(b): Json<KeyBody>) -> ApiResult<Json<Value>> {
    crate::openrouter::set_key(&e, &b.key).await?;
    crate::providers::publish(&e);
    Ok(Json(crate::openrouter::doc(&e, true).await))
}

#[logged]
pub async fn openrouter_key_clear(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    crate::openrouter::clear_key(&e).await?;
    crate::providers::publish(&e);
    Ok(Json(crate::openrouter::doc(&e, false).await))
}

#[derive(Deserialize, Debug)]
pub struct HarnessBody {
    harness: String,
}

#[logged]
pub async fn openrouter_harness(State(e): State<Arc<Engine>>, Json(b): Json<HarnessBody>) -> ApiResult<Json<Value>> {
    crate::openrouter::set_harness(&e, &b.harness).await?;
    Ok(Json(crate::openrouter::doc(&e, false).await))
}

#[derive(Deserialize, Debug, Default)]
pub struct ModelsQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: usize,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    order: String,
    #[serde(default)]
    group_by_vendor: bool,
}

#[logged]
pub async fn openrouter_models(State(e): State<Arc<Engine>>, Query(q): Query<ModelsQuery>) -> ApiResult<Json<Value>> {
    let limit = if q.limit == 0 { 8 } else { q.limit };
    Ok(Json(crate::openrouter::search(&e, &q.q, q.offset, limit, &q.sort, &q.order, q.group_by_vendor).await?))
}

#[derive(Deserialize, Debug)]
pub struct FavoriteBody {
    id: String,
    selected: bool,
}

#[logged]
pub async fn openrouter_favorite(State(e): State<Arc<Engine>>, Json(b): Json<FavoriteBody>) -> ApiResult<Json<Value>> {
    crate::openrouter::set_favorite(&e, &b.id, b.selected).await?;
    crate::providers::refresh_openrouter(&e);
    crate::providers::publish(&e);
    for o in e.orgs.all() {
        crate::changes::notify(&e, &o, vec![crate::changes::Change::Tiers]);
    }
    Ok(Json(crate::openrouter::doc(&e, false).await))
}
