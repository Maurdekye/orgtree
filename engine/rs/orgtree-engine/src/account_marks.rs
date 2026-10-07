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
pub async fn success(engine: &Engine, account: &str, provider: &str, admitted: DateTime<Utc>) {
    let result: anyhow::Result<u64> = async {
        let client = engine.db.get().await?;
        let legacy_pool = match provider { "openai" => "openai-plan", "claude" => "pooled", _ => "default" };
        let n = client.execute(
            "DELETE FROM ot.account_marks WHERE account = $1 AND pool IN ('default', $3) AND at < $2 AND until > now()",
            &[&account, &admitted, &legacy_pool],
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
