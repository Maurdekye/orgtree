//! Usage over time (docket track-usage-over-time-and-show-usage-analytics,
//! phase 1 recorded it, phase 2 shows it). Every provider usage readout the engine
//! fetches is turned into one row per allowance window plus one for the
//! account's availability, in `ot.usage_history`.
//!
//! - A value the provider did not report is stored as NULL, never as zero;
//!   a failed or unsupported readout is a row with that state.
//! - A row is written only when the series changed, or hourly as a keepalive.
//! - A window whose reset time moved on, or whose used share fell, gets a
//!   `reset` row first, so a graph never draws a reset as consumption.
//! - Rows older than `RETAIN_DAYS` are pruned in small batches.
//! - `history` answers the analytics panel: per series and period, downsampled
//!   in the database (phase 2).
//!
//! The last row of each series is kept in a lock-free map (seeded from the
//! table after a restart). Recording never fails the readout it records.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

use crate::engine::Engine;
use crate::util::{gist, parse_ts};

/// Rows are kept this long.
pub const RETAIN_DAYS: i64 = 90;
/// An unchanged series is written again after this long (a keepalive).
const KEEPALIVE_MIN: i64 = 60;
/// A reset time that moves later by more than this starts a new window.
const RESET_SHIFT_MIN: i64 = 5;
/// At most this many windows from one readout.
const MAX_WINDOWS: usize = 32;
const PRUNE_BATCH: i64 = 2000;
const PRUNE_ROUNDS: usize = 20;

/// The last row written for a series.
#[derive(Clone, Debug, PartialEq)]
pub struct Last {
    at: DateTime<Utc>,
    state: String,
    pct: Option<f64>,
    amount: Option<f64>,
    resets: Option<DateTime<Utc>>,
    detail: Option<String>,
}

/// One series' reading from a readout.
#[derive(Debug)]
struct Reading {
    win: String,
    grp: String,
    model: String,
    state: &'static str,
    pct: Option<f64>,
    amount: Option<f64>,
    unit: Option<String>,
    resets: Option<DateTime<Utc>>,
    label: Option<String>,
    detail: Option<String>,
}

#[nolog]
impl Reading {
    fn key(&self, account: &str) -> String {
        format!("{account}\u{1f}{}\u{1f}{}\u{1f}{}", self.win, self.grp, self.model)
    }

    /// The same as `last`, to within rounding of the readout.
    fn same(&self, last: &Last) -> bool {
        let close = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => (a - b).abs() < 0.05,
            (None, None) => true,
            _ => false,
        };
        let resets = match (self.resets, last.resets) {
            (Some(a), Some(b)) => (a - b).num_seconds().abs() < 60,
            (None, None) => true,
            _ => false,
        };
        self.state == last.state && close(self.pct, last.pct) && close(self.amount, last.amount) && resets
            && self.detail == last.detail
    }

    /// The window restarted between `last` and this reading.
    fn reset_from(&self, last: &Last) -> bool {
        if self.state != "ok" || last.state != "ok" {
            return false;
        }
        let moved = matches!((self.resets, last.resets),
            (Some(new), Some(old)) if new > old + Duration::minutes(RESET_SHIFT_MIN));
        let fell = matches!((self.pct, last.pct), (Some(new), Some(old)) if new + 1.0 <= old);
        // a credit balance that grew was topped up; any other amount that fell restarted
        let jumped = match (self.amount, last.amount) {
            (Some(new), Some(old)) if self.win == "credits" => new > old + 0.005,
            (Some(new), Some(old)) => new + 0.005 < old,
            _ => false,
        };
        moved || fell || jumped
    }
}

#[nolog]
fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

#[nolog]
fn text(v: &Value) -> String {
    v.as_str().map(str::trim).unwrap_or("").to_string()
}

