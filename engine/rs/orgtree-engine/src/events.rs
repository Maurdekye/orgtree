//! Typed event envelopes (`ev`) on engine-sent mail (decision 24): the
//! renderer draws them as cards and validates them strictly against
//! `renderer/src/generated/events.schema.json` (no extra keys), while the
//! agent reads the mail body. Each builder emits exactly its variant's fields;
//! a value outside a variant's enum yields `None` and the mail stays plain.

use serde_json::{json, Map, Value};

pub const USER: &str = "@user";
pub const SYSTEM: &str = "@system";

/// Canonical leaf construction. Callers supply the declared fields, never prose
/// recognition; the same envelope reaches the desk, inbox and agent formatter.
#[logged]
pub fn typed(variant: &str, who: &str, object: Value, fields: Value) -> Value {
    let mut out = envelope(variant, actor(who), object);
    if let Value::Object(fields) = fields {
        out.extend(fields);
    }
    Value::Object(out)
}

#[logged]
pub fn ordinary(who: &str, kind: &str, notice: bool, body: &str) -> Value {
    let kind = if notice { "notice" } else if ["message", "question", "request", "decision", "status"].contains(&kind) { kind } else { "message" };
    typed(&format!("ordinary.{kind}"), who, Value::Null, json!({ "body": body }))
}

#[logged]
pub fn status_report(org: &str, node: &str, generation: i64, state: &str, summary: &str) -> Value {
    typed("status.report", node, node_ref(org, node, generation), json!({ "state": state, "summary": summary }))
}

#[logged]
pub fn credit_decision(org: &str, node: &str, request: &str, old: f64, asked: f64, granted: Option<f64>) -> Value {
    let outcome = match granted {
        None => "denied", Some(n) if n < old => "reduced", Some(n) if n == asked => "approved", Some(_) => "counter",
    };
    typed("decision.credit", USER, json!({"kind":"credit_request", "org":org, "id":request, "node":node}),
          json!({ "outcome": outcome, "old": old, "asked": asked, "granted": granted, "now": granted.unwrap_or(old) }))
}

/// The canonical actor for a sender id: the user, the engine, an outside peer, an agent.
pub fn actor(who: &str) -> Value {
    match who {
        "@user" | "user" => json!({ "kind": "user", "id": USER }),
        "@system" | "system" | "orgtree" => json!({ "kind": "system", "id": SYSTEM }),
        w if w.starts_with("@net:") || w.starts_with("@org:") => json!({ "kind": "external", "id": w }),
        w => json!({ "kind": "agent", "id": w }),
    }
}

pub fn watchdog_actor(uid: &str) -> Value {
    json!({ "kind": "watchdog", "id": uid })
}

