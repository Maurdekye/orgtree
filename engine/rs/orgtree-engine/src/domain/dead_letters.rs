//! A project's dead letters (docket project-dead-letter-queue-failed-ack-queue-jobs-a;
//! user 2026-10-18 19:38Z-19:40Z): the jobs of an ack-mode queue that ran out
//! of attempts (`projects::reclaim`). A dead letter is the project's own copy
//! of the mail, `state = 'read'`, with `extra.dead_letter` ({by, by_id, why, how,
//! attempts, at}) and the attempt history `extra.attempt_log` (one entry per
//! hand-out: {n, by, by_id, copy, at, ended: {how, why, at}}).
//!
//! The agents above or below the project (and the user) list and read them,
//! retry one (back in the queue with its attempts reset; the history stays) or
//! drop one with a reason (it leaves the open list and the count but stays
//! readable). An event watchdog on `project.dead_letter` alerts an agent with
//! that reach when a job lands here (`projects::reclaim` emits it).

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

use crate::util::{gist, iso};

/// SQL: an open dead letter of the project (alias `m`): dead-lettered and not dropped.
pub const OPEN: &str = "m.state = 'read' AND m.extra ? 'dead_letter' AND NOT (m.extra ? 'dead_letter_dropped')";
/// SQL: any dead letter of the project, dropped ones included.
const ANY: &str = "m.state = 'read' AND m.extra ? 'dead_letter'";

/// How many open dead letters the project holds.
#[logged]
pub async fn count(client: &impl GenericClient, project: i64) -> Result<i64> {
    Ok(client
        .query_one(&format!("SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $1 AND {OPEN}"), &[&project])
        .await?
        .get(0))
}

/// The project's dead letters, newest first: `{project, total, dropped, letters}`.
/// `total` counts the open ones; `include_dropped` lists the dropped ones too.
#[logged]
pub async fn list(client: &impl GenericClient, project: i64, pname: &str, limit: i64, offset: i64, include_dropped: bool) -> Result<Value> {
    let total = count(client, project).await?;
    let dropped: i64 = client
        .query_one(&format!("SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $1 AND {ANY} AND m.extra ? 'dead_letter_dropped'"), &[&project])
        .await?
        .get(0);
    let scope = if include_dropped { ANY } else { OPEN };
    let rows = client
        .query(
            &format!("SELECT m.uid, m.sender, m.kind, m.created_at, m.body, jsonb_array_length(m.attachments), m.extra
                        FROM ot.mail m WHERE m.recipient_agent_id = $1 AND {scope} ORDER BY m.id DESC LIMIT $2 OFFSET $3"),
            &[&project, &limit, &offset],
        )
        .await?;
    let letters: Vec<Value> = rows
        .iter()
        .map(|r| {
            let extra: Value = r.get(6);
            let mut v = summary(&r.get::<_, String>(0), &r.get::<_, String>(1), &r.get::<_, String>(2), &extra);
            v["at"] = json!(iso(r.get(3)));
            v["preview"] = json!(gist(&r.get::<_, String>(4), 300));
            let files: i32 = r.get(5);
            if files > 0 {
                v["attachments"] = json!(files);
            }
            v
        })
        .collect();
    Ok(json!({ "project": pname, "total": total, "dropped": dropped, "letters": letters }))
}

/// The fields every listing of a dead letter carries.
#[nolog]
fn summary(uid: &str, sender: &str, kind: &str, extra: &Value) -> Value {
    let d = &extra["dead_letter"];
    let mut v = json!({
        "id": uid, "from": sender, "kind": crate::domain::mail::shown_kind(kind),
        "attempts": d["attempts"], "by": d["by"], "why": d["why"], "how": d["how"], "dead_at": d["at"],
    });
    if let Some(r) = extra.get("retried").and_then(Value::as_array).filter(|r| !r.is_empty()) {
        v["retried"] = json!(r.len());
    }
    if let Some(x) = extra.get("dead_letter_dropped").filter(|x| x.is_object()) {
        v["dropped"] = json!({ "by": x["by"], "reason": x["reason"], "at": x["at"] });
    }
    v
}

/// One dead letter in full: the whole mail, the final reason and the attempt history.
#[logged]
pub async fn read(client: &impl GenericClient, project: i64, pname: &str, uid: &str) -> Result<Value> {
    let Some(r) = client
        .query_opt(
            &format!("SELECT m.uid, m.sender, m.kind, m.created_at, m.body, m.attachments, m.reply_to, m.extra
                        FROM ot.mail m WHERE m.recipient_agent_id = $1 AND m.uid = $2 AND {ANY}"),
            &[&project, &uid],
        )
        .await?
    else {
        crate::refuse!(NotFound, "project {pname} has no dead letter {uid}; orgtree_project action=dead_letters lists them");
    };
    let extra: Value = r.get(7);
    let mut v = summary(&r.get::<_, String>(0), &r.get::<_, String>(1), &r.get::<_, String>(2), &extra);
    v["project"] = json!(pname);
    v["at"] = json!(iso(r.get(3)));
    v["body"] = json!(r.get::<_, String>(4));
    v["attachments"] = r.get::<_, Value>(5);
    v["reason"] = extra["dead_letter"]["why"].clone();
    v["history"] = extra.get("attempt_log").filter(|l| l.is_array()).cloned().unwrap_or_else(|| json!([]));
    if let Some(x) = extra.get("retried").filter(|x| x.is_array()) {
        v["retries"] = x.clone();
    }
    Ok(v)
}

/// Put a dead letter back in the queue with its attempts reset (the attempt
/// history stays; the retry is recorded). Runs in the op's transaction.
#[logged]
pub async fn retry(tx: &impl GenericClient, project: i64, pname: &str, uid: &str, by: &str) -> Result<()> {
    check_open(tx, project, pname, uid).await?;
    tx.execute(
        "UPDATE ot.mail m SET state = 'pending', read_at = NULL,
                extra = (m.extra - 'dead_letter' - 'claimed') || jsonb_build_object('attempts', 0,
                        'retried', coalesce(m.extra->'retried', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                            'by', $3::text, 'at', now(), 'after_attempts', coalesce((m.extra->>'attempts')::bigint, 0),
                            'was', m.extra->'dead_letter')))
          WHERE m.recipient_agent_id = $1 AND m.uid = $2",
        &[&project, &uid, &by],
    )
    .await?;
    Ok(())
}

/// Drop a dead letter with a reason: it leaves the open list and the count and
/// stays readable. Runs in the op's transaction.
#[logged]
pub async fn drop_letter(tx: &impl GenericClient, project: i64, pname: &str, uid: &str, by: &str, reason: &str) -> Result<()> {
    check_open(tx, project, pname, uid).await?;
    tx.execute(
        "UPDATE ot.mail m SET extra = m.extra || jsonb_build_object('dead_letter_dropped',
                jsonb_build_object('by', $3::text, 'reason', $4::text, 'at', now()))
          WHERE m.recipient_agent_id = $1 AND m.uid = $2",
        &[&project, &uid, &by, &reason],
    )
    .await?;
    Ok(())
}

