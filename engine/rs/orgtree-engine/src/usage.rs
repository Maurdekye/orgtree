//! Usage readouts for the usage window and the header glow: Claude's
//! subscription bars (the OAuth usage endpoint, read with the CLI's own
//! unexpired sign-in — never refreshed here, so the CLI's rotating token is
//! never spent behind its back), Codex rate limits (a short-lived app-server's
//! `account/rateLimits/read`), Antigravity's zero-token `/usage`, Muse Code's
//! own usage observations (dated when Muse observed them), OpenRouter's
//! credit standing, and API-key accounts' metered spend. Every readout is
//! cached in a lock-free map; the peeks read the cache alone.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::util::{gist, iso};

pub mod query;

const TTL: Duration = Duration::from_secs(30);
/// a peek older than this is no claim about now
const PEEK_MAX: Duration = Duration::from_secs(900);
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT: &str = concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"));
const NOT_YET: &str = "usage unavailable; start a turn on this account to see usage";
/// The `provider` a host lane's readout carries: 3.x's display names
/// (codex_limits.py / antigravity_limits.py), not the provider ids.
pub const CODEX_NAME: &str = "Codex";
pub const AGY_NAME: &str = "Antigravity";
pub const MUSE_NAME: &str = "Muse";

#[cfg(test)]
mod continuation_auth_tests {
    use super::*;

    #[test]
    fn cached_auth_is_tristate_and_expires_at_boundary() {
        let usage = Usage::default();
        let key = codex_key(None);
        assert_eq!(usage.cached_reauth_required(&key), None);
        for (data, expected) in [
            (json!({"available":true}), Some(false)),
            (json!({"reauth_required":false}), Some(false)),
            (json!({"reauth_required":true}), Some(true)),
            (json!({"reauth_required":false,"reauth_evidence":"not_connected"}), Some(true)),
        ] {
            usage.put(&key, &data);
            assert_eq!(usage.cached_reauth_required(&key), expected);
        }
        usage.auth.pin().insert(key.clone(), AuthEvidence { at: Instant::now() - PEEK_MAX, required: Some(true) });
        assert_eq!(usage.cached_reauth_required(&key), None);
        usage.auth.pin().insert(key.clone(), AuthEvidence { at: Instant::now() - (PEEK_MAX - Duration::from_secs(1)), required: Some(true) });
        assert_eq!(usage.cached_reauth_required(&key), Some(true));
    }

    #[test]
    fn claude_recent_good_then_negative_auth() {
        let usage = Usage::default();
        let key = claude_key(None);
        usage.claude_result(&key, json!({"available":true,"limits":[{"percent":10}]}));
        let at = usage.cache.pin().get(&key).unwrap().at;
        let result = usage.claude_result(&key, json!({"available":false,
            "error":"rejected","reauth_required":true,"reauth_evidence":"measured_403"}));
        assert_eq!(result["limits"][0]["percent"], 10);
        assert_eq!(usage.cached_reauth_required(&key), Some(true));
        assert_eq!(usage.cache.pin().get(&key).unwrap().at, at);
    }

    #[test]
    fn claude_failure_keeps_bar_age_and_records_recent_auth() {
        let usage = Usage::default();
        let key = claude_key(None);
        usage.claude_result(&key, json!({"available":true,"observed_at":"2001-01-01T00:00:00Z",
            "limits":[{"kind":"session","percent":10}]}));
        assert_eq!(usage.cached_reauth_required(&key), Some(false));
        let old = Instant::now() - (PEEK_MAX + Duration::from_secs(1));
        usage.cache.pin().insert(key.clone(), Cached { at: old,
            data: usage.fresh(&key, Duration::MAX).unwrap() });
        let result = usage.claude_result(&key, json!({"available":false,
            "reauth_required":true,"reauth_evidence":"measured_403"}));
        assert_eq!(result["reauth_required"], true);
        assert_eq!(result["observed_at"], "2001-01-01T00:00:00Z");
        assert_eq!(usage.cache.pin().get(&key).unwrap().at, old);
        assert_eq!(usage.peek(&key, "claude")["available"], false);
        assert_eq!(usage.cached_reauth_required(&key), Some(true));
        let auth_at = usage.auth.pin().get(&key).unwrap().at;
        // Neither a transient failure nor replaying last-good during cooldown
        // asserts a fresh successful authentication or refreshes the bars.
        usage.claude_result(&key, json!({"available":false,"error":"transient"}));
        usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(30));
        assert_eq!(usage.auth.pin().get(&key).unwrap().at, auth_at);
        assert_eq!(usage.cached_reauth_required(&key), Some(true));
        assert_eq!(usage.cache.pin().get(&key).unwrap().at, old);
        usage.claude_result(&key, json!({"available":true,"limits":[]}));
        assert_eq!(usage.cached_reauth_required(&key), Some(false));
        assert!(usage.cache.pin().get(&key).unwrap().at > old);
    }

    #[test]
    fn physical_auth_uses_latest_genuine_fresh_observation() {
        let usage = Usage::default();
        let keys = [claude_key(None), claude_key(Some("synthetic-native-home"))];
        let aggregate = || usage.cached_reauth_required_across(keys.iter().map(String::as_str));
        assert_eq!(aggregate(), None);
        for (bad, good) in [(0, 1), (1, 0)] {
            usage.claude_result(&keys[bad], json!({"available":false,"reauth_required":true}));
            usage.claude_result(&keys[good], json!({"available":true,"limits":[]}));
            assert_eq!(aggregate(), Some(false));
            usage.claude_result(&keys[bad], json!({"available":false,"reauth_required":true}));
            assert_eq!(aggregate(), Some(true));
            let auth_at = usage.auth.pin().get(&keys[bad]).unwrap().at;
            usage.claude_result(&keys[good], json!({"available":false,"error":"transient"}));
            usage.claude_cooldown(&keys[good], Instant::now() + Duration::from_secs(30));
            usage.record_auth(&keys[good], &json!({"available":true,"error":"retained bars"}));
            assert_eq!(aggregate(), Some(true));
            assert_eq!(usage.auth.pin().get(&keys[bad]).unwrap().at, auth_at);
            usage.auth.pin().insert(keys[good].clone(), AuthEvidence { at: Instant::now() - PEEK_MAX, required: Some(false) });
            assert_eq!(aggregate(), Some(true));
            usage.auth.pin().insert(keys[good].clone(), AuthEvidence { at: Instant::now(), required: None });
            assert_eq!(aggregate(), Some(true));
        }
    }
}

/// Antigravity has one native sign-in. Only its model family's windows apply.
/// Missing/stale readings remain unknown; an observed unexpired full window refuses.
#[logged]
pub fn antigravity_limit(engine: &Engine, tier: &str) -> Option<String> {
    use crate::providers::catalog;
    if catalog::provider_of(tier) != catalog::GOOGLE {
        return None;
    }
    let pool = catalog::antigravity_pool(tier);
    let data = engine.usage.peek("agy", catalog::GOOGLE);
    let limits = data["limits"].as_array()?;
    limits.iter().find(|l| {
        let group = l["group"].as_str().unwrap_or("");
        (group == format!("{pool}-5h") || group == format!("{pool}-weekly"))
            && l["percent"].as_f64().is_some_and(|p| p >= 100.0)
            && !l["resets_at"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|t| t <= Utc::now())
    }).map(|l| format!("Antigravity {} is exhausted until {}; this tier spends the {pool} windows",
        l["group"].as_str().unwrap_or("usage"), l["resets_at"].as_str().unwrap_or("the provider resets it")))
}

// ------------------------------------------------------------ the 100% rule

/// The cached reading of one login (never a fetch): `None` is the
/// provider's own sign-in, a row its folder's; an API key has none.
#[nolog]
fn reading_of(engine: &Engine, provider: &str, account: Option<&crate::accounts::AccountInfo>) -> Option<Value> {
    use crate::providers::catalog;
    // an OpenRouter key's reading is its credit standing, by its lane (`None`
    // is the original key)
    if provider == catalog::OPENROUTER {
        let id = account.filter(|a| a.provider == catalog::OPENROUTER).map(|a| a.id.as_str()).unwrap_or(crate::openrouter::ACCOUNT_ID);
        let v = openrouter_reading(engine, &crate::openrouter::lane(id))?;
        return v["available"].as_bool().unwrap_or(false).then_some(v);
    }
    if account.is_some_and(|a| a.is_apikey()) {
        return None;
    }
    let folder = account.and_then(|a| a.config_dir.as_deref());
    let key = match provider {
        catalog::CLAUDE => claude_key(folder),
        catalog::OPENAI => codex_key(folder),
        catalog::GOOGLE => "agy".to_string(),
        catalog::MUSE => muse_key(folder),
        _ => return None,
    };
    let v = engine.usage.peek(&key, provider);
    v["available"].as_bool().unwrap_or(false).then_some(v)
}

/// Whether `tier` spends this reading window (the user's rule, 2026-09-12):
/// Claude: the session and the standard weekly window for every tier, and a
/// model-scoped weekly window only for the model it names (so fable needs
/// both weekly windows and the lower tiers ignore Fable's); Codex: the plan
/// pool (its unnamed windows, 3.x `codex_route.pool_of_window`); Antigravity:
/// the tier's model group; Muse: only windows observed while the tier's own
/// model ran (Muse reports one window set per login and does not say which
/// models share it, so another model's reading is no evidence for this one;
/// user ruling 2026-10-12: never assume Wonder and Wonder Full share a pool).
#[nolog]
fn spends(provider: &str, tier: &str, w: &Value) -> bool {
    use crate::providers::catalog;
    match provider {
        catalog::CLAUDE => match w["kind"].as_str().unwrap_or("") {
            "session" | "weekly_all" => true,
            "weekly_scoped" => w["model"].as_str().is_some_and(|m| m.to_lowercase().contains(&tier.to_lowercase())),
            _ => false,
        },
        catalog::OPENAI => w["model"].as_str().map(str::trim).unwrap_or("").is_empty(),
        catalog::GOOGLE => {
            let pool = catalog::antigravity_pool(tier);
            w["group"].as_str().is_some_and(|g| g == format!("{pool}-5h") || g == format!("{pool}-weekly"))
        }
        // every OpenRouter tier spends its key's one credit row
        catalog::OPENROUTER => w["group"] == "credits",
        catalog::MUSE => w["observed_model"].as_str().is_some_and(|m| catalog::runs_model(tier, m)),
        _ => false,
    }
}

/// 3.x `account_fallback.exhausted`: positive evidence that this login cannot
/// run `tier` now, a window the tier spends reading 100% (why, for the
/// refusal). Silence is never evidence: no reading, a failed one, or a
/// percent it cannot read. A passed reset does not free a full window
/// (staleness weakens evidence, never frees).
#[logged]
pub fn at_limit(engine: &Engine, account: Option<&crate::accounts::AccountInfo>, tier: &str) -> Option<String> {
    let provider = crate::providers::catalog::provider_of(tier);
    let v = reading_of(engine, provider, account)?;
    v["limits"].as_array()?.iter().filter(|w| spends(provider, tier, w)).find_map(|w| spent_window(provider, w))
}

/// Why one usage row `at_limit` read is spent, or None.
#[nolog]
fn spent_window(provider: &str, w: &Value) -> Option<String> {
    // an OpenRouter key's credit row says itself when it is spent
    // (`is_active`): a capped key whose account balance is at zero reads
    // under 100% of its cap, and a prepaid balance at zero has no percent
    if provider == crate::providers::catalog::OPENROUTER && w["is_active"] == json!(true) {
        return Some(format!("its latest reading shows {}", w["label"].as_str().unwrap_or("its credit spent")));
    }
    let p = w["percent"].as_f64().filter(|p| p.is_finite() && *p >= 100.0)?;
    let window = w["label"].as_str().or(w["kind"].as_str()).unwrap_or("usage");
    Some(format!("its latest reading shows the {window} window at {}% (resets {})", p.round() as i64,
                 w["resets_at"].as_str().unwrap_or("at an unreported time")))
}

