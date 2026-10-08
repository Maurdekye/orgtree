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
use crate::domain::{ops, scope};
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
        if !body["parts"].is_object() {
            // A question imported from a 3.x store keeps its tabs at the top
            // level (`questions`, or the single `question` and its options).
            return Parts { questions: legacy_questions(body), credit: None, scope: None };
        }
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

/// The tabs of a question stored without `parts`: its `questions` list, or
/// the single `question` with its header, options and multi.
#[logged]
pub(crate) fn legacy_questions(body: &Value) -> Vec<Value> {
    if let Some(list) = body["questions"].as_array().filter(|l| !l.is_empty()) {
        return list.clone();
    }
    if !body["question"].as_str().is_some_and(|q| !q.trim().is_empty()) {
        return Vec::new();
    }
    let mut q = Map::new();
    for k in ["question", "header", "options", "multi", "work_item"] {
        if let Some(v) = body.get(k).filter(|v| !v.is_null()) {
            q.insert(k.into(), v.clone());
        }
    }
    vec![Value::Object(q)]
}

/// One attachment per ticket for one request, preserving every matching tab
/// and its original index. Unattached tabs still belong to the full ask card.
#[logged]
pub(crate) fn attached_tabs(questions: &[Value]) -> Vec<(String, Vec<Value>)> {
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for (index, q) in questions.iter().enumerate() {
        let Some(slug) = q["work_item"].as_str() else { continue };
        let mut tab = json!({ "index": index, "question": q["question"].clone() });
        for key in ["header", "options", "multi"] {
            if let Some(value) = q.get(key).filter(|v| !v.is_null()) {
                tab[key] = value.clone();
            }
        }
        if let Some((_, tabs)) = groups.iter_mut().find(|(item, _)| item == slug) {
            tabs.push(tab);
        } else {
            groups.push((slug.to_string(), vec![tab]));
        }
    }
    groups
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
    let work: Vec<String> = attached_tabs(&p.questions).into_iter().map(|(slug, _)| slug).collect();
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
async fn amend(engine: &Arc<Engine>, org: &OrgHandle, agent_id: i64, f: impl FnOnce(&mut Parts) -> Result<bool>) -> Result<String> {
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
    // Validation happens before any write; a refused merge preserves every tab.
    if !f(&mut parts)? {
        return Ok(uid);
    }
    if parts.is_empty() {
        if existing {
            tx.execute(
                "UPDATE ot.asks SET status = 'withdrawn', resolved_at = now(), reason = 'request no longer needed', rev = $2 WHERE uid = $1",
                &[&uid, &rev],
            ).await?;
            tx.commit().await?;
            changes::notify(engine, org, vec![Change::Asks, Change::Agent(agent_id)]);
        }
        return Ok(uid);
    }
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

/// A caller's own malformed tool call can arrive with its options swallowed
/// into the question text (`…</question>\n<parameter name="options">[{…}]`,
/// measured in 3.x 2026-08-30). As 3.x did: recover the question and the
/// options when the embedded list parses, and refuse a question that still
/// carries tool-call markup rather than show the user a garbled card.
#[logged]
fn recover_leaked(question: &str, options: Option<&Value>) -> Result<(String, Option<Value>)> {
    static LEAKED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?i)</(?:question|header|options|multi|questions)>\s*<(?:\w+:)?parameter\s+name="options">"#).unwrap()
    });
    static MARKUP: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?i)</(?:question|header|options|multi|questions|parameter|invoke)>|<(?:\w+:)?parameter\s+name="|<(?:\w+:)?invoke\s+name=""#)
            .unwrap()
    });
    let Some(m) = LEAKED.find(question) else {
        if options.is_none() && MARKUP.is_match(question) {
            refuse!(
                BadRequest,
                "this question's text contains what looks like a leaked tool-call fragment (e.g. '</question>' or \
                 '<parameter name=\"...\">') rather than a clean question; your call arrived malformed. Nothing was asked: \
                 retry the ask (a shorter question and shorter option descriptions are less likely to trip it)"
            );
        }
        return Ok((question.to_string(), options.cloned()));
    };
    let head = question[..m.start()].trim();
    if head.is_empty() {
        refuse!(BadRequest, "this question's text is only a leaked tool-call fragment, with no question left once it is stripped; retry the ask");
    }
    match serde_json::Deserializer::from_str(question[m.end()..].trim()).into_iter::<Value>().next() {
        Some(Ok(Value::Array(list))) if !list.is_empty() => Ok((head.to_string(), Some(Value::Array(list)))),
        Some(Ok(_)) => refuse!(
            BadRequest,
            "this question's text contains a leaked tool-call fragment, and the options in it are not a non-empty list; retry the ask"
        ),
        _ => refuse!(
            BadRequest,
            "this question's text contains a leaked tool-call fragment ('<parameter name=\"options\">...'), and the options in it \
             do not parse as JSON; retry the ask"
        ),
    }
}

