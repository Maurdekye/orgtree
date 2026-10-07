//! Usage readouts for the usage window and the header glow: Claude's
//! subscription bars (the OAuth usage endpoint, read with the CLI's own
//! unexpired sign-in — never refreshed here, so the CLI's rotating token is
//! never spent behind its back), Codex rate limits (a short-lived app-server's
//! `account/rateLimits/read`), Antigravity's zero-token `/usage`, OpenRouter's
//! credit standing, and API-key accounts' metered spend. Every readout is
//! cached in a lock-free map; the peeks read the cache alone.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::util::{gist, iso};

const TTL: Duration = Duration::from_secs(30);
/// a peek older than this is no claim about now
const PEEK_MAX: Duration = Duration::from_secs(900);
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT: &str = concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"));
const NOT_YET: &str = "usage unavailable; start a turn on this account to see usage";

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

#[derive(Clone)]
struct Cached {
    at: Instant,
    data: Value,
}

/// The readouts, by key (`claude:<dir>`, `codex:<home>`, `agy`, `openrouter`).
#[derive(Default)]
pub struct Usage {
    cache: papaya::HashMap<String, Cached>,
    /// a provider that told us to wait: not before this
    cooldown: papaya::HashMap<String, Instant>,
    /// the last usage-history row of each series
    pub history: papaya::HashMap<String, crate::usage_history::Last>,
}

#[logged]
impl Usage {
    #[nolog]
    fn fresh(&self, key: &str, max: Duration) -> Option<Value> {
        self.cache.pin().get(key).filter(|c| c.at.elapsed() < max).map(|c| c.data.clone())
    }

    #[nolog]
    fn put(&self, key: &str, data: &Value) {
        self.cache.pin().insert(key.to_string(), Cached { at: Instant::now(), data: data.clone() });
    }

