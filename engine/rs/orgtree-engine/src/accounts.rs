//! Machine-wide provider accounts: the registry, each account's sign-in
//! state, limit marks and tint. Readers get a lock-free snapshot.

use std::collections::HashMap;
use std::sync::Arc;

use arc_swap::ArcSwap;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::engine::Engine;

#[derive(Clone, Debug)]
pub struct AccountInfo {
    pub id: String,
    pub provider: String,
    pub kind: String,
    pub label: String,
    pub email: Option<String>,
    pub tint_ordinal: i64,
    pub auth: String,
    pub config_dir: Option<String>,
    pub enabled: bool,
    pub origin_org: Option<String>,
    /// pool → limited until
    pub marks: HashMap<String, (DateTime<Utc>, String)>,
    pub ord: i64,
}

#[logged]
impl AccountInfo {
    #[nolog]
    pub fn display(&self) -> String {
        match &self.email {
            Some(e) if !e.is_empty() => e.clone(),
            _ => {
                if self.label.is_empty() {
                    self.id.clone()
                } else {
                    self.label.clone()
                }
            }
        }
    }
    #[nolog]
    pub fn limited(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.marks.values().map(|(u, _)| *u).filter(|u| *u > now).max()
    }
    #[nolog]
    pub fn is_apikey(&self) -> bool {
        self.kind == "apikey"
    }
}

#[derive(Default)]
pub struct Inner {
    pub by_id: HashMap<String, AccountInfo>,
}

#[derive(Clone)]
pub struct AccountsView(pub Arc<Inner>);

#[logged]
impl AccountsView {
    #[nolog]
    pub fn get(&self, id: &str) -> Option<&AccountInfo> {
        self.0.by_id.get(id)
    }
    #[nolog]
    pub fn all(&self) -> Vec<&AccountInfo> {
        let mut v: Vec<&AccountInfo> = self.0.by_id.values().collect();
        v.sort_by_key(|a| (a.provider.clone(), a.ord, a.id.clone()));
        v
    }
    /// Other usable accounts of `provider` a frozen agent could continue on.
    pub fn continue_candidates(&self, provider: &str, current: Option<&str>) -> Vec<String> {
        let now = Utc::now();
        self.all()
            .into_iter()
            .filter(|a| {
                a.provider == provider
                    && Some(a.id.as_str()) != current
                    && a.enabled
                    && a.auth != "unauthenticated"
                    && a.limited(now).is_none()
            })
            .map(|a| a.id.clone())
            .collect()
    }
}

#[derive(Default)]
pub struct Accounts {
    snap: ArcSwap<Inner>,
}

#[logged]
impl Accounts {
    #[nolog]
    pub fn view(&self) -> AccountsView {
        AccountsView(self.snap.load_full())
    }

    pub async fn reload(&self, engine: &Engine) -> anyhow::Result<()> {
        let client = engine.db.get().await?;
        let rows = client
            .query(
                "SELECT id, provider, kind, label, identity, tint_ordinal, auth, config_dir, enabled, origin_org, ord
                   FROM ot.accounts ORDER BY provider, ord, id",
                &[],
            )
            .await?;
        let marks = client.query("SELECT account, pool, until, provenance FROM ot.account_marks", &[]).await?;
        let mut by_id = HashMap::new();
        for r in rows {
            let identity: Value = r.get(4);
            let id: String = r.get(0);
            by_id.insert(
                id.clone(),
                AccountInfo {
                    id,
                    provider: r.get(1),
                    kind: r.get(2),
                    label: r.get(3),
                    email: identity.get("email").and_then(Value::as_str).map(str::to_string),
                    tint_ordinal: r.get::<_, i32>(5) as i64,
                    auth: r.get(6),
                    config_dir: r.get(7),
                    enabled: r.get(8),
                    origin_org: r.get(9),
                    marks: HashMap::new(),
                    ord: r.get::<_, i32>(10) as i64,
                },
            );
        }
        for m in marks {
            let acc: String = m.get(0);
            if let Some(a) = by_id.get_mut(&acc) {
                a.marks.insert(m.get(1), (m.get(2), m.get(3)));
            }
        }
        self.snap.store(Arc::new(Inner { by_id }));
        Ok(())
    }
}

#[logged]
pub async fn start(engine: &Arc<Engine>) {
    if let Err(e) = engine.accounts.reload(engine).await {
        tracing::warn!(error = %e, "could not load accounts");
    }
    publish(engine);
}

/// An account picked on a surface: left out, the provider's own login
/// (`provider/primary`, shown as `default`), or a registry row.
#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    Unset,
    Primary,
    Account(String),
}

#[logged]
pub fn choice(raw: Option<&str>) -> Choice {
    match raw.map(str::trim) {
        None | Some("") => Choice::Unset,
        Some("primary") | Some("default") => Choice::Primary,
        Some(v) if v.ends_with("/primary") => Choice::Primary,
        Some(v) => Choice::Account(v.to_string()),
    }
}

