//! Project queue relay (relay spec rev 1.4, USER 2026-11-04 16:10:28Z m8bb8c9368e2d): a `fair_queue` dog owned by project
//! Q and targeting project P takes jobs out of P's queue and re-enqueues each as a NEW job in Q's own queue. The child job
//! (J2) carries the original sender, `org_inbox` (for outside mail) and `relayed_from`, so the worker in Q that finally
//! claims it gets the reply right, the threading and the follow-ups exactly as if it had listened to P directly. P's job
//! (J) is claimed `by_project` (never `by_id`/`by_user`) until J2's custody in Q ends.
use super::*;

/// How many waiting, unclaimed jobs a relay lets pile up in its own project's queue (R6); the dog's `batch` replaces it.
pub const RELAY_BATCH: i64 = 5;
/// A job may be relayed at most this many times (R7).
pub const RELAY_DEPTH: usize = 8;

/// Does a relay edge path lead from project `from` to project `to` (R7)? A relay "Q on P" is the edge P -> Q, so a new
/// relay of Q on P closes a loop when `Q` already reaches `P` through relays.
#[logged]
pub async fn relay_loop(client: &impl GenericClient, q: i64, p: i64) -> Result<bool> {
    Ok(client
        .query_opt(
            "WITH RECURSIVE r(id) AS (
               SELECT $1::bigint
               UNION
               SELECT w.owner_agent_id FROM ot.watchdogs w JOIN r ON (w.memo->>'target_id')::bigint = r.id
                WHERE w.kind = 'fair_queue' AND w.owner_kind = 'project' AND w.state IN ('armed', 'paused'))
             SELECT 1 FROM r WHERE id = $2",
            &[&q, &p],
        )
        .await?
        .is_some())
}

/// The relays that take jobs from `project`, as watchers: their room is `batch` minus what already waits in their own
/// queue, counted under the relaying project's row lock (R6). The project row of the SOURCE is already locked by the
/// caller, so the lock order is always source then target, and the relay edges form no loop (R7).
#[logged]
pub(super) async fn eligible(tx: &impl GenericClient, org_id: i64, project: i64) -> Result<Vec<Watcher>> {
    let rows = tx
        .query(
            "SELECT w.id, w.uid, w.owner_agent_id, q.name, w.last_fired, w.created_at, w.memo
               FROM ot.watchdogs w JOIN ot.agents q ON q.id = w.owner_agent_id AND q.kind = 'project' AND q.state = 'live'
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.owner_kind = 'project' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2
              ORDER BY w.last_fired NULLS FIRST, w.created_at, w.id LIMIT 16 FOR UPDATE OF w",
            &[&org_id, &project],
        )
        .await?;
    let mut out = Vec::new();
    for r in &rows {
        let q: i64 = r.get(2);
        let memo: Value = r.get(6);
        if tx.query_opt("SELECT 1 FROM ot.agents WHERE id = $1 AND kind = 'project' AND state = 'live' FOR NO KEY UPDATE", &[&q]).await?.is_none() {
            continue;
        }
        let waiting: i64 = tx
            .query_one("SELECT count(*) FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending' AND NOT (extra ? 'bundled_with')", &[&q])
            .await?
            .get(0);
        out.push(Watcher {
            row: r.get(0),
            uid: r.get(1),
            owner: Some(q),
            owner_name: r.get(3),
            last_fired: r.get(4),
            created_at: r.get(5),
            once: false,
            notice: false,
            remaining: batch_size(&memo).saturating_sub(waiting.max(0) as usize),
            freed_at: None,
            relay: true,
        });
    }
    Ok(out)
}

/// May this job be relayed into project `q`: no loop at run time and not past the depth limit (R7)?
#[nolog]
pub(super) fn may_relay(relayed_from: &Option<Value>, q: i64) -> bool {
    let chain = relayed_from.as_ref().and_then(|v| v["chain"].as_array().cloned()).unwrap_or_default();
    chain.len() < RELAY_DEPTH && !chain.iter().any(|c| c.as_i64() == Some(q))
}