/// What account balancing reads from a login's cached reading for `tier`:
/// over the windows the tier spends, the last reset and the highest percent
/// used. None without a cached reading (never a fetch).
#[logged]
pub fn balance_reading(engine: &Engine, account: Option<&crate::accounts::AccountInfo>, tier: &str) -> Option<crate::domain::templates::Reading> {
    let provider = crate::providers::catalog::provider_of(tier);
    let v = reading_of(engine, provider, account)?;
    let spent: Vec<&Value> = v["limits"].as_array()?.iter().filter(|w| spends(provider, tier, w)).collect();
    let reset = spent.iter().filter_map(|w| w["resets_at"].as_str().and_then(crate::util::parse_ts)).max();
    let used = spent.iter().filter_map(|w| w["percent"].as_f64().filter(|p| p.is_finite())).reduce(f64::max);
    (reset.is_some() || used.is_some()).then_some(crate::domain::templates::Reading { reset, used })
}

/// 3.x `account_fallback.available`: positive proof of room, which a move
/// nobody asked for needs: every window `tier` spends reads under 100%, is
/// not active and resets ahead, and none is missing (Claude: the session and
/// the standard weekly, and Fable's own weekly for fable).
#[logged]
pub fn has_room(engine: &Engine, account: Option<&crate::accounts::AccountInfo>, tier: &str) -> bool {
    let provider = crate::providers::catalog::provider_of(tier);
    let Some(v) = reading_of(engine, provider, account) else { return false };
    let Some(limits) = v["limits"].as_array() else { return false };
    room_in(provider, tier, limits, Utc::now())
}

/// `has_room` over one reading's windows. Muse reports one account-wide
/// document: a window a metadata host read names no model and is that
/// account's own evidence, while a window observed under ANOTHER model is
/// never proof for this tier (user 2026-10-12: no shared pool is assumed).
/// If the tier's pool refuses anyway, its typed quota marks that pool and
/// the fallback moves on.
#[nolog]
fn room_in(provider: &str, tier: &str, limits: &[Value], now: DateTime<Utc>) -> bool {
    use crate::providers::catalog;
    let spent: Vec<&Value> = limits.iter()
        .filter(|w| spends(provider, tier, w) || (provider == catalog::MUSE && w["observed_model"].is_null()))
        .collect();
    let needed: &[&str] = match (provider, tier) {
        (catalog::CLAUDE, "fable") => &["session", "weekly_all", "weekly_scoped"],
        (catalog::CLAUDE, _) => &["session", "weekly_all"],
        (catalog::MUSE, _) => &["session", "weekly_all"],
        _ => &[],
    };
    if spent.is_empty() || needed.iter().any(|k| !spent.iter().any(|w| w["kind"].as_str() == Some(*k))) {
        return false;
    }
    // an OpenRouter key has no rolling window: room is a credit row that is
    // not spent (under its cap, or a balance left)
    if provider == catalog::OPENROUTER {
        return spent.iter().all(|w| {
            !w["is_active"].as_bool().unwrap_or(false) && w["percent"].as_f64().is_none_or(|p| p.is_finite() && p < 100.0)
        });
    }
    spent.iter().all(|w| {
        w["percent"].as_f64().is_some_and(|p| p.is_finite() && (0.0..100.0).contains(&p))
            && !w["is_active"].as_bool().unwrap_or(false)
            && w["resets_at"].as_str().and_then(crate::util::parse_ts).is_some_and(|t| t > now)
    })
}

#[derive(Clone)]
struct Cached {
    at: Instant,
    data: Value,
}

#[derive(Clone)]
struct AuthEvidence {
    at: Instant,
    required: Option<bool>,
}

/// The readouts, by key (`claude:<dir>`, `codex:<home>`, `agy`, `openrouter`).
#[derive(Default)]
pub struct Usage {
    cache: papaya::HashMap<String, Cached>,
    /// Authentication observations have their own age, separate from last-good bars.
    auth: papaya::HashMap<String, AuthEvidence>,
    /// Single-flight reservation shared by HTTP, timers and manual readers.
    probing: papaya::HashMap<String, ()>,
    /// Manual attempt floor (failures count); automatic cadence is unchanged.
    manual: papaya::HashMap<String, Instant>,
    /// a provider that told us to wait: not before this
    cooldown: papaya::HashMap<String, Instant>,
    /// the last usage-history row of each series
    pub history: papaya::HashMap<String, crate::usage_history::Last>,
}

pub struct Probe<'a> {
    usage: &'a Usage,
    key: String,
}

impl Drop for Probe<'_> {
    fn drop(&mut self) {
        self.usage.probing.pin().remove(&self.key);
    }
}

pub enum RefreshGate<'a> {
    Ready(Probe<'a>),
    Skip(&'static str, Option<u64>),
}

#[logged]
impl Usage {
    #[nolog]
    fn reserve(&self, key: &str) -> Option<Probe<'_>> {
        self.probing.pin().try_insert(key.to_owned(), ()).ok()?;
        Some(Probe { usage: self, key: key.to_owned() })
    }

    /// Shared reservation is held until the reader finishes or is cancelled.
    pub fn refresh_gate(&self, key: &str, provider: &str) -> RefreshGate<'_> {
        let Some(guard) = self.reserve(key) else { return RefreshGate::Skip("in_progress", None) };
        let now = Instant::now();
        let floor = if provider == "google" { 300 } else { 60 };
        if let Some(last) = self.manual.pin().get(key) {
            let until = *last + Duration::from_secs(floor);
            if until > now {
                return RefreshGate::Skip("rate_limited", Some(until.duration_since(now).as_secs().max(1)));
            }
        }
        if let Some(until) = self.cooling(key) {
            return RefreshGate::Skip("rate_limited", Some(until.saturating_duration_since(now).as_secs().max(1)));
        }
        if self.snapshot(key, Utc::now())["age_seconds"].as_u64().is_some_and(|age| age < floor) {
            return RefreshGate::Skip("reused", None);
        }
        self.manual.pin().insert(key.to_owned(), now);
        RefreshGate::Ready(guard)
    }

    #[nolog]
    fn busy_reading(&self, key: &str) -> Value {
        let mut v = self.fresh(key, Duration::MAX).unwrap_or_else(|| json!({"available":false}));
        v["error"] = json!("usage read already in progress");
        v
    }
    #[nolog]
    fn fresh(&self, key: &str, max: Duration) -> Option<Value> {
        self.cache.pin().get(key).filter(|c| c.at.elapsed() < max).map(|c| c.data.clone())
    }

    #[nolog]
    fn put(&self, key: &str, data: &Value) {
        self.record_auth(key, data);
        self.cache.pin().insert(key.to_string(), Cached { at: Instant::now(), data: data.clone() });
    }

    /// Store a reading dated when the provider observed it, not when it
    /// reached us: a cached observation is never re-dated as fresh, and an
    /// older one never replaces a newer reading. One older than this
    /// machine's uptime is dropped (no clock here can date it).
    #[nolog]
    fn put_observed(&self, key: &str, data: &Value, observed: DateTime<Utc>) -> bool {
        let age = (Utc::now() - observed).to_std().unwrap_or_default();
        let Some(at) = Instant::now().checked_sub(age) else { return false };
        let pin = self.cache.pin();
        if pin.get(key).is_some_and(|c| c.at >= at && c.data["available"] == true) {
            return false;
        }
        // only a recent observation says anything about the sign-in now
        if age < Duration::from_secs(60) {
            self.record_auth(key, data);
        }
        pin.insert(key.to_string(), Cached { at, data: data.clone() });
        true
    }

    /// The cached readout behind `key` as stored (any age), never a fetch.
    #[nolog]
    pub fn cached(&self, key: &str) -> Option<Value> {
        self.fresh(key, Duration::MAX)
    }

    #[nolog]
    fn record_auth(&self, key: &str, data: &Value) {
        let required = if data["reauth_required"] == true || data["reauth_evidence"] == "not_connected" {
            Some(true)
        } else if data["error"].is_null() {
            // A successful provider result is a positive authentication
            // observation even when it carries no explicit reauth flag.
            data["reauth_required"].as_bool().or_else(|| (data["available"] == true).then_some(false))
        } else {
            None
        };
        // A genuine successful read replaces earlier negative evidence. An
        // unrelated transient failure supplies no new authentication evidence.
        if required.is_some() {
            self.auth.pin().insert(key.to_string(), AuthEvidence { at: Instant::now(), required });
        }
    }

    /// Process a completed Claude read, retaining the original age of last-good
    /// bars on failure. Shared by the provider path and its isolated fixtures.
    #[nolog]
    fn claude_result(&self, key: &str, out: Value) -> Value {
        self.record_auth(key, &out);
        if out["available"].as_bool().unwrap_or(false) {
            self.put(key, &out);
        } else if let Some(prev) = self.fresh(key, Duration::MAX).filter(|p| p["available"].as_bool().unwrap_or(false)) {
            let mut v = prev;
            v["error"] = out["error"].clone();
            if out.get("reauth_required").is_some() || out.get("reauth_evidence").is_some() {
                v["reauth_required"] = out["reauth_required"].clone();
                v["reauth_evidence"] = out["reauth_evidence"].clone();
            }
            return v;
        } else {
            self.put(key, &out);
        }
        out
    }

    #[nolog]
    fn claude_cooldown(&self, key: &str, until: Instant) -> Value {
        let mut v = self.fresh(key, Duration::MAX).unwrap_or_else(|| json!({ "available": false }));
        v["error"] = json!(format!("the usage service asked us to wait ({} s more)", until.saturating_duration_since(Instant::now()).as_secs()));
        v
    }

    #[nolog]
    fn cooling(&self, key: &str) -> Option<Instant> {
        self.cooldown.pin().get(key).copied().filter(|t| *t > Instant::now())
    }

    /// Recent genuine authentication evidence only; false includes successful
    /// unflagged provider results. Missing/stale observations are unknown.
    #[nolog]
    pub fn cached_reauth_required(&self, key: &str) -> Option<bool> {
        let guard = self.auth.pin();
        let c = guard.get(key).filter(|c| c.at.elapsed() < PEEK_MAX)?;
        c.required
    }

    /// Reconcile aliases of one physical login by genuine observation time.
    /// Cooldown, transient failures and absent evidence cannot supersede it.
    #[nolog]
    pub fn cached_reauth_required_across<'a>(&self, keys: impl IntoIterator<Item = &'a str>) -> Option<bool> {
        let guard = self.auth.pin();
        keys.into_iter().filter_map(|key| guard.get(key))
            .filter(|c| c.required.is_some() && c.at.elapsed() < PEEK_MAX)
            // Equal timestamps conservatively keep a negative assertion.
            .max_by_key(|c| (c.at, c.required == Some(true)))
            .and_then(|c| c.required)
    }

    /// Raw provider fields stay internal; invocation logging must not see them.
    #[nolog]
    /// The cached readout behind `key`, for a peek (the glow): never a fetch.
    pub fn peek(&self, key: &str, provider: &str) -> Value {
        match self.cache.pin().get(key) {
            Some(c) if c.at.elapsed() < PEEK_MAX && c.data["available"].as_bool().unwrap_or(false) => json!({
                "available": true, "provider": provider, "limits": c.data["limits"], "age": c.at.elapsed().as_secs(),
            }),
            Some(c) => json!({ "available": false, "provider": provider, "age": c.at.elapsed().as_secs(),
                                "error": c.data["error"] }),
            None => json!({ "available": false, "provider": provider }),
        }
    }

    /// Safe cache projection for an on-demand reader. Never fetches, reads
    /// credentials, or serializes the cached provider document unchanged.
    pub fn snapshot(&self, key: &str, now: DateTime<Utc>) -> Value {
        self.snapshot_selected(key, now, &query::Selection::default())
    }

    pub fn snapshot_selected(&self, key: &str, now: DateTime<Utc>, selection: &query::Selection) -> Value {
        let pin = self.cache.pin();
        match pin.get(key) {
            Some(c) => {
                let cached_at = now - chrono::Duration::from_std(c.at.elapsed()).unwrap_or_default();
                query::reading_selected(Some(&c.data), Some(cached_at), now, selection)
            }
            None => query::reading(None, None, now),
        }
    }
}

fn home() -> PathBuf {
    crate::rig::home_dir().unwrap_or_default()
}

fn severity(percent: f64) -> &'static str {
    if percent >= 90.0 {
        "critical"
    } else if percent >= 75.0 {
        "warning"
    } else {
        "normal"
    }
}

