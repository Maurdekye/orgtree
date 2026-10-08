//! Turn-failure recovery and the alerts that go with it, as in 3.x (parity
//! batch 4a). 3.x source: `supervisor.py` at `4ddbfb1`.
//!
//! - P34: a transient connection failure (or a CLI that died mid-answer) is
//!   retried with a connection freeze, 30 s doubling to 300 s, at most
//!   `NET_RETRY_MAX` times; when the retries are spent the agent and its
//!   superior are told once (`_retry_exhausted`).
//! - P35: a rejected credential (401) parks the agent with no reset time;
//!   OpenRouter balance refusals (402) are probed every 5 minutes and parked
//!   after `NET_RETRY_MAX` in a row. A park is announced to the superior once
//!   per episode (`_parked_announce`).
//! - P33: background task deaths and orphans are mailed to the agent.
//! - P36: the sender of mail that waits unread 45 s is told once.
//!
//! Run counters live in `ot.agents.extra` (one short statement each) and are
//! cleared by a turn that completes.

use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};

use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::util::{gist, iso, now_iso};

/// Attempts before a transient failure falls to manual (3.x `NET_RETRY_MAX`).
pub const NET_RETRY_MAX: i64 = 4;
/// The blind recheck horizon for a balance refusal (3.x `PROBE_FLOOR`).
pub const PROBE_FLOOR_S: i64 = 300;
/// Mail unread this long while its recipient works tells the sender (3.x `STEER_LATE_AFTER`).
pub const STEER_LATE_AFTER_S: i64 = 45;

/// What a failed turn is, for recovery. `None` from `classify` = terminal.
#[derive(Debug, Clone, PartialEq)]
pub enum Class {
    /// transient: retried with backoff; the text names which classifier spoke
    Net(String),
    /// the provider rejected the credential (401)
    Auth,
    /// OpenRouter refused the request against the key's balance (402)
    Balance,
}

/// 3.x `_looks_like_connection_failure`: narrow and positive, never a
/// catch-all (retrying any failure turns a bad argv into an endless loop).
#[logged]
pub fn looks_like_connection_failure(blob: &str) -> bool {
    let b = blob.to_lowercase();
    [
        "econnrefused", "econnreset", "etimedout", "econnaborted", "enetunreach", "ehostunreach", "enotfound",
        "eai_again", "socket hang up", "fetch failed", "network error", "networkerror", "connection refused",
        "connection reset", "connection error", "getaddrinfo", "dns lookup failed",
    ]
    .iter()
    .any(|p| b.contains(p))
}

/// Decide the class once (3.x "WHICH CLASS, decided ONCE"). On the OpenRouter
/// lane a typed HTTP status chooses exclusively; elsewhere the status is read
/// only for 401, and prose or the turn's shape decides a transient failure.
/// `died_in_flight`: the CLI exited after it had answered but before a result.
#[logged]
pub fn classify(error: &str, res: &Value, openrouter: bool, died_in_flight: bool) -> Option<Class> {
    let status = res.get("api_error_status").and_then(Value::as_i64);
    if openrouter {
        if let Some(s) = status {
            return match s {
                401 => Some(Class::Auth),
                402 => Some(Class::Balance),
                s if s >= 500 => Some(Class::Net(format!("the provider answered {s}"))),
                _ => None,
            };
        }
    }
    if status == Some(401) {
        return Some(Class::Auth);
    }
    if looks_like_connection_failure(error) {
        return Some(Class::Net("network interruption".into()));
    }
    if died_in_flight {
        return Some(Class::Net("the CLI died mid-response".into()));
    }
    None
}

/// `4m47s` / `35s` / `0.4s` (3.x `_dur`).
#[logged]
pub fn dur(secs: f64) -> String {
    if secs < 10.0 {
        format!("{secs:.1}s")
    } else if secs < 60.0 {
        format!("{secs:.0}s")
    } else {
        format!("{}m{:02}s", (secs / 60.0) as i64, (secs % 60.0) as i64)
    }
}

