//! Evidence-based clearing. Never resume an agent or infer room from missing usage.
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::engine::Engine;

/// Only known subscription pools are interchangeable with the current default pool.
/// Reserve/unknown imported pools require their own evidence and are left alone.
#[logged]
fn usage_allows(provider: &str, pool: &str, win: Option<&str>, usage: &Value) -> bool {
    if usage["available"] != true || !usage["error"].is_null() || usage["reauth_required"] == true {
        return false;
    }
    if provider == "google" && matches!(pool, "agy:3p" | "agy:gemini") {
        let prefix = pool.trim_start_matches("agy:");
        let Some(bars) = usage["limits"].as_array() else { return false };
        return [format!("{prefix}-5h"), format!("{prefix}-weekly")].iter().all(|id| {
            bars.iter().any(|b| b["group"].as_str() == Some(id.as_str())
                && b["percent"].as_f64().is_some_and(|p| p.is_finite() && p >= 0.0 && p < 100.0)
                && b["is_active"] != true)
        });
    }
    let supported = pool == "default"
        || (provider == "openai" && pool == "openai-plan")
        || (provider == "claude" && pool == "pooled");
    if !supported {
        return false;
    }
    let Some(bars) = usage["limits"].as_array().filter(|b| !b.is_empty()) else {
        return false;
    };
    // Conservatively require every reported window to have room, even when the
    // mark names one window: a still-full shared window is not a recovered pool.
    if !bars.iter().all(|b| {
        b["percent"]
            .as_f64()
            .is_some_and(|p| p.is_finite() && p >= 0.0 && p < 100.0)
            && b["is_active"] != true
    }) {
        return false;
    }
    if matches!(provider, "claude" | "openai") && !bars.iter().any(|b| b["kind"] == "weekly_all") {
        return false;
    }
    if provider == "claude" && !bars.iter().any(|b| b["kind"] == "session") {
        return false;
    }
    match win {
        None => true,
        Some(w) => {
            let kind = match w {
                "five_hour" => "session",
                "seven_day" => "weekly_all",
                _ => w,
            };
            bars.iter().any(|b| b["kind"] == kind || b["group"] == w)
        }
    }
}

/// True limit signals are sticky for a turn; an earlier turn's signal is not evidence.
#[logged]
pub fn limit_signal(value: &Value) -> bool {
    value["status"] == "rejected"
        || !value["rateLimitReachedType"].is_null()
        || ["primary", "secondary"].iter().any(|w| {
            value[*w]["usedPercent"]
                .as_f64()
                .is_some_and(|p| p >= 100.0)
        })
}

/// Associate a provider's native/profile probe only with registry rows for that login.
#[logged]
pub async fn profile_usage(
    engine: &Engine,
    provider: &str,
    profile: Option<&str>,
    observed: DateTime<Utc>,
    value: &Value,
) {
    let accounts: Vec<String> = engine
        .accounts
        .view()
        .all()
        .into_iter()
        .filter(|a| {
            a.provider == provider
                && !a.is_apikey()
                && (a.config_dir.as_deref() == profile || (profile.is_none() && a.ambient))
        })
        .map(|a| a.id.clone())
        .collect();
    for account in accounts {
        usage(engine, &account, provider, observed, value).await;
        crate::usage_history::record(engine, &account, provider, observed, value).await;
    }
}

/// Called only after a provider request, never on cache hits or stale fallback.
/// Use request start, not completion, so a concurrent new refusal always wins.
#[logged]
pub async fn usage(
    engine: &Engine,
    account: &str,
    provider: &str,
    observed: DateTime<Utc>,
    value: &Value,
) {
    if observed > Utc::now()
        || Utc::now() - observed > chrono::Duration::seconds(30)
        || value["available"] != true
        || !value["error"].is_null()
        || value["reauth_required"] == true
    {
        return;
    }
    let result: anyhow::Result<u64> = async {
        let client = engine.db.get().await?;
        let rows = client.query(
            "SELECT pool, win, at FROM ot.account_marks WHERE account = $1 AND at < $2 AND until > now() ORDER BY pool LIMIT 32",
            &[&account, &observed],
        ).await?;
        let mut cleared = 0;
        for r in rows {
            let pool: String = r.get(0);
            let win: Option<String> = r.get(1);
            let at: DateTime<Utc> = r.get(2);
            if usage_allows(provider, &pool, win.as_deref(), value) {
                let n = client.execute(
                    "DELETE FROM ot.account_marks WHERE account = $1 AND pool = $2 AND at = $3 AND until > now()",
                    &[&account, &pool, &at],
                ).await?;
                cleared += n;
                if n > 0 { tracing::info!(account, pool, %observed, "account limit mark cleared by fresh provider usage"); }
            }
        }
        Ok(cleared)
    }.await;
    refreshed(engine, result).await;
}