fn epoch_iso(secs: i64) -> Option<String> {
    (secs > 0).then(|| DateTime::from_timestamp(secs, 0).map(iso)).flatten()
}

// ------------------------------------------------------------ Claude

/// `claude:<config dir>`: the cache key of one Claude login.
pub fn claude_key(config_dir: Option<&str>) -> String {
    format!("claude:{}", config_dir.unwrap_or("~"))
}

fn claude_dir(config_dir: Option<&str>) -> PathBuf {
    config_dir.map(PathBuf::from).unwrap_or_else(|| home().join(".claude"))
}

/// The Claude usage bars of one login (`config_dir` None: the machine's own).
#[nolog]
pub async fn claude(engine: &Engine, config_dir: Option<&str>, force: bool) -> Value {
    let key = claude_key(config_dir);
    let Some(_guard) = engine.usage.reserve(&key) else { return engine.usage.busy_reading(&key) };
    claude_read(engine, config_dir, force).await
}

#[nolog]
async fn claude_read(engine: &Engine, config_dir: Option<&str>, force: bool) -> Value {
    if let Some(v) = crate::rig::usage("claude", config_dir) {
        // the canned reading stands in for the probe, cache included; it may
        // play a slow provider
        if let Some(ms) = v["rig_delay_ms"].as_u64() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        // a canned reading is still history, so a rig proof sees it recorded
        if crate::rig::canned_reading(&v) {
            crate::account_marks::profile_history(engine, "claude", config_dir, Utc::now(), &v).await;
        }
        return engine.usage.claude_result(&claude_key(config_dir), v);
    }
    let key = claude_key(config_dir);
    if !force {
        if let Some(v) = engine.usage.fresh(&key, TTL) {
            return v;
        }
    }
    let dir = claude_dir(config_dir);
    let (_, email) = crate::providers::claude_identity(config_dir.map(PathBuf::from).as_ref());
    let mut out = match engine.usage.cooling(&key) {
        Some(until) => {
            let mut v = engine.usage.claude_cooldown(&key, until);
            v["email"] = json!(email);
            return v;
        }
        None => {
            let observed = Utc::now();
            let mut value = fetch_claude(engine, &key, &dir).await;
            // the history labels the login by it (set on `out` below anyway)
            value["email"] = json!(email);
            crate::account_marks::profile_usage(engine, "claude", config_dir, observed, &value).await;
            value
        },
    };
    out["email"] = json!(email);
    engine.usage.claude_result(&key, out)
}

/// The sign-in a Claude login holds: (access token, expires at ms, plan). Not logged.
fn claude_sign_in(dir: &Path) -> Option<(String, i64, String)> {
    let doc: Value = serde_json::from_slice(&std::fs::read(dir.join(".credentials.json")).ok()?).ok()?;
    let o = doc.get("claudeAiOauth")?;
    Some((
        o.get("accessToken")?.as_str()?.to_string(),
        o.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
        o.get("subscriptionType").and_then(Value::as_str).unwrap_or("").to_string(),
    ))
}

async fn fetch_claude(engine: &Engine, key: &str, dir: &Path) -> Value {
    let Some((token, expires_ms, plan)) = claude_sign_in(dir) else {
        return json!({ "available": false, "error": "Claude Code is not signed in for this account",
                       "reauth_required": true, "reauth_evidence": "not_connected" });
    };
    if expires_ms > 0 && expires_ms < Utc::now().timestamp_millis() + 60_000 {
        return json!({ "available": false, "error": NOT_YET,
                       "detail": "the stored sign-in has expired; Claude Code renews it on its next turn" });
    }
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(USER_AGENT).build() {
        Ok(c) => c,
        Err(e) => return json!({ "available": false, "error": NOT_YET, "detail": e.to_string() }),
    };
    let resp = client
        .get(USAGE_URL)
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .send()
        .await;
    drop(token);
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return json!({ "available": false, "error": NOT_YET, "detail": gist(&e.to_string(), 300) }),
    };
    let status = resp.status().as_u16();
    let retry = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
    let body = resp.text().await.unwrap_or_default();
    match status {
        200 => {
            let raw: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let mut out = json!({ "available": true, "limits": claude_limits(&raw), "observed_at": iso(Utc::now()) });
            if !plan.is_empty() {
                out["plan"] = json!(plan);
            }
            if let Some(b) = raw.pointer("/spend/balance").and_then(Value::as_f64).filter(|b| *b > 0.0) {
                out["credits"] = json!({ "balance": b, "unit": raw.pointer("/spend/currency").and_then(Value::as_str).unwrap_or("USD"),
                                         "unlimited": false });
            }
            out
        }
        429 => {
            let secs = retry.unwrap_or(60).clamp(1, 6 * 3600);
            engine.usage.cooldown.pin().insert(key.to_string(), Instant::now() + Duration::from_secs(secs));
            json!({ "available": false, "error": format!("the usage service asked us to wait {secs} s"), "detail": "HTTP 429" })
        }
        401 | 403 if !body.contains("error code: 1010") => json!({
            "available": false, "error": "Claude Code needs to sign in again for this account",
            "detail": format!("HTTP {status}"), "reauth_required": true, "reauth_evidence": "measured_403",
        }),
        _ => json!({ "available": false, "error": NOT_YET, "detail": format!("HTTP {status}: {}", gist(&body, 200)) }),
    }
}

/// `limits[]` (or the older flat five_hour / seven_day pair) as usage bars.
fn claude_limits(raw: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = raw["limits"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|l| l.is_object())
                .map(|l| {
                    json!({ "kind": l["kind"], "group": l["group"], "percent": l["percent"], "severity": l["severity"],
                            "resets_at": l["resets_at"], "is_active": l["is_active"].as_bool().unwrap_or(false),
                            "model": l.pointer("/scope/model/display_name").cloned().unwrap_or(Value::Null) })
                })
                .collect()
        })
        .unwrap_or_default();
    if out.is_empty() {
        for (k, kind) in [("five_hour", "session"), ("seven_day", "weekly_all")] {
            if let Some(u) = raw[k]["utilization"].as_f64() {
                out.push(json!({ "kind": kind, "group": kind, "percent": u, "severity": severity(u),
                                 "resets_at": raw[k]["resets_at"], "is_active": false, "model": null }));
            }
        }
    }
    out
}

// ------------------------------------------------------------ Codex

pub fn codex_key(home: Option<&str>) -> String {
    format!("codex:{}", home.unwrap_or("~"))
}

/// One Codex login's rate limits (`home` None: the machine's own `~/.codex`).
#[nolog]
pub async fn codex(engine: &Engine, account: &str, home: Option<&str>, force: bool) -> Value {
    let key = codex_key(home);
    let Some(_guard) = engine.usage.reserve(&key) else { return engine.usage.busy_reading(&key) };
    codex_read(engine, account, home, force).await
}

#[nolog]
async fn codex_read(engine: &Engine, account: &str, home: Option<&str>, force: bool) -> Value {
    let rig_url = crate::rig::codex_usage_url();
    if let Some(v) = rig_url.is_none().then(|| crate::rig::usage("openai", home)).flatten() {
        if let Some(ms) = v["rig_delay_ms"].as_u64() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        engine.usage.put(&codex_key(home), &v);
        if crate::rig::canned_reading(&v) {
            crate::account_marks::profile_history(engine, "openai", home, Utc::now(), &v).await;
        }
        return v;
    }
    let key = codex_key(home);
    if !force {
        if let Some(v) = engine.usage.fresh(&key, TTL) {
            return v;
        }
    }
    let (_, email, _) = crate::providers::codex_identity(home.map(PathBuf::from).as_ref());
    let observed = Utc::now();
    // codex's own `/status` source over HTTPS: no codex process at all
    // (docket urgent-orgtree-s-hard-killing-of-codex-processes)
    let dir = home.map(PathBuf::from).unwrap_or_else(crate::providers::codex_default_home);
    let http = fetch_codex(&dir, rig_url.as_deref().unwrap_or(CODEX_USAGE_URL)).await;
    let fallback = match &http {
        Ok(_) => false,
        Err(why) => {
            tracing::info!(account, why = %why, "Codex usage over HTTPS unavailable");
            engine.usage.cooling(&appserver_key(&key)).is_none()
        }
    };
    let exe = if fallback {
        match engine.providers.codex_path() {
            Some(p) => Some(p),
            None => tokio::task::spawn_blocking(crate::providers::locate_codex).await.ok().flatten().map(|(p, _)| p),
        }
    } else {
        None
    };
    let mut out = match (http, exe) {
        (Ok(v), _) => v,
        (Err(why), None) if !fallback => json!({ "available": false, "error": NOT_YET,
            "detail": format!("{why}; the next read through the Codex app-server is at most every {} min",
                              APPSERVER_EVERY.as_secs() / 60) }),
        (Err(_), None) => json!({ "available": false, "error": "the Codex CLI is not installed", "reauth_evidence": "not_connected" }),
        (Err(_), Some(exe)) => {
            // the rare fallback: an app-server (ended gracefully), then none
            // for this login again until APPSERVER_EVERY has passed
            engine.usage.cooldown.pin().insert(appserver_key(&key), Instant::now() + APPSERVER_EVERY);
            appserver_reading(&exe, home).await
        }
    };
    out["account"] = json!(account);
    // 3.x parity: the host lane reads under its display name (codex_limits.py
    // "Codex"); a registered row keeps its id (`registered` overwrites it)
    out["provider"] = json!(CODEX_NAME);
    out["label"] = json!(email.clone().unwrap_or_else(|| "signed-in account".into()));
    out["email"] = json!(email);
    out["observed_at"] = json!(iso(Utc::now()));
    crate::account_marks::profile_usage(engine, "openai", home, observed, &out).await;
    if !out["available"].as_bool().unwrap_or(false) && out.get("reauth_required").is_none() {
        // a miss between app-server fallbacks: keep the last good bars (dated),
        // with why they are not fresh, as the Claude lane does
        if let Some(mut prev) = engine.usage.fresh(&key, Duration::MAX).filter(|p| p["available"].as_bool().unwrap_or(false)) {
            prev["error"] = out["error"].clone();
            prev["detail"] = out["detail"].clone();
            return prev;
        }
    }
    engine.usage.put(&key, &out);
    out
}

/// The fallback read: a short-lived app-server (`runtime::codex::probe`,
/// which ends it gracefully).
#[nolog]
async fn appserver_reading(exe: &Path, home: Option<&str>) -> Value {
    match crate::runtime::codex::probe(exe, home).await {
        Ok((account_doc, limits)) => {
            let mut v = codex_limits(&limits);
            if account_doc.is_null() {
                v["reauth_required"] = json!(true);
                v["reauth_evidence"] = json!("not_connected");
                v["error"] = json!("Codex is not signed in for this account");
            }
            v
        }
        Err(e) => json!({ "available": false, "error": NOT_YET, "detail": gist(&format!("{e:#}"), 300) }),
    }
}

/// Codex's rate limits as its own `/status` reads them (the endpoint and its
/// fields are the ones the installed codex.exe carries).
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// The app-server read is only the fallback, and at most this often per login.
const APPSERVER_EVERY: Duration = Duration::from_secs(30 * 60);

#[nolog]
fn appserver_key(key: &str) -> String {
    format!("appserver:{key}")
}

/// The ChatGPT sign-in a Codex home holds: (access token, account id).
/// `Ok(None)`: no auth.json at all (signed out). Not logged: it holds a token.
#[nolog]
fn codex_sign_in(dir: &Path) -> std::result::Result<Option<(String, Option<String>)>, String> {
    let Ok(bytes) = std::fs::read(dir.join("auth.json")) else { return Ok(None) };
    let doc: Value = serde_json::from_slice(&bytes).map_err(|_| "auth.json is not readable JSON".to_string())?;
    let tokens = doc.get("tokens").filter(|t| t.is_object())
        .ok_or_else(|| "this Codex login is an API key, which has no ChatGPT usage".to_string())?;
    let token = tokens.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty())
        .ok_or_else(|| "auth.json holds no access token".to_string())?;
    Ok(Some((token.to_string(), tokens.get("account_id").and_then(Value::as_str).map(str::to_string))))
}

