//! Questions and requests for the user: each agent has at most ONE open
//! request (question tabs, a credit request, scope items) that the user
//! resolves at one submit. Asking again amends it. The card the desk shows
//! is recomposed into the shape the renderer draws (`question`, `credit`,
//! `scope`, or a mixed `batch` of tabs) on every change; the outcome reaches
//! the agent as mail.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};
use tokio_postgres::Transaction;

use crate::changes::{self, Change};
use crate::domain::mail::{self, From, Outgoing};
use crate::domain::scope;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::refuse;
use crate::util::gist;

/// The parts a request is made of.
#[derive(Debug, Default, Clone)]
pub struct Parts {
    pub questions: Vec<Value>,
    pub credit: Option<Value>,
    pub scope: Option<Value>,
}

#[logged]
impl Parts {
    pub(crate) fn of(body: &Value) -> Parts {
        Parts {
            questions: body["parts"]["questions"].as_array().cloned().unwrap_or_default(),
            credit: body["parts"].get("credit").filter(|v| !v.is_null()).cloned(),
            scope: body["parts"].get("scope").filter(|v| !v.is_null()).cloned(),
        }
    }
    fn is_empty(&self) -> bool {
        self.questions.is_empty() && self.credit.is_none() && self.scope.is_none()
    }
}