/// Add one to a run counter in `ot.agents.extra` and return its new value.
#[logged]
pub async fn bump(engine: &Engine, agent_id: i64, key: &str) -> Result<i64> {
    let client = engine.db.get().await?;
    let row = client
        .query_one(
            "UPDATE ot.agents SET extra = jsonb_set(extra, ARRAY[$2::text],
                    to_jsonb(coalesce((extra->>$2)::bigint, 0) + 1))
              WHERE id = $1 RETURNING (extra->>$2)::bigint",
            &[&agent_id, &key],
        )
        .await?;
    Ok(row.get::<_, Option<i64>>(0).unwrap_or(1))
}

/// A turn completed: every failure run of this agent is over.
#[logged]
pub async fn clear_runs(engine: &Engine, agent_id: i64) -> Result<()> {
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.agents SET extra = extra - 'net_fail_run' - 'balance_probe_run' - 'parked_run' - 'hard_fail_run'
              WHERE id = $1 AND (extra ? 'net_fail_run' OR extra ? 'balance_probe_run' OR extra ? 'parked_run'
                                 OR extra ? 'hard_fail_run')",
            &[&agent_id],
        )
        .await?;
    Ok(())
}

/// The connection-freeze record for retry `run` (3.x writes it while
/// `run <= NET_RETRY_MAX`). The engine's freeze timer wakes a pure connection
/// freeze with no grace and regardless of auto-resume, with `wake_text`.
#[logged]
pub fn connection_freeze(run: i64, kind: &str, error: &str, account: Option<&str>) -> Value {
    let delay = (30_i64 << (run - 1).clamp(0, 10)).min(300);
    let until = Utc::now() + chrono::Duration::seconds(delay);
    json!({
        "at": now_iso(), "until": iso(until), "error": gist(error, 300), "connection": true, "limit": false,
        "provenance": "observed", "account": account, "attempt": run,
        "label": format!("{kind} — attempt {run}/{NET_RETRY_MAX}"),
        "wake_text": retry_banner(kind, run),
    })
}

/// What the retried turn is told (3.x: name the retry, never a bare replay).
#[logged]
fn retry_banner(kind: &str, run: i64) -> String {
    format!(
        "Your previous turn died part-way through ({kind}) and is being retried — attempt {run} of {NET_RETRY_MAX}. \
         Whatever that turn had ALREADY done was not undone: check your real state (files on disk, `git status`, \
         mail you may have already sent, processes you may have already started) before redoing any of it.\n\n\
         ⚠ DO NOT TRUST YOUR OWN LAST MESSAGE as a record of what happened. The turn died mid-response, so \
         anything you had ANNOUNCED may have been said without the tool call behind it ever running. Trust the \
         DISK, not the transcript. Continue where you left off."
    )
}

/// A balance refusal: probe again in 5 minutes, or park after `NET_RETRY_MAX`
/// in a row (3.x `balance_probe_run`). Returns (record, parked).
#[logged]
pub fn balance_freeze(run: i64, error: &str, account: Option<&str>) -> (Value, bool) {
    if run >= NET_RETRY_MAX {
        // a park has no reset time, so `until` carries the remedy (3.x shape):
        // the desk badge and the org banner show it
        let remedy = format!("balance refused {run} turns running — check balance or in-flight requests, then resume manually");
        let rec = json!({
            "at": now_iso(), "until": remedy, "error": gist(error, 300), "limit": false, "cause": "balance",
            "provenance": "observed", "account": account, "parked": true, "label": remedy,
        });
        return (rec, true);
    }
    let until = Utc::now() + chrono::Duration::seconds(PROBE_FLOOR_S);
    let rec = json!({
        "at": now_iso(), "until": iso(until), "error": gist(error, 300), "limit": true, "balance": true,
        "provenance": "observed", "account": account, "attempt": run,
        "label": format!("balance refused — check balance or in-flight requests, then resume; probing again in ~5 min ({run}/{NET_RETRY_MAX})"),
        "wake_text": "Retrying after the provider refused the request against the key's balance. Continue where you left off.",
    });
    (rec, false)
}

/// A rejected credential: parked with no reset time (no timer can fix it).
/// `until` carries the remedy (3.x shape): the desk badge and the org banner
/// show it. An OpenRouter key is replaced in the app, not with a CLI login.
#[logged]
pub fn auth_freeze(error: &str, account: Option<&str>, openrouter: bool) -> Value {
    let remedy = if openrouter {
        "credential rejected — replace the OpenRouter key in App settings → Providers, then resume"
    } else {
        "credential rejected — replace it, then resume"
    };
    json!({
        "at": now_iso(), "until": remedy, "error": gist(error, 300), "limit": false, "cause": "auth",
        "provenance": "observed", "account": account, "parked": true, "label": remedy,
    })
}