/// One Codex home's usage over HTTPS, as `codex()` reports it. `Err`: no
/// answer that settles it (the caller may fall back to the app-server).
#[nolog]
async fn fetch_codex(dir: &Path, url: &str) -> std::result::Result<Value, String> {
    let (token, account_id) = match codex_sign_in(dir)? {
        Some(s) => s,
        None => return Ok(json!({ "available": false, "error": "Codex is not signed in for this account",
                                  "reauth_required": true, "reauth_evidence": "not_connected" })),
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(USER_AGENT).build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url).bearer_auth(&token).header("accept", "application/json");
    if let Some(id) = &account_id {
        req = req.header("ChatGPT-Account-Id", id);
    }
    let resp = req.send().await;
    drop(token);
    let resp = resp.map_err(|e| gist(&e.to_string(), 300))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    let raw: Value = serde_json::from_str(&body).map_err(|_| "the usage answer is not JSON".to_string())?;
    let v = codex_limits(&wham_rate_limits(&raw));
    if v["available"] != json!(true) {
        return Err("the usage answer carries no rate limits".into());
    }
    Ok(v)
}

/// `/wham/usage` in the app-server's `account/rateLimits/read` shape, so
/// `codex_limits` reads both: `rate_limit` is the main `codex` limit,
/// `additional_rate_limits[]` the per-feature ones.
#[nolog]
fn wham_rate_limits(raw: &Value) -> Value {
    let window = |w: &Value| if w.is_object() {
        json!({ "usedPercent": w["used_percent"].as_f64(),
                "windowDurationMins": w["limit_window_seconds"].as_i64().map(|s| s / 60),
                "resetsAt": w["reset_at"].as_i64() })
    } else {
        Value::Null
    };
    let c = &raw["credits"];
    let credits = if c.is_object() {
        let balance = match &c["balance"] {
            Value::Number(n) => json!(n.to_string()),
            other => other.clone(),
        };
        json!({ "hasCredits": c["has_credits"], "unlimited": c["unlimited"], "balance": balance })
    } else {
        Value::Null
    };
    let snapshot = |id: &str, name: Option<&str>, rl: &Value| json!({
        "limitId": id, "limitName": name, "planType": raw["plan_type"],
        "primary": window(&rl["primary_window"]), "secondary": window(&rl["secondary_window"]),
        "rateLimitReachedType": if rl["limit_reached"] == json!(true) || rl["allowed"] == json!(false) { json!("rate_limit") } else { Value::Null },
        "credits": credits,
    });
    let mut out = json!({});
    if raw["rate_limit"].is_object() {
        out["rateLimits"] = snapshot("codex", None, &raw["rate_limit"]);
    }
    let mut by = serde_json::Map::new();
    for extra in raw["additional_rate_limits"].as_array().into_iter().flatten() {
        let Some(id) = extra["metered_feature"].as_str().or_else(|| extra["limit_name"].as_str()) else { continue };
        if extra["rate_limit"].is_object() {
            by.insert(id.to_string(), snapshot(id, extra["limit_name"].as_str(), &extra["rate_limit"]));
        }
    }
    if !by.is_empty() {
        out["rateLimitsByLimitId"] = Value::Object(by);
    }
    out
}

fn duration_label(mins: Option<i64>) -> String {
    match mins {
        Some(m) if m > 0 && m % 1440 == 0 => format!("{} d", m / 1440),
        Some(m) if m > 0 && m % 60 == 0 => format!("{} h", m / 60),
        Some(m) if m > 0 => format!("{m} min"),
        _ => "window".into(),
    }
}

/// `account/rateLimits/read` as usage bars, plan and credits.
fn codex_limits(raw: &Value) -> Value {
    let mut snaps: Vec<&Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if raw["rateLimits"].is_object() {
        snaps.push(&raw["rateLimits"]);
        seen.push(raw["rateLimits"]["limitId"].as_str().unwrap_or("codex").to_string());
    }
    if let Some(by) = raw["rateLimitsByLimitId"].as_object() {
        for (k, v) in by {
            let id = v["limitId"].as_str().unwrap_or(k).to_string();
            if v.is_object() && !seen.contains(&id) {
                snaps.push(v);
                seen.push(id);
            }
        }
    }
    let mut limits = Vec::new();
    let mut plan: Option<String> = None;
    let mut credits = Value::Null;
    for s in snaps {
        let id = s["limitId"].as_str().unwrap_or("codex");
        let name = s["limitName"].as_str().map(str::trim).filter(|n| !n.is_empty());
        if plan.is_none() {
            plan = s["planType"].as_str().map(|p| {
                let p = p.replace('_', " ").replace("prolite", "pro lite");
                p.split(' ').map(|w| {
                    let mut c = w.chars();
                    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
                }).collect::<Vec<_>>().join(" ")
            });
        }
        let reached = !s["rateLimitReachedType"].is_null();
        for slot in ["primary", "secondary"] {
            let w = &s[slot];
            if !w.is_object() {
                continue;
            }
            let pct = w["usedPercent"].as_f64().unwrap_or(0.0).clamp(0.0, 100.0);
            let mins = w["windowDurationMins"].as_i64();
            let kind = match mins {
                Some(m) if m <= 360 => "session",
                Some(m) if m >= 6 * 1440 => if name.is_some() { "weekly_scoped" } else { "weekly_all" },
                _ => "codex_window",
            };
            limits.push(json!({
                "kind": kind, "group": id, "percent": w["usedPercent"].as_f64(), "severity": severity(pct),
                "resets_at": w["resetsAt"].as_i64().and_then(epoch_iso), "is_active": reached || pct >= 100.0,
                "model": name, "label": format!("{}{}", name.map(|n| format!("{n} · ")).unwrap_or_default(), duration_label(mins)),
            }));
        }
        let c = &s["credits"];
        if credits.is_null() && c["hasCredits"] == json!(true) {
            if c["unlimited"] == json!(true) {
                credits = json!({ "balance": null, "unit": "credits", "unlimited": true });
            } else if let Some(b) = c["balance"].as_str().and_then(|b| b.parse::<f64>().ok()).filter(|b| *b > 0.0) {
                credits = json!({ "balance": b, "unit": "credits", "unlimited": false });
            }
        }
    }
    let mut out = json!({ "available": !limits.is_empty(), "limits": limits, "plan": plan });
    if !credits.is_null() {
        out["credits"] = credits;
    }
    out
}

// ------------------------------------------------------------ Antigravity

/// Antigravity's own `/usage` (zero tokens, verified per run), for the machine's login.
#[nolog]
pub async fn antigravity(engine: &Engine, force: bool) -> Value {
    let Some(_guard) = engine.usage.reserve("agy") else { return engine.usage.busy_reading("agy") };
    antigravity_read(engine, force).await
}

#[nolog]
async fn antigravity_read(engine: &Engine, force: bool) -> Value {
    if let Some(v) = crate::rig::usage("google", None).filter(|_|
        !engine.cfg.data_root.join("agy-auth-metadata.json").is_file()) {
        // Isolated fixtures may exercise the same structured-result/log parser
        // as the zero-token CLI path. This branch is unreachable outside rig.
        let v = if let Some(raw) = v.get("rig_google_result") {
            let mut out = agy_result(raw, v["rig_google_log"].as_str().unwrap_or(""))
                .unwrap_or_else(|why| json!({"available":false,"error":NOT_YET,"detail":why}));
            out["observed_at"] = v["observed_at"].clone();
            out
        } else { v };
        engine.usage.put("agy", &v);
        if crate::rig::canned_reading(&v) {
            crate::account_marks::profile_history(engine, "google", None, Utc::now(), &v).await;
        }
        return v;
    }
    if force { crate::providers::agy_auth::user_recheck(engine); }
    if let Some(failure) = crate::providers::agy_auth::blocked(engine) {
        let out = failure.reading();
        record_agy_auth_failure(engine, out.clone());
        return out;
    }
    if !force {
        if let Some(v) = engine.usage.fresh("agy", TTL) {
            return v;
        }
    }
    let exe = match engine.providers.agy_path() {
        Some(p) => Some(p),
        None => tokio::task::spawn_blocking(crate::providers::locate_agy).await.ok().flatten().map(|(p, _)| p),
    };
    let observed = Utc::now();
    let mut out = match exe {
        None => json!({ "available": false, "error": "the Antigravity CLI is not installed", "reauth_evidence": "not_connected" }),
        Some(exe) => match agy_usage(engine, &exe).await {
            Ok(v) => v,
            Err(e) => json!({ "available": false, "error": NOT_YET, "detail": gist(&e, 300) }),
        },
    };
    out["account"] = json!("google/primary");
    out["provider"] = json!(AGY_NAME);
    match out["email"].as_str().map(str::to_string) {
        Some(email) => {
            out["label"] = json!(email);
            crate::providers::set_agy_email(engine, &email);
        }
        None => out["label"] = json!(if out["reauth_required"] == true { "signed out" } else { "Antigravity account" }),
    }
    out["observed_at"] = json!(iso(Utc::now()));
    crate::account_marks::profile_usage(engine, "google", None, observed, &out).await;
    engine.usage.put("agy", &out);
    out
}

#[nolog]
pub fn record_agy_auth_failure(engine: &Engine, mut reading: Value) {
    reading["observed_at"] = json!(iso(Utc::now()));
    reading["label"] = json!(if reading["reauth_required"] == true { "signed out" } else { "Antigravity account" });
    engine.usage.put("agy", &reading);
    publish(engine, "google", &reading);
}

#[nolog]
async fn agy_usage(engine: &Engine, exe: &Path) -> Result<Value, String> {
    // only builds verified to answer /usage without a model turn
    let version = {
        let mut cmd = tokio::process::Command::new(exe);
        cmd.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        crate::winproc::no_window(&mut cmd);
        let o = match crate::providers::agy_auth::checked_output(engine, exe, cmd, Duration::from_secs(20)).await {
            Ok(o) => o,
            Err(e) => return Ok(e.reading()),
        };
        String::from_utf8_lossy(&o.stdout).to_string()
    };
    let parts: Vec<u64> = version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .take(3)
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() < 3 || (parts[0], parts[1], parts[2]) < (1, 2, 0) {
        return Err(format!("this Antigravity build ({}) is not verified to read usage without a turn", version.trim()));
    }
    let dir = engine.cfg.path("diagnostics").join("agy-probe");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // a fresh log per probe: it names the account the CLI signed in as
    let log = dir.join("usage-probe.log");
    let _ = std::fs::remove_file(&log);
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--log-file")
        .arg(&log)
        .args(["--print", "/usage", "--output-format", "json", "--print-timeout", "20s"])
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    for (k, _) in std::env::vars() {
        if k.starts_with("ANTHROPIC_") || ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ORGTREE_V2_TOKEN", "ELECTRON_RUN_AS_NODE"].contains(&k.as_str()) {
            cmd.env_remove(&k);
        }
    }
    crate::winproc::no_window(&mut cmd);
    let o = match crate::providers::agy_auth::checked_output(engine, exe, cmd, Duration::from_secs(30)).await {
        Ok(o) => o,
        Err(e) => return Ok(e.reading()),
    };
    let stdout = String::from_utf8_lossy(&o.stdout);
    let result = stdout
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .find(|v| v.is_object())
        .ok_or_else(|| format!("no JSON result (exit {:?}): {}", o.status.code(), gist(&String::from_utf8_lossy(&o.stderr), 200)))?;
    let log_text = std::fs::read_to_string(&log).unwrap_or_default();
    agy_result(&result, &log_text)
}

