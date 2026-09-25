//! WS5's verbs on the store service (CONTRACT-M1 §9): the mail doors, the
//! inbox reads and read mark, and the internal receiver/recovery/runtime
//! drivers the harness uses. Kept in its own module so the shared handler
//! only needs one routing line per workstream.
//!
//! Binding rules: the door has authenticated the caller and bound the
//! principal; the service trusts it and every command re-anchors inside its
//! transaction. A request with a caller key uses it as the operation key
//! (agent keys under the immutable principal, operator keys — the human
//! send's `client_op`, E-D4 — under the operator); a keyless request gets a
//! minted key (E4). `args.fingerprint` is the door's canonical fingerprint.

use serde_json::{json, Value};

use orgtree_store::mail::doors::{AgentSend, Target};
use orgtree_store::mail::human::{self, HumanCommand, HumanSend, MarkRead};
use orgtree_store::mail::{inbox, receive, recovery};
use orgtree_store::runtime::{self, admit::FakeProvider};
use orgtree_store::sent::MailClass;
use orgtree_store::{Binding, Connector, Executor, KeyNamespace, OpIdentity, Outcome, Principal, Uuid};

use crate::proto::Request;

pub const VERBS: &[&str] = &[
    "mail.message",
    "mail.notice",
    "mail.extern-send",
    "mail.human-send",
    "mail.human-command",
    "mail.user-inbox",
    "mail.node-inbox",
    "mail.user-inbox-read",
    // internal drivers (harness / background owners)
    "mail.deliver",
    "mail.recover",
    "runtime.turn",
];

fn bad(detail: impl Into<String>) -> Value {
    json!({"error": "bad_request", "detail": detail.into()})
}

fn uuid_arg(args: &Value, k: &str) -> Result<Uuid, Value> {
    args.get(k).and_then(Value::as_str).and_then(|s| s.parse().ok()).ok_or_else(|| bad(format!("missing uuid argument {k}")))
}

fn str_arg<'a>(args: &'a Value, k: &str) -> Result<&'a str, Value> {
    args.get(k).and_then(Value::as_str).ok_or_else(|| bad(format!("missing string argument {k}")))
}

fn binding(req: &Request) -> Result<Binding, Value> {
    let b = &req.binding;
    let fp = req.args.get("fingerprint").and_then(Value::as_str).unwrap_or("").to_string();
    let principal = match (b.principal_kind.as_str(), b.principal, b.generation) {
        ("agent", Some(id), Some(generation)) => Principal::Agent { id, generation },
        ("operator", Some(id), _) => Principal::Operator { id },
        ("system", _, _) => Principal::System,
        (k, _, _) => return Err(bad(format!("principal {k} cannot use this verb"))),
    };
    let op = match (&b.key, &principal) {
        (Some(k), Principal::Agent { id, .. }) => OpIdentity { org: req.org, ns: KeyNamespace::Agent { principal: *id }, key: k.clone(), fingerprint: fp, fingerprint_codec: "legacy-1", caller_keyed: true },
        (Some(k), Principal::Operator { id }) => OpIdentity { org: req.org, ns: KeyNamespace::Operator { operator: *id }, key: k.clone(), fingerprint: fp, fingerprint_codec: "legacy-1", caller_keyed: true },
        _ => OpIdentity::minted(req.org, fp, "legacy-1"),
    };
    let op_tag = if orgtree_store::hooks::QUALIFICATION { b.op_tag.clone() } else { None };
    Ok(Binding { principal, acting: b.acting, op, db_incarnation: Uuid::nil(), op_tag })
}

fn outcome<T: serde::Serialize>(o: Outcome<T>) -> Value {
    match o {
        Outcome::Applied(v) => json!({"outcome": "applied", "result": v}),
        Outcome::Replayed(v) => json!({"outcome": "replayed", "result": v}),
        Outcome::Compensated(v) => json!({"outcome": "compensated", "result": v}),
        Outcome::Refused(r) => json!({"outcome": "refused", "code": r.code, "message": r.message}),
        Outcome::RetryExhausted { attempts, last_sqlstate } => json!({"outcome": "retry_exhausted", "attempts": attempts, "last_sqlstate": last_sqlstate}),
        other => json!({"outcome": other.name()}),
    }
}