/// The agent, its live superior (if any) and the org, for a card.
struct Who {
    name: String,
    generation: i64,
    parent: Option<String>,
    account: Option<String>,
    session: Option<String>,
    org: String,
}

#[logged]
async fn who(engine: &Engine, org_id: i64, agent_id: i64) -> Result<Option<Who>> {
    let client = engine.db.get().await?;
    let row = client
        .query_opt(
            "SELECT a.name, a.generation, p.name, a.account, a.session_id, o.slug
               FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
               LEFT JOIN ot.agents p ON p.id = a.parent_id AND p.state = 'live'
              WHERE a.id = $1 AND a.org_id = $2 AND a.state = 'live'",
            &[&agent_id, &org_id],
        )
        .await?;
    Ok(row.map(|r| Who {
        name: r.get(0),
        generation: r.get::<_, i32>(1) as i64,
        parent: r.get(2),
        account: r.get(3),
        session: r.get(4),
        org: r.get(5),
    }))
}

/// Engine mail that wakes its recipient (`to` = an agent name or `user`).
#[logged]
async fn card(engine: &Arc<Engine>, org_id: i64, to: &str, body: &str, ev: Value, notice: bool) -> Result<()> {
    let mut out = Outgoing::new(From::System, to, body);
    out.kind = if notice { "notice".into() } else { "message".into() };
    out.notice = notice;
    out.ev = Some(ev);
    mail::send(engine, org_id, out).await?;
    Ok(())
}

/// The transient retries are spent: tell the agent (it holds the work) and
/// its superior, or the user for a top-level agent (3.x `_retry_exhausted`).
/// Never fails the turn it reports on.
#[logged]
pub async fn retry_exhausted(engine: &Arc<Engine>, org_id: i64, agent_id: i64, run: i64, err: &str, kind: &str) {
    if let Err(e) = async {
        let Some(w) = who(engine, org_id, agent_id).await? else { return Ok(()) };
        let err = gist(err, 300);
        let session = w.session.clone().unwrap_or_default();
        let body = format!(
            "Your turn failed {run} times in a row ({kind}) and orgtree has stopped retrying it. Whatever those turns \
             had already done was not undone: check your real state (files, git, sent mail, started processes) and \
             continue or report. Last error: {err}"
        );
        let ev = crate::events::turn_failed_repeated(&w.org, &w.name, &session, run, kind, &err);
        card(engine, org_id, &w.name, &body, ev, false).await?;
        let (to, audience) = match &w.parent { Some(p) => (p.as_str(), "superior"), None => ("user", "user") };
        let body = format!("{}'s turn failed {run} times in a row ({kind}); its retries are spent. Last error: {err}", w.name);
        let ev = crate::events::report_stalled_repeated(&w.org, &w.name, w.generation, audience, run, kind, &err);
        card(engine, org_id, to, &body, ev, false).await
    }.await {
        tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "could not report exhausted retries");
    }
}

/// An agent was frozen with no reset time: tell its superior (or the user)
/// once per stuck episode (3.x `_parked_announce`, `parked_run`).
#[logged]
pub async fn parked(engine: &Arc<Engine>, org_id: i64, agent_id: i64, kind: &str, err: &str) {
    if let Err(e) = async {
        if bump(engine, agent_id, "parked_run").await? != 1 {
            return Ok(());
        }
        let Some(w) = who(engine, org_id, agent_id).await? else { return Ok(()) };
        let (headline, detail) = match kind {
            "auth" => (
                "had its credential REJECTED",
                "Its provider answered the turn with a 401: the credential it ran on was rejected. This is not a \
                 usage limit: there is no reset time, so nothing will wake it. The remedy is the operator's: replace \
                 the credential, then resume it. Resuming it first only spends another turn on the same refusal. If \
                 you are not the one who holds that credential, pass this up.".to_string(),
            ),
            _ => (
                "is parked after repeated BALANCE refusals",
                format!(
                    "Its provider (the OpenRouter gateway) answered {NET_RETRY_MAX} turns in a row with a 402: the \
                     request was refused against the key's credit balance. This is not proof the balance is exhausted, \
                     and it is not a usage limit. There is no reset time and nothing will wake it. The remedy is the \
                     operator's: check the OpenRouter balance or wait for in-flight requests to settle, then resume it."
                ),
            ),
        };
        let lane = w.account.clone().unwrap_or_else(|| "primary".into());
        let err = gist(err, 300);
        let (to, audience) = match &w.parent { Some(p) => (p.as_str(), "superior"), None => ("user", "user") };
        let body = format!("{} {headline}. {detail}\nLast error: {err}", w.name);
        let ev = crate::events::report_parked(&w.org, &w.name, w.generation, audience, headline, &detail, &lane, Some(&err));
        card(engine, org_id, to, &body, ev, false).await
    }.await {
        tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "could not announce a parked agent");
    }
}