/// Structured provider JSON and CLI logs can contain secrets in arbitrary
/// fields. Parse them without invocation-logging arguments or return values.
#[nolog]
fn agy_result(result: &Value, log: &str) -> Result<Value, String> {
    let r = if result["result"].is_object() { &result["result"] } else { result };
    if r["status"].as_str().map(|s| s.to_uppercase()) != Some("SUCCESS".into()) {
        return Err("Antigravity /usage did not report success".into());
    }
    let zero = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]
        .iter()
        .all(|k| r["usage"][*k].as_f64() == Some(0.0));
    if r["conversation_id"] != json!("") || r["num_turns"] != json!(0) || !zero {
        return Err("Antigravity /usage was not verified as a zero-token command".into());
    }
    let data = r.pointer("/command/data").filter(|_| r.pointer("/command/name") == Some(&json!("usage"))).ok_or("no structured /usage data")?;
    let mut limits = Vec::new();
    for g in data["groups"].as_array().cloned().unwrap_or_default() {
        let gname = g["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Antigravity models").to_string();
        for b in g["buckets"].as_array().cloned().unwrap_or_default() {
            let Some(rem) = b["remaining_fraction"].as_f64().filter(|r| (0.0..=1.0).contains(r)) else { continue };
            let pct = ((1.0 - rem) * 100.0 * 1e6).round() / 1e6;
            let raw = b["name"].as_str().unwrap_or("usage limit").trim();
            let label = raw.trim_end_matches(" limit remaining").trim_end_matches(" Limit Remaining").trim();
            let label = if label.is_empty() { "usage limit" } else { label };
            let kind = match b["window"].as_str().unwrap_or("").to_lowercase().as_str() {
                "5h" | "5hr" | "5-hour" | "five-hour" => "session",
                "weekly" | "week" | "7d" | "7-day" => "weekly_scoped",
                _ => "antigravity_window",
            };
            limits.push(json!({
                "kind": kind, "group": b["id"].as_str().unwrap_or(label), "percent": pct, "severity": severity(pct),
                "resets_at": b["reset_time"], "is_active": pct >= 100.0, "model": gname, "label": format!("{gname} · {label}"),
            }));
        }
    }
    let mut out = json!({ "available": !limits.is_empty(), "limits": limits });
    if let Some(t) = data["tier"].as_str().or_else(|| r["tier"].as_str()).filter(|t| !t.is_empty()) {
        out["tier"] = json!(t);
        out["plan"] = json!(t);
    }
    if let Some(email) = agy_log_email(log) {
        out["email"] = json!(email);
    }
    Ok(out)
}

/// The account an Antigravity CLI run signed in as, from its own log (as 3.x
/// read it): "authenticated successfully as <email>", or the auth result line.
#[nolog]
fn agy_log_email(log: &str) -> Option<String> {
    static RES: std::sync::LazyLock<[regex::Regex; 2]> = std::sync::LazyLock::new(|| {
        [
            regex::Regex::new(r"authenticated successfully as (\S+@\S+)").unwrap(),
            regex::Regex::new(r"(?i)applyAuthResult:\s*email=([^,\s]+)").unwrap(),
        ]
    });
    RES.iter()
        .find_map(|re| re.captures(log).map(|c| c[1].trim_end_matches(['.', ',', ';', ')']).to_string()))
        .filter(|e| e.contains('@'))
}

// ------------------------------------------------------------ Muse

/// `muse:<login root>`: the cache key of one Muse login (None: the user's own).
pub fn muse_key(root: Option<&str>) -> String {
    format!("muse:{}", root.unwrap_or("~"))
}

/// A managed Muse login is probed at most this often; its live sessions'
/// `usage/changed` keep it current in between.
const MUSE_PROBE_EVERY: Duration = Duration::from_secs(300);

/// Muse's usage document (`usage/read`'s `usage`, `usage/changed`'s params)
/// as usage bars: the rolling `window` (300 min measured on 1.4.6) and
/// `weekly`. A window Muse did not report is unknown, never zero; the
/// opaque `tier` id is not a plan name and is not shown. `observed_model`
/// is the model a live session ran when Muse reported it (None from a
/// metadata host): Muse does not say which models a window covers.
#[nolog]
pub fn muse_limits(raw: &Value, observed_model: Option<&str>) -> Value {
    let mut limits = Vec::new();
    for slot in ["window", "weekly"] {
        let w = &raw[slot];
        let Some(pct) = w["usedPercent"].as_f64().filter(|p| p.is_finite()) else { continue };
        let mins = w["windowDurationMins"].as_i64().filter(|m| *m > 0);
        let kind = if slot == "weekly" || mins.is_some_and(|m| m >= 6 * 1440) { "weekly_all" } else { "session" };
        limits.push(json!({
            "kind": kind, "group": slot, "percent": pct, "severity": severity(pct.clamp(0.0, 100.0)),
            "resets_at": w["resetsAtMs"].as_i64().and_then(|ms| epoch_iso(ms.div_euclid(1000))),
            "is_active": pct >= 100.0, "model": null, "observed_model": observed_model,
            "label": if slot == "weekly" { "weekly".to_string() } else { duration_label(mins) },
        }));
    }
    json!({ "available": !limits.is_empty(), "limits": limits })
}

/// Record one Muse usage observation of the login at `root` (a live
/// session's `usage/changed`, or a metadata host's cached `usage/read`),
/// dated by Muse's own `observedAtMs`. An undated or windowless document is
/// no reading. True when it became the lane's latest reading.
#[nolog]
pub async fn muse_observed(engine: &Engine, root: Option<&str>, raw: &Value, observed_model: Option<&str>) -> bool {
    let Some(observed) = raw["observedAtMs"].as_i64().and_then(DateTime::from_timestamp_millis) else { return false };
    let observed = observed.min(Utc::now());
    let mut out = muse_limits(raw, observed_model);
    if out["available"] != true {
        return false;
    }
    out["account"] = json!(crate::org_accounts::primary(crate::providers::catalog::MUSE));
    out["provider"] = json!(MUSE_NAME);
    if root.is_none() {
        let email = engine.providers.state.load().muse.email.clone();
        out["label"] = json!(email.clone().unwrap_or_else(|| "signed-in account".into()));
        out["email"] = json!(email);
    }
    out["observed_at"] = json!(iso(observed));
    if !engine.usage.put_observed(&muse_key(root), &out, observed) {
        return false;
    }
    crate::account_marks::profile_usage(engine, crate::providers::catalog::MUSE, root, observed, &out).await;
    true
}

/// What one metadata host said about the login at `root`: signed out, its
/// cached usage observation, or that Muse has observed none yet.
#[nolog]
pub async fn muse_probed(engine: &Engine, root: Option<&str>, probe: &crate::providers::muse_models::MuseProbe) {
    let key = muse_key(root);
    if probe.account_state.as_deref() == Some("loggedOut") {
        engine.usage.put(&key, &json!({ "available": false, "provider": MUSE_NAME,
            "error": "Muse Code is not signed in for this account", "reauth_required": true,
            "reauth_evidence": "not_connected", "observed_at": iso(Utc::now()) }));
        return;
    }
    let observed = match &probe.usage {
        Some(u) => muse_observed(engine, root, u, None).await,
        None => false,
    };
    if !observed && engine.usage.cached(&key).is_none() {
        engine.usage.put(&key, &json!({ "available": false, "provider": MUSE_NAME,
            "error": "Muse has not reported usage for this account yet; it reports usage after a turn" }));
    }
}

/// One Muse login's usage (`root` None: the user's own): the latest
/// observation, as Muse dated it. The user's own login is read by provider
/// discovery every 5 minutes (and at once when `force`); a managed login by
/// its own metadata host, at most every 5 minutes.
#[nolog]
pub async fn muse(engine: &Engine, account: &str, root: Option<&str>, force: bool) -> Value {
    let key = muse_key(root);
    let Some(_guard) = engine.usage.reserve(&key) else { return engine.usage.busy_reading(&key) };
    muse_read(engine, account, root, force).await
}

#[nolog]
async fn muse_read(engine: &Engine, account: &str, root: Option<&str>, force: bool) -> Value {
    let key = muse_key(root);
    // a rig run's canned reading stands in for Muse's; without one the rig's
    // fake host is read like the real one (its usage/read and usage/changed)
    if let Some(v) = crate::rig::usage("muse", root).filter(crate::rig::canned_reading) {
        engine.usage.put(&key, &v);
        crate::account_marks::profile_history(engine, crate::providers::catalog::MUSE, root, Utc::now(), &v).await;
        return v;
    }
    let probe_key = format!("probe:{key}");
    if force || engine.usage.cooling(&probe_key).is_none() {
        match root {
            None if force => crate::providers::refresh_muse(engine).await,
            None => {}
            Some(dir) => {
                engine.usage.cooldown.pin().insert(probe_key, Instant::now() + MUSE_PROBE_EVERY);
                match crate::providers::muse_probe_login(engine, Some(dir)).await {
                    Ok(probe) => {
                        // the same read says what this login offers (placement checks)
                        crate::providers::muse_login_seen(engine, account, Ok(&probe));
                        muse_probed(engine, root, &probe).await
                    }
                    Err(e) => {
                        crate::providers::muse_login_seen(engine, account, Err(gist(&format!("{e:#}"), 200)));
                        tracing::info!(account, error = %gist(&format!("{e:#}"), 200), "Muse usage probe failed")
                    }
                }
            }
        }
    }
    let mut out = engine.usage.cached(&key)
        .unwrap_or_else(|| json!({ "available": false, "provider": MUSE_NAME, "error": NOT_YET }));
    out["account"] = json!(account);
    out
}

/// Push the user's own Muse lane as it stands (after a live observation).
#[logged]
pub fn muse_publish(engine: &Engine) {
    if let Some(v) = engine.usage.cached(&muse_key(None)) {
        publish(engine, crate::providers::catalog::MUSE, &v);
    }
}

// ------------------------------------------------------------ OpenRouter

/// Read every stored OpenRouter key again and push them: the original
/// key's usage as before (`openrouter_usage`), every key's by lane
/// (`openrouter_keys_usage`), and the panel's document, whose `connected` is
/// the original key's check. The usage loop does this every 5 minutes; a
/// refused turn at once.
#[logged]
pub async fn refresh_openrouter(engine: &Engine, force: bool) {
    let mut by_lane = serde_json::Map::new();
    for a in crate::openrouter::keys(engine) {
        let v = openrouter_key_usage(engine, &a.id, force).await;
        if a.id == crate::openrouter::ACCOUNT_ID {
            publish(engine, "openrouter", &v);
        }
        let mut named = v;
        named["name"] = json!(crate::openrouter::display(engine, &a));
        by_lane.insert(crate::openrouter::lane(&a.id), named);
    }
    engine.app.set_value("openrouter_keys_usage", Value::Object(by_lane));
    crate::openrouter::publish(engine).await;
}

/// The original OpenRouter key's credit standing (`GET /api/v1/key`). Not
/// logged: a reading can carry the provider's own error text
/// (`openrouter_key_usage` logs a safe summary).
#[nolog]
pub async fn openrouter(engine: &Engine, force: bool) -> Value {
    openrouter_key_usage(engine, crate::openrouter::ACCOUNT_ID, force).await
}

/// One OpenRouter key's last cached reading, by its lane (`openrouter` for
/// the original key, the id of an added one). Never a fetch.
#[nolog]
pub fn openrouter_reading(engine: &Engine, lane: &str) -> Option<Value> {
    engine.usage.cache.pin().get(lane).map(|c| c.data.clone())
}

/// One OpenRouter key's credit standing, cached and recorded under its lane
/// (the original key's as before several keys: `openrouter`). The public
/// reader; `openrouter_key_read` is the read itself (a probe reservation
/// per lane wraps it here, not there). Not logged: a reading can carry the
/// provider's own error text; one safe line says what came back.
#[nolog]
pub async fn openrouter_key_usage(engine: &Engine, id: &str, force: bool) -> Value {
    let lane = crate::openrouter::lane(id);
    let Some(_guard) = engine.usage.reserve(&lane) else { return engine.usage.busy_reading(&lane) };
    let v = openrouter_key_read(engine, id, force).await;
    tracing::info!(lane = %lane, available = v["available"] == json!(true), error = v["error"].is_string(),
                   detail = v["detail"].is_string(), reauth = v["reauth_required"] == json!(true), "OpenRouter key usage read");
    v
}

/// How often one read tries again when the key it read with was replaced
/// before the answer came back.
const OPENROUTER_REPLACED_RETRIES: usize = 2;