/// Compose the card (what `AskInfo` shows) from the parts.
#[logged]
pub(crate) fn compose(uid: &str, rev: i32, p: &Parts) -> (String, Value) {
    let has_q = !p.questions.is_empty();
    let items: Vec<Value> = p.scope.as_ref().and_then(|s| s["items"].as_array().cloned()).unwrap_or_default();
    let kinds = has_q as u8 + p.credit.is_some() as u8 + (!items.is_empty()) as u8;
    let kind = if kinds > 1 {
        "batch"
    } else if has_q {
        "question"
    } else if p.credit.is_some() {
        "credit"
    } else {
        "scope"
    };
    let mut o = Map::new();
    o.insert("parts".into(), json!({ "questions": p.questions, "credit": p.credit, "scope": p.scope }));
    if has_q {
        o.insert("questions".into(), json!(p.questions));
        let first = &p.questions[0];
        for k in ["question", "header", "options", "multi"] {
            if let Some(v) = first.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
    }
    if let Some(c) = &p.credit {
        o.insert("old".into(), c["old"].clone());
        o.insert("new".into(), c["new"].clone());
        o.insert("reason".into(), c["reason"].clone());
    }
    if !items.is_empty() {
        o.insert("items".into(), json!(items));
        if p.credit.is_none() {
            o.insert("reason".into(), p.scope.as_ref().map(|s| s["reason"].clone()).unwrap_or(Value::Null));
        }
    }
    // Open requests always use the renderer's batch form, even when every
    // tab is a question. Keep the stored kind for resolved-card history.
    {
        let mut tabs = Vec::new();
        for q in &p.questions {
            let mut t = q.clone();
            t["kind"] = json!("question");
            tabs.push(t);
        }
        if let Some(c) = &p.credit {
            tabs.push(json!({ "kind": "credits", "id": uid, "old": c["old"], "new": c["new"], "reason": c["reason"] }));
        }
        let reason = p.scope.as_ref().map(|s| s["reason"].clone()).unwrap_or(Value::Null);
        for (i, it) in items.iter().enumerate() {
            tabs.push(json!({ "kind": "scope", "id": format!("{uid}:{i}"), "item": it, "label": item_label(it),
                              "reason": reason }));
        }
        o.insert("tabs".into(), json!(tabs));
    }
    o.insert("revs".into(), json!({ "ask": rev, "credits": rev, "scope": rev }));
    let work: Vec<Value> = p.questions.iter().filter_map(|q| q.get("work_item").cloned()).filter(|w| w.is_string()).collect();
    if !work.is_empty() {
        o.insert("work_items".into(), json!(work));
    }
    (kind.to_string(), Value::Object(o))
}

fn item_label(it: &Value) -> String {
    match it["kind"].as_str() {
        Some("dir") => format!("folder {} ({})", it["path"].as_str().unwrap_or("?"), it["mode"].as_str().unwrap_or("rw")),
        Some("tool") => format!("tool: {}", it["tool"].as_str().unwrap_or("?")),
        Some("mcp") => format!("MCP server {}", it["server"].as_str().unwrap_or("?")),
        Some("permission_mode") => format!("permission mode {}", it["mode"].as_str().unwrap_or("?")),
        _ => "access".into(),
    }
}

/// The asker: top-level agents and user-audience holders ask the user;
/// anyone else's request goes to its superior as mail.
#[derive(Debug)]
pub struct Asker {
    pub id: i64,
    pub name: String,
    pub generation: i32,
    pub superior: Option<String>,
    pub may_ask_user: bool,
}

#[logged]
pub async fn asker(engine: &Engine, org_id: i64, agent_id: i64) -> Result<Asker> {
    let client = engine.db.get().await?;
    let r = client
        .query_one(
            "SELECT a.name, a.generation, p.name,
                    a.parent_id IS NULL OR EXISTS (SELECT 1 FROM ot.audiences au WHERE au.org_id = $1 AND au.grantee = a.name
                         AND au.grantor = '@user' AND au.revoked_at IS NULL AND NOT au.paused)
               FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.id = $2",
            &[&org_id, &agent_id],
        )
        .await?;
    Ok(Asker { id: agent_id, name: r.get(0), generation: r.get(1), superior: r.get(2), may_ask_user: r.get(3) })
}

/// Add to (or open) the agent's one request. Returns the request's id.
#[logged]
async fn amend(engine: &Arc<Engine>, org: &OrgHandle, agent_id: i64, f: impl FnOnce(&mut Parts)) -> Result<String> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = tx
        .query_opt(
            "SELECT uid, body, rev FROM ot.asks WHERE agent_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE",
            &[&agent_id],
        )
        .await?;
    let (uid, mut parts, rev, existing) = match open {
        Some(r) => (r.get::<_, String>(0), Parts::of(&r.get::<_, Value>(1)), r.get::<_, i32>(2) + 1, true),
        None => (crate::util::uid("q"), Parts::default(), 1, false),
    };
    f(&mut parts);
    let (kind, body) = compose(&uid, rev, &parts);
    let work: Vec<String> = body["work_items"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if existing {
        tx.execute(
            "UPDATE ot.asks SET kind = $2, body = $3, rev = $4, work_items = $5 WHERE uid = $1",
            &[&uid, &kind, &body, &rev, &work],
        )
        .await?;
    } else {
        tx.execute(
            "INSERT INTO ot.asks (uid, org_id, agent_id, kind, status, body, rev, work_items) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)",
            &[&uid, &org.id, &agent_id, &kind, &body, &rev, &work],
        )
        .await?;
    }
    tx.commit().await?;
    changes::notify(engine, org, vec![Change::Asks, Change::Agent(agent_id)]);
    Ok(uid)
}

/// Normalize one question (or tab) from a tool's arguments.
#[logged]
fn question_of(v: &Value) -> Result<Value> {
    let q = v["question"].as_str().map(str::trim).unwrap_or("");
    if q.is_empty() {
        refuse!(BadRequest, "a question needs its text");
    }
    let mut out = json!({ "question": q });
    if let Some(h) = v["header"].as_str().filter(|h| !h.trim().is_empty()) {
        out["header"] = json!(gist(h, 24));
    }
    if let Some(opts) = v["options"].as_array() {
        let opts: Vec<Value> = opts
            .iter()
            .take(4)
            .filter_map(|o| match o {
                Value::String(s) => Some(json!({ "label": s })),
                Value::Object(m) => ["label", "text", "value", "name"].iter().find_map(|k| m.get(*k).and_then(Value::as_str)).map(|l| {
                    let mut x = json!({ "label": l });
                    if let Some(d) = m.get("description").and_then(Value::as_str) {
                        x["description"] = json!(d);
                    }
                    x
                }),
                _ => None,
            })
            .collect();
        if !opts.is_empty() {
            out["options"] = json!(opts);
        }
    }
    if v["multi"].as_bool().unwrap_or(false) {
        out["multi"] = json!(true);
    }
    if let Some(w) = v["work_item"].as_str() {
        out["work_item"] = json!(w);
    }
    Ok(out)
}

/// `orgtree_ask`.
#[logged]
pub async fn ask(engine: &Arc<Engine>, org: &Arc<OrgHandle>, a: &Asker, args: &Value) -> Result<String> {
    let mut qs = Vec::new();
    match args["questions"].as_array() {
        Some(list) if !list.is_empty() => {
            for q in list.iter().take(4) {
                qs.push(question_of(q)?);
            }
        }
        _ => qs.push(question_of(args)?),
    }
    if !a.may_ask_user {
        let questions: Vec<Value> = qs.iter().map(|q| json!({
            "header":q.get("header").cloned().unwrap_or(Value::Null), "text":q["question"],
            "work_item":q.get("work_item").cloned().unwrap_or(Value::Null),
            "options":q["options"].as_array().map(|a|a.iter().filter_map(|o|o["label"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
            "multi":q["multi"].as_bool().unwrap_or(false) })).collect();
        let ev=crate::events::typed("ask.routed", &a.name, crate::events::node_ref(&org.slug,&a.name,a.generation as i64), json!({"from_node":a.name,"questions":questions}));
        return route_to_superior(engine, org, a, "question", &qs.iter().map(render_question).collect::<Vec<_>>().join("\n\n"), ev).await;
    }
    let uid = amend(engine, org, a.id, |p| {
        for q in qs {
            // the same question text amends its tab
            match p.questions.iter_mut().find(|x| x["question"] == q["question"]) {
                Some(x) => *x = q,
                None => p.questions.push(q),
            }
        }
        if p.questions.len() > 4 {
            let n = p.questions.len() - 4;
            p.questions.drain(..n);
        }
    })
    .await?;
    Ok(format!(
        "Your question is on the user's desk (request {uid}). End your turn now; the answer arrives as mail."
    ))
}

fn render_question(q: &Value) -> String {
    let mut s = q["question"].as_str().unwrap_or("").to_string();
    if let Some(opts) = q["options"].as_array() {
        for o in opts {
            s.push_str(&format!("\n  - {}", o["label"].as_str().unwrap_or("")));
            if let Some(d) = o["description"].as_str() {
                s.push_str(&format!(": {d}"));
            }
        }
    }
    s
}

#[logged]
async fn route_to_superior(engine: &Arc<Engine>, org: &Arc<OrgHandle>, a: &Asker, kind: &str, text: &str, ev: Value) -> Result<String> {
    let Some(sup) = &a.superior else {
        refuse!(Forbidden, "you cannot ask the user directly");
    };
    let mut out = Outgoing::new(From::Agent { id: a.id, name: a.name.clone(), generation: a.generation }, sup, text);
    out.kind = kind.into();
    out.ev = Some(ev);
    let sent = mail::send(engine, org.id, out).await?;
    Ok(format!(
        "You hold no audience with the user, so this went to your superior {sup} as mail ({}). End your turn; the reply arrives as mail.",
        sent.uid
    ))
}

/// `orgtree_request_credits`.
#[logged]
pub async fn request_credits(engine: &Arc<Engine>, org: &Arc<OrgHandle>, a: &Asker, new_limit: f64, reason: &str) -> Result<String> {
    if !a.may_ask_user {
        refuse!(Forbidden, "only top-level agents and holders of a user audience ask the user for credits; ask your superior by mail");
    }
    if reason.trim().is_empty() {
        refuse!(BadRequest, "say why you need the credits");
    }
    let client = engine.db.get().await?;
    let grant: f64 = client.query_one("SELECT grant_credits::float8 FROM ot.agents WHERE id = $1", &[&a.id]).await?.get(0);
    drop(client);
    let uid = amend(engine, org, a.id, |p| {
        p.credit = Some(json!({ "old": grant, "new": new_limit, "reason": reason.trim() }));
    })
    .await?;
    Ok(format!("Your credit request ({grant} → {new_limit}) is on the user's desk (request {uid}). The decision arrives as mail."))
}

/// `orgtree_request_scope`.
#[logged]
pub async fn request_scope(engine: &Arc<Engine>, org: &Arc<OrgHandle>, a: &Asker, items: &[Value], reason: &str) -> Result<String> {
    if items.is_empty() {
        refuse!(BadRequest, "name at least one item");
    }
    let mut clean = Vec::new();
    for it in items.iter().take(8) {
        let kind = it["kind"].as_str().unwrap_or("");
        let item = match kind {
            "dir" => {
                let Some(p) = it["path"].as_str().filter(|p| !p.trim().is_empty()) else {
                    refuse!(BadRequest, "a folder item needs its path");
                };
                json!({ "kind": "dir", "path": p.trim(), "mode": if it["mode"] == "ro" { "ro" } else { "rw" } })
            }
            "tool" => {
                let t = it["tool"].as_str().unwrap_or("");
                if !["bash", "web", "edit", "subagents"].contains(&t) {
                    refuse!(BadRequest, "a tool item names bash, web, edit or subagents");
                }
                json!({ "kind": "tool", "tool": t })
            }
            "mcp" => {
                let Some(s) = it["server"].as_str().filter(|s| !s.is_empty()) else {
                    refuse!(BadRequest, "an mcp item names its server");
                };
                json!({ "kind": "mcp", "server": s })
            }
            "permission_mode" => {
                let m = it["mode"].as_str().unwrap_or("");
                if !scope::PM_LEVELS.contains(&m) {
                    refuse!(BadRequest, "permission_mode is one of {}", scope::PM_LEVELS.join(", "));
                }
                json!({ "kind": "permission_mode", "mode": m })
            }
            other => refuse!(BadRequest, "unknown item kind {other}"),
        };
        clean.push(item);
    }
    if !a.may_ask_user {
        let text = format!(
            "Scope request: {}\nWhy: {}",
            clean.iter().map(item_label).collect::<Vec<_>>().join("; "),
            reason
        );
        let mut wanted=json!({"folders":[],"tools":{"bash":null,"web":null,"edit":null,"subagents":null,"mcp":null},"permission_mode":null,"org_visibility":null});
        for item in &clean {
            match item["kind"].as_str().unwrap_or("") {
                "dir" => wanted["folders"].as_array_mut().unwrap().push(json!({"path":item["path"],"mode":item["mode"]})),
                "tool" => if let Some(tool)=item["tool"].as_str() { wanted["tools"][tool]=json!(true); },
                "mcp" => { if wanted["tools"]["mcp"].is_null() { wanted["tools"]["mcp"]=json!([]); } wanted["tools"]["mcp"].as_array_mut().unwrap().push(item["server"].clone()); },
                "permission_mode" => wanted["permission_mode"]=item["mode"].clone(),
                _=>{},
            }
        }
        let ev=crate::events::typed("access.scope_requested", &a.name, crate::events::node_ref(&org.slug,&a.name,a.generation as i64),
            json!({"items":clean.iter().map(item_label).collect::<Vec<_>>(),"reason":reason,"wanted":wanted}));
        return route_to_superior(engine, org, a, "request", &text, ev).await;
    }
    let uid = amend(engine, org, a.id, |p| {
        let mut items: Vec<Value> = p.scope.as_ref().and_then(|s| s["items"].as_array().cloned()).unwrap_or_default();
        for c in clean {
            if !items.iter().any(|x| x == &c) {
                items.push(c);
            }
        }
        p.scope = Some(json!({ "items": items, "reason": reason.trim() }));
    })
    .await?;
    Ok(format!("Your scope request is on the user's desk (request {uid}). End your turn; the decision arrives as mail."))
}

/// `orgtree_withdraw_ask`.
#[logged]
pub async fn withdraw(engine: &Arc<Engine>, org: &Arc<OrgHandle>, agent_id: i64) -> Result<String> {
    let client = engine.db.get().await?;
    let n = client
        .execute(
            "UPDATE ot.asks SET status = 'withdrawn', resolved_at = now(), reason = 'withdrawn by the agent'
              WHERE agent_id = $1 AND status = 'open'",
            &[&agent_id],
        )
        .await?;
    drop(client);
    if n == 0 {
        return Ok("You have no open request.".into());
    }
    changes::notify(engine, org, vec![Change::Asks, Change::Agent(agent_id)]);
    Ok("Your request was withdrawn.".into())
}

// ------------------------------------------------------------ the user's side

struct Open {
    uid: String,
    agent_id: i64,
    agent: String,
    rev: i32,
    parts: Parts,
}

#[logged]
async fn open_by(tx: &Transaction<'_>, org_id: i64, uid: Option<&str>, agent: Option<&str>) -> Result<Open> {
    let r = match (uid, agent) {
        (Some(u), _) => {
            tx.query_opt(
                "SELECT k.uid, k.agent_id, a.name, k.rev, k.body, k.status FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
                  WHERE k.org_id = $1 AND k.uid = $2 FOR UPDATE OF k",
                &[&org_id, &u.split(':').next().unwrap_or(u)],
            )
            .await?
        }
        (None, Some(n)) => {
            tx.query_opt(
                "SELECT k.uid, k.agent_id, a.name, k.rev, k.body, k.status FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
                  WHERE k.org_id = $1 AND a.name = $2 AND k.status = 'open' ORDER BY k.id DESC LIMIT 1 FOR UPDATE OF k",
                &[&org_id, &n],
            )
            .await?
        }
        _ => None,
    };
    let Some(r) = r else { refuse!(NotFound, "that request no longer exists") };
    let status: String = r.get(5);
    if status != "open" {
        refuse!(Conflict, "that request was already {status}");
    }
    Ok(Open { uid: r.get(0), agent_id: r.get(1), agent: r.get(2), rev: r.get(3), parts: Parts::of(&r.get::<_, Value>(4)) })
}

/// A tab's chosen values, trimmed, empty ones dropped.
fn chosen(a: &Value) -> Vec<String> {
    match a {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()).into_iter().collect(),
        Value::Array(list) => list.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        _ => Vec::new(),
    }
}

fn header(q: &Value) -> Value {
    q.get("header").and_then(Value::as_str).filter(|h| !h.is_empty()).map(|h| json!(h)).unwrap_or(Value::Null)
}

fn answer_text(q: &Value, a: &Value) -> String {
    let shown = match a {
        Value::Null => "(skipped)".to_string(),
        Value::String(s) if s.is_empty() => "(skipped)".to_string(),
        Value::String(s) => s.clone(),
        Value::Array(list) => list.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    };
    format!("Q: {}\nA: {}", q["question"].as_str().unwrap_or(""), shown)
}

/// Settle: mark answered, mail the outcome, stamp the mail on the card.
#[logged]
async fn settle(
    engine: &Arc<Engine>,
    org: &Arc<OrgHandle>,
    tx: deadpool_postgres::Transaction<'_>,
    open: &Open,
    status: &str,
    answer: Value,
    text: String,
    ev: Option<Value>,
) -> Result<String> {
    tx.execute(
        "UPDATE ot.asks SET status = $2, resolved_at = now(), answer = $3 WHERE uid = $1",
        &[&open.uid, &status, &answer],
    )
    .await?;
    tx.commit().await?;
    let mut out = Outgoing::new(From::User, &open.agent, &text);
    out.kind = "decision".into();
    out.ev = ev;
    let sent = mail::send(engine, org.id, out).await?;
    let client = engine.db.get().await?;
    client.execute("UPDATE ot.asks SET answer_mail = $2 WHERE uid = $1", &[&open.uid, &sent.uid]).await?;
    drop(client);
    changes::notify(engine, org, vec![Change::Asks, Change::Agent(open.agent_id), Change::UserMail]);
    Ok(open.agent.clone())
}

/// `POST /asks/{aid}/answer`: a question card (`selected` is one entry per tab).
#[logged]
pub async fn answer(engine: &Arc<Engine>, org: &Arc<OrgHandle>, uid: &str, body: &Value) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = open_by(&tx, org.id, Some(uid), None).await?;
    if let Some(rev) = body["rev"].as_i64() {
        if rev as i32 != open.rev {
            refuse!(Conflict, "the question changed while you were answering; read it again");
        }
    }
    if body["dismiss"].as_bool().unwrap_or(false) {
        let text = format!(
            "The user dismissed your request without answering:\n\n{}",
            open.parts.questions.iter().map(render_question).collect::<Vec<_>>().join("\n\n")
        );
        let qs: Vec<Value> = open
            .parts
            .questions
            .iter()
            .map(|q| json!({ "label": header(q), "question": q["question"].as_str().unwrap_or(""), "selected": [] }))
            .collect();
        let single = qs.len() <= 1;
        let ev = crate::events::answer_ask(&org.slug, &open.uid, &open.agent, qs, None, true, single);
        let node = settle(engine, org, tx, &open, "dismissed", json!({ "dismissed": true }), text, Some(ev)).await?;
        return Ok(json!({ "answered": open.uid, "node": node }));
    }
    let selected = body["selected"].as_array().cloned().unwrap_or_default();
    let free = body["text"].as_str().unwrap_or("").trim().to_string();
    let mut lines = Vec::new();
    for (i, q) in open.parts.questions.iter().enumerate() {
        let mut a = selected.get(i).cloned().unwrap_or(Value::Null);
        if i == 0 && !free.is_empty() && (a.is_null() || a.as_str() == Some("")) {
            a = json!(free);
        }
        lines.push(answer_text(q, &a));
    }
    if open.parts.questions.len() <= 1 && !free.is_empty() && selected.first().map(|v| !v.is_null()).unwrap_or(false) {
        lines.push(format!("Note: {free}"));
    }
    let text = format!("The user answered your question:\n\n{}", lines.join("\n\n"));
    let qs: Vec<Value> = open
        .parts
        .questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            json!({ "label": header(q), "question": q["question"].as_str().unwrap_or(""),
                    "selected": chosen(&selected.get(i).cloned().unwrap_or(Value::Null)) })
        })
        .collect();
    let single = qs.len() <= 1;
    let note = Some(free.as_str()).filter(|f| !f.is_empty());
    let ev = crate::events::answer_ask(&org.slug, &open.uid, &open.agent, qs, note, false, single);
    let node = settle(engine, org, tx, &open, "answered", json!({ "selected": selected, "text": free }), text, Some(ev)).await?;
    Ok(json!({ "answered": open.uid, "node": node }))
}

