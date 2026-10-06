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
const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";
const USER_AGENT: &str = concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"));
const NOT_YET: &str = "usage unavailable; start a turn on this account to see usage";

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
        None => fetch_claude(engine, &key, &dir).await,
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
                "kind": kind, "group": id, "percent": pct, "severity": severity(pct),
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
    let mut out = match exe {
        None => json!({ "available": false, "error": "the Antigravity CLI is not installed", "reauth_evidence": "not_connected" }),
        Some(exe) => match agy_usage(engine, &exe).await {
            Ok(v) => v,
            Err(e) => json!({ "available": false, "error": NOT_YET, "detail": gist(&e, 300) }),
        },
    };
    out["account"] = json!("google/primary");
    out["provider"] = json!("google");
    out["label"] = json!("signed-in account");
    out["observed_at"] = json!(iso(Utc::now()));
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
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--log-file")
        .arg(dir.join("usage-probe.log"))
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
    Ok(out)
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
    let mut out = match crate::openrouter::key(engine).await {
        None => json!({ "available": false, "error": "no OpenRouter key is stored", "reauth_evidence": "not_connected" }),
        Some(key) => match openrouter_fetch(&key).await {
            Ok(v) => v,
            Err(e) => json!({ "available": false, "error": NOT_YET, "detail": gist(&e, 300) }),
        },
    };
    out["account"] = json!("openrouter/primary");
    out["provider"] = json!("openrouter");
    out["observed_at"] = json!(iso(Utc::now()));
    engine.usage.put("openrouter", &out);
    out
}

async fn openrouter_fetch(key: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(USER_AGENT).build().map_err(|e| e.to_string())?;
    let r = client.get(OPENROUTER_KEY_URL).bearer_auth(key).send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    if status == 401 || status == 403 {
        return Ok(json!({ "available": false, "error": "OpenRouter refused the stored key", "reauth_required": true,
                          "reauth_evidence": "measured_403" }));
    }
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    let d = &body["data"];
    let f = |k: &str| d[k].as_f64();
    let balance = match (f("total_credits"), f("total_usage")) {
        (Some(t), Some(u)) => Some((t - u).max(0.0)),
        _ => f("limit_remaining"),
    };
    let mut label = d["label"].as_str().unwrap_or("OpenRouter key").to_string();
    if let Some(rem) = f("limit_remaining") {
        label.push_str(&format!(" · ${rem:.2} remaining"));
    }
    let mut out = json!({ "available": balance.is_some(), "label": label, "limits": [] });
    if let Some(b) = balance {
        out["credits"] = json!({ "balance": b, "unit": "USD", "unlimited": false });
    }
    if d["is_free_tier"] == json!(true) {
        out["plan"] = json!("free tier");
    }
    Ok(out)
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