#[nolog]
async fn openrouter_key_read(engine: &Engine, id: &str, force: bool) -> Value {
    let lane = crate::openrouter::lane(id);
    // rig mode: a canned reading stands in for the check, cache included;
    // without one the key check below is the rig's canned one too (never the
    // network), so a rig proof reads each key through the real derivation
    if let Some(v) = crate::rig::usage(&lane, None).filter(crate::rig::canned_reading) {
        engine.usage.put(&lane, &v);
        return v;
    }
    if !force {
        if let Some(v) = engine.usage.fresh(&lane, Duration::from_secs(60)) {
            return v;
        }
    }
    // the key and its replacement generation are read together, and the
    // generation again once the answer is in: an answer for a key replaced
    // (or removed) meanwhile describes a credential no longer stored, so it
    // is never cached or recorded; the read starts over on the new key
    let mut attempt = 0;
    let (observed, mut out) = loop {
        let observed = Utc::now();
        let Some((key, generation)) = crate::openrouter::key_with_generation(engine, id).await else {
            break (observed, json!({ "available": false, "error": "no API key — add one in App settings › Providers",
                                     "reauth_evidence": "not_connected" }));
        };
        let out = match openrouter_fetch(&lane, &key).await {
            Ok(v) => v,
            Err(e) => json!({ "available": false, "error": "OpenRouter usage check failed", "detail": gist(&e, 300) }),
        };
        drop(key);
        if crate::openrouter::generation(engine, id).await == Some(generation) {
            break (observed, out);
        }
        attempt += 1;
        if attempt > OPENROUTER_REPLACED_RETRIES {
            tracing::info!(lane = %lane, "OpenRouter key replaced during every read; nothing recorded");
            return json!({ "available": false, "account": lane, "key_id": id, "provider": "OpenRouter",
                           "error": "the key was replaced while it was being read; read again" });
        }
        tracing::info!(lane = %lane, attempt, "OpenRouter key replaced during the read; reading the stored key again");
    };
    out["account"] = json!(lane);
    out["key_id"] = json!(id);
    out["provider"] = json!("OpenRouter");
    if out.get("label").and_then(Value::as_str).is_none() {
        out["label"] = json!("OpenRouter API key");
    }
    out["observed_at"] = json!(iso(Utc::now()));
    crate::usage_history::record(engine, &lane, "openrouter", observed, &out).await;
    engine.usage.put(&lane, &out);
    out
}

async fn openrouter_fetch(lane: &str, key: &str) -> Result<Value, String> {
    match crate::openrouter::key_standing(lane, key).await {
        Err((true, e)) => Ok(json!({ "available": false, "error": e, "reauth_required": true, "reauth_evidence": "measured_403" })),
        Err((false, e)) => Err(e),
        Ok(ks) => {
            let own = ks.get("label").and_then(Value::as_str).filter(|s| !s.is_empty());
            let label = own.unwrap_or("OpenRouter API key");
            let mut out = json!({ "available": true, "label": label, "key_label": own, "limits": openrouter_limits(&ks) });
            if ks.get("is_free_tier") == Some(&json!(true)) {
                out["plan"] = json!("free tier");
            }
            Ok(out)
        }
    }
}

/// OpenRouter's one usage row, as 3.x derived it. A prepaid credit balance
/// has no rolling window, so no reset time is ever invented: with a spend
/// cap on the key the row is spend ÷ cap; without one it states the credits
/// used and the remaining balance; with neither, what the key reports.
#[nolog]
fn openrouter_limits(ks: &serde_json::Map<String, Value>) -> Vec<Value> {
    let f = |k: &str| ks.get(k).and_then(Value::as_f64).filter(|x| x.is_finite());
    let Some(usage) = f("usage") else { return Vec::new() };
    let balance = match (f("total_credits"), f("total_usage")) {
        (Some(t), Some(u)) => Some((t - u).max(0.0)),
        _ => None,
    };
    let row = |percent: Option<f64>, severity: &str, active: bool, label: String| {
        json!({ "kind": "usage", "group": "credits", "percent": percent, "severity": severity, "resets_at": null,
                "is_active": active, "model": null, "label": label, "amount": usage, "unit": "USD" })
    };
    if let Some(limit) = f("limit").filter(|l| *l > 0.0) {
        let percent = (usage / limit * 100.0).clamp(0.0, 100.0);
        let mut label = format!("${usage:.2} of ${limit:.2} spend cap");
        if let Some(b) = balance {
            // the prepaid balance is the OpenRouter account's, shared by
            // every key of it (ruling 2026-10-11: say so on each key's row)
            label.push_str(&format!(" · ${b:.2} account balance"));
        } else if let Some(rem) = f("limit_remaining") {
            label.push_str(&format!(" · ${rem:.2} remaining"));
        }
        if let Some(cadence) = ks.get("limit_reset").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) {
            label.push_str(&format!(" · renews {cadence}"));
        }
        let active = percent >= 100.0 || balance.map(|b| b <= 0.0).unwrap_or(false);
        return vec![row(Some(percent), if active { "critical" } else { severity(percent) }, active, label)];
    }
    if let Some(b) = balance {
        let active = b <= 0.0;
        let sev = if active { "critical" } else if b <= 1.0 { "warning" } else { "normal" };
        return vec![row(None, sev, active, format!("${usage:.2} credits used · ${b:.2} account balance"))];
    }
    vec![row(None, "normal", false, format!("${usage:.2} spent · no spend cap"))]
}

// ------------------------------------------------------------ API-key accounts

/// A metered key account's spend so far (local metering is the figure).
#[logged]
pub async fn apikey_spend(engine: &Engine, account: &str) -> Value {
    let key = format!("apikey:{account}");
    let Some(_guard) = engine.usage.reserve(&key) else { return engine.usage.busy_reading(&key) };
    apikey_spend_read(engine, account).await
}

#[logged]
async fn apikey_spend_read(engine: &Engine, account: &str) -> Value {
    let row = match engine.db.get().await {
        Ok(c) => c.query_opt(
                "SELECT usd_total::float8, turns, extract(epoch FROM since)::float8, extract(epoch FROM updated_at)::float8
                   FROM ot.account_spend WHERE account = $1",
                &[&account],
            )
            .await.map_err(|_| ()),
        Err(_) => Err(()),
    };
    let mut out = match row {
        Ok(Some(r)) => json!({ "available": true, "mode": "apikey", "currency": "USD", "limits": [],
            "spend": { "usd_total": r.get::<_, f64>(0), "turns": r.get::<_, i32>(1),
                           "since": r.get::<_, Option<f64>>(2).map(|x| x as i64), "updated_at": r.get::<_, Option<f64>>(3).map(|x| x as i64) } }),
        Ok(None) => json!({"available":false,"mode":"apikey","reason":"no_recorded_spend","limits":[]}),
        Err(()) => json!({"available":false,"mode":"apikey","reason":"failed","limits":[]}),
    };
    out["observed_at"] = json!(iso(Utc::now()));
    engine.usage.put(&format!("apikey:{account}"), &out);
    out
}

/// Refresh under a permit already obtained by the tool. Public readers take
/// this same reservation; calling the inner reader avoids reacquiring it.
#[logged]
pub async fn refresh_permitted(engine: &Engine, provider: &str, account: &str, folder: Option<&str>, apikey: bool) -> bool {
    // Preserve registered()'s rehearsal isolation: an imported scratch row
    // cannot make this path open another data root's sign-in.
    if crate::mailhub::safe_start() && folder.is_some_and(|dir| {
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        !canon(Path::new(dir)).starts_with(canon(&engine.cfg.data_root))
    }) {
        return false;
    }
    let out = if apikey { apikey_spend_read(engine, account).await } else {
        match provider {
            "claude" => claude_read(engine, folder, false).await,
            "openai" => codex_read(engine, account, folder, false).await,
            "google" => antigravity_read(engine, false).await,
            // a key row's id, or the original key's lane
            "openrouter" => openrouter_key_read(engine, &crate::openrouter::id_of_lane(account), false).await,
            "muse" => muse_read(engine, account, folder, true).await,
            _ => return false,
        }
    };
    // Match existing successful-probe history behavior, no transaction spans
    // provider I/O. Primary readers record their own history already.
    if apikey {
        crate::usage_history::record(engine, account, provider, Utc::now(), &out).await;
    }
    out["available"] == true && out["error"].is_null()
        && out["reauth_required"] != true && out["reauth_evidence"] != "not_connected"
}

// ------------------------------------------------------------ what the windows read

/// One registry account's readout and standing (`registered_usage[id]`).
#[nolog]
pub async fn registered(engine: &Engine, a: &crate::accounts::AccountInfo, force: bool) -> Value {
    // a scratch copy's accounts can name another data folder's sign-ins (the
    // live install's): a safe-start engine never reads or refreshes those
    let foreign = a.config_dir.as_deref().map(|d| {
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        !canon(Path::new(d)).starts_with(canon(&engine.cfg.data_root))
    });
    if crate::mailhub::safe_start() && foreign == Some(true) {
        return json!({ "available": false, "account": a.id, "provider": a.provider, "label": a.display(),
                       "error": "not read in safe start: this account's sign-in belongs to another data folder" });
    }
    let mut u = if a.provider == crate::providers::catalog::OPENROUTER {
        openrouter_key_usage(engine, &a.id, force).await
    } else if a.is_apikey() {
        let spend = apikey_spend(engine, &a.id).await;
        crate::usage_history::record(engine, &a.id, &a.provider, Utc::now(), &spend).await;
        spend
    } else {
        match a.provider.as_str() {
            "claude" => claude(engine, a.config_dir.as_deref(), force).await,
            "openai" => codex(engine, &a.id, a.config_dir.as_deref(), force).await,
            "google" => antigravity(engine, force).await,
            "muse" => muse(engine, &a.id, a.config_dir.as_deref(), force).await,
            _ => json!({ "available": false }),
        }
    };
    let view = engine.accounts.view();
    let row = crate::accounts::row(view.get(&a.id).unwrap_or(a), Vec::new(), chrono::Utc::now());
    u["account"] = json!(a.id);
    u["label"] = json!(a.display());
    u["provider"] = json!(a.provider);
    u["standing"] = row["standing"].clone();
    u["enabled"] = json!(a.enabled);
    u
}

/// Push a lane's readout and its cache-only peek to every window.
#[nolog]
pub fn publish(engine: &Engine, lane: &str, value: &Value) {
    let (key, peek_key, cache, provider) = match lane {
        "claude" => ("usage", "usage_peek", claude_key(None), "claude"),
        "openai" => ("codex_usage", "codex_usage_peek", codex_key(None), "openai"),
        "google" => ("antigravity_usage", "antigravity_usage_peek", "agy".to_string(), "google"),
        "openrouter" => ("openrouter_usage", "openrouter_usage_peek", "openrouter".to_string(), "openrouter"),
        "muse" => ("muse_usage", "muse_usage_peek", muse_key(None), "muse"),
        _ => return,
    };
    engine.app.set_value(key, value.clone());
    engine.app.set_value(peek_key, engine.usage.peek(&cache, provider));
}

/// How often a lane is read (3.x parity, supervisor `_warm_interval` plus the
/// modal's 60 s poll): paced by how close the lane is to a wall, 5 min under
/// 80 %, 2 min from 80 %, 45 s from 95 %; and a minute at most while a window
/// is open, because the windows read the pushed values and nothing else.
/// `idle_cap` keeps 4.x's own idle cadence where it was already faster (Claude 2 min).
#[nolog]
fn lane_every(pressure: f64, window_open: bool, idle_cap: u64) -> u64 {
    let paced = if pressure >= 95.0 { 45 } else if pressure >= 80.0 { 120 } else { 300 }.min(idle_cap);
    if window_open { paced.min(60) } else { paced }
}

/// The lane's cached readout: its highest used percent, and whether a window
/// it showed has already reset (a reset five seconds past, 3.x `RESET_LAG`).
#[nolog]
fn lane_state(engine: &Engine, key: &str) -> (f64, bool) {
    let pin = engine.usage.cache.pin();
    let Some(c) = pin.get(key) else { return (0.0, false) };
    let now = Utc::now();
    let limits = c.data["limits"].as_array().cloned().unwrap_or_default();
    let pressure = limits.iter().filter_map(|l| l["percent"].as_f64()).fold(0.0, f64::max);
    let passed = limits.iter().any(|l| {
        l["resets_at"].as_str().and_then(crate::util::parse_ts).is_some_and(|t| t + chrono::Duration::seconds(5) <= now)
    });
    (pressure, passed)
}

