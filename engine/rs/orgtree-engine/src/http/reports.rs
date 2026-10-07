//! The cross-organization notice inventory the desktop pages, and the UI's
//! crash reports (saved under diagnostics, mailed to a `crash-reporting`
//! agent when the org has a live one).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::http::error::ApiResult;
use crate::util::{gist, uid};

const NOTICE_PAGE: usize = 500;
const CRASH_STR_MAX: usize = 4000;
const CRASH_STACK_MAX: usize = 20_000;
const CRASH_BREADCRUMBS_MAX: usize = 40;
const CRASH_KEEP: usize = 200;

#[derive(Deserialize, Debug, Default)]
pub struct PageQuery {
    #[serde(default)]
    offset: usize,
}

/// Every open organization's notices, paged.
#[logged]
pub async fn notifications(State(e): State<Arc<Engine>>, Query(q): Query<PageQuery>) -> ApiResult<Json<Value>> {
    let client = e.db.get().await?;
    let mut all: Vec<Value> = Vec::new();
    for o in e.orgs.all() {
        all.extend(crate::domain::notices::for_org(&client, o.id, &o.slug).await?);
    }
    let total = all.len();
    let active: Vec<Value> = all.iter().map(|n| json!({ "org": n["org"], "id": n["id"] })).collect();
    let page: Vec<Value> = all.into_iter().skip(q.offset).take(NOTICE_PAGE).collect();
    let end = q.offset + page.len();
    let truncated = end < total;
    Ok(Json(json!({ "notices": page, "total": total, "truncated": truncated,
                    "next_offset": if truncated { Some(end) } else { None }, "active": active })))
}

fn clip(v: &Value, max: usize) -> Value {
    match v.as_str() {
        Some(s) => json!(s.chars().take(max).collect::<String>()),
        None => Value::Null,
    }
}

#[derive(Deserialize, Debug)]
pub struct CrashBody {
    org: Option<String>,
    report: Value,
}

/// A renderer crash: keep it, log it, and tell the org's crash agent if it has one.
#[logged]
pub async fn crash_report(State(e): State<Arc<Engine>>, Json(b): Json<CrashBody>) -> ApiResult<Json<Value>> {
    let r = &b.report;
    let id = r["id"].as_str().map(|s| s.chars().take(64).collect::<String>()).unwrap_or_else(|| uid("c"));
    let mut report = json!({
        "id": id, "at": r["at"], "kind": clip(&r["kind"], 64), "message": clip(&r["message"], CRASH_STR_MAX),
        "stack": clip(&r["stack"], CRASH_STACK_MAX), "url": clip(&r["url"], 1000), "userAgent": clip(&r["userAgent"], 500),
        "org": b.org,
    });
    if r["componentStack"].is_string() {
        report["componentStack"] = clip(&r["componentStack"], CRASH_STACK_MAX);
    }
    if let Some(bc) = r["breadcrumbs"].as_array() {
        let n = bc.len();
        report["breadcrumbs"] = json!(bc
            .iter()
            .skip(n.saturating_sub(CRASH_BREADCRUMBS_MAX))
            .filter(|x| x.is_object())
            .map(|x| json!({ "at": x["at"], "kind": clip(&x["kind"], 32), "detail": clip(&x["detail"], 300) }))
            .collect::<Vec<_>>());
    }
    tracing::error!(report = %gist(&report.to_string(), 2000), "the UI reported a crash");
    let dir = e.cfg.path("diagnostics").join("crash-reports");
    let name = format!("{}-{}.json", chrono::Utc::now().format("%Y%m%d-%H%M%S"), id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_"));
    let saved = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(&name), serde_json::to_vec_pretty(&report).unwrap_or_default())).is_ok();
    // keep the newest few hundred
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut files: Vec<_> = rd.filter_map(|x| x.ok()).map(|x| x.path()).collect();
        files.sort();
        if files.len() > CRASH_KEEP {
            for f in &files[..files.len() - CRASH_KEEP] {
                let _ = std::fs::remove_file(f);
            }
        }
    }
    let mut delivered = false;
    if let Some(org) = b.org.as_deref().filter(|s| !s.is_empty()).and_then(|s| e.orgs.get(s)) {
        let client = e.db.get().await?;
        let live = client
            .query_opt("SELECT 1 FROM ot.agents WHERE org_id = $1 AND name = 'crash-reporting' AND state = 'live'", &[&org.id])
            .await?
            .is_some();
        drop(client);
        if live {
            let mut body = format!(
                "[UI CRASH REPORT {}] {}\n{}\nurl: {}\n",
                id,
                report["kind"].as_str().unwrap_or("unknown"),
                report["message"].as_str().unwrap_or(""),
                report["url"].as_str().unwrap_or("")
            );
            if let Some(s) = report["stack"].as_str() {
                body.push_str("\nstack:\n");
                body.push_str(&gist(s, 6000));
            }
            let mut out=Outgoing::new(From::User,"crash-reporting",&body);
            out.ev=Some(crate::events::typed("runtime.ui_crash_report","@user",json!({"kind":"org","org":org.slug}),
                json!({"summary":gist(&body,300),"report":{"kind":report["kind"].as_str().unwrap_or("unknown"),"message":report["message"].as_str().unwrap_or(""),"stack":report["stack"],"url":report["url"],"at":report["at"].as_str().unwrap_or("")}})));
            delivered = mail::send(&e,org.id,out).await.is_ok();
        }
    }
    Ok(Json(json!({ "id": id, "saved": saved, "delivered": delivered, "path": name })))
}

#[derive(Deserialize, Debug, Default)]
pub struct CrashListQuery {
    org: Option<String>,
    #[serde(default)]
    limit: usize,
}

/// The kept crash reports, newest first.
#[logged]
pub async fn crash_reports(State(e): State<Arc<Engine>>, Query(q): Query<CrashListQuery>) -> ApiResult<Json<Value>> {
    let dir = e.cfg.path("diagnostics").join("crash-reports");
    let limit = if q.limit == 0 { 50 } else { q.limit.min(200) };
    let mut files: Vec<_> = std::fs::read_dir(&dir).map(|rd| rd.filter_map(|x| x.ok()).map(|x| x.path()).collect()).unwrap_or_default();
    files.sort();
    files.reverse();
    let mut out = Vec::new();
    for f in files {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { continue };
        if let Some(o) = &q.org {
            if v["org"].as_str() != Some(o.as_str()) {
                continue;
            }
        }
        out.push(v);
        if out.len() >= limit {
            break;
        }
    }
    Ok(Json(json!({ "reports": out })))
}