/// The captured account of a successful admitted turn, not its current binding.
/// Current Rust turns spend the default pool (legacy plan/pooled alias); never
/// clear an imported reserve or Fable-only mark from a different pool.
#[logged]
pub async fn success(engine: &Engine, account: &str, provider: &str, tier: &str, admitted: DateTime<Utc>) {
    let result: anyhow::Result<u64> = async {
        let client = engine.db.get().await?;
        let legacy_pool = match provider {
            "google" => format!("agy:{}", crate::providers::catalog::antigravity_pool(tier)),
            "openai" => "openai-plan".into(), "claude" => "pooled".into(), _ => "default".into()
        };
        let default_pool = if provider == "google" { legacy_pool.as_str() } else { "default" };
        let n = client.execute(
            "DELETE FROM ot.account_marks WHERE account = $1 AND pool IN ($4, $3) AND at < $2 AND until > now()",
            &[&account, &admitted, &legacy_pool, &default_pool],
        ).await?;
        if n > 0 { tracing::info!(account, %admitted, "account limit mark cleared by successful turn"); }
        Ok(n)
    }.await;
    refreshed(engine, result).await;
}

#[logged]
async fn refreshed(engine: &Engine, result: anyhow::Result<u64>) {
    match result {
        Ok(n) if n > 0 => match engine.accounts.reload(engine).await {
            Ok(()) => crate::accounts::publish(engine),
            Err(e) => tracing::warn!(error = %e, "cleared account marks could not be published"),
        },
        Err(e) => tracing::warn!(error = %e, "account mark reconciliation failed"),
        _ => {}
    }
}

// ------------------------------------------------------------ manual clear (3.x parity F01)

/// The fable mark a pooled/default mark carries when it was inferred with it.
const FABLE: &str = "fable";

#[nolog]
fn micros(t: DateTime<Utc>) -> i64 {
    t.timestamp_micros()
}

#[nolog]
fn secs(t: DateTime<Utc>) -> f64 {
    t.timestamp_micros() as f64 / 1e6
}

/// A stored mark, as read under the clear's row lock or for inspect.
struct Mark {
    pool: String,
    until: DateTime<Utc>,
    provenance: String,
    win: Option<String>,
    at: DateTime<Utc>,
}

#[logged]
impl Mark {
    #[nolog]
    fn of(r: &tokio_postgres::Row) -> Mark {
        Mark { pool: r.get(0), until: r.get(1), provenance: r.get(2), win: r.get(3), at: r.get(4) }
    }
    /// The exact values a clear must present back (3.x `mark_fingerprint`):
    /// any write to the mark since it was read changes at least one of them.
    #[nolog]
    fn fingerprint(&self) -> Value {
        serde_json::json!({ "until": secs(self.until), "observed_at": secs(self.at),
                            "provenance": self.provenance, "window": self.win.clone().unwrap_or_default() })
    }
    /// Does a caller's `expected` still name this exact mark? Times compare at
    /// the microsecond the database stores; a malformed fingerprint never matches.
    #[nolog]
    fn matches(&self, expected: &Value) -> bool {
        let us = |k: &str| expected[k].as_f64().filter(|v| v.is_finite()).map(|v| (v * 1e6).round() as i64);
        us("until") == Some(micros(self.until))
            && us("observed_at") == Some(micros(self.at))
            && expected["provenance"].as_str() == Some(self.provenance.as_str())
            && expected["window"].as_str().unwrap_or("") == self.win.as_deref().unwrap_or("")
    }
    #[nolog]
    fn snapshot(&self) -> Value {
        serde_json::json!({ "until": secs(self.until), "observed_at": secs(self.at),
                            "provenance": self.provenance, "window": self.win })
    }
}

/// Is this fable mark the inferred companion of this pooled mark? Same rule
/// as 3.x `_rides_with`: inferred, with the same horizon.
#[nolog]
fn rides_with(pooled: &Mark, fable: &Mark) -> bool {
    fable.provenance == "inferred" && fable.until == pooled.until
}

#[nolog]
fn pooled(pool: &str) -> bool {
    pool == "pooled" || pool == "default"
}

/// Every stored mark on one exact account row, with its freshness and the
/// `expected` fingerprint a clear must present (3.x `describe_marks`).
#[logged]
pub async fn describe(client: &deadpool_postgres::Object, account: &str) -> anyhow::Result<Vec<Value>> {
    let rows = client
        .query("SELECT pool, until, provenance, win, at FROM ot.account_marks WHERE account = $1 ORDER BY pool LIMIT 64", &[&account])
        .await?;
    let marks: Vec<Mark> = rows.iter().map(Mark::of).collect();
    let now = Utc::now();
    let fable = marks.iter().find(|m| m.pool == FABLE);
    Ok(marks
        .iter()
        .map(|m| {
            let mut e = serde_json::json!({
                "source": "registry", "account": account, "pool": m.pool,
                "state": if m.until > now { "active" } else { "expired" },
                "until": secs(m.until), "until_iso": crate::util::iso(m.until),
                "remaining_s": ((m.until - now).num_milliseconds() as f64 / 1000.0).max(0.0),
                "observed_at": secs(m.at), "age_s": (now - m.at).num_milliseconds() as f64 / 1000.0,
                "provenance": m.provenance, "window": m.win.clone().unwrap_or_default(),
                "expected": m.fingerprint() });
            if let (true, Some(f)) = (pooled(&m.pool), fable) {
                e["companion"] = serde_json::json!({ "pool": FABLE, "cleared_with_this": rides_with(m, f), "expected": f.fingerprint() });
            }
            e
        })
        .collect())
}