/// Is this lane due? Its cadence has run out, or a window it showed reset and
/// the readout has not caught up: re-ask every 10 s, at most four times in a
/// row (3.x `WARM_MIN_SLEEP` / `RESET_RECHECKS`), then fall back to the cadence.
#[nolog]
fn lane_due(engine: &Engine, last: &mut std::collections::HashMap<&'static str, Instant>,
            misses: &mut std::collections::HashMap<&'static str, u8>, lane: &'static str, key: &str, idle_cap: u64) -> bool {
    let (pressure, passed) = lane_state(engine, key);
    let every = lane_every(pressure, crate::appfeed::windows_open() > 0, idle_cap);
    let since = last.get(lane).map(|t| t.elapsed());
    let Some(since) = since else { return true };
    if since >= Duration::from_secs(every) {
        misses.insert(lane, 0);
        return true;
    }
    let m = misses.get(lane).copied().unwrap_or(0);
    if passed && m < 4 && since >= Duration::from_secs(10) {
        misses.insert(lane, m + 1);
        return true;
    }
    if !passed {
        misses.insert(lane, 0);
    }
    false
}

/// Keep the usage the windows show fresh: the four provider lanes, their
/// peeks (the usage button's glow) and every registered account. The
/// windows never poll; they read these pushed values.
#[logged]
pub fn start(engine: &std::sync::Arc<Engine>) {
    let eng = engine.clone();
    tokio::spawn(async move {
        let mut last: std::collections::HashMap<&'static str, Instant> = std::collections::HashMap::new();
        let mut misses: std::collections::HashMap<&'static str, u8> = std::collections::HashMap::new();
        tokio::time::sleep(Duration::from_secs(if crate::rig::active() { 1 } else { 5 })).await;
        loop {
            publish_due(&eng, &mut last, &mut misses).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                _ = eng.shutdown.cancelled() => break,
            }
        }
    });
}

#[logged]
async fn publish_due(engine: &std::sync::Arc<Engine>, last: &mut std::collections::HashMap<&'static str, Instant>,
                     misses: &mut std::collections::HashMap<&'static str, u8>) {
    // a rig engine reads only the canned readings: the three lanes, nothing else
    let rig = crate::rig::active();
    let due = |last: &std::collections::HashMap<&'static str, Instant>, k: &str, every: u64| {
        last.get(k).map(|t| t.elapsed() >= Duration::from_secs(every)).unwrap_or(true)
    };
    let st = engine.providers.state.load_full();
    if (rig || st.claude.installed) && lane_due(engine, last, misses, "claude", &claude_key(None), 120) {
        let v = claude(engine, None, false).await;
        publish(engine, "claude", &v);
        last.insert("claude", Instant::now());
    }
    if (rig || st.codex.installed) && lane_due(engine, last, misses, "openai", &codex_key(None), 300) {
        let v = codex(engine, "openai/primary", None, false).await;
        publish(engine, "openai", &v);
        last.insert("openai", Instant::now());
    }
    let agy_changed = st.agy.installed && crate::providers::agy_auth::changed(engine);
    if (rig || st.agy.installed) && (agy_changed || lane_due(engine, last, misses, "google", "agy", 300)) {
        let before = engine.usage.peek("agy", "google");
        let signed_out_before = engine.usage.cached_reauth_required("agy") == Some(true);
        let v = antigravity(engine, agy_changed).await;
        publish(engine, "google", &v);
        // A known full group becoming usable releases mail held at the turn gate.
        let recovered = before["limits"].as_array().is_some_and(|old| old.iter().any(|b| {
            b["percent"].as_f64().is_some_and(|p| p >= 100.0)
                && v["limits"].as_array().is_some_and(|new| new.iter().any(|n| {
                    n["group"] == b["group"] && n["percent"].as_f64().is_some_and(|p| p < 100.0)
                }))
        }));
        if recovered || ((signed_out_before || before["available"] != true) && v["available"] == true) {
            crate::accounts::wake_waiting(engine, crate::accounts::Waiting::Native("google".into())).await;
        }
        last.insert("google", Instant::now());
    }
    if (rig || st.muse.installed) && lane_due(engine, last, misses, "muse", &muse_key(None), 300) {
        // the cache as it stands: discovery and live sessions feed it
        let v = muse(engine, "muse/primary", None, false).await;
        publish(engine, "muse", &v);
        last.insert("muse", Instant::now());
    }
    if rig {
        return;
    }
    let open_every = if crate::appfeed::windows_open() > 0 { 60 } else { 300 };
    if due(last, "openrouter", open_every) {
        refresh_openrouter(engine, false).await;
        last.insert("openrouter", Instant::now());
    }
    if due(last, "usage_history_prune", 3600) {
        crate::usage_history::prune(engine).await;
        crate::account_marks::prune(engine).await;
        last.insert("usage_history_prune", Instant::now());
    }
    if due(last, "registered", open_every) {
        let view = engine.accounts.view();
        let accounts: Vec<crate::accounts::AccountInfo> =
            view.all().into_iter().filter(|a| a.provider != "openrouter" && !crate::accounts::is_ambient(a)).cloned().collect();
        drop(view);
        let mut map = serde_json::Map::new();
        for a in &accounts {
            map.insert(a.id.clone(), registered(engine, a, false).await);
        }
        engine.app.set_value("registered_usage", Value::Object(map));
        last.insert("registered", Instant::now());
    }
}

// ------------------------------------------------------------ the turn's usage board

/// a reading older than this is a memory, not a measurement (3.x MAX_EVIDENCE_AGE)
const BOARD_FRESH: Duration = Duration::from_secs(900);

#[nolog]
fn countdown(secs: i64) -> String {
    let s = secs.max(0);
    let (d, h, m) = (s / 86_400, (s % 86_400) / 3600, (s % 3600) / 60);
    if d > 0 {
        format!("{d}d{h}h")
    } else if h > 0 {
        format!("{h}h{m}m")
    } else {
        format!("{m}m")
    }
}

/// The PROVIDER USAGE block a turn starts with (as in 3.x): every account's
/// cached usage windows, the agent's own account starred, and which account
/// its turns draw on. Cache-only: it never fetches. Returns the text and a
/// key of what changed materially (the readings' ages left out), so an
/// unchanged board can be sent as one line.
#[nolog]
pub fn turn_board(engine: &Engine, provider: &str, account: Option<&str>, tier: &str, org_slug: &str) -> (String, String) {
    let now = Utc::now();
    let view = engine.accounts.view();
    let pin = engine.usage.cache.pin();
    let own = account.and_then(|a| view.get(a)).filter(|a| !crate::accounts::is_ambient(a)).map(|a| a.id.clone());
    let selected_lane = match (provider, &own) {
        // an OpenRouter seat's lane is its key's (the original: `openrouter`)
        ("openrouter", _) => crate::openrouter::lane(&crate::openrouter::seat_key(engine, account)),
        (_, Some(id)) => id.clone(),
        ("openai", None) => "openai/primary".into(),
        ("google", None) => "google/primary".into(),
        ("muse", None) => "muse/primary".into(),
        ("langserver", _) => crate::langserver::route_of(engine, tier)
            .map(|(s, _)| format!("langserver:{}", s["id"].as_str().unwrap_or("")))
            .unwrap_or_else(|| "langserver".into()),
        _ => "claude/primary".into(),
    };
    // (lane name, cache key, email)
    let mut lanes: Vec<(String, String, Option<String>)> = vec![("claude/primary".into(), claude_key(None), None)];
    // another org's legacy org keys are not this agent's lanes (3.x list_accounts(org))
    let registered: Vec<_> = view.all().into_iter().filter(|a| a.available_to(Some(org_slug))).collect();
    for a in registered.iter().filter(|a| a.provider == "claude" && !a.is_apikey() && !crate::accounts::is_ambient(a)) {
        lanes.push((a.id.clone(), claude_key(a.config_dir.as_deref()), a.email.clone()));
    }
    lanes.push(("openai/primary".into(), codex_key(None), None));
    for a in registered.iter().filter(|a| a.provider == "openai" && !a.is_apikey() && !crate::accounts::is_ambient(a)) {
        lanes.push((a.id.clone(), codex_key(a.config_dir.as_deref()), a.email.clone()));
    }
    lanes.push(("google/primary".into(), "agy".into(), None));
    if engine.providers.state.load().muse.installed || pin.get(&muse_key(None)).is_some() {
        lanes.push(("muse/primary".into(), muse_key(None), None));
    }
    for a in registered.iter().filter(|a| a.provider == "muse" && !a.is_apikey() && !crate::accounts::is_ambient(a)) {
        lanes.push((a.id.clone(), muse_key(a.config_dir.as_deref()), a.email.clone()));
    }
    // every OpenRouter key this org may see, by its lane (its cache key too)
    for a in registered.iter().filter(|a| a.provider == "openrouter") {
        let lane = crate::openrouter::lane(&a.id);
        lanes.push((lane.clone(), lane, None));
    }
    // only the accounts this org may use: an agent never plans onto one it
    // switched off (Org settings › Accounts)
    lanes.retain(|(lane, _, _)| crate::org_accounts::allowed(Some(org_slug), lane));
    let mut lines: Vec<String> = Vec::new();
    let mut key_lines: Vec<String> = Vec::new();
    let mut roster: Vec<String> = Vec::new();
    for (lane, key, email) in &lanes {
        let star = if *lane == selected_lane { "*" } else { "" };
        let Some(c) = pin.get(key) else {
            if star == "*" {
                lines.push(format!("{lane}{star} | usage | - | - | - | - | not read yet"));
                key_lines.push(format!("{lane}|none"));
            }
            continue;
        };
        let email = email.clone().or_else(|| c.data["email"].as_str().map(str::to_string));
        roster.push(match &email {
            Some(e) => format!("{lane} ({e})"),
            None => lane.clone(),
        });
        let age = c.at.elapsed();
        let observed = format!(
            "{} ({}, {})",
            iso(now - chrono::Duration::from_std(age).unwrap_or_default()),
            countdown(age.as_secs() as i64),
            if age < BOARD_FRESH { "fresh" } else { "stale" }
        );
        let lane_account = view.get(lane).or_else(|| {
            if lane == "google/primary" {
                registered.iter().copied().find(|a| a.provider == "google" && crate::accounts::is_ambient(a))
            } else { None }
        });
        if !c.data["available"].as_bool().unwrap_or(false) {
            let why = c.data["error"].as_str().map(|e| gist(e, 60)).unwrap_or_else(|| "no reading".into());
            lines.push(format!("{lane}{star} | usage | - | - | - | {observed} | unavailable ({why})"));
            key_lines.push(format!("{lane}|unavailable"));
            continue;
        }
        for l in c.data["limits"].as_array().cloned().unwrap_or_default() {
            let marked = lane_account.and_then(|a| {
                match (a.provider.as_str(), l["group"].as_str().unwrap_or("")) {
                    ("google", "3p-5h" | "3p-weekly") => a.limited_for("agy-sonnet", now),
                    ("google", "gemini-5h" | "gemini-weekly") => a.limited_for("flash", now),
                    _ => a.limited(now),
                }
            }).is_some();
            // the provider's own window name where it gives one
            let window = match (l["label"].as_str().filter(|s| !s.trim().is_empty()), l["kind"].as_str().unwrap_or("usage")) {
                (Some(label), _) => gist(label, 48),
                (None, "session") => "session".to_string(),
                (None, "weekly_all") => "weekly".to_string(),
                (None, k) => k.replace('_', " "),
            };
            let pct = l["percent"].as_f64();
            let used = pct.map(|p| format!("{}%", p.round() as i64)).unwrap_or_else(|| "-".into());
            let amount = if pct.is_none() { l["label"].as_str().map(|s| gist(s, 60)).unwrap_or_else(|| "-".into()) } else { "-".into() };
            let reset = match l["resets_at"].as_str().and_then(crate::util::parse_ts) {
                Some(t) => format!("{} (in {})", iso(t), countdown((t - now).num_seconds())),
                None => "-".into(),
            };
            // a window with a percentage is spent at 100%; one without (a prepaid
            // balance) says so itself
            let spent = match pct {
                Some(p) => p >= 100.0,
                None => l["is_active"].as_bool().unwrap_or(false),
            };
            let state = if spent {
                "limited"
            } else if marked {
                "limited (marked)"
            } else {
                "ok"
            };
            lines.push(format!("{lane}{star} | {window} | {used} | {amount} | {reset} | {observed} | {state}"));
            // the material part: a 5% band and the reset hour, never the reading's age
            let band = pct.map(|p| ((p / 5.0).floor() * 5.0) as i64).map(|b| b.to_string()).unwrap_or_else(|| "-".into());
            let hour = l["resets_at"].as_str().map(|r| r.chars().take(13).collect::<String>()).unwrap_or_default();
            key_lines.push(format!("{lane}|{window}|{band}|{hour}|{state}"));
        }
    }
    // an OpenRouter key is listed above under its lane, not again here
    for a in registered.iter().filter(|a| a.is_apikey() && a.provider != "openrouter") {
        roster.push(format!("{} (API key, metered)", a.id));
    }
    // the user's own model servers: no usage window, only an agents-at-once cap
    for srv in crate::langserver::servers(engine).iter().filter(|s| s["enabled"].as_bool() != Some(false)) {
        let lane = format!("langserver:{}", srv["id"].as_str().unwrap_or(""));
        if !crate::org_accounts::allowed(Some(org_slug), &lane) {
            continue;
        }
        let star = if lane == selected_lane { "*" } else { "" };
        let cap = srv["max_agents"].as_i64().unwrap_or(1);
        roster.push(format!("{lane} ({}, local)", gist(srv["label"].as_str().unwrap_or(""), 40)));
        lines.push(format!("{lane}{star} | local | - | - | - | - | no limit; {cap} agent(s) at once"));
        key_lines.push(format!("{lane}|local|{cap}"));
    }
    let header = format!("[PROVIDER USAGE — current as of {}; dynamic/cache-only]", iso(now));
    let mut text = header;
    if !roster.is_empty() {
        text.push_str(&format!("\n[ACCOUNTS] {}", roster.join(" · ")));
    }
    text.push_str("\naccount | window | used | amount | reset (countdown) | observed (age,freshness) | state");
    for l in &lines {
        text.push('\n');
        text.push_str(l);
    }
    text.push_str("\n* your account for this turn; - = not authoritatively reported.");
    if provider == crate::providers::catalog::LANGSERVER {
        text.push_str(&format!(
            "
Your turns run on {selected_lane} (tier {tier}): the user's own model server. It has no usage limit; it runs a set number of agents at once and the others wait."
        ));
    } else if provider == crate::providers::catalog::MUSE {
        text.push_str(&format!("\nYour turns run on {selected_lane} (tier {tier}) and draw on its windows above; Muse reports one window set per account and does not say which models share it."));
    } else if provider == crate::providers::catalog::GOOGLE {
        let pool = crate::providers::catalog::antigravity_pool(tier);
        text.push_str(&format!("\nThis turn spends: {tier} on {selected_lane} → session:{pool}-5h and weekly_scoped:{pool}-weekly. Other model groups' windows do not apply to this tier."));
    } else {
        text.push_str(&format!("\nYour turns run on {selected_lane} (tier {tier}) and draw on its windows above."));
    }
    text.push_str("\n[END PROVIDER USAGE]");
    let key = format!("{selected_lane}\n{tier}\n{}\n{}", roster.join("|"), key_lines.join("\n"));
    (text, key)
}