fn store_err(e: impl std::fmt::Debug) -> Value {
    json!({"error": "store_error", "detail": format!("{e:?}")})
}

/// Route one WS5 verb. `None` = not a WS5 verb.
pub async fn handle<C: Connector>(exec: &Executor<C>, req: &Request) -> Option<Result<Value, Value>> {
    let a = &req.args;
    let org = req.org;
    let r = match req.verb.as_str() {
        v @ ("mail.message" | "mail.notice" | "mail.extern-send") => {
            let run = async {
                let b = binding(req)?;
                let target = match v {
                    "mail.extern-send" => Target::External { handle: str_arg(a, "to")?.to_string() },
                    _ if a.get("to").and_then(Value::as_str) == Some("user") => Target::User,
                    _ => Target::Agent { principal: uuid_arg(a, "to")? },
                };
                let cmd = AgentSend {
                    target,
                    message_id: a.get("message_id").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or_else(Uuid::new_v4),
                    class: if v == "mail.notice" { MailClass::Passive } else { MailClass::Message },
                    kind: a.get("kind").and_then(Value::as_str).unwrap_or(if v == "mail.notice" { "notice" } else { "message" }).to_string(),
                    body: a.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
                    urgent_reason: a.get("urgent_reason").and_then(Value::as_str).map(str::to_string),
                    reply_grant: a.get("reply_grant").and_then(Value::as_bool).unwrap_or(true),
                };
                exec.run(&cmd, &b).await.map(outcome).map_err(store_err)
            };
            run.await
        }
        "mail.human-send" => {
            let run = async {
                let operator = match (req.binding.principal_kind.as_str(), req.binding.principal) {
                    ("operator", Some(id)) => id,
                    _ => return Err(bad("the human send is made by the operator")),
                };
                let fp = a.get("fingerprint").and_then(Value::as_str).unwrap_or("");
                // E-D4: client_op is the key (the Q-HM2 control ignores it)
                let b = human::human_binding(exec.hooks(), org, operator, req.binding.key.as_deref(), fp);
                let cmd = HumanSend {
                    node: uuid_arg(a, "node")?,
                    message_id: a.get("message_id").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or_else(Uuid::new_v4),
                    kind: a.get("kind").and_then(Value::as_str).unwrap_or("message").to_string(),
                    body: a.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
                };
                exec.run(&cmd, &b).await.map(outcome).map_err(store_err)
            };
            run.await
        }
        "mail.human-command" => {
            let run = async {
                let b = binding(req)?;
                let cmd = HumanCommand::new(uuid_arg(a, "node")?, str_arg(a, "command")?, a.get("args").cloned().unwrap_or(json!({})));
                human::human_command(exec, cmd, &b).await.map(outcome).map_err(store_err)
            };
            run.await
        }
        "mail.user-inbox-read" => {
            let run = async {
                let b = binding(req)?;
                let ids: Vec<Uuid> = a.get("ids").and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str()?.parse().ok()).collect()).unwrap_or_default();
                let o = exec.run(&MarkRead { ids }, &b).await.map_err(store_err)?;
                Ok(json!({"read": human::read_count(&o)}))
            };
            run.await
        }
        "mail.user-inbox" => inbox::user_inbox(exec, org).await.map(|v| json!(v)).map_err(store_err),
        "mail.node-inbox" => match uuid_arg(a, "node") {
            Ok(n) => inbox::node_inbox(exec, org, n).await.map(|v| json!(v)).map_err(store_err),
            Err(e) => Err(e),
        },
        "mail.deliver" => {
            let run = async {
                let d = receive::deliver(exec, org, uuid_arg(a, "mailbox")?, uuid_arg(a, "message")?).await.map_err(store_err)?;
                Ok(json!({"delivery": format!("{d:?}")}))
            };
            run.await
        }
        "mail.recover" => recovery::recover(exec, org, &recovery::Sweep::default()).await.map(|r| json!(r)).map_err(store_err),
        "runtime.turn" => {
            let run = async {
                let t = runtime::run_turn(exec, org, uuid_arg(a, "seat")?, &FakeProvider { tamper: false }).await.map_err(store_err)?;
                Ok(json!(t))
            };
            run.await
        }
        _ => return None,
    };
    Some(r)
}