/// Lock the dead letter and refuse unless it is open: dead-lettered, not
/// dropped, not retried since.
#[logged]
async fn check_open(tx: &impl GenericClient, project: i64, pname: &str, uid: &str) -> Result<()> {
    let row = tx
        .query_opt(
            "SELECT m.state, m.extra ? 'dead_letter', m.extra ? 'dead_letter_dropped' FROM ot.mail m
              WHERE m.recipient_agent_id = $1 AND m.uid = $2 FOR UPDATE",
            &[&project, &uid],
        )
        .await?;
    match row {
        None => crate::refuse!(NotFound, "project {pname} has no dead letter {uid}; orgtree_project action=dead_letters lists them"),
        Some(r) if r.get::<_, String>(0) != "read" || !r.get::<_, bool>(1) => {
            crate::refuse!(Conflict, "mail {uid} is not a dead letter of project {pname} (it may have been retried already)")
        }
        Some(r) if r.get::<_, bool>(2) => crate::refuse!(Conflict, "dead letter {uid} of project {pname} was already dropped"),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_summary_names_the_last_holder_the_reason_and_any_drop_or_retry() {
        let extra = json!({
            "dead_letter": { "by": "dz", "why": "was halted", "how": "released", "attempts": 2, "at": "2026-10-18T19:05:00Z" },
            "retried": [{ "by": "boss" }],
            "dead_letter_dropped": { "by": "boss", "reason": "obsolete", "at": "2026-10-18T19:10:00Z", "extra": 1 },
        });
        let v = summary("m1", "@user", "message", &extra);
        assert_eq!(v["id"], "m1");
        assert_eq!(v["by"], "dz");
        assert_eq!(v["attempts"], 2);
        assert_eq!(v["why"], "was halted");
        assert_eq!(v["retried"], 1);
        assert_eq!(v["dropped"]["reason"], "obsolete");
        assert!(v["dropped"].get("extra").is_none(), "only by, reason and at are shown");
        let open = summary("m2", "boss", "message", &json!({ "dead_letter": { "by": "dz", "attempts": 3 } }));
        assert!(open.get("dropped").is_none() && open.get("retried").is_none());
    }

    #[test]
    fn the_open_filter_leaves_dropped_letters_out() {
        assert!(OPEN.contains("NOT (m.extra ? 'dead_letter_dropped')"));
        assert!(!ANY.contains("dead_letter_dropped"));
    }
}
