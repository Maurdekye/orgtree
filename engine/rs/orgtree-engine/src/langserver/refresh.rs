//! Once-per-start discovery and the last successful stored-server probe. The
//! cache is memory only; only an exact legacy context can be upgraded on disk.
use super::*;

#[derive(Default)]
pub struct ProbeCache {
    entries: arc_swap::ArcSwap<std::collections::HashMap<String, ProbeEntry>>,
}

#[derive(Clone)]
struct ProbeEntry { epoch: u64, value: Option<Arc<Value>> }

impl ProbeCache {
    #[nolog]
    pub fn get(&self, id: &str) -> Option<Value> {
        self.entries.load().get(id)?.value.as_ref().map(|value| (**value).clone())
    }

    #[nolog]
    pub fn epoch(&self, id: &str) -> u64 {
        self.entries.load().get(id).map(|entry| entry.epoch).unwrap_or(0)
    }

    /// Invalidates in-flight old-key probes as well as old endpoint results.
    #[nolog]
    pub fn evict(&self, id: &str) {
        self.entries.rcu(|old| {
            let mut next = (**old).clone();
            let epoch = next.get(id).map(|entry| entry.epoch).unwrap_or(0) + 1;
            next.insert(id.to_string(), ProbeEntry { epoch, value: None });
            Arc::new(next)
        });
    }

    /// Failed probes leave the last success intact, including its timestamp.
    #[nolog]
    pub fn record(&self, id: &str, probe: &Value, epoch: u64) -> bool {
        if epoch != self.epoch(id) { return false; }
        if probe["reachable"] != true || probe["error"].as_str().is_some() {
            tracing::warn!(server = id, "language model server model-list refresh failed");
            return false;
        }
        let models = probe["models"].as_array().cloned().unwrap_or_default();
        let value = Arc::new(json!({
            "at": iso(chrono::Utc::now()), "reachable": true,
            "models": models, "error": Value::Null,
        }));
        loop {
            let old = self.entries.load_full();
            let entry = old.get(id);
            if entry.map(|entry|entry.epoch).unwrap_or(0) != epoch { return false; }
            if models.is_empty() && entry.and_then(|entry|entry.value.as_ref())
                .is_some_and(|old| old["models"].as_array().is_some_and(|m|!m.is_empty())) {
                tracing::warn!(server = id, "empty language model server refresh kept the previous model list");
                return false;
            }
            let mut next = (*old).clone();
            next.insert(id.to_string(),ProbeEntry { epoch, value: Some(value.clone()) });
            let previous = self.entries.compare_and_swap(&old,Arc::new(next));
            if Arc::ptr_eq(&old,&previous) { return true; }
        }
    }
}

#[nolog]
pub fn valid_context(value: &Value) -> Option<i64> {
    value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && (1.0..=10_000_000.0).contains(n)).map(|n| n as i64)
}

/// Mirrors renderer Models.startWindow; shared fixture rows pin agreement.
#[nolog]
pub fn start_window(model: &Value) -> i64 {
    ["configured_context", "loaded_context", "max_context"].iter()
        .find_map(|field| valid_context(&model[*field])).unwrap_or(DEFAULT_CONTEXT)
}

#[nolog]
fn same_endpoint(a: &Value, b: &Value) -> bool {
    !b.is_null() && ["address", "preset", "base_path"].iter().all(|key| a[*key] == b[*key])
}

#[nolog]
fn upgrades(server: &Value, probe: &Value) -> Vec<(String, i64)> {
    if probe["reachable"] != true { return Vec::new(); }
    probe["models"].as_array().into_iter().flatten().filter_map(|model| {
        let id = model["id"].as_str()?;
        let saved = server["models"].get(id)?;
        let next = start_window(model);
        (saved["context"].as_i64() == Some(65_536) && next != 65_536).then(|| (id.to_string(), next))
    }).collect()
}

#[nolog]
fn upgrade_guard(id: &str, server: &Value, model: &str) -> Vec<(String, Value)> {
    let esc = |s: &str| s.replace('~', "~0").replace('/', "~1");
    let path = format!("/language_servers/servers/{}", esc(id));
    let mut expected: Vec<_> = ["address", "preset", "base_path"].iter()
        .map(|field| (format!("{path}/{field}"), server[*field].clone())).collect();
    expected.push((format!("{path}/models/{}/context", esc(model)), json!(65_536)));
    expected
}

/// The HTTP stored-server path and startup use this same result handler. A
/// successful probe remains cached even if a guarded legacy upgrade fails.
#[nolog]
pub async fn accept(engine: &Engine, original: &Value, result: &Value, epoch: u64) {
    let Some(id) = original["id"].as_str() else { return };
    if engine.langserver_probes.epoch(id) != epoch || !same_endpoint(original, &server(engine, id).unwrap_or(Value::Null)) {
        tracing::debug!(server = id, "discarded stale language model server probe");
        return;
    }
    if !engine.langserver_probes.record(id, result, epoch) { return; }
    for (model, context) in upgrades(original, result) {
        let patch = ServerPatch { models: vec![(model.clone(), None, Some(context), None)], ..Default::default() };
        match update_server_if(engine, id, patch, &upgrade_guard(id, original, &model)).await {
            Ok(Some(_)) => tracing::info!(server = id, model, old = 65_536, new = context, "language model server context upgraded"),
            Ok(None) => tracing::debug!(server = id, model, "skipped stale language model server context upgrade"),
            Err(_) => tracing::warn!(server = id, model, "language model server context upgrade failed"),
        }
    }
    publish(engine).await;
}

#[nolog]
pub async fn stored_probe(engine: &Engine, original: &Value, only: &[String]) -> Value {
    let Some(id) = original["id"].as_str() else { return Value::Null };
    let epoch = engine.langserver_probes.epoch(id);
    let key = key(engine, id).await;
    let result = probe(original["preset"].as_str().unwrap_or("custom"), original["address"].as_str().unwrap_or(""),
        key.as_deref(), original["harness"].as_str().unwrap_or("claude-code"), original["base_path"].as_str(), only).await;
    accept(engine, original, &result, epoch).await;
    result
}

#[nolog]
async fn refresh_enabled(engine: &Engine) {
    for saved in servers(engine) {
        if saved["enabled"] != true { continue; }
        tokio::select! {
            _ = engine.shutdown.cancelled() => return,
            _ = stored_probe(engine, &saved, &[]) => {},
        }
    }
}

/// Called once after the ready boundary; no request or startup waits for it.
#[logged]
pub fn start(engine: &Arc<Engine>) {
    let engine = engine.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = engine.shutdown.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(30)) => {},
        }
        refresh_enabled(&engine).await;
    });
}

#[cfg(test)]
#[path = "refresh_unit_tests.rs"]
mod tests;
