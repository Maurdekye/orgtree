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

/// Push the registry list to every window (`accounts` app value).
#[logged]
pub fn publish(engine: &Engine) {
    let view = engine.accounts.view();
    let now = Utc::now();
    let rows: Vec<Value> = view
        .all()
        .into_iter()
        .map(|a| {
            let marks: serde_json::Map<String, Value> = a
                .marks
                .iter()
                .map(|(pool, (until, prov))| (pool.clone(), json!({ "until": until.timestamp(), "provenance": prov })))
                .collect();
            json!({
                "id": a.id, "name": a.id, "provider": a.provider,
                "harness": a.provider, "label": a.label,
                "credential": { "kind": a.kind, "path": a.config_dir },
                "identity": a.email.as_ref().map(|e| json!({ "email": e })).unwrap_or(json!({})),
                "auth": a.auth, "tint_ordinal": a.tint_ordinal,
                "origin_org": a.origin_org, "ambient": false,
                "mode": if a.is_apikey() { json!("apikey") } else { Value::Null },
                "enabled": a.enabled,
                "standing": { "auth": a.auth, "state": if a.limited(now).is_some() { "limited" } else { "ready" }, "marks": marks },
                "bound": [],
            })
        })
        .collect();
    engine.app.set_value("accounts", json!({ "accounts": rows }));
}