#[cfg(test)]
mod wham_tests {
    use super::{codex_limits, wham_rate_limits};
    use serde_json::json;

    /// `/wham/usage` (the fields the installed codex.exe reads) reaches the
    /// same bars, plan and credits the app-server's shape did.
    #[test]
    fn wham_usage_reads_like_the_app_server() {
        let raw = json!({
            "plan_type": "prolite",
            "rate_limit": { "allowed": true, "limit_reached": false,
                "primary_window": { "used_percent": 12, "limit_window_seconds": 18000, "reset_after_seconds": 600, "reset_at": 1_900_000_000 },
                "secondary_window": { "used_percent": 92.5, "limit_window_seconds": 604800, "reset_after_seconds": 9000, "reset_at": 1_900_500_000 } },
            "credits": { "has_credits": true, "unlimited": false, "balance": 7 },
            "additional_rate_limits": [ { "limit_name": "GPT-5 Codex Spark", "metered_feature": "codex_spark",
                "rate_limit": { "allowed": true, "limit_reached": true,
                    "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": 1_900_600_000 } } } ],
        });
        let v = codex_limits(&wham_rate_limits(&raw));
        assert_eq!(v["available"], json!(true));
        assert_eq!(v["plan"], json!("Pro Lite"));
        assert_eq!(v["credits"]["balance"], json!(7.0));
        let limits = v["limits"].as_array().unwrap();
        assert_eq!(limits.len(), 3);
        assert_eq!((limits[0]["kind"].as_str(), limits[0]["percent"].as_f64()), (Some("session"), Some(12.0)));
        assert_eq!((limits[1]["kind"].as_str(), limits[1]["percent"].as_f64()), (Some("weekly_all"), Some(92.5)));
        assert_eq!(limits[2]["kind"], json!("weekly_scoped"));
        assert_eq!(limits[2]["model"], json!("GPT-5 Codex Spark"));
        assert_eq!(limits[2]["is_active"], json!(true));
    }

    /// The prepaid balance is the OpenRouter account's, shared by its keys:
    /// each key's row says "account balance" (ruling 2026-10-11), and every
    /// OpenRouter tier spends that one credit row.
    #[test]
    fn an_openrouter_key_row_names_the_account_balance() {
        let ks = |v: serde_json::Value| v.as_object().unwrap().clone();
        let capped = super::openrouter_limits(&ks(json!({ "usage": 8.49, "limit": 25.0, "total_credits": 30.0, "total_usage": 11.43 })));
        assert_eq!(capped[0]["label"], json!("$8.49 of $25.00 spend cap · $18.57 account balance"));
        assert!(super::spends("openrouter", "or-x", &capped[0]));
        let prepaid = super::openrouter_limits(&ks(json!({ "usage": 3.0, "total_credits": 3.0, "total_usage": 3.0 })));
        assert_eq!(prepaid[0]["label"], json!("$3.00 credits used · $0.00 account balance"));
        assert_eq!(prepaid[0]["is_active"], json!(true));
        assert!(!super::spends("claude", "opus", &prepaid[0]));
    }

    #[test]
    fn a_capped_key_with_no_account_balance_is_spent() {
        let ks = |v: serde_json::Value| v.as_object().unwrap().clone();
        let broke = super::openrouter_limits(&ks(json!({ "usage": 3.0, "limit": 10.0, "total_credits": 30.0, "total_usage": 30.0 })));
        assert_eq!(broke[0]["percent"], json!(30.0));
        assert_eq!(broke[0]["is_active"], json!(true));
        assert!(super::spent_window("openrouter", &broke[0]).is_some());
        let room = super::openrouter_limits(&ks(json!({ "usage": 3.0, "limit": 10.0, "total_credits": 30.0, "total_usage": 11.43 })));
        assert!(super::spent_window("openrouter", &room[0]).is_none());
        let prepaid = super::openrouter_limits(&ks(json!({ "usage": 3.0, "total_credits": 3.0, "total_usage": 3.0 })));
        assert!(super::spent_window("openrouter", &prepaid[0]).is_some());
    }

    #[test]
    fn no_rate_limits_is_not_available() {
        assert_eq!(codex_limits(&wham_rate_limits(&json!({ "plan_type": "free" })))["available"], json!(false));
    }
}

#[cfg(test)]
mod agy_tests {
    use super::agy_result;
    use serde_json::json;

    fn result() -> serde_json::Value {
        json!({"status":"SUCCESS", "conversation_id":"", "num_turns":0,
            "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},
            "command":{"name":"usage","data":{"groups":[{"name":"Gemini","buckets":[
                {"id":"gemini-session","name":"5h limit remaining","window":"5h","remaining_fraction":0.3}
            ]}]}}, "extra_credential":"raw-secret-sentinel"})
    }

    #[test]
    fn structured_usage_retains_bars_without_raw_json_or_log() {
        let raw = result();
        let log = "raw-secret-sentinel\nauthenticated successfully as rig@example.invalid";
        let direct = agy_result(&raw, log).unwrap();
        assert_eq!(direct, agy_result(&json!({"result":raw}), log).unwrap());
        assert_eq!(direct["limits"][0]["percent"], json!(70.0));
        assert_eq!(direct["email"], json!("rig@example.invalid"));
        assert!(!direct.to_string().contains("raw-secret-sentinel"));
    }

    #[test]
    fn structured_usage_refuses_turns_tokens_and_incomplete_token_evidence() {
        for (key, value) in [("num_turns", json!(1)), ("conversation_id", json!("turn")), ("status", json!("FAILURE"))] {
            let mut raw = result();
            raw[key] = value;
            assert!(agy_result(&raw, "").is_err());
        }
        let mut raw = result();
        raw["usage"]["total_tokens"] = json!(1);
        assert!(agy_result(&raw, "").is_err());
        raw["usage"] = json!({});
        assert!(agy_result(&raw, "").is_err());
    }
}

#[cfg(test)]
mod query_gate_tests {
    use super::*;

    #[test]
    fn shared_reservation_and_drop_block_duplicate_probes() {
        let usage = Usage::default();
        let guard = usage.reserve("agy").unwrap();
        assert!(usage.reserve("agy").is_none());
        assert!(matches!(usage.refresh_gate("agy", "google"), RefreshGate::Skip("in_progress", None)));
        drop(guard);
        assert!(matches!(usage.refresh_gate("agy", "google"), RefreshGate::Ready(_)));
        assert!(matches!(usage.refresh_gate("agy", "google"), RefreshGate::Skip("rate_limited", Some(_))));
    }

    #[test]
    fn manual_attempt_floor_includes_failures_and_does_not_gate_automatic_reads() {
        let usage = Usage::default();
        let RefreshGate::Ready(permit) = usage.refresh_gate("key", "openai") else { panic!("first attempt") };
        drop(permit);
        assert!(matches!(usage.refresh_gate("key", "openai"), RefreshGate::Skip("rate_limited", Some(_))));
        assert!(usage.reserve("key").is_some());
        usage.manual.pin().insert("key".into(), Instant::now() - Duration::from_secs(61));
        assert!(matches!(usage.refresh_gate("key", "openai"), RefreshGate::Ready(_)));
        usage.manual.pin().insert("agy".into(), Instant::now() - Duration::from_secs(61));
        assert!(matches!(usage.refresh_gate("agy", "google"), RefreshGate::Skip("rate_limited", Some(_))));
    }

    #[test]
    fn provider_cooldown_survives_manual_floor_and_cache_reads_have_no_effect() {
        let usage = Usage::default();
        usage.cooldown.pin().insert("key".into(), Instant::now() + Duration::from_secs(3600));
        assert!(matches!(usage.refresh_gate("key", "claude"), RefreshGate::Skip("rate_limited", Some(secs)) if secs > 3500));
        let snapshot = usage.snapshot("key", Utc::now());
        assert_eq!(snapshot["reason"], "no_cache");
        assert!(usage.manual.pin().get("key").is_none());
        assert!(usage.probing.pin().get("key").is_none());
    }
}

#[cfg(test)]
mod room_tests {
    use super::*;

    /// Muse's room proof: its account-wide (model-less) windows count for any
    /// tier the account offers; a window observed under another model never
    /// does; a full window or a missing one is no proof.
    #[test]
    fn muse_room_reads_account_wide_windows_but_never_another_models() {
        let now = Utc::now();
        let ahead = iso(now + chrono::Duration::hours(1));
        let w = |kind: &str, pct: f64, model: Option<&str>| json!({ "kind": kind, "percent": pct, "is_active": false,
            "resets_at": ahead, "observed_model": model });
        let meta = vec![w("session", 10.0, None), w("weekly_all", 20.0, None)];
        assert!(room_in("muse", "wonder", &meta, now) && room_in("muse", "wonder-full", &meta, now));
        let wonder = vec![w("session", 10.0, Some("muse-wonder-1.0")), w("weekly_all", 20.0, Some("muse-wonder-1.0"))];
        assert!(room_in("muse", "wonder", &wonder, now));
        assert!(!room_in("muse", "wonder-full", &wonder, now), "Wonder's windows prove nothing for Full");
        assert!(!room_in("muse", "wonder", &[w("session", 100.0, None), w("weekly_all", 20.0, None)], now));
        assert!(!room_in("muse", "wonder", &[w("session", 10.0, None)], now), "no weekly reading, no proof");
    }
}
