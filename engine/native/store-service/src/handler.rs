//! The store service's request routing. At M1 it serves `ping` and
//! `receipt.lookup`; WS3-WS5 register their family verbs here.

use serde_json::{json, Value};

use orgtree_store::lookup::{LookupAnswer, LookupReq};
use orgtree_store::{Connector, Executor, KeyNamespace, OpIdentity, Uuid};

use crate::proto::{Handshake, Request, PROTOCOL};
use crate::server::Handler;

pub const VERBS: &[&str] = &["ping", "receipt.lookup", "service.shutdown"];

/// Generic executor points every family verb exposes (CONTRACT-M1 §5).
pub const GENERIC_POINTS: &[&str] =
    &["admitted", "begin", "after_anchor", "after_claim", "before_commit", "after_commit", "before_effects"];

/// Every unsafe control this build contains (static list for the handshake).
pub const CONTROLS: &[&str] = &[
    "Q-C4.remint_identity",
    "Q-C4.stale_attempt_ts",
    "Q-C4.retry_any_23505",
    "Q-C4.effects_before_commit",
    "Q-RL1.late_receipt_separate_fence",
    "Q-RL3.skip_inflight_check",
    "Q-C5.hidden_pooled_statement",
    "Q-C1.org_wide_lock",
    "Q-C6.register_without_lock",
    "Q-C5.no_xact_baseline",
    "Q-C6.ack_without_lock",
];

/// The handshake's DECLARED-CONTACTS table (CONTRACT-M1 §5 r4; WS7
/// `oracle.py` shape). `required` marks the design's mandatory contacts.
pub fn declared() -> Value {
    json!({
        "receipt.lookup": {
            "relations": {
                "authority_epoch": {"modes": ["read", "for_share"], "required": true},
                "operation_receipts": {"modes": ["read", "write"], "required": true},
                "store_incarnation": {"modes": ["read"], "required": true},
                "runtime_inflight": {"modes": ["read"], "required": true},
                "service_incarnations": {"modes": ["read"], "required": true}
            },
            "p01_contract": null,
            "source": "S3 §4.12 and E-D13; CONTRACT-M1 §4 (caller anchor, in-flight check, fence on the original key)"
        },
        "inflight.admit": {
            "relations": {"runtime_inflight": {"modes": ["write"], "required": true}},
            "p01_contract": null,
            "source": "S3 E-D13: infrastructure step outside the command transaction"
        },
        "inflight.release": {
            "relations": {"runtime_inflight": {"modes": ["write"], "required": true}},
            "p01_contract": null,
            "source": "S3 E-D13: infrastructure step outside the command transaction"
        }
    })
}

/// Every pause point this build's verbs expose (static list for the handshake).
pub fn points() -> Vec<String> {
    let mut out: Vec<String> = ["receipt.lookup.after_inflight_check", "receipt.lookup.before_fence"].iter().map(|s| s.to_string()).collect();
    for label in ["lookup.anchor", "receipt.read", "lookup.incarnation", "inflight.live", "exec.now", "receipt.fence"] {
        out.push(format!("receipt.lookup.stmt.{label}.before"));
        out.push(format!("receipt.lookup.stmt.{label}.after"));
    }
    out
}

pub struct StoreHandler<C: Connector> {
    pub exec: Executor<C>,
    pub build_sha: String,
    pub service_incarnation: Uuid,
    /// Notified by the authenticated `service.shutdown` verb.
    pub shutdown: std::sync::Arc<tokio::sync::Notify>,
}

fn lookup_json(a: &LookupAnswer) -> Value {
    match a {
        LookupAnswer::Applied { result, compensated } => json!({"state": "applied", "result": result, "compensated": compensated}),
        LookupAnswer::NotApplied => json!({"state": "not_applied", "fenced": true}),
        LookupAnswer::Running => json!({"state": "running"}),
        LookupAnswer::Conflict => json!({"state": "conflict"}),
        LookupAnswer::Unknown { reason, fenced } => json!({"state": "unknown", "reason": reason, "fenced": fenced}),
        LookupAnswer::CallerRefused => json!({"error": "caller_refused"}),
    }
}

fn arg_str<'a>(args: &'a Value, k: &str) -> Result<&'a str, Value> {
    args.get(k).and_then(Value::as_str).ok_or_else(|| json!({"error": "bad_request", "detail": format!("missing string argument {k}")}))
}

impl<C: Connector + 'static> StoreHandler<C> {
    async fn lookup(&self, req: &Request) -> Result<Value, Value> {
        let b = &req.binding;
        let (Some(caller), Some(generation)) = (b.principal, b.generation) else {
            return Err(json!({"error": "bad_request", "detail": "a lookup is made by an agent principal"}));
        };
        let a = &req.args;
        let key_incarnation: Uuid = arg_str(a, "key_incarnation")?.parse().map_err(|_| json!({"error": "bad_request", "detail": "key_incarnation is not a uuid"}))?;
        let lr = LookupReq {
            op: OpIdentity {
                org: req.org,
                ns: KeyNamespace::Agent { principal: caller },
                key: arg_str(a, "op_key")?.to_string(),
                fingerprint: arg_str(a, "fingerprint")?.to_string(),
                fingerprint_codec: "legacy-1",
                caller_keyed: true,
            },
            caller,
            caller_generation: generation,
            key_incarnation,
            coverage: arg_str(a, "coverage")?.to_string(),
            receipted: a.get("receipted").and_then(Value::as_bool).unwrap_or(false),
            provable_absence: a.get("provable_absence").and_then(Value::as_bool).unwrap_or(false),
        };
        match self.exec.lookup(&lr).await {
            Ok(ans) => {
                let mut v = lookup_json(&ans);
                v["op_key"] = json!(lr.op.key);
                v["coverage"] = json!(lr.coverage);
                Ok(v)
            }
            Err(e) => Err(json!({"error": "store_error", "detail": format!("{e:?}")})),
        }
    }
}

impl<C: Connector + 'static> Handler for StoreHandler<C> {
    fn handshake(&self) -> Handshake {
        Handshake {
            protocol: PROTOCOL.into(),
            qualification: orgtree_store::hooks::QUALIFICATION,
            build_sha: self.build_sha.clone(),
            verbs: VERBS.iter().map(|s| s.to_string()).collect(),
            points: if orgtree_store::hooks::QUALIFICATION { points() } else { vec![] },
            controls: if orgtree_store::hooks::QUALIFICATION { CONTROLS.iter().map(|s| s.to_string()).collect() } else { vec![] },
        }
    }

    async fn handle(&self, req: Request) -> Value {
        let r = match req.verb.as_str() {
            "ping" => Ok(json!({"pong": true, "service_incarnation": self.service_incarnation})),
            "receipt.lookup" => self.lookup(&req).await,
            "service.shutdown" => {
                self.shutdown.notify_one();
                Ok(json!({"ok": true, "stopping": true}))
            }
            other => Err(json!({"error": "unknown_verb", "verb": other})),
        };
        r.unwrap_or_else(|e| e)
    }
}
