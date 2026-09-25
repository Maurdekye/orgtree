//! The qualification harness endpoint, without a database: plan validation,
//! hold/release, actions, controls, and the frames on the wire.
#![cfg(feature = "qualification")]

use std::sync::Arc;
use std::time::Duration;

use orgtree_store::hooks::{ControlPlan, HookAction, PauseHook, PausePoint};
use orgtree_store::{KeyNamespace, OpIdentity, Uuid};
use orgtree_store_service::harness::{self, HarnessState, PROTOCOL};
use orgtree_store_service::proto::{read_frame, write_frame};
use orgtree_store_service::{handler, server};
use serde_json::{json, Value};
use tokio::net::TcpStream;

fn op() -> OpIdentity {
    OpIdentity { org: Uuid::nil(), ns: KeyNamespace::Minted, key: "k".into(), fingerprint: "f".into(), fingerprint_codec: "legacy-1", caller_keyed: false }
}

async fn at(s: &HarnessState, name: &str, tag: Option<&str>) -> HookAction {
    let op = op();
    let p = PausePoint { name, family: "receipt", verb: "lookup", op: &op, op_tag: tag, attempt: 1, backend_pid: Some(7) };
    s.at(&p).await
}

#[test]
fn plans_are_validated_before_install() {
    let s = HarnessState::new();
    let bad_action = json!({"type": "plan", "run_id": "r", "holds": [{"op_tag": "t", "point": "a.b.c", "action": "teleport", "timeout_ms": 5}], "controls": []});
    assert!(!s.install_plan(&bad_action).is_empty());
    let no_timeout = json!({"type": "plan", "run_id": "r", "holds": [{"op_tag": "t", "point": "a.b.c", "action": "hold", "timeout_ms": 0}], "controls": []});
    assert!(!s.install_plan(&no_timeout).is_empty());
    let dup = json!({"type": "plan", "run_id": "r", "controls": [], "holds": [
        {"op_tag": "t", "point": "a.b.c", "action": "hold", "timeout_ms": 5},
        {"op_tag": "t", "point": "a.b.c", "action": "sleep", "ms": 1, "timeout_ms": 5}]});
    assert!(!s.install_plan(&dup).is_empty());
}

#[tokio::test]
async fn unplanned_points_and_untagged_operations_never_block() {
    let s = HarnessState::new();
    let plan = json!({"type": "plan", "run_id": "r", "controls": [], "holds": [
        {"op_tag": "t", "point": "receipt.lookup.before_fence", "action": "hold", "timeout_ms": 60000}]});
    assert!(s.install_plan(&plan).is_empty());
    let d = Duration::from_millis(200);
    assert_eq!(tokio::time::timeout(d, at(&s, "receipt.lookup.after_inflight_check", Some("t"))).await.unwrap(), HookAction::Continue);
    assert_eq!(tokio::time::timeout(d, at(&s, "receipt.lookup.before_fence", None)).await.unwrap(), HookAction::Continue);
    assert_eq!(tokio::time::timeout(d, at(&s, "receipt.lookup.before_fence", Some("other"))).await.unwrap(), HookAction::Continue);
}

#[tokio::test]
async fn actions_map_to_hook_actions_and_controls_arm() {
    let s = HarnessState::new();
    let plan = json!({"type": "plan", "run_id": "r", "controls": ["Q-RL3.skip_inflight_check"], "holds": [
        {"op_tag": "t", "point": "x.y.fail", "action": "fail_next", "sqlstate": "40P01", "timeout_ms": 5},
        {"op_tag": "t", "point": "x.y.drop", "action": "drop_conn", "timeout_ms": 5},
        {"op_tag": "t", "point": "x.y.sleep", "action": "sleep", "ms": 3, "timeout_ms": 5}]});
    assert!(s.install_plan(&plan).is_empty());
    assert_eq!(at(&s, "x.y.fail", Some("t")).await, HookAction::FailNext("40P01".into()));
    assert_eq!(at(&s, "x.y.drop", Some("t")).await, HookAction::DropConn);
    assert_eq!(at(&s, "x.y.sleep", Some("t")).await, HookAction::Sleep(3));
    assert!(s.armed("Q-RL3.skip_inflight_check", &op(), None));
    assert!(!s.armed("Q-C4.remint_identity", &op(), None));
}