/// Normalize one question (or tab) from a tool's arguments.
#[logged]
fn question_of(v: &Value) -> Result<Value> {
    let q = v["question"].as_str().map(str::trim).unwrap_or("");
    if q.is_empty() {
        refuse!(BadRequest, "a question needs its text");
    }
    let (q, options) = recover_leaked(q, v.get("options").filter(|o| !o.is_null()))?;
    let mut out = json!({ "question": q });
    if let Some(h) = v["header"].as_str().filter(|h| !h.trim().is_empty()) {
        out["header"] = json!(gist(h, 24));
    }
    // as in 3.x: a label is at most 60 characters, a description 300, and
    // an option without a label is dropped
    let clip = |s: &str, n: usize| s.trim().chars().take(n).collect::<String>();
    if let Some(opts) = options.as_ref().and_then(Value::as_array) {
        let opts: Vec<Value> = opts
            .iter()
            .take(4)
            .filter_map(|o| {
                let (label, description) = match o {
                    Value::String(s) => (s.as_str(), None),
                    Value::Object(m) => (
                        ["label", "text", "value", "name"].iter().find_map(|k| m.get(*k).and_then(Value::as_str))?,
                        m.get("description").and_then(Value::as_str),
                    ),
                    _ => return None,
                };
                let label = clip(label, 60);
                if label.is_empty() {
                    return None;
                }
                let mut x = json!({ "label": label });
                if let Some(d) = description.map(|d| clip(d, 300)).filter(|d| !d.is_empty()) {
                    x["description"] = json!(d);
                }
                Some(x)
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
    match args.get("questions").filter(|v| !v.is_null()) {
        Some(value) => {
            let Some(list) = value.as_array().filter(|a| !a.is_empty()) else {
                refuse!(BadRequest, "questions must be a non-empty list of question objects (1–4)");
            };
            if list.len() > 4 {
                refuse!(BadRequest, "a batch carries at most 4 questions; split the rest into a follow-up ask");
            }
            for q in list {
                qs.push(question_of(q)?);
            }
        }
        None => qs.push(question_of(args)?),
    }
    // Attachments are docket reads, even when the question will be routed to
    // a superior. Validate the whole call before any card or mail is written.
    let who = crate::domain::docket::Who::Agent { id: a.id, name: a.name.clone(), generation: a.generation };
    for q in &mut qs {
        let work = q["work_item"].as_str().map(str::trim).filter(|s| !s.is_empty())
            .or_else(|| args["work_item"].as_str().map(str::trim).filter(|s| !s.is_empty()));
        if let Some(work) = work {
            let item = crate::domain::docket::agent_get(engine, org, &who, work, &json!({ "fields": ["slug"] })).await?;
            q["work_item"] = item["slug"].clone();
        } else if let Some(obj) = q.as_object_mut() {
            obj.remove("work_item");
        }
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
        if p.questions.len() > 8 {
            refuse!(BadRequest, "your open batch would grow to {} questions (cap 8); withdraw it or wait for the user's submit", p.questions.len());
        }
        Ok(true)
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

/// Python's ceil(round(value, 2)): decimal formatting preserves ties-to-even
/// on the actual binary input (multiplying by 100 first can change a tie).
#[logged]
fn credit_total(value: f64) -> Result<f64> {
    if !value.is_finite() {
        refuse!(BadRequest, "new_limit must be a finite number (the requested TOTAL grant)");
    }
    Ok(format!("{value:.2}").parse::<f64>()?.ceil())
}

/// Existing grant and conservative whole-credit headroom, as in 3.x.
/// None means the org has no top-level cap and the chain may grow.
#[logged]
async fn credit_room(engine: &Engine, org_id: i64, agent_id: i64) -> Result<(f64, Option<f64>)> {
    let client = engine.db.get().await?;
    let settings: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let settings = crate::feed::groups::effective_settings(&settings, &engine.settings.defaults());
    let rows = client.query(
        "WITH RECURSIVE up(id, parent_id, depth) AS (
           SELECT id, parent_id, 0 FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live'
           UNION ALL SELECT a.id, a.parent_id, u.depth + 1 FROM ot.agents a JOIN up u ON a.id = u.parent_id
            WHERE u.depth < 1024 AND a.org_id = $2)
         SELECT a.grant_credits::float8, u.parent_id,
                (a.grant_credits - coalesce((SELECT sum(c.seat + c.grant_credits) FROM ot.agents c
                   WHERE c.parent_id = a.id AND c.state = 'live'), 0))::float8
           FROM up u JOIN ot.agents a ON a.id = u.id ORDER BY u.depth LIMIT 1025",
        &[&agent_id, &org_id],
    ).await?;
    let Some(first) = rows.first() else { refuse!(NotFound, "the requesting agent is not live") };
    if rows.last().and_then(|r| r.get::<_, Option<i64>>(1)).is_some() {
        refuse!(Conflict, "the superior chain exceeds the supported depth");
    }
    let grant: f64 = first.get(0);
    let cap = settings["max_top_grant"].as_f64().unwrap_or(0.0).trunc();
    let room = if first.get::<_, Option<i64>>(1).is_none() {
        (cap != 0.0).then(|| cap - grant.ceil())
    } else if settings["cascade_alloc"].as_bool() == Some(false) {
        Some(rows[1].get::<_, f64>(2).floor())
    } else if cap == 0.0 {
        None
    } else {
        let free: f64 = rows.iter().skip(1).map(|r| r.get::<_, f64>(2).floor()).sum();
        let top: f64 = rows.last().expect("nonempty chain").get(0);
        Some(free + (cap - top.ceil()).max(0.0))
    };
    Ok((grant, room))
}

/// `orgtree_request_credits`.
#[logged]
pub async fn request_credits(engine: &Arc<Engine>, org: &Arc<OrgHandle>, a: &Asker, new_limit: f64, reason: &str) -> Result<String> {
    if !a.may_ask_user {
        refuse!(Forbidden, "only top-level agents and holders of a user audience ask the user for credits; ask your superior by mail");
    }
    let new_limit = credit_total(new_limit)?;
    let (grant, room) = credit_room(engine, org.id, a.id).await?;
    if new_limit <= grant {
        amend(engine, org, a.id, |p| Ok(p.credit.take().is_some())).await?;
        return Ok(format!("Your grant is already {grant}; no credit request remains. Other request tabs are unchanged."));
    }
    if reason.trim().is_empty() {
        refuse!(BadRequest, "say why you need the credits");
    }
    if room.is_some_and(|n| n <= 0.0) {
        refuse!(Conflict, "there are ZERO credits available to grant (the superior chain or top-level cap has no headroom). No request was made; free credits or ask the user to raise the cap");
    }
    let uid = amend(engine, org, a.id, |p| {
        p.credit = Some(json!({ "old": grant, "new": new_limit, "reason": reason.trim() }));
        Ok(true)
    })
    .await?;
    Ok(format!("Your credit request ({grant} → {new_limit}) is on the user's desk (request {uid}). The decision arrives as mail."))
}

#[logged]
fn item_key(item: &Value) -> String {
    match item["kind"].as_str().unwrap_or("") {
        "dir" => format!("dir:{}", item["path"].as_str().unwrap_or("")),
        "tool" => format!("tool:{}", item["tool"].as_str().unwrap_or("")),
        "mcp" => format!("mcp:{}", item["server"].as_str().unwrap_or("")),
        _ => "permission_mode".into(),
    }
}

#[logged]
async fn held_scope(engine: &Engine, org_id: i64, agent_id: i64) -> Result<Value> {
    let client = engine.db.get().await?;
    let settings: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let settings = crate::feed::groups::effective_settings(&settings, &engine.settings.defaults());
    let rows = client.query(
        "WITH RECURSIVE up(id, parent_id, scope, depth) AS (
           SELECT id, parent_id, scope, 0 FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live'
           UNION ALL SELECT a.id, a.parent_id, a.scope, u.depth + 1 FROM ot.agents a JOIN up u ON a.id = u.parent_id
            WHERE u.depth < 1024 AND a.org_id = $2)
         SELECT scope, parent_id FROM up ORDER BY depth DESC LIMIT 1025", &[&agent_id, &org_id],
    ).await?;
    let Some(root) = rows.first() else { refuse!(NotFound, "the requesting agent is not live") };
    if root.get::<_, Option<i64>>(1).is_some() {
        refuse!(Conflict, "the superior chain exceeds the supported depth");
    }
    let mut effective = scope::org_ceiling(&settings["dirs"]);
    for row in rows {
        effective = scope::clamp(&row.get::<_, Value>(0), &effective);
    }
    Ok(effective)
}

#[logged]
fn holds_item(held: &Value, item: &Value) -> bool {
    match item["kind"].as_str() {
        Some("dir") => held["add_dirs"].as_array().is_some_and(|dirs| dirs.iter().any(|d| {
            d["path"] == item["path"] && (d["mode"] == "rw" || d["mode"] == item["mode"])
        })),
        Some("tool") => item["tool"].as_str().and_then(|t| held["tools"][t].as_bool()).unwrap_or(false),
        Some("mcp") => held["tools"]["mcp"].as_array().is_some_and(|servers| {
            servers.iter().any(|s| s == "*" || s == &item["server"])
        }),
        Some("permission_mode") => {
            let current = held["permission_mode"].as_str().unwrap_or("acceptEdits");
            let wanted = item["mode"].as_str().unwrap_or("");
            scope::PM_LEVELS.contains(&current) && scope::PM_LEVELS.contains(&wanted)
                && scope::pm_rank(current) >= scope::pm_rank(wanted)
        }
        _ => false,
    }
}

/// `orgtree_request_scope`.
#[logged]
pub async fn request_scope(engine: &Arc<Engine>, org: &Arc<OrgHandle>, a: &Asker, items: &[Value], reason: &str) -> Result<String> {
    if reason.trim().is_empty() {
        refuse!(BadRequest, "a reason is required; say what the access is for");
    }
    if items.is_empty() {
        refuse!(BadRequest, "name at least one item");
    }
    if items.len() > 8 {
        refuse!(BadRequest, "at most 8 items per request");
    }
    let mut clean = Vec::new();
    for it in items {
        let kind = it["kind"].as_str().unwrap_or("");
        let item = match kind {
            "dir" => {
                let Some(p) = it["path"].as_str().filter(|p| !p.trim().is_empty()) else {
                    refuse!(BadRequest, "a folder item needs its path");
                };
                let mode = it["mode"].as_str().filter(|m| !m.is_empty()).unwrap_or("rw").trim();
                if !["ro", "rw"].contains(&mode) {
                    refuse!(BadRequest, "folder mode must be ro or rw");
                }
                json!({ "kind": "dir", "path": p.trim(), "mode": mode })
            }
            "tool" => {
                let t = it["tool"].as_str().unwrap_or("").trim();
                if !["bash", "web", "edit", "subagents"].contains(&t) {
                    refuse!(BadRequest, "a tool item names bash, web, edit or subagents");
                }
                json!({ "kind": "tool", "tool": t })
            }
            "mcp" => {
                let Some(s) = it["server"].as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                    refuse!(BadRequest, "an mcp item names its server");
                };
                json!({ "kind": "mcp", "server": s })
            }
            "permission_mode" => {
                let m = it["mode"].as_str().unwrap_or("").trim();
                if !scope::PM_LEVELS.contains(&m) {
                    refuse!(BadRequest, "permission_mode is one of {}", scope::PM_LEVELS.join(", "));
                }
                json!({ "kind": "permission_mode", "mode": m })
            }
            other => refuse!(BadRequest, "unknown item kind {other}"),
        };
        clean.push(item);
    }
    let effective = held_scope(engine, org.id, a.id).await?;
    let before = clean.len();
    clean.retain(|it| !holds_item(&effective, it));
    let held = before - clean.len();
    if clean.is_empty() {
        return Ok("You already hold everything you asked for; nothing to request.".into());
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
        let previous = p.scope.as_ref().and_then(|s| s["items"].as_array().cloned()).unwrap_or_default();
        let mut items: Vec<Value> = Vec::new();
        // Old cards may already contain multiple modes for the same path.
        // As in the Python identity map, the last value wins in the first slot.
        for c in previous.into_iter().chain(clean) {
            let key = item_key(&c);
            match items.iter_mut().find(|x| item_key(x) == key) {
                Some(old) => *old = c,
                None => items.push(c),
            }
        }
        if items.len() > 8 {
            refuse!(BadRequest, "your pending scope request would exceed 8 items; withdraw the batch or wait for the user's submit");
        }
        p.scope = Some(json!({ "items": items, "reason": reason.trim() }));
        Ok(true)
    })
    .await?;
    let note = if held > 0 { format!(" {held} item(s) you already hold were dropped.") } else { String::new() };
    Ok(format!("Your scope request is on the user's desk (request {uid}).{note} End your turn; the decision arrives as mail."))
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

#[derive(Default)]
struct DecisionEffects {
    credits: ops::Effects,
    scope: Option<crate::http::nodes::ScopeEffects>,
}

struct CommittedDecision {
    question: Option<String>,
    agent: String,
    agent_id: i64,
    live: bool,
    halted: bool,
    fx: DecisionEffects,
}

/// Commit the decision, grants and durable answer mail together. All actor
/// messages and feed notifications follow the commit.
#[logged]
async fn settle(
    org: &Arc<OrgHandle>,
    tx: deadpool_postgres::Transaction<'_>,
    open: &Open,
    status: &str,
    answer: Value,
    text: String,
    ev: Option<Value>,
    fx: DecisionEffects,
) -> Result<CommittedDecision> {
    let target = tx.query_one(
        "SELECT state, halt IS NOT NULL FROM ot.agents WHERE id = $1 FOR UPDATE",
        &[&open.agent_id],
    ).await?;
    let state: String = target.get(0);
    let halted: bool = target.get(1);
    if state == "deleted" || state == "unrecoverable" {
        refuse!(Conflict, "{} cannot receive the answer; nothing was changed", open.agent);
    }
    let mail_uid = crate::util::uid("m");
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_agent_id,
                              recipient_name, kind, notice, body, ev, state)
         VALUES ($1, $2, '@user', 'agent', $3, $4, 'decision', false, $5, $6, 'pending')",
        &[&mail_uid, &org.id, &open.agent_id, &open.agent, &crate::util::pg_text(&text).as_ref(), &crate::util::pg_json_option(&ev).as_ref()],
    ).await?;
    tx.execute(
        "UPDATE ot.asks SET status = $2, resolved_at = now(), answer = $3, answer_mail = $4 WHERE uid = $1",
        &[&open.uid, &status, &answer, &mail_uid],
    ).await?;
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail)
         VALUES ($1, 'request_resolved', '@user', $2, $3)",
        &[&org.id, &open.agent_id, &json!({ "id": open.uid, "status": status })],
    ).await?;
    tx.commit().await?;
    Ok(CommittedDecision {
        question: (status=="answered" && !open.parts.questions.is_empty()).then(||open.uid.clone()),
        agent: open.agent.clone(), agent_id: open.agent_id,
        live: state == "live", halted, fx,
    })
}