    #[nolog]
    fn cooling(&self, key: &str) -> Option<Instant> {
        self.cooldown.pin().get(key).copied().filter(|t| *t > Instant::now())
    }

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
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
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
#[logged]
pub async fn claude(engine: &Engine, config_dir: Option<&str>, force: bool) -> Value {
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
            let mut v = engine.usage.fresh(&key, Duration::MAX).unwrap_or_else(|| json!({ "available": false }));
            v["error"] = json!(format!("the usage service asked us to wait ({} s more)", until.saturating_duration_since(Instant::now()).as_secs()));
            v
        }
        None => {
            let observed = Utc::now();
            let value = fetch_claude(engine, &key, &dir).await;
            crate::account_marks::profile_usage(engine, "claude", config_dir, observed, &value).await;
            value
        },
    };
    out["email"] = json!(email);
    if out["available"].as_bool().unwrap_or(false) {
        engine.usage.put(&key, &out);
    } else if let Some(prev) = engine.usage.fresh(&key, Duration::MAX).filter(|p| p["available"].as_bool().unwrap_or(false)) {
        // keep the last good bars (dated), with why they are not fresh
        let mut v = prev;
        v["error"] = out["error"].clone();
        if out.get("reauth_required").is_some() {
            v["reauth_required"] = out["reauth_required"].clone();
            v["reauth_evidence"] = out["reauth_evidence"].clone();
        }
        return v;
    } else {
        engine.usage.put(&key, &out);
    }
    out
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
#[logged]
pub async fn codex(engine: &Engine, account: &str, home: Option<&str>, force: bool) -> Value {
    let key = codex_key(home);
    if !force {
        if let Some(v) = engine.usage.fresh(&key, TTL) {
            return v;
        }
    }
    let (_, email, _) = crate::providers::codex_identity(home.map(PathBuf::from).as_ref());
    let exe = match engine.providers.codex_path() {
        Some(p) => Some(p),
        None => tokio::task::spawn_blocking(crate::providers::locate_codex).await.ok().flatten().map(|(p, _)| p),
    };
    let observed = Utc::now();
    let mut out = match exe {
        None => json!({ "available": false, "error": "the Codex CLI is not installed", "reauth_evidence": "not_connected" }),
        Some(exe) => match crate::runtime::codex::probe(&exe, home).await {
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
        },
    };
    out["account"] = json!(account);
    out["provider"] = json!("openai");
    out["label"] = json!(email.clone().unwrap_or_else(|| "signed-in account".into()));
    out["email"] = json!(email);
    out["observed_at"] = json!(iso(Utc::now()));
    crate::account_marks::profile_usage(engine, "openai", home, observed, &out).await;
    engine.usage.put(&key, &out);
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
#[logged]
pub async fn antigravity(engine: &Engine, force: bool) -> Value {
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
    out["provider"] = json!("google");
    match out["email"].as_str().map(str::to_string) {
        Some(email) => {
            out["label"] = json!(email);
            crate::providers::set_agy_email(engine, &email);
        }
        None => out["label"] = json!("signed-in account"),
    }
    out["observed_at"] = json!(iso(Utc::now()));
    crate::account_marks::profile_usage(engine, "google", None, observed, &out).await;
    engine.usage.put("agy", &out);
    out
}

async fn agy_usage(engine: &Engine, exe: &Path) -> Result<Value, String> {
    // only builds verified to answer /usage without a model turn
    let version = {
        let mut cmd = tokio::process::Command::new(exe);
        cmd.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        crate::winproc::no_window(&mut cmd);
        let o = tokio::time::timeout(Duration::from_secs(20), cmd.output()).await.map_err(|_| "agy --version timed out")?.map_err(|e| e.to_string())?;
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
    let o = tokio::time::timeout(Duration::from_secs(30), cmd.output()).await.map_err(|_| "agy /usage timed out")?.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&o.stdout);
    let result = stdout
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .find(|v| v.is_object())
        .ok_or_else(|| format!("no JSON result (exit {:?}): {}", o.status.code(), gist(&String::from_utf8_lossy(&o.stderr), 200)))?;
    let r = if result["result"].is_object() { &result["result"] } else { &result };
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
    if let Some(email) = std::fs::read_to_string(&log).ok().and_then(|t| agy_log_email(&t)) {
        out["email"] = json!(email);
    }
    Ok(out)
}

/// The account an Antigravity CLI run signed in as, from its own log (as 3.x
/// read it): "authenticated successfully as <email>", or the auth result line.
#[logged]
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

// ------------------------------------------------------------ OpenRouter

/// The stored OpenRouter key's credit standing (`GET /api/v1/key`).
#[logged]
pub async fn openrouter(engine: &Engine, force: bool) -> Value {
    if !force {
        if let Some(v) = engine.usage.fresh("openrouter", Duration::from_secs(60)) {
            return v;
        }
    }
    let observed = Utc::now();
    let mut out = match crate::openrouter::key(engine).await {
        None => json!({ "available": false, "error": "no API key — add one in App settings › Providers",
                        "reauth_evidence": "not_connected" }),
        Some(key) => match openrouter_fetch(&key).await {
            Ok(v) => v,
            Err(e) => json!({ "available": false, "error": "OpenRouter usage check failed", "detail": gist(&e, 300) }),
        },
    };
    out["account"] = json!("openrouter");
    out["provider"] = json!("OpenRouter");
    if out.get("label").and_then(Value::as_str).is_none() {
        out["label"] = json!("OpenRouter API key");
    }
    out["observed_at"] = json!(iso(Utc::now()));
    crate::usage_history::record(engine, "openrouter", "openrouter", observed, &out).await;
    engine.usage.put("openrouter", &out);
    out
}

async fn openrouter_fetch(key: &str) -> Result<Value, String> {
    match crate::openrouter::key_standing(key).await {
        Err((true, e)) => Ok(json!({ "available": false, "error": e, "reauth_required": true, "reauth_evidence": "measured_403" })),
        Err((false, e)) => Err(e),
        Ok(ks) => {
            let label = ks.get("label").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("OpenRouter API key");
            let mut out = json!({ "available": true, "label": label, "limits": openrouter_limits(&ks) });
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
#[logged]
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
            label.push_str(&format!(" · ${b:.2} balance"));
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
        return vec![row(None, sev, active, format!("${usage:.2} credits used · ${b:.2} remaining balance"))];
    }
    vec![row(None, "normal", false, format!("${usage:.2} spent · no spend cap"))]
}

// ------------------------------------------------------------ API-key accounts

/// A metered key account's spend so far (local metering is the figure).
#[logged]
pub async fn apikey_spend(engine: &Engine, account: &str) -> Value {
    let row = match engine.db.get().await {
        Ok(c) => c
            .query_opt(
                "SELECT usd_total::float8, turns, extract(epoch FROM since)::float8, extract(epoch FROM updated_at)::float8
                   FROM ot.account_spend WHERE account = $1",
                &[&account],
            )
            .await
            .ok()
            .flatten(),
        Err(_) => None,
    };
    let spend = match row {
        Some(r) => json!({ "usd_total": r.get::<_, f64>(0), "turns": r.get::<_, i32>(1),
                           "since": r.get::<_, Option<f64>>(2).map(|x| x as i64), "updated_at": r.get::<_, Option<f64>>(3).map(|x| x as i64) }),
        None => json!({ "usd_total": 0.0, "turns": 0, "since": null, "updated_at": null }),
    };
    json!({ "available": true, "mode": "apikey", "currency": "USD", "spend": spend, "limits": [] })
}

// ------------------------------------------------------------ what the windows read

/// One registry account's readout and standing (`registered_usage[id]`).
#[logged]
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
    let mut u = if a.is_apikey() {
        let spend = apikey_spend(engine, &a.id).await;
        crate::usage_history::record(engine, &a.id, &a.provider, Utc::now(), &spend).await;
        spend
    } else {
        match a.provider.as_str() {
            "claude" => claude(engine, a.config_dir.as_deref(), force).await,
            "openai" => codex(engine, &a.id, a.config_dir.as_deref(), force).await,
            "google" => antigravity(engine, force).await,
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
#[logged]
pub fn publish(engine: &Engine, lane: &str, value: &Value) {
    let (key, peek_key, cache, provider) = match lane {
        "claude" => ("usage", "usage_peek", claude_key(None), "claude"),
        "openai" => ("codex_usage", "codex_usage_peek", codex_key(None), "openai"),
        "google" => ("antigravity_usage", "antigravity_usage_peek", "agy".to_string(), "google"),
        "openrouter" => ("openrouter_usage", "openrouter_usage_peek", "openrouter".to_string(), "openrouter"),
        _ => return,
    };
    engine.app.set_value(key, value.clone());
    engine.app.set_value(peek_key, engine.usage.peek(&cache, provider));
}

/// Keep the usage the windows show fresh: the four provider lanes, their
/// peeks (the usage button's glow) and every registered account. The
/// windows never poll; they read these pushed values.
#[logged]
pub fn start(engine: &std::sync::Arc<Engine>) {
    let eng = engine.clone();
    tokio::spawn(async move {
        let mut last: std::collections::HashMap<&'static str, Instant> = std::collections::HashMap::new();
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            publish_due(&eng, &mut last).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                _ = eng.shutdown.cancelled() => break,
            }
        }
    });
}

#[logged]
async fn publish_due(engine: &std::sync::Arc<Engine>, last: &mut std::collections::HashMap<&'static str, Instant>) {
    let due = |last: &std::collections::HashMap<&'static str, Instant>, k: &str, every: u64| {
        last.get(k).map(|t| t.elapsed() >= Duration::from_secs(every)).unwrap_or(true)
    };
    let st = engine.providers.state.load_full();
    if st.claude.installed && due(last, "claude", 120) {
        let v = claude(engine, None, false).await;
        publish(engine, "claude", &v);
        last.insert("claude", Instant::now());
    }
    if st.codex.installed && due(last, "openai", 300) {
        let v = codex(engine, "openai/primary", None, false).await;
        publish(engine, "openai", &v);
        last.insert("openai", Instant::now());
    }
    if st.agy.installed && due(last, "google", 300) {
        let before = engine.usage.peek("agy", "google");
        let v = antigravity(engine, false).await;
        publish(engine, "google", &v);
        // A known full group becoming usable releases mail held at the turn gate.
        let recovered = before["limits"].as_array().is_some_and(|old| old.iter().any(|b| {
            b["percent"].as_f64().is_some_and(|p| p >= 100.0)
                && v["limits"].as_array().is_some_and(|new| new.iter().any(|n| {
                    n["group"] == b["group"] && n["percent"].as_f64().is_some_and(|p| p < 100.0)
                }))
        }));
        if recovered {
            crate::accounts::wake_waiting(engine, crate::accounts::Waiting::Native("google".into())).await;
        }
        last.insert("google", Instant::now());
    }
    let key_set = engine.settings.get().pointer("/openrouter/key_set").and_then(Value::as_bool).unwrap_or(false);
    if due(last, "openrouter", 300) {
        if key_set {
            let v = openrouter(engine, false).await;
            publish(engine, "openrouter", &v);
        }
        crate::openrouter::publish(engine).await;
        last.insert("openrouter", Instant::now());
    }
    if due(last, "usage_history_prune", 3600) {
        crate::usage_history::prune(engine).await;
        last.insert("usage_history_prune", Instant::now());
    }
    if due(last, "registered", 300) {
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
#[logged]
pub fn turn_board(engine: &Engine, provider: &str, account: Option<&str>, tier: &str, org_slug: &str) -> (String, String) {
    let now = Utc::now();
    let view = engine.accounts.view();
    let pin = engine.usage.cache.pin();
    let own = account.and_then(|a| view.get(a)).filter(|a| !crate::accounts::is_ambient(a)).map(|a| a.id.clone());
    let selected_lane = match (provider, &own) {
        (_, Some(id)) => id.clone(),
        ("openai", None) => "openai/primary".into(),
        ("google", None) => "google/primary".into(),
        ("openrouter", None) => "openrouter".into(),
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
    if crate::providers::openrouter_key_set(engine) {
        lanes.push(("openrouter".into(), "openrouter".into(), None));
    }
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
        let marked = view.get(lane).and_then(|a| a.limited(now)).is_some();
        if !c.data["available"].as_bool().unwrap_or(false) {
            let why = c.data["error"].as_str().map(|e| gist(e, 60)).unwrap_or_else(|| "no reading".into());
            lines.push(format!("{lane}{star} | usage | - | - | - | {observed} | unavailable ({why})"));
            key_lines.push(format!("{lane}|unavailable"));
            continue;
        }
        for l in c.data["limits"].as_array().cloned().unwrap_or_default() {
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
    for a in registered.iter().filter(|a| a.is_apikey()) {
        roster.push(format!("{} (API key, metered)", a.id));
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
    if provider == crate::providers::catalog::GOOGLE {
        let pool = crate::providers::catalog::antigravity_pool(tier);
        text.push_str(&format!("\nThis turn spends: {tier} on {selected_lane} → session:{pool}-5h and weekly_scoped:{pool}-weekly. Other model groups' windows do not apply to this tier."));
    } else {
        text.push_str(&format!("\nYour turns run on {selected_lane} (tier {tier}) and draw on its windows above."));
    }
    text.push_str("\n[END PROVIDER USAGE]");
    let key = format!("{selected_lane}\n{tier}\n{}\n{}", roster.join("|"), key_lines.join("\n"));
    (text, key)
}