/// Who asked for a manual clear; kept in the audit row.
pub struct ClearBy<'a> {
    pub actor: &'a str,
    pub org_slug: Option<&'a str>,
    /// the clearing org's events log, for the agent tool
    pub org_id: Option<i64>,
    pub via: &'a str,
}

#[nolog]
fn with(mut v: Value, extra: Value) -> Value {
    if let (Some(o), Value::Object(x)) = (v.as_object_mut(), extra) {
        o.extend(x);
    }
    v
}

/// Remove ONE stored mark only if it is still exactly `expected` (3.x
/// `registry.clear_mark`). `changed`, `missing` and `expired` write nothing.
/// Clearing pooled/default also removes an inferred fable companion with the
/// same horizon; any other fable mark is kept and reported. The delete and its
/// audit row commit in ONE transaction. Adds no capacity and resumes no agent.
#[logged]
pub async fn clear(
    engine: &Engine,
    account: &str,
    pool: &str,
    expected: &Value,
    companion_expected: Option<&Value>,
    reason: &str,
    by: &ClearBy<'_>,
) -> anyhow::Result<Value> {
    if pool.is_empty() {
        crate::refuse!(BadRequest, "name the pool to clear");
    }
    if !expected.is_object() {
        crate::refuse!(BadRequest, "expected must be the `expected` object inspect returned");
    }
    if reason.chars().count() > 500 {
        crate::refuse!(BadRequest, "reason is limited to 500 characters");
    }
    let base = serde_json::json!({ "account": account, "source": "registry", "pool": pool });
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let rows = tx
        .query(
            "SELECT pool, until, provenance, win, at FROM ot.account_marks WHERE account = $1 AND pool IN ($2, $3) FOR UPDATE",
            &[&account, &pool, &FABLE],
        )
        .await?;
    let marks: Vec<Mark> = rows.iter().map(Mark::of).collect();
    let Some(mark) = marks.iter().find(|m| m.pool == pool) else {
        return Ok(with(base, serde_json::json!({ "result": "missing", "current": null })));
    };
    if !mark.matches(expected) {
        return Ok(with(base, serde_json::json!({ "result": "changed", "current": mark.snapshot() })));
    }
    if mark.until <= Utc::now() {
        return Ok(with(base, serde_json::json!({ "result": "expired", "current": mark.snapshot() })));
    }
    let mut cleared = serde_json::Map::new();
    let mut kept = serde_json::Map::new();
    cleared.insert(pool.to_string(), mark.snapshot());
    if let (true, Some(f)) = (pooled(pool), marks.iter().find(|m| m.pool == FABLE)) {
        if companion_expected.is_some_and(|c| !f.matches(c)) {
            return Ok(with(
                base,
                serde_json::json!({ "result": "changed", "current": mark.snapshot(), "companion_current": f.snapshot() }),
            ));
        }
        if rides_with(mark, f) {
            cleared.insert(FABLE.to_string(), f.snapshot());
        } else {
            kept.insert(FABLE.to_string(), f.snapshot());
        }
    }
    let pools: Vec<String> = cleared.keys().cloned().collect();
    tx.execute("DELETE FROM ot.account_marks WHERE account = $1 AND pool = ANY($2)", &[&account, &pools]).await?;
    let (cleared, kept) = (Value::Object(cleared), Value::Object(kept));
    let audit = tx
        .query_one(
            "INSERT INTO ot.account_mark_audit (actor, org, via, account, pool, cleared, kept, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, at",
            &[&by.actor, &by.org_slug, &by.via, &account, &pool, &cleared, &kept, &reason],
        )
        .await?;
    let entry = serde_json::json!({ "id": audit.get::<_, i64>(0), "at": crate::util::iso(audit.get(1)), "actor": by.actor,
                                    "org": by.org_slug, "via": by.via, "account": account, "source": "registry",
                                    "pool": pool, "cleared": cleared, "kept": kept, "reason": reason });
    if let Some(org_id) = by.org_id {
        tx.execute(
            "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'account_mark_cleared', $2, $3)",
            &[&org_id, &by.actor, &entry],
        )
        .await?;
    }
    tx.commit().await?;
    drop(client);
    refreshed(engine, Ok(1)).await;
    Ok(with(base, serde_json::json!({ "result": "cleared", "cleared": cleared, "kept": kept, "audit": entry })))
}