/// Over the wire: a bad token gets nothing; hello → handshake; plan; the
/// operation ARRIVES and waits; release lets it continue; finish → finished.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hold_and_release_over_the_wire() {
    let state = HarnessState::new();
    let l = server::bind_loopback().await.unwrap();
    let port = l.local_addr().unwrap().port();
    let token = server::new_token();
    let hs = json!({"type": "handshake", "protocol": PROTOCOL, "qualification": true, "build_sha": "t",
                    "points": handler::points(), "controls": handler::CONTROLS, "declared": handler::declared()});
    tokio::spawn(harness::serve(l, Arc::new(token.clone()), state.clone(), hs));
    let t = Duration::from_secs(5);

    let mut bad = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    write_frame(&mut bad, &json!({"type": "hello", "token": "nope", "protocol": PROTOCOL})).await.unwrap();
    assert!(matches!(tokio::time::timeout(t, read_frame(&mut bad)).await.unwrap(), Ok(None) | Err(_)));

    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    write_frame(&mut s, &json!({"type": "hello", "token": token, "protocol": PROTOCOL})).await.unwrap();
    let hs = tokio::time::timeout(t, read_frame(&mut s)).await.unwrap().unwrap().unwrap();
    assert_eq!(hs["type"], "handshake");
    assert_eq!(hs["qualification"], true);
    assert_eq!(hs["declared"]["receipt.lookup"]["relations"]["authority_epoch"]["required"], true);
    let plan = json!({"type": "plan", "run_id": "r1", "controls": [], "holds": [
        {"op_tag": "t1", "point": "receipt.lookup.before_fence", "action": "hold", "timeout_ms": 20000}]});
    write_frame(&mut s, &plan).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let st = state.clone();
    let op_task = tokio::spawn(async move { at(&st, "receipt.lookup.before_fence", Some("t1")).await });
    let arrived: Value = tokio::time::timeout(t, read_frame(&mut s)).await.unwrap().unwrap().unwrap();
    assert_eq!(arrived["type"], "arrived");
    assert_eq!(arrived["point"], "receipt.lookup.before_fence");
    assert_eq!(arrived["op_tag"], "t1");
    assert_eq!(arrived["backend_pid"], 7);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!op_task.is_finished(), "a hold must block until release");
    write_frame(&mut s, &json!({"type": "release", "op_tag": "t1", "point": "receipt.lookup.before_fence"})).await.unwrap();
    assert_eq!(tokio::time::timeout(t, op_task).await.unwrap().unwrap(), HookAction::Continue);
    write_frame(&mut s, &json!({"type": "finish"})).await.unwrap();
    assert_eq!(tokio::time::timeout(t, read_frame(&mut s)).await.unwrap().unwrap().unwrap()["type"], "finished");
}

#[test]
fn declared_contacts_have_the_oracle_shape() {
    let d = handler::declared();
    let modes = ["read", "write", "for_key_share", "for_share", "for_no_key_update", "for_update"];
    for (kind, spec) in d.as_object().unwrap() {
        assert!(spec.get("p01_contract").is_some(), "{kind}");
        assert!(!spec["source"].as_str().unwrap().trim().is_empty(), "{kind}");
        let rels = spec["relations"].as_object().unwrap();
        assert!(!rels.is_empty(), "{kind}");
        for (rel, r) in rels {
            assert!(r["required"].is_boolean(), "{kind}.{rel}");
            let m = r["modes"].as_array().unwrap();
            assert!(!m.is_empty() && m.iter().all(|x| modes.contains(&x.as_str().unwrap())), "{kind}.{rel}");
        }
    }
    assert_eq!(d["receipt.lookup"]["relations"]["operation_receipts"]["required"], true);
}