/// R4: hand job `m` (a row of `hand_batch_in`'s waiting query) to the relay `w`: the child job in the relaying project's
/// mailbox, J's claim `by_project`, and J's bundled follow-ups as follow-ups of the child. Returns the child's uid.
#[logged]
pub(super) async fn hand(tx: &impl GenericClient, org_id: i64, project: i64, pname: &str, ack: bool, w: &Watcher,
                         m: &tokio_postgres::Row, waited_from: DateTime<Utc>) -> Result<String> {
    let q = w.owner.unwrap_or_default();
    let job_uid: String = m.get(1);
    let mail_id: i64 = m.get(0);
    let relayed_from: Option<Value> = m.get(20);
    let org_inbox: Option<Value> = m.get(21);
    let mut chain = relayed_from.as_ref().and_then(|v| v["chain"].as_array().cloned()).unwrap_or_default();
    chain.push(json!(project));
    let mut extra = json!({ "relayed_from": { "project": project, "name": pname, "job": job_uid, "dog": w.uid, "chain": chain } });
    if let Some(o) = org_inbox { extra["org_inbox"] = o; }
    let j2 = uid("m");
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id, recipient_name,
                              kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, state, net_id, net_hub, replies, extra)
         VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', $16, $17, $18, $19)",
        &[&j2, &org_id, &m.get::<_, String>(2), &m.get::<_, Option<i64>>(3), &m.get::<_, Option<i32>>(4), &q, &w.owner_name,
          &m.get::<_, String>(5), &m.get::<_, bool>(6), &m.get::<_, String>(7), &m.get::<_, Value>(8), &m.get::<_, Option<Value>>(9),
          &m.get::<_, Option<Value>>(10), &m.get::<_, bool>(11), &m.get::<_, Option<String>>(12), &m.get::<_, Option<String>>(13),
          &m.get::<_, Option<String>>(14), &m.get::<_, Value>(15), &extra],
    )
    .await?;
    tx.execute(
        "UPDATE ot.mail SET state = 'read', read_at = now(), delivered_at = coalesce(delivered_at, now()),
                extra = extra || jsonb_build_object('claimed', jsonb_build_object('by', $2::text, 'by_project', $3::bigint, 'by_user', false,
                        'dog', $4::text, 'copy', $5::text, 'at', now(), 'ack', $6::boolean, 'wakes', 0, 'waited_from', $7::timestamptz),
                        'relayed_to', jsonb_build_object('project', $3::bigint, 'job', $5::text),
                        'attempts', coalesce((extra->>'attempts')::int, 0) + 1,
                        'attempt_log', coalesce(extra->'attempt_log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                            'n', coalesce((extra->>'attempts')::int, 0) + 1, 'by', $2::text, 'by_project', $3::bigint,
                            'copy', $5::text, 'at', now(), 'waited_from', $7::timestamptz, 'dog', $4::text)))
          WHERE id = $1",
        &[&mail_id, &w.owner_name, &q, &w.uid, &j2, &ack, &waited_from],
    )
    .await?;
    // follow-ups bundled with J travel with the child (R4)
    let bundled = tx
        .query(
            "SELECT id, uid, sender, sender_agent_id, sender_generation, kind, body, attachments, reply_to, ev, net_id, net_hub, replies,
                    extra->'org_inbox'
               FROM ot.mail WHERE extra->>'bundled_with' = $1 AND recipient_agent_id = $2 AND NOT (extra ? 'bundled_handed')
              ORDER BY id FOR UPDATE",
            &[&job_uid, &project],
        )
        .await?;
    for b in &bundled {
        let b_uid = uid("m");
        let mut bx = json!({ "bundled_with": j2 });
        if let Some(o) = b.get::<_, Option<Value>>(13) { bx["org_inbox"] = o; }
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id, recipient_name,
                                  kind, body, attachments, reply_to, ev, state, read_at, net_id, net_hub, replies, extra)
             VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, 'read', now(), $13, $14, $15, $16)",
            &[&b_uid, &org_id, &b.get::<_, String>(2), &b.get::<_, Option<i64>>(3), &b.get::<_, Option<i32>>(4), &q, &w.owner_name,
              &b.get::<_, String>(5), &b.get::<_, String>(6), &b.get::<_, Value>(7), &b.get::<_, Option<Value>>(8),
              &b.get::<_, Option<Value>>(9), &b.get::<_, Option<String>>(10), &b.get::<_, Option<String>>(11),
              &b.get::<_, Value>(12), &bx],
        )
        .await?;
        tx.execute("UPDATE ot.mail SET extra = extra || jsonb_build_object('bundled_handed', $2::text) WHERE id = $1", &[&b.get::<_, i64>(0), &b_uid]).await?;
    }
    Ok(j2)
}