/// Apply a credit decision: the agent's grant becomes `granted`.
#[logged]
async fn grant_credits(engine: &Arc<Engine>, org: &Arc<OrgHandle>, agent: &str, granted: f64) -> Result<Value> {
    let client = engine.db.get().await?;
    let grant: f64 = client
        .query_one("SELECT grant_credits::float8 FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org.id, &agent])
        .await?
        .get(0);
    drop(client);
    let delta = granted - grant;
    crate::domain::ops::run(
        engine,
        org,
        crate::domain::ops::Actor::User,
        &json!({ "op": "reallocate", "node": agent, "delta": delta }),
    )
    .await
}

/// `POST /credit-requests {id, action, granted?, dry?}` on a credit card.
#[logged]
pub async fn credit_decide(engine: &Arc<Engine>, org: &Arc<OrgHandle>, body: &Value) -> Result<Value> {
    let uid = body["id"].as_str().unwrap_or("");
    let action = body["action"].as_str().unwrap_or("");
    let dry = body["dry"].as_bool().unwrap_or(false);
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = open_by(&tx, org.id, Some(uid), None).await?;
    let Some(c) = open.parts.credit.clone() else { refuse!(Conflict, "that request asks for no credits") };
    let asked = c["new"].as_f64().unwrap_or(0.0);
    let granted = body["granted"].as_f64().unwrap_or(asked);
    let mut warnings = Vec::new();
    if action != "deny" {
        let client2 = engine.db.get().await?;
        let held: f64 = client2
            .query_one(
                "SELECT coalesce(sum(c.seat + c.grant_credits), 0)::float8 FROM ot.agents c JOIN ot.agents a ON a.id = c.parent_id
                  WHERE a.org_id = $1 AND a.name = $2 AND c.state = 'live'",
                &[&org.id, &open.agent],
            )
            .await?
            .get(0);
        if granted < held {
            warnings.push(format!("{} holds {held:.2} credits for its reports; a grant below that strands them", open.agent));
        }
    }
    if dry {
        tx.rollback().await?;
        return Ok(json!({ "ok": true, "warnings": warnings }));
    }
    let text;
    let status;
    if action == "deny" {
        status = "denied";
        text = format!("The user denied your credit request ({} → {asked}).", c["old"]);
    } else {
        tx.rollback().await?;
        grant_credits(engine, org, &open.agent, granted).await?;
        let mut client = engine.db.get().await?;
        let tx = client.transaction().await?;
        let open = open_by(&tx, org.id, Some(uid), None).await?;
        let msg = format!("The user granted credits: your grant is now {granted} (you asked for {asked}).");
        let node = settle(engine, org, tx, &open, "granted", json!({ "granted": granted }), msg, Some(crate::events::credit_decision(&org.slug, &open.agent, &open.uid, c["old"].as_f64().unwrap_or(0.0), asked, Some(granted)))).await?;
        return Ok(json!({ "ok": true, "node": node, "warnings": warnings }));
    }
    let node = settle(engine, org, tx, &open, status, json!({ "denied": true }), text, Some(crate::events::credit_decision(&org.slug, &open.agent, &open.uid, c["old"].as_f64().unwrap_or(0.0), asked, None))).await?;
    Ok(json!({ "ok": true, "node": node, "warnings": warnings }))
}

/// `POST /nodes/{nid}/batch`: resolve the whole request at once.
#[logged]
pub async fn resolve_batch(engine: &Arc<Engine>, org: &Arc<OrgHandle>, agent: &str, body: &Value) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = open_by(&tx, org.id, None, Some(agent)).await?;
    if let Some(rev) = body.pointer("/revs/ask").and_then(Value::as_i64) {
        if rev as i32 != open.rev {
            refuse!(Conflict, "the request changed while you were answering; read it again");
        }
    }
    tx.rollback().await?;
    let mut sections = Vec::new();
    let mut cards: Vec<Value> = Vec::new();
    // questions
    let answers = body["answers"].as_array().cloned().unwrap_or_default();
    let mut asked = Vec::new();
    for (i, q) in open.parts.questions.iter().enumerate() {
        let a = answers.get(i).cloned().unwrap_or(Value::Null);
        sections.push(answer_text(q, &a));
        let picked = chosen(&a);
        asked.push(json!({ "label": header(q), "question": q["question"].as_str().unwrap_or(""),
                           "answer": if picked.is_empty() { Value::Null } else { json!(picked.join(" · ")) } }));
    }
    if !asked.is_empty() {
        cards.push(json!({ "kind": "ask", "ask_id": open.uid, "questions": asked }));
    }
    // credits
    if let Some(c) = &open.parts.credit {
        let cd = &body["credits"];
        let old = c["old"].as_f64().unwrap_or(0.0);
        let wanted = c["new"].as_f64().unwrap_or(0.0);
        if let Some(g) = cd["granted"].as_f64() {
            grant_credits(engine, org, &open.agent, g).await?;
            sections.push(format!("Credits: granted — your grant is now {g} (you asked for {}).", c["new"]));
            cards.push(json!({ "kind": "credit", "outcome": if (g - wanted).abs() < 1e-9 { "approved" } else { "counter" },
                               "old": old, "asked": wanted, "granted": g, "now": g }));
        } else if cd["deny"].as_bool().unwrap_or(false) {
            sections.push(format!("Credits: denied (you asked for {}).", c["new"]));
            cards.push(json!({ "kind": "credit", "outcome": "denied", "old": old, "asked": wanted, "granted": null, "now": old }));
        } else {
            sections.push("Credits: not decided; ask again if you still need them.".into());
            cards.push(json!({ "kind": "credit", "outcome": "skipped", "old": old, "asked": wanted, "granted": null, "now": null }));
        }
    }
    // scope items, decided one by one
    let items: Vec<Value> = open.parts.scope.as_ref().and_then(|s| s["items"].as_array().cloned()).unwrap_or_default();
    if !items.is_empty() {
        let decisions = body["scope"].as_array().cloned().unwrap_or_default();
        let mut approved = Vec::new();
        let mut decided = Vec::new();
        let mut lines = vec![json!("[SCOPE REQUEST decided]")];
        for (i, it) in items.iter().enumerate() {
            let d = decisions.get(i).and_then(Value::as_str).unwrap_or("skip");
            let d = if d == "approve" || d == "deny" { d } else { "skip" };
            sections.push(format!("{}: {}", item_label(it), match d {
                "approve" => "granted",
                "deny" => "denied",
                _ => "not decided",
            }));
            decided.push(json!({ "label": item_label(it), "decision": d }));
            lines.push(json!(format!("- {} → {}", item_label(it), match d {
                "approve" => "GRANTED — live from your next turn",
                "deny" => "denied",
                _ => "skipped (undecided — you may re-ask)",
            })));
            if d == "approve" {
                approved.push(it.clone());
            }
        }
        cards.push(json!({ "kind": "scope", "decisions": decided, "lines": lines }));
        if !approved.is_empty() {
            apply_scope(engine, org, &open.agent, &approved).await?;
        }
    }
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = open_by(&tx, org.id, None, Some(agent)).await?;
    let text = format!("The user resolved your request:\n\n{}", sections.join("\n\n"));
    let ev = crate::events::answer_batch(&org.slug, &open.uid, &open.agent, cards);
    let node = settle(engine, org, tx, &open, "answered", body.clone(), text, Some(ev)).await?;
    Ok(json!({ "resolved": open.uid, "node": node }))
}

