//! App-wide settings (App settings > Runtime, provider switches, defaults).
//!
//! Stored as one JSON document in `ot.kv` under `app_settings`. Readers use
//! a lock-free snapshot; writers apply an atomic JSON merge in the database
//! (no application lock) and republish the snapshot from what was written.

use std::sync::Arc;

use anyhow::Result;
use arc_swap::ArcSwap;
use serde_json::{json, Map, Value};

pub const KEY: &str = "app_settings";

pub struct AppSettings {
    snapshot: ArcSwap<Value>,
}

#[logged]
impl AppSettings {
    pub fn new(initial: Value) -> Self {
        AppSettings { snapshot: ArcSwap::from_pointee(initial) }
    }

    #[nolog]
    pub fn get(&self) -> Arc<Value> {
        self.snapshot.load_full()
    }

    pub async fn load(client: &tokio_postgres::Client) -> Result<Value> {
        let row = client.query_opt("SELECT value FROM ot.kv WHERE key = $1", &[&KEY]).await?;
        Ok(row.map(|r| r.get::<_, Value>(0)).unwrap_or_else(|| json!({})))
    }

    /// Republish a document changed by a coordinated database operation.
    pub async fn reload(&self, pool: &deadpool_postgres::Pool) -> Result<()> {
        let client = pool.get().await?;
        let next = Self::load(&client).await?;
        self.snapshot.store(Arc::new(next));
        Ok(())
    }

    /// Deep-merge `patch` into the stored document (null removes a key) under
    /// the document's own row lock, and publish the result.
    pub async fn merge(&self, client: &mut tokio_postgres::Client, patch: Value) -> Result<Arc<Value>> {
        let tx = client.transaction().await?;
        tx.execute(
            "INSERT INTO ot.kv (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING",
            &[&KEY],
        )
        .await?;
        let row = tx.query_one("SELECT value FROM ot.kv WHERE key = $1 FOR UPDATE", &[&KEY]).await?;
        let mut next: Value = row.get(0);
        deep_merge(&mut next, &patch);
        tx.execute("UPDATE ot.kv SET value = $2, updated_at = now() WHERE key = $1", &[&KEY, &next])
            .await?;
        tx.commit().await?;
        let arc = Arc::new(next);
        self.snapshot.store(arc.clone());
        Ok(arc)
    }

    // ---- typed readers with the documented defaults ----
    /// Separate Antigravity Claude tiers are opt-in; existing installations keep them off.
    pub fn antigravity_claude_enabled(&self) -> bool {
        self.runtime().get("antigravity_claude_enabled").and_then(Value::as_bool).unwrap_or(false)
    }

    /// Message composers share this app-wide choice; old installations send on Enter.
    pub fn enter_key_behavior(&self) -> &'static str {
        if self.runtime().get("enter_key_behavior").and_then(Value::as_str) == Some("newline") {
            "newline"
        } else {
            "send"
        }
    }

    #[nolog]
    fn runtime(&self) -> Value {
        self.get().get("runtime").cloned().unwrap_or_else(|| json!({}))
    }

    /// Verbose logging (App settings › Developer): left unset, off in a
    /// packaged build and on in a development build.
    #[nolog]
    pub fn verbose_logging(&self) -> bool {
        self.runtime().get("verbose_logging").and_then(Value::as_bool).unwrap_or(!crate::trace::RELEASE_BUILD)
    }

    #[nolog]
    pub fn max_concurrent_turns(&self) -> usize {
        self.runtime().get("max_concurrent_turns").and_then(Value::as_u64).filter(|n| *n >= 1).unwrap_or(16) as usize
    }
    #[nolog]
    pub fn turn_timeout_s(&self) -> u64 {
        self.runtime().get("turn_timeout_s").and_then(Value::as_u64).unwrap_or(86_400)
    }
    #[nolog]
    pub fn turn_idle_s(&self) -> u64 {
        self.runtime().get("turn_idle_s").and_then(Value::as_u64).unwrap_or(600)
    }
    #[nolog]
    pub fn keep_warm(&self) -> bool {
        self.runtime().get("warming_enabled").and_then(Value::as_bool).unwrap_or(true)
    }
    #[nolog]
    pub fn wait_for_mcp_tools(&self) -> bool {
        self.runtime().get("wait_for_mcp_tools_enabled").and_then(Value::as_bool).unwrap_or(false)
    }
    #[nolog]
    pub fn quick_staff_behavior(&self) -> String {
        self.runtime()
            .get("quick_staff_behavior")
            .and_then(Value::as_str)
            .unwrap_or("request")
            .to_string()
    }
    #[nolog]
    pub fn provider_enabled(&self, provider: &str) -> bool {
        self.get().get("providers").and_then(|p| p.get(provider)).and_then(Value::as_bool).unwrap_or(true)
    }
    #[nolog]
    pub fn apikey_fallback(&self, provider: &str) -> bool {
        self.get()
            .get("apikey_fallback")
            .and_then(|p| p.get(provider))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
    #[nolog]
    pub fn subscription_inference(&self, provider: &str) -> bool {
        self.get()
            .get("subscription_inference")
            .and_then(|p| p.get(provider))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }
    #[nolog]
    pub fn defaults(&self) -> Map<String, Value> {
        self.get().get("defaults").and_then(Value::as_object).cloned().unwrap_or_default()
    }
}

/// 3.x's cheap-compaction setting: only `enabled` (true or false) and `occ`
/// (a fraction of the context window, kept within 5–95%). An org or app
/// write fills what a partial write leaves out from `old` (`merge`); an
/// agent's override keeps only what it names. A write naming neither is a
/// no-op (`None`); a value of the wrong kind is refused.
#[logged]
pub fn cheap_compact(acc: &Value, old: &Value, merge: bool) -> std::result::Result<Option<Value>, String> {
    let Some(a) = acc.as_object() else {
        return Err("auto_cheap_compact is {enabled, occ}".into());
    };
    let enabled = match a.get("enabled") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err("auto_cheap_compact.enabled must be true or false".into()),
    };
    let occ = match a.get("occ") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_f64() {
            Some(f) => Some(f.clamp(0.05, 0.95)),
            None => return Err("auto_cheap_compact.occ must be a number (a fraction of the context window)".into()),
        },
    };
    if enabled.is_none() && occ.is_none() {
        return Ok(None);
    }
    let mut out = Map::new();
    if merge {
        out.insert("enabled".into(), json!(enabled.or_else(|| old.get("enabled").and_then(Value::as_bool)).unwrap_or(false)));
        let occ = occ.or_else(|| old.get("occ").and_then(Value::as_f64)).unwrap_or(0.5).clamp(0.05, 0.95);
        out.insert("occ".into(), json!(occ));
    } else {
        if let Some(e) = enabled {
            out.insert("enabled".into(), json!(e));
        }
        if let Some(o) = occ {
            out.insert("occ".into(), json!(o));
        }
    }
    Ok(Some(Value::Object(out)))
}

pub fn deep_merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else if let Some(existing) = t.get_mut(k) {
                    if existing.is_object() && v.is_object() {
                        deep_merge(existing, v);
                    } else {
                        *existing = v.clone();
                    }
                } else {
                    t.insert(k.clone(), v.clone());
                }
            }
        }
        (t, p) => *t = p.clone(),
    }
}
