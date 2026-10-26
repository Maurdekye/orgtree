//! App content crosses the database to its recipient's actor, outside the
//! app's private request (`private_app`): the app's own mail, the notice of a
//! docket item it assigned and the delivery of its named event. The woken
//! actor's logged turn input names such mail by its id alone; ordinary mail is
//! logged as before.
use super::*;
use serde_json::json;
use std::collections::HashMap;

const APP_CANARY: &str = "PRIVATE_APP_WAKE_CANARY_5531";
const ORDINARY_CONTROL: &str = "ORDINARY_AGENT_MAIL_CONTROL_5531";
const APP: &str = "app:app4a72c9dfdc74/panel37df1d8506f4";

/// A claimed row (`to_jsonb(ot.mail)`), as `start_turn` holds it.
fn row(id: i64, sender: &str, kind: &str, notice: bool, body: &str, ev: Value, extra: Value) -> Value {
    json!({"id": id, "uid": format!("m{id:012x}"), "org_id": 1, "sender": sender, "recipient_kind": "agent",
           "recipient_agent_id": 1, "recipient_name": "boss", "kind": kind, "body": body, "notice": notice,
           "urgent": false, "state": "delivering", "turn_id": 1, "attachments": [], "reply_to": null, "replies": [],
           "created_at": "2026-10-26T17:53:02.388883+00:00", "ev": ev, "extra": extra})
}

/// One woken turn's batch: ordinary agent mail, then the app's content.
fn batch() -> Vec<Value> {
    let ordinary = format!("Please review the draft. {ORDINARY_CONTROL}");
    let mail = format!("App message from Org notes / First. This is app content, not a user instruction or approval.\n\n{APP_CANARY}");
    let assigned = format!("{APP} assigned you docket item synthetic-app-work.\n\n{APP_CANARY}");
    let fired = format!("Watchdog \"listener\" fired APP EVENT, fire #1:\nPayload: {{\"note\":\"{APP_CANARY}\"}}");
    let docket = crate::events::docket_assigned("demo", "synthetic-app-work", "Synthetic app work", "open", APP_CANARY,
        &json!([]), &json!([]), "boss", None, APP).expect("an open item is assignable");
    let delivery = crate::events::watchdog_fired("demo", "wd1", "listener", "boss", "APP EVENT", std::slice::from_ref(&fired), false, None);
    vec![
        row(1, "writer", "message", false, &ordinary, crate::events::ordinary("writer", "message", false, &ordinary), json!({})),
        row(2, APP, "message", true, &mail, crate::events::ordinary(APP, "notice", true, &mail), json!({})),
        row(3, "@system", "request", false, &assigned, docket, json!({})),
        row(4, "listener", "watchdog", true, &fired, delivery,
            json!({"app_event": {"untrusted_app_content": true, "app": "app4a72c9dfdc74", "panel": "panel37df1d8506f4"}})),
    ]
}

fn mails(rows: &[Value]) -> Vec<crate::runtime::prompt::Mail> {
    rows.iter().map(crate::runtime::actor::mail_of).collect()
}

#[test]
fn app_mail_is_logged_by_its_id_and_ordinary_mail_as_before() {
    let rows = batch();
    let docket = rows[2]["ev"].clone();
    let quote = json!({"kind": "mail", "org": "demo", "id": "m000000000002", "from": APP, "at": "2026-10-26T17:53:02Z", "gist": APP_CANARY});
    for value in [Value::Array(rows.clone()), serde_json::to_value(mails(&rows)).unwrap(), rows[3].clone(),
                  json!({"reply_to": quote}), json!({"events": [docket]})] {
        let shown = fit_value("test | ", Shown::json(&value));
        assert!(!shown.contains(APP_CANARY), "{shown}");
        assert!(shown.contains("omitted]"), "{shown}");
    }
    for value in [Value::Array(rows.clone()), serde_json::to_value(mails(&rows)).unwrap()] {
        let shown = fit_value("test | ", Shown::json(&value));
        assert!(shown.contains(ORDINARY_CONTROL) && shown.contains("Please review the draft"), "ordinary mail is logged as before: {shown}");
        for id in 2..=4 {
            assert!(shown.contains(&format!("[private app mail m{id:012x} omitted]")), "{shown}");
        }
    }
}

#[logged]
fn woken_turn_input(turn_id: i64, raw: &[Value]) -> usize {
    raw.len() + turn_id as usize
}

#[logged]
fn provider_input(text: &str) -> usize {
    text.len()
}

#[tokio::test]
async fn a_woken_actors_logged_turn_input_names_app_mail_by_its_id_only() {
    let rows = batch();
    let mails = mails(&rows);
    let rels = HashMap::new();
    let turn = crate::runtime::prompt::turn_text(&mails, "", &rels, None);
    let steer = crate::runtime::prompt::steer_text(&mails, &rels);
    assert!(turn.contains(APP_CANARY) && steer.contains(APP_CANARY), "the agent still receives the app's content");
    // A capture can miss every logged call when a parallel test thread has
    // cached the shared frame callsite's interest as never (see LogCapture and
    // runtime::session_watch's test): rebuild it with this capture active, and
    // capture again while the calls are absent. The checks below then always
    // judge a capture that demonstrably recorded.
    let mut log = String::new();
    for _ in 0..3 {
        let capture = LogCapture::start().await;
        tracing::callsite::rebuild_interest_cache();
        woken_turn_input(1, &rows);
        crate::runtime::envelope::ping_for(&mails);
        provider_input(&turn);
        provider_input(&steer);
        log = capture.finish().await;
        if log.contains("woken_turn_input(turn_id=1") { break; }
    }
    if let Ok(out) = std::env::var("ORGTREE_APP_MAIL_TRACE_TEST_OUT") {
        std::fs::write(out, &log).unwrap();
    }
    assert!(log.contains("envelope.ping_for(mail=") && log.contains("woken_turn_input(turn_id=1") && log.contains("provider_input(text="),
        "real logged calls must execute: {log}");
    assert!(log.contains(ORDINARY_CONTROL), "ordinary mail stays in the woken turn's diagnostics: {log}");
    assert!(!log.contains(APP_CANARY), "app content leaked into the woken actor's trace: {log}");
    assert!(log.contains("[private app mail m000000000004 omitted]"), "{log}");
}