/// R5: the custody of `child` (a relayed job) has ended in its project, so the job it was relayed from is done: in the
/// parent project's ACK mode it is ACKed now (`acked_by` "relay Q"); in round-robin mode there is nothing to record. The
/// parent job may itself be a child of an earlier relay, whose custody then ends too.
#[logged]
pub(crate) async fn settle(tx: &impl GenericClient, org_id: i64, child: &str) -> Result<()> {
    let mut child = child.to_string();
    for _ in 0..=RELAY_DEPTH {
        let Some(c) = tx.query_opt("SELECT extra->'relayed_from', recipient_name FROM ot.mail WHERE uid = $1", &[&child]).await? else { return Ok(()) };
        let (Some(rf), qname): (Option<Value>, String) = (c.get(0), c.get(1)) else { return Ok(()) };
        let (Some(p), Some(job)) = (rf["project"].as_i64(), rf["job"].as_str().map(str::to_string)) else { return Ok(()) };
        let Some(row) = tx
            .query_opt(
                "SELECT id, extra->'claimed', coalesce((extra->>'attempts')::bigint, 0) FROM ot.mail
                  WHERE uid = $1 AND recipient_agent_id = $2 AND extra->'claimed'->>'by_project' IS NOT NULL
                    AND extra->'claimed'->>'acked_at' IS NULL AND extra->'claimed'->>'copy' = $3 FOR UPDATE",
                &[&job, &p, &child],
            )
            .await?
        else {
            return Ok(());
        };
        let claimed: Value = row.get(1);
        if claimed["ack"].as_bool() != Some(true) {
            return Ok(());
        }
        let by = format!("relay {qname}");
        tx.execute(
            &format!("UPDATE ot.mail SET extra = {} WHERE id = $1", closed_attempt(
                "jsonb_set(jsonb_set(extra, '{claimed,acked_at}', to_jsonb(now())), '{claimed,acked_by}', to_jsonb($2::text))", "'acked'", "'acked'")),
            &[&row.get::<_, i64>(0), &by],
        )
        .await?;
        record_ending(tx, org_id, p, &job, &claimed, claimed["by_project"].as_i64(), &by, "acked", None, row.get(2), None).await?;
        child = job;
    }
    Ok(())
}

/// R5: the relayed job `child` dead-lettered in its project, so the job it came from does too, in the parent project,
/// without being requeued (that could loop it back into the same relay).
#[logged]
pub(crate) async fn dead_lettered(tx: &impl GenericClient, org_id: i64, child: &str, qname: &str) -> Result<()> {
    let Some(c) = tx.query_opt("SELECT extra->'relayed_from' FROM ot.mail WHERE uid = $1", &[&child]).await? else { return Ok(()) };
    let Some(rf) = c.get::<_, Option<Value>>(0) else { return Ok(()) };
    let (Some(p), Some(job)) = (rf["project"].as_i64(), rf["job"].as_str().map(str::to_string)) else { return Ok(()) };
    let Some(row) = tx
        .query_opt(
            "SELECT id, extra->'claimed', coalesce((extra->>'attempts')::bigint, 0) FROM ot.mail
              WHERE uid = $1 AND recipient_agent_id = $2 AND extra->'claimed'->>'by_project' IS NOT NULL
                AND extra->'claimed'->>'copy' = $3 AND extra->'claimed'->>'acked_at' IS NULL FOR UPDATE",
            &[&job, &p, &child],
        )
        .await?
    else {
        return Ok(());
    };
    let claimed: Value = row.get(1);
    let attempts: i64 = row.get(2);
    let by = format!("relay {qname}");
    let why = format!("relayed to project {qname} and dead-lettered there");
    tx.execute(
        &format!("UPDATE ot.mail m SET extra = (({}) - 'claimed') || jsonb_build_object('dead_letter', jsonb_build_object(
                    'by', $2::text, 'why', $3::text, 'how', 'relayed'::text, 'attempts', $4::bigint, 'at', now()))
          WHERE m.id = $1", closed_attempt("m.extra", "'dead_letter'", "$3::text")),
        &[&row.get::<_, i64>(0), &by, &why, &attempts],
    )
    .await?;
    record_ending(tx, org_id, p, &job, &claimed, claimed["by_project"].as_i64(), &by, "dead_letter", Some(&why), attempts, None).await?;
    Ok(())
}