/// The caller has returned its connection to the pool before publishing.
#[logged]
async fn publish_decision(engine: &Arc<Engine>, org: &Arc<OrgHandle>, decision: CommittedDecision) -> String {
    let CommittedDecision { question, agent, agent_id, live, halted, fx } = decision;
    ops::apply_effects(engine, org, fx.credits).await;
    if let Some(scope) = fx.scope {
        crate::http::nodes::apply_scope_effects(engine, org, scope).await;
    }
    changes::notify(engine, org, vec![
        Change::Asks, Change::Agent(agent_id), Change::UserMail,
        Change::Mailbox(agent_id), Change::Events, Change::History(agent_id),
        Change::Spark { from: "@user".into(), to: agent.clone() },
    ]);
    if let Some(request)=question {crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("docket.question.answered",crate::runtime::watchdogs::events::Scope::Agent(org.id,agent_id),json!({"agent_id":agent_id,"request":request})));}
    if live && !halted {
        crate::runtime::wake(engine, org.id, agent_id);
    }
    if let Some(h) = engine.agents.get(agent_id) {
        h.send(crate::runtime::AgentMsg::Wake);
    }
    agent
}

/// `POST /asks/{aid}/answer`: a question card. On a one-question card
/// `selected` is its picks; on a batch, one entry per tab (as in 3.x).
#[logged]
pub async fn answer(engine: &Arc<Engine>, org: &Arc<OrgHandle>, uid: &str, body: &Value) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = open_by(&tx, org.id, Some(uid), None).await?;
    if open.parts.credit.is_some() || open.parts.scope.is_some() {
        refuse!(Conflict, "this request has other tabs; submit the complete batch");
    }
    if let Some(rev) = body["rev"].as_i64() {
        if rev != i64::from(open.rev) {
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
        let decision = settle(org, tx, &open, "dismissed", json!({ "dismissed": true }), text, Some(ev), DecisionEffects::default()).await?;
        drop(client);
        let node = publish_decision(engine, org, decision).await;
        return Ok(json!({ "answered": open.uid, "node": node }));
    }
    // 3.x's guards: answers are positional, so an unstamped answer to a card
    // amended after it first rendered may attach to tabs the user never saw
    if body.get("rev").is_none_or(Value::is_null) && open.rev > 1 {
        refuse!(Conflict, "this card was amended after it first rendered; read it again and answer what it shows now");
    }
    if open.parts.questions.is_empty() {
        refuse!(Conflict, "that request asks no question");
    }
    let selected = body["selected"].as_array().cloned().unwrap_or_default();
    let free = body["text"].as_str().unwrap_or("").trim().to_string();
    let n = open.parts.questions.len();
    // one list of picks per tab: on a one-question card `selected` is that
    // question's picks (several on a multi-select); on a batch, one entry
    // per tab, each answered
    let picks: Vec<Vec<String>> = if n > 1 {
        if selected.len() > n {
            refuse!(BadRequest, "the answer carried {} items for a {n}-question card; send exactly one per tab", selected.len());
        }
        let per: Vec<Vec<String>> = (0..n).map(|i| chosen(selected.get(i).unwrap_or(&Value::Null))).collect();
        let covered = per.iter().filter(|p| !p.is_empty()).count();
        if covered < n {
            refuse!(BadRequest, "every tab needs an answer: this card has {n} questions and the answer covered {covered}");
        }
        per
    } else {
        let sel: Vec<String> = selected.iter().flat_map(chosen).collect();
        if sel.is_empty() && free.is_empty() {
            refuse!(BadRequest, "an answer needs selected options or text");
        }
        vec![sel]
    };
    let mut lines = Vec::new();
    for (q, p) in open.parts.questions.iter().zip(&picks) {
        lines.push(answer_text(q, &if p.is_empty() { json!(free) } else { json!(p) }));
    }
    if !free.is_empty() && !(n == 1 && picks[0].is_empty()) {
        lines.push(format!("Note: {free}"));
    }
    let text = format!("The user answered your question:\n\n{}", lines.join("\n\n"));
    let qs: Vec<Value> = open
        .parts
        .questions
        .iter()
        .zip(&picks)
        .map(|(q, p)| json!({ "label": header(q), "question": q["question"].as_str().unwrap_or(""), "selected": p }))
        .collect();
    let single = qs.len() <= 1;
    let note = Some(free.as_str()).filter(|f| !f.is_empty());
    let ev = crate::events::answer_ask(&org.slug, &open.uid, &open.agent, qs, note, false, single);
    let decision = settle(org, tx, &open, "answered", json!({ "selected": selected, "text": free }), text, Some(ev), DecisionEffects::default()).await?;
    drop(client);
    let node = publish_decision(engine, org, decision).await;
    Ok(json!({ "answered": open.uid, "node": node }))
}