/// A readout as series readings: the account itself first, then each window.
#[nolog]
fn readings(value: &Value) -> Vec<Reading> {
    let available = value["available"].as_bool().unwrap_or(false);
    let why = [text(&value["error"]), text(&value["detail"])]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(": ");
    let state = if available {
        "ok"
    } else if why.is_empty() {
        "unsupported"
    } else {
        "unavailable"
    };
    let mut out = vec![Reading {
        win: String::new(), grp: String::new(), model: String::new(), state, pct: None, amount: None, unit: None,
        resets: None,
        label: value["label"].as_str().or_else(|| value["email"].as_str()).filter(|s| !s.trim().is_empty()).map(str::to_string),
        detail: Some(gist(&why, 300)).filter(|d| !d.is_empty() && !available),
    }];
    if !available {
        return out;
    }
    for l in value["limits"].as_array().into_iter().flatten().filter(|l| l.is_object()).take(MAX_WINDOWS) {
        out.push(Reading {
            win: Some(text(&l["kind"])).filter(|k| !k.is_empty()).unwrap_or_else(|| "window".into()),
            grp: text(&l["group"]),
            model: text(&l["model"]),
            state: "ok",
            pct: num(&l["percent"]),
            amount: num(&l["amount"]),
            unit: l["unit"].as_str().map(str::to_string),
            resets: l["resets_at"].as_str().and_then(parse_ts),
            label: l["label"].as_str().map(str::to_string),
            detail: None,
        });
    }
    if let Some(balance) = num(&value["credits"]["balance"]) {
        out.push(Reading {
            win: "credits".into(), grp: String::new(), model: String::new(), state: "ok", pct: None,
            amount: Some(balance), unit: value["credits"]["unit"].as_str().map(str::to_string), resets: None,
            label: None, detail: None,
        });
    }
    if value["mode"] == "apikey" {
        out.push(Reading {
            win: "spend".into(), grp: String::new(), model: String::new(), state: "ok", pct: None,
            amount: num(&value["spend"]["usd_total"]), unit: Some("USD".into()), resets: None,
            label: Some("metered spend".into()), detail: None,
        });
    }
    out
}

/// Record one readout of `account`, observed (asked) at `observed`.
#[nolog]
pub async fn record(engine: &Engine, account: &str, provider: &str, observed: DateTime<Utc>, value: &Value) {
    tracing::info!(account, provider, available = value["available"].as_bool().unwrap_or(false),
        window_count = value["limits"].as_array().map_or(0, Vec::len), "usage history observation");
    if let Err(e) = write(engine, account, provider, observed, value).await {
        // Database errors may quote a rejected provider value. Keep the safe
        // SQLSTATE, never the raw message/context or raw reading.
        let sqlstate = e.downcast_ref::<tokio_postgres::Error>()
            .and_then(|e| e.as_db_error()).map(|e| e.code().code()).unwrap_or("unknown");
        tracing::warn!(account, provider, sqlstate, "usage history could not be recorded");
    }
}

#[nolog]
async fn write(engine: &Engine, account: &str, provider: &str, observed: DateTime<Utc>, value: &Value) -> anyhow::Result<()> {
    let client = engine.db.get().await?;
    for r in readings(value) {
        let key = r.key(account);
        // the map's guard must not live across an await
        let cached = engine.usage.history.pin().get(&key).cloned();
        let last = match cached {
            Some(l) => Some(l),
            None => seed(&client, account, &r).await?,
        };
        if let Some(l) = &last {
            if observed <= l.at || (r.same(l) && observed - l.at < Duration::minutes(KEEPALIVE_MIN)) {
                continue;
            }
            if r.reset_from(l) {
                client.execute(
                    "INSERT INTO ot.usage_history (observed_at, provider, account, win, grp, model, event, state,
                            used_pct, amount, unit, resets_at, prev_pct, prev_amount, prev_resets_at, label)
                     VALUES ($1, $2, $3, $4, $5, $6, 'reset', 'ok', $7, $8, $9, $10, $11, $12, $13, $14)",
                    &[&observed, &provider, &account, &r.win, &r.grp, &r.model, &r.pct, &r.amount, &r.unit,
                      &r.resets, &l.pct, &l.amount, &l.resets, &r.label],
                ).await?;
            }
        }
        client.execute(
            "INSERT INTO ot.usage_history (observed_at, provider, account, win, grp, model, state, used_pct, amount,
                    unit, resets_at, label, detail)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
            &[&observed, &provider, &account, &r.win, &r.grp, &r.model, &r.state, &r.pct, &r.amount, &r.unit,
              &r.resets, &r.label, &r.detail],
        ).await?;
        engine.usage.history.pin().insert(key, Last {
            at: observed, state: r.state.to_string(), pct: r.pct, amount: r.amount, resets: r.resets, detail: r.detail,
        });
    }
    Ok(())
}

/// The series' last reading from the table (after a restart).
#[nolog]
async fn seed(client: &tokio_postgres::Client, account: &str, r: &Reading) -> anyhow::Result<Option<Last>> {
    let row = client.query_opt(
        "SELECT observed_at, state, used_pct, amount, resets_at, detail FROM ot.usage_history
          WHERE account = $1 AND win = $2 AND grp = $3 AND model = $4 AND event = 'reading'
          ORDER BY observed_at DESC LIMIT 1",
        &[&account, &r.win, &r.grp, &r.model],
    ).await?;
    Ok(row.map(|row| Last {
        at: row.get(0), state: row.get(1), pct: row.get(2), amount: row.get(3), resets: row.get(4), detail: row.get(5),
    }))
}