/// R5: take job `row` back from its relay: the child is revoked (a worker that holds it keeps it but loses its reply right;
/// one still waiting in the relaying project's queue is withdrawn), and the job goes back to the front of its own project's
/// queue, preferring another listener. `ending` is `taken_back` (the user's act) or `failed` (the relaying project retired).
/// The caller holds the parent project's row. `false`: it is not a held relay job any more.
#[logged]
pub async fn take_back(tx: &impl GenericClient, org_id: i64, project: i64, row: i64, why: &str, ending: &str) -> Result<bool> {
    let Some(m) = tx
        .query_opt(
            &format!("SELECT m.uid, coalesce((m.extra->>'attempts')::bigint, 0), m.extra->'claimed' FROM ot.mail m WHERE m.id = $1 AND {OUTSTANDING} FOR UPDATE"),
            &[&row],
        )
        .await?
    else {
        return Ok(false);
    };
    let (uid, attempts, claimed): (String, i64, Value) = (m.get(0), m.get(1), m.get(2));
    let (Some(q), Some(child)) = (claimed["by_project"].as_i64(), claimed["copy"].as_str().map(str::to_string)) else { return Ok(false) };
    let qname = claimed["by"].as_str().unwrap_or("?").to_string();
    // the child: revoked; a still-waiting one leaves the relaying project's queue (and its bundled follow-ups with it)
    tx.execute("UPDATE ot.mail SET extra = extra || '{\"revoked\": true}'::jsonb WHERE uid = $1", &[&child]).await?;
    tx.execute(
        "UPDATE ot.mail SET state = 'read', read_at = now(), extra = extra || jsonb_build_object('withdrawn', jsonb_build_object('why', $2::text, 'at', now()))
          WHERE uid = $1 AND state = 'pending'",
        &[&child, &why],
    )
    .await?;
    let ended = closed_attempt("m.extra", "$4::text", "$3::text");
    tx.execute(
        &format!("UPDATE ot.mail m SET state = 'pending', read_at = NULL,
                extra = (({ended}) - 'claimed' - 'relayed_to')
                    || jsonb_build_object('released', jsonb_build_object('by', $2::text, 'why', $3::text, 'copy', $5::text, 'at', now()))
          WHERE m.id = $1"),
        &[&row, &format!("relay {qname}"), &why, &"released", &child],
    )
    .await?;
    if ending == "taken_back" {
        tx.execute(
            "UPDATE ot.mail SET extra = jsonb_set(extra, '{taken_from}', coalesce(extra->'taken_from', '[]'::jsonb) || to_jsonb($2::bigint)) WHERE id = $1",
            &[&row, &q],
        )
        .await?;
    }
    tx.execute(
        "UPDATE ot.mail SET extra = extra - 'bundled_handed' WHERE extra->>'bundled_with' = $2 AND recipient_agent_id = $1 AND extra ? 'bundled_handed'",
        &[&project, &uid],
    )
    .await?;
    record_ending(tx, org_id, project, &uid, &claimed, Some(q), &format!("relay {qname}"), ending, Some(why), attempts, None).await?;
    Ok(true)
}