/// Apply a credit decision: the agent's grant becomes `granted`.
#[logged]
async fn grant_credits(
    engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>,
    agent: &str, granted: f64, fx: &mut ops::Effects,
) -> Result<Value> {
    let grant: f64 = tx
        .query_one("SELECT grant_credits::float8 FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live' FOR UPDATE", &[&org.id, &agent])
        .await?
        .get(0);
    let delta = granted - grant;
    ops::run_in_tx(engine, org, tx, &ops::Actor::User,
        &json!({ "op": "reallocate", "node": agent, "delta": delta }), fx).await
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
    if !open.parts.questions.is_empty() || open.parts.scope.is_some() {
        refuse!(Conflict, "this request has other tabs; submit the complete batch");
    }
    if let Some(rev) = body.get("rev") {
        if rev.as_i64() != Some(i64::from(open.rev)) {
            refuse!(Conflict, "the credit request changed; read it again");
        }
    }
    let Some(c) = open.parts.credit.clone() else { refuse!(Conflict, "that request asks for no credits") };
    let asked = c["new"].as_f64().unwrap_or(0.0);
    let granted = credit_total(body["granted"].as_f64().unwrap_or(asked))?;
    let mut warnings = Vec::new();
    if action != "deny" {
        let held: f64 = tx
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
        let mut fx = DecisionEffects::default();
        grant_credits(engine, org, &tx, &open.agent, granted, &mut fx.credits).await?;
        let msg = format!("The user granted credits: your grant is now {granted} (you asked for {asked}).");
        let decision = settle(org, tx, &open, "granted", json!({ "granted": granted }), msg, Some(crate::events::credit_decision(&org.slug, &open.agent, &open.uid, c["old"].as_f64().unwrap_or(0.0), asked, Some(granted))), fx).await?;
        drop(client);
        let node = publish_decision(engine, org, decision).await;
        return Ok(json!({ "ok": true, "node": node, "warnings": warnings }));
    }
    let decision = settle(org, tx, &open, status, json!({ "denied": true }), text, Some(crate::events::credit_decision(&org.slug, &open.agent, &open.uid, c["old"].as_f64().unwrap_or(0.0), asked, None)), DecisionEffects::default()).await?;
    drop(client);
    let node = publish_decision(engine, org, decision).await;
    Ok(json!({ "ok": true, "node": node, "warnings": warnings }))
}

