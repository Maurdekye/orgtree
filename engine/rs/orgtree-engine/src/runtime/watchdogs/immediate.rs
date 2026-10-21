//! Already-resolved one-shots (USER 2026-10-21 18:05:58Z). No watchdog
//! row, runner, fire mail or holder wake is created for the inline result.
use super::*;

#[nolog]
fn ready_lines(kind: &str, target: &str, smoke: &Value, lines: &[String]) -> Vec<String> {
    match kind {
        "command" => lines.to_vec(),
        "process" if smoke["up"] == false => vec![format!("{target} is already DOWN")],
        _ => Vec::new(),
    }
}

#[nolog]
pub(super) async fn resolve(engine: &Arc<Engine>, org_id: i64, owner: i64, owner_name: &str, id: &str,
    kind: &str, target: &str, memo: &Value, smoke: &Value, smoke_lines: &[String], actions: &[Value]) -> Result<Option<Value>> {
    let mut out = json!({});
    let (lines, prefix) = match kind {
        "slot" => {
            let project = memo["target_id"].as_i64().unwrap();
            let Some(grant) = crate::domain::slots::claim_once(engine, org_id, project, owner, memo).await? else { return Ok(None) };
            let lines = vec![grant["line"].as_str().unwrap().to_string()];
            out["lease"] = grant["lease"].clone(); out["slots"] = grant["slots"].clone();
            (lines, " SLOT GRANTED —")
        }
        "fair_queue" => {
            let project = memo["target_id"].as_i64().unwrap();
            let Some(messages) = crate::domain::projects::take_once(engine, org_id, project, owner, owner_name, id,
                crate::domain::projects::batch_size(memo)).await? else { return Ok(None) };
            let lines = messages.iter().map(|m| format!("Mail {} from {} via project {target}:\n{}", m["id"].as_str().unwrap_or(""),
                m["from"].as_str().unwrap_or(""), m["body"].as_str().unwrap_or(""))).collect();
            out["messages"] = json!(messages);
            (lines, " PROJECT MAIL —")
        }
        _ => {
            let lines = ready_lines(kind, target, smoke, smoke_lines);
            if lines.is_empty() { return Ok(None); }
            (lines, "")
        }
    };
    let clean: Vec<String> = lines.iter().map(|s| s.replace('\0', "")).collect();
    // Reuse normal formatting and action authority/depth/time limits. Durable
    // slot/queue effects committed above; never hold DB locks over tool calls.
    let mut body = fire_body_parts(id, kind, target, &clean, prefix, false, 1, false);
    body.push_str("Resolved immediately inside this tool call. No watchdog was registered; no fire mail or wake was sent.\n");
    let results = run_fire_actions(engine, org_id, owner, owner_name, id, id, actions).await;
    body.push_str(&results);
    out["id"] = json!(id); out["name"] = json!(id); out["once"] = json!(true);
    out["resolved"] = json!(true); out["registered"] = json!(false); out["status"] = json!("resolved immediately; no watchdog registered");
    out["fire"] = json!({"body":body,"events":clean,"fire_actions":results});
    out["smoke"] = smoke.clone();
    if kind == "process" { out["smoke"]["note"] = json!("Already DOWN: this one-shot resolved immediately, without registering a DOWN-edge watcher."); }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_down_and_smoke_matches_are_immediate() {
        assert_eq!(ready_lines("command", "echo", &json!({}), &["READY".into()]), vec!["READY"]);
        assert!(ready_lines("command", "echo", &json!({}), &[]).is_empty());
        assert_eq!(ready_lines("process", "pid:5", &json!({"up":false}), &[]), vec!["pid:5 is already DOWN"]);
        for up in [json!(true), Value::Null] { assert!(ready_lines("process", "pid:5", &json!({"up":up}), &[]).is_empty()); }
        for kind in ["file","stream","mqtt","websocket","usage","event","activity","project_listener","listener_watch"] {
            assert!(ready_lines(kind, "target", &json!({"up":false}), &["READY".into()]).is_empty(), "{kind}");
        }
    }
}
