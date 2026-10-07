//! Usage over time (docket track-usage-over-time-and-show-usage-analytics,
//! phase 1: recorded, not shown). Every provider usage readout the engine
//! fetches is turned into one row per allowance window plus one for the
//! account's availability, in `ot.usage_history`.
//!
//! - A value the provider did not report is stored as NULL, never as zero;
//!   a failed or unsupported readout is a row with that state.
//! - A row is written only when the series changed, or hourly as a keepalive.
//! - A window whose reset time moved on, or whose used share fell, gets a
//!   `reset` row first, so a graph never draws a reset as consumption.
//! - Rows older than `RETAIN_DAYS` are pruned in small batches.
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

#[logged]
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

#[logged]
fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

#[logged]
fn text(v: &Value) -> String {
    v.as_str().map(str::trim).unwrap_or("").to_string()
}

/// A readout as series readings: the account itself first, then each window.
#[logged]
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
        resets: None, label: value["label"].as_str().map(str::to_string),
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
#[logged]
pub async fn record(engine: &Engine, account: &str, provider: &str, observed: DateTime<Utc>, value: &Value) {
    if let Err(e) = write(engine, account, provider, observed, value).await {
        tracing::warn!(account, provider, error = %format!("{e:#}"), "usage history could not be recorded");
    }
}

#[logged]
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
#[logged]
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

/// One account's recorded series since `since`, oldest first (for the later
/// analytics panel; nothing calls it yet).
#[allow(dead_code)]
#[logged]
pub async fn series(engine: &Engine, account: &str, since: DateTime<Utc>, limit: i64) -> anyhow::Result<Vec<Value>> {
    let client = engine.db.get().await?;
    let rows = client.query(
        "SELECT observed_at, provider, win, grp, model, event, state, used_pct, amount, unit, resets_at,
                prev_pct, prev_amount, prev_resets_at, label, detail
           FROM ot.usage_history WHERE account = $1 AND observed_at >= $2
          ORDER BY observed_at, id LIMIT $3",
        &[&account, &since, &limit.clamp(1, 20_000)],
    ).await?;
    let ts = |t: Option<DateTime<Utc>>| t.map(crate::util::iso);
    Ok(rows.iter().map(|r| serde_json::json!({
        "observed_at": crate::util::iso(r.get(0)), "provider": r.get::<_, String>(1), "window": r.get::<_, String>(2),
        "group": r.get::<_, String>(3), "model": r.get::<_, String>(4), "event": r.get::<_, String>(5),
        "state": r.get::<_, String>(6), "used_pct": r.get::<_, Option<f64>>(7), "amount": r.get::<_, Option<f64>>(8),
        "unit": r.get::<_, Option<String>>(9), "resets_at": ts(r.get(10)), "prev_pct": r.get::<_, Option<f64>>(11),
        "prev_amount": r.get::<_, Option<f64>>(12), "prev_resets_at": ts(r.get(13)),
        "label": r.get::<_, Option<String>>(14), "detail": r.get::<_, Option<String>>(15),
    })).collect())
}