/// `POST /nodes/{nid}/batch`: resolve the whole request at once.
#[logged]
fn validate_batch(open: &Open, body: &Value) -> Result<()> {
    for (part, present) in [
        ("ask", !open.parts.questions.is_empty()),
        ("credits", open.parts.credit.is_some()),
        ("scope", open.parts.scope.is_some()),
    ] {
        if present && body["revs"][part].as_i64() != Some(i64::from(open.rev)) {
            refuse!(Conflict, "the {part} request changed or its revision is missing; read it again");
        }
    }
    if !open.parts.questions.is_empty() {
        let Some(answers) = body["answers"].as_array() else {
            refuse!(BadRequest, "send one answer per question; use null to skip explicitly");
        };
        if answers.len() != open.parts.questions.len() {
            refuse!(BadRequest, "send one answer per question; use null to skip explicitly");
        }
    }
    if open.parts.credit.is_some() {
        let cd = &body["credits"];
        let decisions = usize::from(cd["skip"] == true)
            + usize::from(cd["deny"] == true)
            + usize::from(cd["granted"].as_f64().is_some());
        if decisions != 1 {
            refuse!(BadRequest, "decide credits explicitly: granted, deny, or skip");
        }
    }
    if let Some(scope) = &open.parts.scope {
        let count = scope["items"].as_array().map(Vec::len).unwrap_or(0);
        let Some(decisions) = body["scope"].as_array() else {
            refuse!(BadRequest, "send approve, deny, or skip for every scope item");
        };
        if decisions.len() != count || decisions.iter().any(|v| {
            !matches!(v.as_str().map(str::trim), Some("approve" | "deny" | "skip"))
        }) {
            refuse!(BadRequest, "send approve, deny, or skip for every scope item");
        }
    }
    Ok(())
}