/// Granted scope items join the agent's configured scope (the user grants
/// them, so the chain above is raised as needed by the scope route).
#[logged]
async fn apply_scope(engine: &Arc<Engine>, org: &Arc<OrgHandle>, agent: &str, items: &[Value]) -> Result<()> {
    let client = engine.db.get().await?;
    let sc: Value = client
        .query_one("SELECT scope FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&org.id, &agent])
        .await?
        .get(0);
    drop(client);
    let cur = scope::normalize(&sc);
    let mut patch = json!({});
    let mut dirs = cur["add_dirs"].as_array().cloned().unwrap_or_default();
    let mut tools = cur["tools"].clone();
    for it in items {
        match it["kind"].as_str() {
            Some("dir") => dirs.push(json!({ "path": it["path"], "mode": it["mode"] })),
            Some("tool") => {
                if let Some(t) = it["tool"].as_str() {
                    tools[t] = json!(true);
                }
            }
            Some("mcp") => {
                if let (Some(s), Some(list)) = (it["server"].as_str(), tools["mcp"].as_array_mut()) {
                    if !list.iter().any(|x| x == s) {
                        list.push(json!(s));
                    }
                }
            }
            Some("permission_mode") => patch["permission_mode"] = it["mode"].clone(),
            _ => {}
        }
    }
    patch["add_dirs"] = json!(dirs);
    patch["tools"] = tools;
    crate::http::nodes::apply_user_scope(engine, org, agent, &patch).await?;
    Ok(())
}