/// The CLI died holding live background subagents: tell the agent so it
/// stops waiting for a notification that died with the process (3.x
/// `_bg_orphaned`). `rows` are the card's orphan rows.
#[logged]
pub async fn subagent_died(engine: &Arc<Engine>, org_id: i64, agent_id: i64, rows: Vec<Value>, reason: &str) {
    if let Err(e) = async {
        let Some(w) = who(engine, org_id, agent_id).await? else { return Ok(()) };
        let session = w.session.clone().unwrap_or_default();
        let list = rows.iter().take(20).map(|r| {
            let out = r["output_file"].as_str().map(|f| format!(" (partial output: {f})")).unwrap_or_default();
            format!("- {} {}{out}", r["id"].as_str().unwrap_or(""), r["description"].as_str().unwrap_or(""))
        }).collect::<Vec<_>>().join("\n");
        let body = format!(
            "{} background subagent(s) you were waiting on died before finishing ({reason}). Their completion \
             notices died with the process, so nothing else will arrive:\n{list}",
            rows.len()
        );
        let Some(ev) = crate::events::subagent_died(&w.org, &w.name, &session, rows, reason) else { return Ok(()) };
        card(engine, org_id, &w.name, &body, ev, false).await
    }.await {
        tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "could not report orphaned background subagents");
    }
}

/// A background task stopped without finishing while the CLI lives (3.x
/// `_bg_task_stopped`): a waking message, not a notice.
#[logged]
pub async fn task_stopped(engine: &Arc<Engine>, org_id: i64, agent_id: i64, stopped: crate::runtime::tasks::Stopped) {
    if let Err(e) = async {
        let Some(w) = who(engine, org_id, agent_id).await? else { return Ok(()) };
        let out = stopped.output_file.as_deref().map(|f| format!(" Output: {f}")).unwrap_or_default();
        let body = format!(
            "A background task you were waiting on stopped without finishing: {} ({}). {}{out}",
            stopped.description, stopped.task_id, stopped.summary
        );
        let summary = Some(stopped.summary.as_str()).filter(|s| !s.is_empty());
        let ev = crate::events::background_task_stopped(&w.org, &w.name, &stopped.task_id, &stopped.description,
                                                        summary, stopped.output_file.as_deref());
        card(engine, org_id, &w.name, &body, ev, false).await
    }.await {
        tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "could not report a stopped background task");
    }
}

/// Mail an agent sent is still unread by a working recipient: one passive
/// notice to the sender (3.x `_steer_late_sweep`, D-236).
#[logged]
pub async fn delivery_unread(engine: &Arc<Engine>, org_id: i64, org: &str, sender: &str, recipient: &str,
                             mail_uid: &str, at: &str, waited_s: f64) {
    let waited = dur(waited_s);
    let body = format!(
        "Your mail to {recipient} is still unread after {waited}: it is in the middle of a long step and reads new \
         mail at its next tool boundary or when its turn ends. Nothing is lost; this is only a delay."
    );
    let ev = crate::events::delivery_unread(org, recipient, mail_uid, sender, at, &waited);
    if let Err(e) = card(engine, org_id, sender, &body, ev, true).await {
        tracing::warn!(sender, recipient, error = %format!("{e:#}"), "could not report unread mail to its sender");
    }
}