#[logged]
pub async fn resolve_batch(engine: &Arc<Engine>, org: &Arc<OrgHandle>, agent: &str, body: &Value) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let open = open_by(&tx, org.id, None, Some(agent)).await?;
    validate_batch(&open, body)?;
    let mut fx = DecisionEffects::default();
    let mut sections = Vec::new();
    let mut cards: Vec<Value> = Vec::new();
    // as in 3.x, a submit that decides nothing (every tab skipped: the
    // card's close) closes the card as dismissed, not answered
    let mut decided_any = false;
    // questions
    let answers = body["answers"].as_array().cloned().unwrap_or_default();
    let mut asked = Vec::new();
    for (i, q) in open.parts.questions.iter().enumerate() {
        let a = answers.get(i).cloned().unwrap_or(Value::Null);
        sections.push(answer_text(q, &a));
        let picked = chosen(&a);
        decided_any |= !picked.is_empty();
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
            let g = credit_total(g)?;
            decided_any = true;
            grant_credits(engine, org, &tx, &open.agent, g, &mut fx.credits).await?;
            sections.push(format!("Credits: granted — your grant is now {g} (you asked for {}).", c["new"]));
            cards.push(json!({ "kind": "credit", "outcome": if (g - wanted).abs() < 1e-9 { "approved" } else { "counter" },
                               "old": old, "asked": wanted, "granted": g, "now": g }));
        } else if cd["deny"].as_bool().unwrap_or(false) {
            decided_any = true;
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
            let d = decisions[i].as_str().unwrap().trim();
            sections.push(format!("{}: {}", item_label(it), match d {
                "approve" => "granted",
                "deny" => "denied",
                _ => "not decided",
            }));
            decided_any |= d != "skip";
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
            fx.scope = Some(apply_scope(org, &tx, &open.agent, &approved).await?);
        }
    }
    let text = format!("The user resolved your request:\n\n{}", sections.join("\n\n"));
    let ev = crate::events::answer_batch(&org.slug, &open.uid, &open.agent, cards);
    let status = if decided_any { "answered" } else { "dismissed" };
    let decision = settle(org, tx, &open, status, body.clone(), text, Some(ev), fx).await?;
    drop(client);
    let node = publish_decision(engine, org, decision).await;
    Ok(json!({ "resolved": open.uid, "node": node }))
}