fn envelope(variant: &str, actor: Value, object: Value) -> Map<String, Value> {
    let engine = actor["kind"] == "system";
    let mut o = Map::new();
    o.insert("v".into(), json!(1));
    o.insert("variant".into(), json!(variant));
    o.insert("actor".into(), actor);
    o.insert("engine_authored".into(), json!(engine));
    o.insert("object".into(), object);
    o
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// `answer.ask`: the user's answer to (or dismissal of) a question card. The
/// desk retires its own queued "Request resolved" entry when this card, for
/// the same ask id, arrives.
pub fn answer_ask(org: &str, ask_id: &str, node: &str, questions: Vec<Value>, text: Option<&str>, dismissed: bool, single: bool) -> Value {
    let mut o = envelope("answer.ask", actor(USER), json!({ "kind": "ask", "org": org, "id": ask_id, "node": node }));
    o.insert("questions".into(), Value::Array(questions));
    o.insert("text".into(), json!(text));
    o.insert("dismissed".into(), json!(dismissed));
    o.insert("single".into(), json!(single));
    Value::Object(o)
}

/// `answer.batch`: a whole request (questions, credits, scope) resolved at once.
pub fn answer_batch(org: &str, ask_id: &str, node: &str, sections: Vec<Value>) -> Value {
    let mut o = envelope("answer.batch", actor(USER), json!({ "kind": "batch", "org": org, "id": ask_id, "node": node }));
    o.insert("sections".into(), Value::Array(sections));
    Value::Object(o)
}

pub fn work_item_ref(org: &str, slug: &str, title: &str) -> Value {
    json!({ "kind": "work_item", "org": org, "slug": slug, "title": title })
}

const ASSIGNABLE: &[&str] = &["backlogged", "open", "in_progress", "blocked", "waiting", "review", "approved", "deploy_ready", "done", "superseded", "dropped"];

/// `docket.assigned`: the item now belongs to `owner`.
#[allow(clippy::too_many_arguments)]
pub fn docket_assigned(
    org: &str,
    slug: &str,
    title: &str,
    status: &str,
    objective: &str,
    done: &Value,
    next: &Value,
    owner: &str,
    previous_owner: Option<&str>,
    assigner: &str,
) -> Option<Value> {
    if !ASSIGNABLE.contains(&status) {
        return None;
    }
    let mut o = envelope("docket.assigned", actor(assigner), work_item_ref(org, slug, title));
    o.insert("owner".into(), json!(owner));
    o.insert("previous_owner".into(), json!(previous_owner));
    o.insert("assigner".into(), json!(assigner));
    o.insert("status".into(), json!(status));
    o.insert("objective".into(), json!(objective));
    o.insert("done_so_far".into(), json!(strings(done)));
    o.insert("working_on_next".into(), json!(strings(next)));
    o.insert("acceptance".into(), json!([]));
    o.insert("objective_notice".into(), Value::Null);
    Some(Value::Object(o))
}

/// `docket.participant_added`.
pub fn participant_added(org: &str, slug: &str, title: &str, added_by: &str, owner: &str, objective: &str) -> Value {
    let mut o = envelope("docket.participant_added", actor(added_by), work_item_ref(org, slug, title));
    o.insert("added_by".into(), json!(added_by));
    o.insert("owner".into(), json!(owner));
    o.insert("objective".into(), json!(objective));
    o.insert("objective_notice".into(), Value::Null);
    Value::Object(o)
}

/// `decision.attention_dismissed`: the user dismissed an item's flag.
pub fn attention_dismissed(org: &str, slug: &str, title: &str, reason: &str, pending_questions: i64) -> Value {
    let mut o = envelope("decision.attention_dismissed", actor(USER), work_item_ref(org, slug, title));
    o.insert("reason".into(), json!(reason));
    o.insert("pending_questions".into(), json!(pending_questions));
    o.insert("dismissed_by".into(), json!(USER));
    Value::Object(o)
}

/// `reply.docket`: the user's reply on an item, to its owner or a participant.
pub fn reply_docket(org: &str, slug: &str, title: &str, body: &str, role: &str, owner: Option<&str>) -> Value {
    let mut o = envelope("reply.docket", actor(USER), work_item_ref(org, slug, title));
    o.insert("body".into(), json!(body));
    o.insert("role".into(), json!(role));
    o.insert("owner".into(), json!(if role == "participant" { owner } else { None }));
    Value::Object(o)
}

pub fn watchdog_ref(org: &str, uid: &str, name: &str, owner: &str) -> Value {
    json!({ "kind": "watchdog", "org": org, "id": uid, "name": name, "owner": owner })
}

/// `monitor.watchdog_fired`.
pub fn watchdog_fired(org: &str, uid: &str, name: &str, owner: &str, prefix: &str, lines: &[String], once: bool) -> Value {
    let mut o = envelope("monitor.watchdog_fired", watchdog_actor(uid), watchdog_ref(org, uid, name, owner));
    o.insert("prefix".into(), json!(prefix));
    o.insert("lines".into(), json!(lines));
    o.insert("count".into(), json!(lines.len()));
    o.insert("once".into(), json!(once));
    Value::Object(o)
}

/// `monitor.watchdog_quiet`: the watched subject went quiet.
pub fn watchdog_quiet(org: &str, uid: &str, name: &str, owner: &str, headline: &str, facts: &[String], advice: &str) -> Value {
    let mut o = envelope("monitor.watchdog_quiet", watchdog_actor(uid), watchdog_ref(org, uid, name, owner));
    o.insert("headline".into(), json!(headline));
    o.insert("facts".into(), json!(facts));
    o.insert("advice".into(), json!(advice));
    Value::Object(o)
}

pub fn audience_req_ref(org: &str, node: &str, target: &str) -> Value {
    json!({ "kind": "audience_request", "org": org, "node": node, "target": target })
}

/// `access.audience_requested`: a request reaching the one who decides it.
pub fn audience_requested(org: &str, from_node: &str, target: &str, reason: &str) -> Value {
    let mut o = envelope("access.audience_requested", actor(from_node), audience_req_ref(org, from_node, target));
    o.insert("stage".into(), json!(if target == USER { "user" } else { "target" }));
    o.insert("from_node".into(), json!(from_node));
    o.insert("target".into(), json!(target));
    o.insert("reason".into(), json!(reason));
    Value::Object(o)
}

/// `decision.audience`: a request was granted or declined.
pub fn audience_decided(org: &str, node: &str, target: &str, granted: bool, decided_by: &str) -> Value {
    let mut o = envelope("decision.audience", actor(decided_by), audience_req_ref(org, node, target));
    o.insert("granted".into(), json!(granted));
    o.insert("target".into(), json!(target));
    o.insert("decided_by".into(), json!(decided_by));
    Value::Object(o)
}

pub fn node_ref(org: &str, name: &str, generation: i64) -> Value {
    json!({ "kind": "node", "org": org, "id": name, "name": name, "generation": generation })
}

const AUDIENCE_OUTCOMES: &[&str] = &[
    "user_audience", "audience_with", "audience_from", "user_audience_seen", "org_inbox", "org_inbox_auto", "org_inbox_released",
    "rescinded", "declined",
];

/// `access.audience_changed`: what a grant or revoke means for `node`.
pub fn audience_changed(org: &str, node: &str, generation: i64, outcome: &str, by: &str, target: &str, other: Option<&str>) -> Option<Value> {
    if !AUDIENCE_OUTCOMES.contains(&outcome) {
        return None;
    }
    let mut o = envelope("access.audience_changed", actor(by), node_ref(org, node, generation));
    o.insert("outcome".into(), json!(outcome));
    o.insert("by".into(), json!(by));
    o.insert("target".into(), json!(target));
    o.insert("other".into(), json!(other));
    Some(Value::Object(o))
}

/// `reminder.working_checkup`: the automatic 20-minute working-status check.
pub fn reminder_working_checkup(org: &str, node: &str, generation: i64) -> Value {
    Value::Object(envelope("reminder.working_checkup", actor(SYSTEM), node_ref(org, node, generation)))
}

/// `reminder.idle_docket`: the items (at most 20) whose next action is this
/// idle agent's; `more` counts the ones not listed.
pub fn reminder_idle_docket(org: &str, node: &str, generation: i64, items: Vec<Value>, more: i64) -> Value {
    let mut o = envelope("reminder.idle_docket", actor(SYSTEM), node_ref(org, node, generation));
    o.insert("items".into(), Value::Array(items));
    o.insert("more".into(), json!(more));
    Value::Object(o)
}
