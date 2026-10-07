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
    /// the row points at the provider's own sign-in (decided at load)
    pub ambient: bool,
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
    /// Google model groups have independent quota. Unknown/default marks remain conservative.
    pub fn limited_for(&self, tier: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        if self.provider != crate::providers::catalog::GOOGLE {
            return self.limited(now);
        }
        let pool = format!("agy:{}", crate::providers::catalog::antigravity_pool(tier));
        self.marks.iter().filter(|(k, _)| !k.starts_with("agy:") || **k == pool)
            .map(|(_, (u, _))| *u).filter(|u| *u > now).max()
    }
    #[nolog]
    pub fn is_apikey(&self) -> bool {
        self.kind == "apikey"
    }
    /// A legacy org key (origin_org) is visible, bindable and spendable only
    /// inside its origin org (3.x registry.list_accounts / validate_binding,
    /// user ruling: legacy org keys keep their org restriction). `None` is the
    /// user's own app surface, which sees every row.
    #[nolog]
    pub fn available_to(&self, org_slug: Option<&str>) -> bool {
        match (self.origin_org.as_deref().filter(|o| !o.is_empty()), org_slug) {
            (None, _) | (_, None) => true,
            (Some(origin), Some(org)) => origin == org,
        }
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
    pub fn continue_candidates(&self, tier: &str, current: Option<&str>, org_slug: &str) -> Vec<String> {
        let provider = crate::providers::catalog::provider_of(tier);
        let now = Utc::now();
        self.all()
            .into_iter()
            .filter(|a| {
                a.provider == provider
                    && a.available_to(Some(org_slug))
                    && Some(a.id.as_str()) != current
                    && a.enabled
                    && a.auth != "unauthenticated"
                    && a.limited_for(tier, now).is_none()
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
                    ambient: ambient_dir(&r.get::<_, String>(1), r.get::<_, Option<String>>(7).as_deref()),
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
        let next=Arc::new(Inner { by_id });
        let old=self.snap.swap(next.clone());
        crate::runtime::watchdogs::events::accounts(engine,&old,&next);
        Ok(())
    }
}

#[logged]
pub async fn start(engine: &Arc<Engine>) {
    if let Err(e) = engine.accounts.reload(engine).await {
        tracing::warn!(error = %e, "could not load accounts");
    }
    publish(engine);
    tokio::spawn(fill_missing_emails(engine.clone()));
}

/// An account imported from 3.x may carry no email (3.x kept it elsewhere):
/// read it from the account's own sign-in folder, as the refresh button
/// does, so the surfaces can say who it is. A scratch copy (safe start) never
/// reads a sign-in folder outside its own data folder.
#[logged]
pub async fn fill_missing_emails(engine: Arc<Engine>) {
    let canon = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let root = canon(&engine.cfg.data_root);
    let todo: Vec<(String, String, String)> = engine
        .accounts
        .view()
        .all()
        .into_iter()
        .filter(|a| !a.is_apikey() && a.email.as_deref().map(str::is_empty).unwrap_or(true))
        .filter(|a| a.provider == "claude" || a.provider == "openai")
        .filter_map(|a| a.config_dir.clone().map(|d| (a.id.clone(), a.provider.clone(), d)))
        .filter(|(_, _, d)| !crate::mailhub::safe_start() || canon(std::path::Path::new(d)).starts_with(&root))
        .collect();
    if todo.is_empty() {
        return;
    }
    let mut found = 0;
    for (id, provider, dir) in todo {
        let email = tokio::task::spawn_blocking(move || {
            let dir = std::path::PathBuf::from(dir);
            match provider.as_str() {
                "claude" => crate::providers::claude_identity(Some(&dir)).1,
                _ => crate::providers::codex_identity(Some(&dir)).1,
            }
        })
        .await
        .ok()
        .flatten();
        let Some(email) = email else { continue };
        let Ok(client) = engine.db.get().await else { return };
        if client
            .execute(
                "UPDATE ot.accounts SET identity = coalesce(identity, '{}'::jsonb) || jsonb_build_object('email', $2::text) WHERE id = $1",
                &[&id, &email],
            )
            .await
            .is_ok()
        {
            found += 1;
        }
    }
    if found > 0 {
        let _ = engine.accounts.reload(&engine).await;
        publish(&engine);
        tracing::info!(accounts = found, "account emails read from their sign-in folders");
    }
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

/// Whether a config folder is the provider's own home (the host sign-in).
#[logged]
pub fn ambient_dir(provider: &str, config_dir: Option<&str>) -> bool {
    let (Some(dir), Some(home)) = (config_dir, default_home(provider)) else { return false };
    let canon = |p: &std::path::Path| std::fs::canonicalize(p).ok();
    match (canon(std::path::Path::new(dir)), canon(&home)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

#[logged]
pub fn is_ambient(a: &AccountInfo) -> bool {
    a.ambient
}

/// The account card an agent on a secondary account wears on its card and
/// desk header (user ruling 2026-10-02: "an account card only shows up when
/// an agent is on a secondary account"); None on the provider's own sign-in.
/// Registry metadata only, never a credential.
#[nolog]
pub fn serving_card(view: &AccountsView, account: Option<&str>, now: DateTime<Utc>) -> Option<Value> {
    let a = view.get(account?)?;
    if a.ambient {
        return None;
    }
    Some(json!({
        "id": a.id, "display": a.id, "provider": a.provider,
        "label": if a.label.is_empty() { Value::Null } else { json!(a.label) },
        "email": a.email, "auth": a.auth,
        "state": if a.limited(now).is_some() { "limited" } else { "ready" },
    }))
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