/// Granted scope items join the agent's configured scope (the user grants
/// them, so the chain above is raised as needed by the scope route).
#[logged]
async fn apply_scope(
    org: &Arc<OrgHandle>, tx: &Transaction<'_>, agent: &str, items: &[Value],
) -> Result<crate::http::nodes::ScopeEffects> {
    let sc: Value = tx
        .query_one("SELECT scope FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted' FOR UPDATE", &[&org.id, &agent])
        .await?
        .get(0);
    let cur = scope::normalize(&sc);
    let mut patch = json!({});
    let mut dirs = cur["add_dirs"].as_array().cloned().unwrap_or_default();
    let mut tools = cur["tools"].clone();
    for it in items {
        match it["kind"].as_str() {
            Some("dir") => {
                if let Some(old) = dirs.iter_mut().find(|d| d["path"] == it["path"]) {
                    if it["mode"] == "rw" { old["mode"] = json!("rw"); }
                } else {
                    dirs.push(json!({ "path": it["path"], "mode": it["mode"] }));
                }
            },
            Some("tool") => {
                if let Some(t) = it["tool"].as_str() {
                    tools[t] = json!(true);
                }
            }
            Some("mcp") => {
                if let (Some(s), Some(list)) = (it["server"].as_str(), tools["mcp"].as_array_mut()) {
                    if !list.iter().any(|x| x == s || x == "*") {
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
    crate::http::nodes::apply_user_scope_in_tx(org, tx, agent, &patch).await
}