/// The provider's own home (`~/.claude`, `~/.codex`): a row pointing there
/// is the host login itself.
#[logged]
pub fn default_home(provider: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    match provider {
        "claude" => Some(home.join(".claude")),
        "openai" => Some(home.join(".codex")),
        _ => None,
    }
}

#[logged]
pub fn is_ambient(a: &AccountInfo) -> bool {
    let (Some(dir), Some(home)) = (a.config_dir.as_deref(), default_home(&a.provider)) else { return false };
    let canon = |p: &std::path::Path| std::fs::canonicalize(p).ok();
    match (canon(std::path::Path::new(dir)), canon(&home)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// Whether an account may serve turns (App settings › Providers): the
/// provider's own sign-in (`None`, or a row pointing at it) follows that
/// provider's native-subscription checkbox; every other account its own.
#[logged]
pub fn active(engine: &Engine, provider: &str, account: Option<&AccountInfo>) -> bool {
    match account {
        Some(a) if !is_ambient(a) => a.enabled,
        _ => engine.settings.subscription_inference(provider),
    }
}

/// Which agents an activation may unblock.
#[derive(Debug, Clone)]
pub enum Waiting {
    /// every agent of the provider (the provider was turned on)
    Provider(String),
    /// agents on the provider's own sign-in
    Native(String),
    /// agents on one registry account
    Account(String),
}

/// After an account (or provider) becomes active: wake the live agents on it
/// that have mail waiting, so held work starts without another message.
#[logged]
pub async fn wake_waiting(engine: &Arc<Engine>, which: Waiting) {
    let Ok(client) = engine.db.get().await else { return };
    let pending = "EXISTS (SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = a.id AND m.state = 'pending')";
    let rows = match &which {
        Waiting::Provider(p) => {
            client
                .query(&format!("SELECT a.org_id, a.id FROM ot.agents a WHERE a.state = 'live' AND a.provider = $1 AND {pending}"), &[p])
                .await
        }
        Waiting::Native(p) => {
            // its own sign-in: no account, or one that is not a separate login
            let others: Vec<String> = engine
                .accounts
                .view()
                .all()
                .into_iter()
                .filter(|a| a.provider == *p && !is_ambient(a))
                .map(|a| a.id.clone())
                .collect();
            client
                .query(
                    &format!(
                        "SELECT a.org_id, a.id FROM ot.agents a WHERE a.state = 'live' AND a.provider = $1
                            AND (a.account IS NULL OR NOT (a.account = ANY($2))) AND {pending}"
                    ),
                    &[p, &others],
                )
                .await
        }
        Waiting::Account(id) => {
            client
                .query(&format!("SELECT a.org_id, a.id FROM ot.agents a WHERE a.state = 'live' AND a.account = $1 AND {pending}"), &[id])
                .await
        }
    };
    drop(client);
    match rows {
        Ok(rows) => {
            for r in rows {
                crate::runtime::wake(engine, r.get(0), r.get(1));
            }
        }
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "could not wake the agents waiting on an account"),
    }
}

/// One registry row as the account surfaces read it.
#[logged]
pub fn row(a: &AccountInfo, bound: Vec<Value>, now: DateTime<Utc>) -> Value {
    let marks: serde_json::Map<String, Value> = a
        .marks
        .iter()
        .map(|(pool, (until, prov))| (pool.clone(), json!({ "until": until.timestamp(), "provenance": prov })))
        .collect();
    let harness = match a.provider.as_str() {
        "openai" => "codex-cli",
        "google" => "antigravity",
        _ => "claude-code",
    };
    json!({
        "id": a.id, "name": a.id, "provider": a.provider, "harness": harness, "label": a.label,
        "credential": if a.is_apikey() { json!({ "kind": "apikey", "token_ref": a.id }) } else { json!({ "kind": a.kind, "path": a.config_dir }) },
        "identity": a.email.as_ref().map(|e| json!({ "email": e })).unwrap_or(json!({})),
        "auth": a.auth, "tint_ordinal": a.tint_ordinal,
        "origin_org": a.origin_org, "ambient": is_ambient(a),
        "mode": if a.is_apikey() { json!("apikey") } else { Value::Null },
        "enabled": a.enabled,
        "standing": { "auth": a.auth, "state": if a.limited(now).is_some() { "limited" } else { "ready" }, "marks": marks },
        "bound": bound,
    })
}

/// Push the registry list to every window (`accounts` app value).
#[logged]
pub fn publish(engine: &Engine) {
    let view = engine.accounts.view();
    let now = Utc::now();
    let rows: Vec<Value> = view.all().into_iter().filter(|a| a.provider != "openrouter").map(|a| row(a, Vec::new(), now)).collect();
    engine.app.set_value("accounts", json!({ "accounts": rows }));
}