/// Drop rows past retention, a small batch at a time.
#[logged]
pub async fn prune(engine: &Engine) {
    let result: anyhow::Result<u64> = async {
        let mut total = 0;
        for _ in 0..PRUNE_ROUNDS {
            let client = engine.db.get().await?;
            let n = client.execute(
                "DELETE FROM ot.usage_history WHERE id IN (
                   SELECT id FROM ot.usage_history WHERE observed_at < now() - make_interval(days => $1::int)
                    ORDER BY observed_at LIMIT $2)",
                &[&(RETAIN_DAYS as i32), &PRUNE_BATCH],
            ).await?;
            drop(client);
            total += n;
            if n < PRUNE_BATCH as u64 || engine.shutdown.is_cancelled() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Ok(total)
    }.await;
    match result {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "old usage history pruned"),
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "usage history could not be pruned"),
    }
}

/// The periods the analytics panel offers, with their bucket width: about
/// 250-300 buckets each, so a series is never more than that many points.
const RANGES: [(&str, i64, i64); 4] = [("24h", 24 * 3600, 300), ("7d", 7 * 86400, 2400),
    ("30d", 30 * 86400, 3 * 3600), ("90d", 90 * 86400, 9 * 3600)];
/// At most this many series (and so `MAX_SERIES` × buckets rows) per answer.
const MAX_SERIES: i64 = 64;
const MAX_RESETS: i64 = 2000;
const MAX_STATES: i64 = 4000;

/// A period name the panel may ask for ("24h", "7d", "30d", "90d").
#[logged]
pub fn range_secs(range: &str) -> Option<(i64, i64)> {
    RANGES.iter().find(|(name, _, _)| *name == range).map(|(_, span, bucket)| (*span, *bucket))
}

