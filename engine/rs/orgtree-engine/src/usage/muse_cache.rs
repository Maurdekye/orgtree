//! Durable Muse last-good observations only. Never store a raw MSP document,
//! credentials, account paths, or authentication evidence.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use crate::engine::Engine;
use crate::util::{iso, parse_ts};

#[nolog]
pub fn key(account: &str) -> String {
    format!("muse_usage:{account}")
}

/// Also validate/re-project durable input: the database is no reason to trust
/// arbitrary metadata or to manufacture a missing observation date.
#[nolog]
fn safe(data: &Value, now: DateTime<Utc>) -> Option<Value> {
    let observed = data["observed_at"].as_str().and_then(parse_ts).filter(|at| *at <= now)?;
    if data["available"] != true { return None; }
    let mut limits = Vec::new();
    for w in data["limits"].as_array()?.iter().take(64) {
        let Some(percent) = w["percent"].as_f64().filter(|p| p.is_finite()) else { continue };
        if !matches!(w["group"].as_str(), Some("window" | "weekly")) { continue; }
        let text = |field: &str| w[field].as_str().map(|s| s.chars().take(256).collect::<String>());
        limits.push(json!({"kind":text("kind"), "group":text("group"),
            "percent":percent, "severity":super::severity(percent.clamp(0.0, 100.0)),
            "is_active":percent >= 100.0,
            "resets_at":w["resets_at"].as_str().and_then(parse_ts).map(iso),
            "label":text("label"), "model":null, "observed_model":text("observed_model")}));
    }
    if limits.is_empty() { return None; }
    Some(json!({"available":true, "provider":super::MUSE_NAME,
        "observed_at":iso(observed), "limits":limits}))
}

#[nolog]
pub(super) async fn persist(engine: &Engine, root: Option<&str>, data: &Value, observed: DateTime<Utc>) -> anyhow::Result<bool> {
    let Some(durable) = safe(data, Utc::now()) else { return Ok(false) };
    let accounts: Vec<String> = match root {
        None => vec!["muse/primary".to_owned()],
        Some(root) => {
            let view = engine.accounts.view();
            let mut ids: Vec<String> = view.all().into_iter().filter(|a| a.provider == "muse"
                && !a.is_apikey() && a.config_dir.as_deref() == Some(root)).map(|a| a.id.clone()).collect();
            ids.sort();
            ids
        },
    };
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let mut present = root.is_none();
    // KEY SHARE pairs with removal's FOR UPDATE: no late turn can recreate
    // a removed account's durable key, even using an obsolete registry view.
    for account in accounts {
        if let Some(root) = root {
            if tx.query_opt("SELECT id FROM ot.accounts WHERE id = $1 AND provider = 'muse'
                AND kind <> 'apikey' AND config_dir = $2 FOR KEY SHARE", &[&account, &root]).await?.is_none() {
                continue;
            }
            present = true;
        }
        tx.execute("INSERT INTO ot.kv (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
            WHERE coalesce(ot.kv.value->>'observed_at', '') < EXCLUDED.value->>'observed_at'",
            &[&key(&account), &durable]).await?;
    }
    // Install while still holding the account's KEY SHARE. Removal clears
    // RAM after committing its FOR UPDATE/delete, so neither memory nor
    // durable state can be resurrected by a late observation.
    let accepted = present && engine.usage.put_observed(&super::muse_key(root), data, observed);
    tx.commit().await?;
    Ok(accepted)
}

/// Called after registry load, before provider discovery or turn recovery.
/// Restore quota history without making a new positive auth observation.
#[logged]
pub async fn restore(engine: &Engine) -> anyhow::Result<()> {
    let view = engine.accounts.view();
    let mut accounts = vec![("muse/primary".to_owned(), super::muse_key(None))];
    accounts.extend(view.all().into_iter().filter(|a| a.provider == "muse" && !a.is_apikey())
        .map(|a| (a.id.clone(), super::muse_key(a.config_dir.as_deref()))));
    let client = engine.db.get().await?;
    let mut restored = 0;
    for (account, cache_key) in accounts {
        let Some(row) = client.query_opt("SELECT value FROM ot.kv WHERE key = $1", &[&key(&account)]).await? else { continue };
        let Some(data) = safe(&row.get::<_, Value>(0), Utc::now()) else { continue };
        let Some(observed) = data["observed_at"].as_str().and_then(parse_ts) else { continue };
        if engine.usage.put_muse_observed(&cache_key, &data, observed, false) { restored += 1; }
    }
    tracing::info!(restored, "restored Muse usage readings");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_projection_rejects_bad_dates_and_drops_unrelated_fields() {
        let now = DateTime::from_timestamp(1_900_000_000, 0).unwrap();
        let mut data = json!({"available":true,"observed_at":iso(now), "secret":"do not persist",
            "reauth_required":false, "limits":[{"group":"weekly","kind":"weekly_all",
                "percent":73,"resets_at":iso(now),"secret":"private"}]});
        let out = safe(&data, now).unwrap();
        assert!(out.get("secret").is_none() && out.get("reauth_required").is_none());
        assert!(out["limits"][0].get("secret").is_none());
        assert_eq!(out["observed_at"], iso(now));
        data["observed_at"] = json!(iso(now + chrono::Duration::seconds(1)));
        assert!(safe(&data, now).is_none());
        data["observed_at"] = Value::Null;
        assert!(safe(&data, now).is_none());
    }

    #[test]
    fn restoration_keeps_old_dates_without_auth_and_expired_windows_are_unknown() {
        let usage = super::super::Usage::default();
        let now = Utc::now();
        let old = now - chrono::Duration::days(300);
        let data = json!({"available":true,"observed_at":iso(old),"limits":[
            {"kind":"session","group":"window","percent":100,"is_active":true,"resets_at":iso(now)},
            {"kind":"weekly_all","group":"weekly","percent":37,"is_active":false,"resets_at":iso(now+chrono::Duration::days(1))}]});
        let key = super::super::muse_key(None);
        assert!(usage.put_muse_observed(&key, &data, old, false));
        assert!(usage.cached(&key).is_some());
        assert_eq!(usage.cached_reauth_required(&key), None);
        let snap = usage.snapshot(&key, now);
        assert_eq!(snap["observed_at"], iso(old));
        assert_eq!(snap["freshness"], "stale");
        assert_eq!(snap["windows"][0]["used_percent"], Value::Null);
        assert_eq!(snap["windows"][0]["limited"], Value::Null);
        assert_eq!(snap["windows"][1]["used_percent"].as_f64(), Some(37.0));
        assert_eq!(data["limits"][0]["percent"], 100, "projection leaves source intact");
        assert_eq!(super::super::current_reading("claude:~", &data, now), data);
        assert!(!usage.put_muse_observed(&key, &data, old-chrono::Duration::seconds(1), false));
    }

    #[test]
    fn recent_restore_never_dates_auth_or_resurrects_an_expired_limit() {
        let usage = super::super::Usage::default();
        let now = Utc::now();
        let key = super::super::muse_key(None);
        let data = json!({"available":true,"observed_at":iso(now),"limits":[
            {"group":"window","percent":100,"is_active":true,"resets_at":iso(now)}]});
        usage.put_muse_observed(&key, &data, now, false);
        assert_eq!(usage.cached_reauth_required(&key), None);
        assert_eq!(usage.peek(&key, "Muse")["limits"][0]["percent"], Value::Null);
        assert_eq!(usage.cached(&key).unwrap()["limits"][0]["is_active"], Value::Null);
    }
}