/// The recorded history for the analytics panel (`GET /api/usage/history`),
/// downsampled in the database: per series (account, window, group, model)
/// one row per time bucket with its first, last, lowest, highest and mean
/// value and when its readings were taken. Only real readings with a value
/// count; a window the provider reported without a number is a gap, never 0.
/// Also each account's availability changes and every reset in the period,
/// unsampled (both capped), so a graph can break its line where the account
/// was unreadable and never draw a reset as consumption.
#[nolog]
pub async fn history(engine: &Engine, range: &str) -> anyhow::Result<Value> {
    let (span, bucket) = range_secs(range).ok_or_else(|| anyhow::anyhow!("unknown range {range}"))?;
    let until = Utc::now();
    let since = until - Duration::seconds(span);
    let client = engine.db.get().await?;
    let ts = |t: Option<DateTime<Utc>>| t.map(crate::util::iso);
    // the latest reading of each series in the period: its labels, unit and kind
    let metas = client.query(
        "SELECT DISTINCT ON (account, win, grp, model) account, win, grp, model, provider, observed_at,
                used_pct, amount, unit, resets_at, label
           FROM ot.usage_history
          WHERE observed_at >= $1 AND observed_at <= $2 AND event = 'reading' AND win <> ''
          ORDER BY account, win, grp, model, observed_at DESC, id DESC LIMIT $3",
        &[&since, &until, &(MAX_SERIES + 1)],
    ).await?;
    let buckets = client.query(
        "SELECT account, win, grp, model, count(*), min(observed_at), max(observed_at),
                (array_agg(coalesce(used_pct, amount) ORDER BY observed_at, id))[1],
                (array_agg(coalesce(used_pct, amount) ORDER BY observed_at DESC, id DESC))[1],
                min(coalesce(used_pct, amount)), max(coalesce(used_pct, amount)), avg(coalesce(used_pct, amount))
           FROM ot.usage_history
          WHERE observed_at >= $1 AND observed_at <= $2 AND event = 'reading' AND win <> '' AND state = 'ok'
            AND coalesce(used_pct, amount) IS NOT NULL
          GROUP BY account, win, grp, model, date_bin(make_interval(secs => $3), observed_at, $1)
          ORDER BY account, win, grp, model, min(observed_at) LIMIT $4",
        &[&since, &until, &(bucket as f64), &(MAX_SERIES * (span / bucket + 2))],
    ).await?;
    let resets = client.query(
        "SELECT observed_at, account, win, grp, model, used_pct, amount, resets_at, prev_pct, prev_amount, prev_resets_at
           FROM ot.usage_history WHERE observed_at >= $1 AND observed_at <= $2 AND event = 'reset'
          ORDER BY observed_at, id LIMIT $3",
        &[&since, &until, &(MAX_RESETS + 1)],
    ).await?;
    // availability: only the rows where an account's state changed
    let states = client.query(
        "SELECT account, provider, observed_at, state, detail FROM (
           SELECT account, provider, observed_at, state, detail, id,
                  lag(state) OVER (PARTITION BY account ORDER BY observed_at, id) AS prev
             FROM ot.usage_history
            WHERE observed_at >= $1 AND observed_at <= $2 AND event = 'reading' AND win = '') s
          WHERE prev IS DISTINCT FROM state ORDER BY observed_at, id LIMIT $3",
        &[&since, &until, &(MAX_STATES + 1)],
    ).await?;
    // the label each account last carried (a provider's own login has no registry row to name it)
    let labels = client.query(
        "SELECT DISTINCT ON (account) account, label FROM ot.usage_history
          WHERE observed_at >= $1 AND observed_at <= $2 AND event = 'reading' AND win = '' AND label IS NOT NULL
          ORDER BY account, observed_at DESC, id DESC LIMIT $3",
        &[&since, &until, &MAX_SERIES],
    ).await?;
    let oldest: Option<DateTime<Utc>> = client.query_one("SELECT min(observed_at) FROM ot.usage_history", &[]).await?.get(0);
    drop(client);

    let key = |r: &tokio_postgres::Row| -> (String, String, String, String) { (r.get(0), r.get(1), r.get(2), r.get(3)) };
    let mut points: std::collections::HashMap<(String, String, String, String), Vec<Value>> = Default::default();
    for r in &buckets {
        points.entry(key(r)).or_default().push(serde_json::json!({
            "n": r.get::<_, i64>(4), "t0": crate::util::iso(r.get(5)), "t1": crate::util::iso(r.get(6)),
            "first": r.get::<_, Option<f64>>(7), "last": r.get::<_, Option<f64>>(8),
            "min": r.get::<_, Option<f64>>(9), "max": r.get::<_, Option<f64>>(10), "avg": r.get::<_, Option<f64>>(11),
        }));
    }
    let view = engine.accounts.view();
    let labels: std::collections::HashMap<String, String> = labels.iter().map(|r| (r.get(0), r.get(1))).collect();
    // the login's email where the registry knows it, else the one its readout carried
    let account_label = |id: &str| {
        let a = view.get(id);
        a.filter(|a| a.email.as_deref().is_some_and(|e| !e.is_empty())).map(|a| a.display())
            .or_else(|| labels.get(id).cloned())
            .or_else(|| a.map(|a| a.display()))
            .unwrap_or_else(|| id.to_string())
    };
    let series: Vec<Value> = metas.iter().take(MAX_SERIES as usize).map(|r| {
        let account: String = r.get(0);
        let used: Option<f64> = r.get(6);
        serde_json::json!({
            "account": account, "account_label": account_label(&account), "window": r.get::<_, String>(1),
            "group": r.get::<_, String>(2), "model": r.get::<_, String>(3), "provider": r.get::<_, String>(4),
            "kind": if used.is_some() { "percent" } else { "amount" },
            "latest": { "observed_at": crate::util::iso(r.get(5)), "used_pct": used,
                        "amount": r.get::<_, Option<f64>>(7), "resets_at": ts(r.get(9)) },
            "unit": r.get::<_, Option<String>>(8), "label": r.get::<_, Option<String>>(10),
            "points": points.remove(&key(r)).unwrap_or_default(),
        })
    }).collect();
    let resets_out: Vec<Value> = resets.iter().take(MAX_RESETS as usize).map(|r| serde_json::json!({
        "at": crate::util::iso(r.get(0)), "account": r.get::<_, String>(1), "window": r.get::<_, String>(2),
        "group": r.get::<_, String>(3), "model": r.get::<_, String>(4), "used_pct": r.get::<_, Option<f64>>(5),
        "amount": r.get::<_, Option<f64>>(6), "resets_at": ts(r.get(7)), "prev_pct": r.get::<_, Option<f64>>(8),
        "prev_amount": r.get::<_, Option<f64>>(9), "prev_resets_at": ts(r.get(10)),
    })).collect();
    let states_out: Vec<Value> = states.iter().take(MAX_STATES as usize).map(|r| {
        let account: String = r.get(0);
        serde_json::json!({
            "account": account, "account_label": account_label(&account), "provider": r.get::<_, String>(1),
            "at": crate::util::iso(r.get(2)), "state": r.get::<_, String>(3), "detail": r.get::<_, Option<String>>(4),
        })
    }).collect();
    Ok(serde_json::json!({
        "range": range, "since": crate::util::iso(since), "until": crate::util::iso(until), "bucket_s": bucket,
        "retain_days": RETAIN_DAYS, "keepalive_min": KEEPALIVE_MIN, "oldest": ts(oldest),
        "series": series, "resets": resets_out, "states": states_out,
        "truncated": metas.len() as i64 > MAX_SERIES || resets.len() as i64 > MAX_RESETS
            || states.len() as i64 > MAX_STATES || buckets.len() as i64 >= MAX_SERIES * (span / bucket + 2),
    }))
}
