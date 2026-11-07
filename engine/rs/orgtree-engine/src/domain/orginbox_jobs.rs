//! Project holders of the org mailbox, and hub threading (USER 2026-11-03 m99ee62b87e70, mdf5da6c51202,
//! m896fa990fc53, m63e16cf45188; spec org-inbox-queue-spec.md rev 2, D5-D8, D13, D14).
//!
//! Routing order for one received row (called from `publish_new` and `release_page`; Do not disturb acts first):
//! 1. a hub reply to an agent's own message goes to that agent alone (D13);
//! 2. a follow-up to the sender's own earlier message goes to its recipients (D14);
//! 3. otherwise every holder: agents as copies, projects as one queued job each (D6, D8).
//!
//! ⚠ AUTHORITY: every job and copy keeps `sender` = the exact envelope peer. Only this module writes
//! `mail.extra.org_inbox` and `mail.extra.outside_job`; a worker's reply right comes from them (D10), never
//! from a caller's arguments.

use super::*;
use tokio_postgres::Transaction;

use crate::domain::replies;

/// One job inserted into a project's mailbox.
pub(super) struct Job {
    pub project: i64,
    pub name: String,
    pub mail: String,
}

/// What a routed row produced, for the post-commit wakes.
pub(super) struct Published {
    pub route: Route,
    pub copies: Vec<(i64, String, String, bool)>,
    pub jobs: Vec<Job>,
    pub changed: bool,
}

/// Route and publish one received `org_inbox` row (D5 steps 2-4).
#[logged]
pub(super) async fn publish(engine: &Engine, tx: &Transaction<'_>, org: i64, raw: &Value, row: &Value) -> Result<Published> {
    if let Some(p) = threaded(tx, org, row).await? {
        return Ok(p);
    }
    let (route, changed) = route_tx(tx, org, None, raw, &engine.settings.defaults()).await?;
    let copies = publish_row(tx, org, &route.to, row).await?;
    let jobs = publish_jobs(tx, org, &route.projects, row).await?;
    record_projects(tx, row, &copies, &jobs).await?;
    Ok(Published { route, copies, jobs, changed })
}

/// `delivered_to` also names the projects that got a job, after the agents (delivery order).
#[logged]
async fn record_projects(tx: &Transaction<'_>, row: &Value, copies: &[(i64, String, String, bool)], jobs: &[Job]) -> Result<()> {
    if jobs.is_empty() {
        return Ok(());
    }
    let agents: Vec<&str> = copies.iter().map(|c| c.1.as_str()).collect();
    let mut after = row.clone();
    after["delivered_to"] = delivered_with(row, &agents);
    let names: Vec<&str> = jobs.iter().map(|j| j.name.as_str()).collect();
    record_delivered(tx, &after, &names).await
}

/// One pending job per project holder, locking the project rows in id order (D8).
#[logged]
async fn publish_jobs(tx: &Transaction<'_>, org: i64, projects: &[String], row: &Value) -> Result<Vec<Job>> {
    if projects.is_empty() {
        return Ok(Vec::new());
    }
    let rows = tx
        .query(
            "SELECT id, name FROM ot.agents WHERE org_id=$1 AND name=ANY($2) AND kind='project' AND state='live' ORDER BY id FOR NO KEY UPDATE",
            &[&org, &projects],
        )
        .await?;
    let mut jobs = Vec::new();
    for r in rows {
        let (id, name): (i64, String) = (r.get(0), r.get(1));
        let mail = insert_job(tx, org, id, &name, row, "pending", json!({})).await?;
        jobs.push(Job { project: id, name, mail });
    }
    Ok(jobs)
}

/// The job row (D8): the exact outside peer as sender, no agent identity, `extra.org_inbox` marking it.
#[logged]
async fn insert_job(tx: &Transaction<'_>, org: i64, project: i64, name: &str, row: &Value, state: &str, more: Value) -> Result<String> {
    let quotes = replies::snapshots(row.get("reply_to"), row.get("replies"));
    let reply = quotes.first().cloned();
    let peer = row["peer"].as_str().unwrap_or("");
    let body = row["body"].as_str().unwrap_or("");
    let kind = row["kind"].as_str().unwrap_or("message");
    let ev = crate::events::ordinary(peer, kind, false, body);
    let mut extra = json!({ "org_inbox": { "uid": row["uid"], "peer": peer } });
    if let (Some(x), Some(m)) = (extra.as_object_mut(), more.as_object()) {
        for (k, v) in m {
            x.insert(k.clone(), v.clone());
        }
    }
    let mail_uid = uid("m");
    tx.execute(
        "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,body,attachments,reply_to,ev,state,net_id,net_hub,replies,extra)
         VALUES($1,$2,$3,'agent',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        &[&mail_uid, &org, &peer, &project, &name, &kind, &crate::util::pg_text(body).as_ref(),
          &crate::util::pg_json(&row["attachments"]).as_ref(), &crate::util::pg_json_option(&reply).as_ref(),
          &crate::util::pg_json(&ev).as_ref(), &state, &row["net_id"].as_str(), &row["hub"].as_str(),
          &json!(quotes), &extra],
    )
    .await?;
    Ok(mail_uid)
}

/// Stamp `extra.outside_job` on these copies (D10: the worker's reply right travels with the thread).
#[logged]
async fn stamp_outside_job(tx: &Transaction<'_>, copies: &[(i64, String, String, bool)], job: &str) -> Result<()> {
    let uids: Vec<&str> = copies.iter().map(|c| c.2.as_str()).collect();
    tx.execute("UPDATE ot.mail SET extra = extra || jsonb_build_object('outside_job', $2::text) WHERE uid = ANY($1)", &[&uids, &job]).await?;
    Ok(())
}

/// A node by id that can still receive: live. Halted or frozen ones count (they get it waiting).
#[logged]
async fn live_node(tx: &Transaction<'_>, org: i64, id: i64) -> Result<Option<(String, String)>> {
    Ok(tx
        .query_opt("SELECT name, kind FROM ot.agents WHERE org_id=$1 AND id=$2 AND state='live'", &[&org, &id])
        .await?
        .map(|r| (r.get(0), r.get(1))))
}

#[logged]
async fn live_by_name(tx: &Transaction<'_>, org: i64, name: &str) -> Result<Option<(i64, String)>> {
    Ok(tx
        .query_opt("SELECT id, kind FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live'", &[&org, &name])
        .await?
        .map(|r| (r.get(0), r.get(1))))
}

/// The org-mailbox rows a received row quotes (in order): `box = org` references.
#[nolog]
fn org_refs(row: &Value) -> Vec<String> {
    replies::snapshots(row.get("reply_to"), row.get("replies"))
        .iter()
        .filter(|q| q["box"] == "org")
        .filter_map(|q| q["id"].as_str().map(str::to_string))
        .collect()
}

/// D13 then D14 for an inbound `@net:` row; `None` routes it to every holder (D6).
#[logged]
async fn threaded(tx: &Transaction<'_>, org: i64, row: &Value) -> Result<Option<Published>> {
    let peer = row["peer"].as_str().unwrap_or("");
    if !peer.starts_with("@net:") && !peer.starts_with("@org:") {
        return Ok(None);
    }
    let refs = org_refs(row);
    // D13: the first reference that is one of this org's own sent messages, written by an agent
    for id in &refs {
        let Some(sent) = tx
            .query_opt(
                "SELECT sender_agent_id, via_job FROM ot.org_inbox WHERE org_id=$1 AND uid=$2 AND dir='out' AND peer=$3 AND sender_agent_id IS NOT NULL",
                &[&org, id, &peer],
            )
            .await?
        else {
            continue;
        };
        let (sender, via): (i64, Option<String>) = (sent.get(0), sent.get(1));
        let Some((name, _)) = live_node(tx, org, sender).await? else { continue };
        let copies = publish_row(tx, org, std::slice::from_ref(&name), row).await?;
        if let Some(job) = &via {
            stamp_outside_job(tx, &copies, job).await?;
        }
        return Ok(Some(Published { route: Route { to: vec![name], waiting: false, projects: Vec::new() }, copies, jobs: Vec::new(), changed: false }));
    }
    // D14: the first reference that is the sender's own earlier message
    for id in &refs {
        let Some(orig) = tx
            .query_opt(
                "SELECT uid, net_id, delivered_to, pulled_by FROM ot.org_inbox WHERE org_id=$1 AND uid=$2 AND dir='in' AND peer=$3",
                &[&org, id, &peer],
            )
            .await?
        else {
            continue;
        };
        let (o_uid, o_net): (String, Option<String>) = (orig.get(0), orig.get(1));
        let delivered: Value = orig.get(2);
        let mut names: Vec<String> = delivered.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
        if names.is_empty() {
            if let Some(p) = orig.get::<_, Option<i64>>(3) {
                if let Some((name, _)) = live_node(tx, org, p).await? {
                    names.push(name);
                }
            }
        }
        let mut copies = Vec::new();
        let mut jobs = Vec::new();
        let mut reached: Vec<String> = Vec::new();
        let mut agent_names: Vec<String> = Vec::new();
        let mut project_names: Vec<String> = Vec::new();
        for name in names {
            let Some((nid, kind)) = live_by_name(tx, org, &name).await? else { continue };
            if kind == "agent" {
                let carry: Option<String> = match &o_net {
                    Some(n) => tx
                        .query_opt(
                            "SELECT extra->>'outside_job' FROM ot.mail WHERE org_id=$1 AND recipient_agent_id=$2 AND net_id=$3 AND sender=$4 AND sender_agent_id IS NULL AND net_id IS NOT NULL ORDER BY id DESC LIMIT 1",
                            &[&org, &nid, n, &peer],
                        )
                        .await?
                        .and_then(|r| r.get(0)),
                    None => None,
                };
                let c = publish_row(tx, org, std::slice::from_ref(&name), row).await?;
                if let Some(job) = &carry {
                    stamp_outside_job(tx, &c, job).await?;
                }
                copies.extend(c);
                agent_names.push(name.clone());
            } else {
                follow_up(tx, org, nid, &name, row, &o_uid, &mut copies, &mut jobs).await?;
                project_names.push(name.clone());
            }
            reached.push(name);
        }
        if !project_names.is_empty() {
            // The follow-up is recorded like the original job: the agents, then the projects. The worker a direct
            // follow-up was handed to is a detail of the job, not a recipient (a reply routes by the job's state).
            let all: Vec<&str> = agent_names.iter().chain(project_names.iter()).map(String::as_str).collect();
            let blank = json!({ "uid": row["uid"], "delivered_to": row["delivered_to"] });
            record_delivered(tx, &blank, &all).await?;
        }
        if reached.is_empty() {
            return Ok(None);
        }
        return Ok(Some(Published { route: Route { to: reached, waiting: false, projects: Vec::new() }, copies, jobs, changed: false }));
    }
    Ok(None)
}

/// D14 for one project recipient: bundle with a job not yet handed out; send straight to the holder of
/// an unacked job (ACK mode); otherwise a new job threaded to the original.
#[logged]
#[allow(clippy::too_many_arguments)]
async fn follow_up(tx: &Transaction<'_>, org: i64, project: i64, name: &str, row: &Value, o_uid: &str,
    copies: &mut Vec<(i64, String, String, bool)>, jobs: &mut Vec<Job>) -> Result<()> {
    tx.execute("SELECT 1 FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE", &[&project]).await?;
    let mut job = tx
        .query_opt(
            "SELECT uid, state, extra FROM ot.mail WHERE recipient_agent_id=$1 AND extra ? 'org_inbox'
                AND extra->'org_inbox'->>'uid'=$2 ORDER BY id LIMIT 1 FOR UPDATE",
            &[&project, &o_uid],
        )
        .await?;
    // a reply quoting a follow-up that travelled with a job follows that JOB's state
    if let Some(parent) = job.as_ref().and_then(|j| j.get::<_, Value>(2)["bundled_with"].as_str().map(str::to_string)) {
        job = tx
            .query_opt("SELECT uid, state, extra FROM ot.mail WHERE recipient_agent_id=$1 AND uid=$2 FOR UPDATE", &[&project, &parent])
            .await?;
    }
    // R9: a job that was relayed follows its child into the relaying project, while the relay's custody lasts
    if let Some(j) = &job {
        if let Some((q, qname)) = relayed_to(tx, &j.get::<_, Value>(2)).await? {
            return Box::pin(follow_up(tx, org, q, &qname, row, o_uid, copies, jobs)).await;
        }
    }
    if let Some(j) = &job {
        let (j_uid, state, extra): (String, String, Value) = (j.get(0), j.get(1), j.get(2));
        if state == "pending" {
            insert_job(tx, org, project, name, row, "read", json!({ "bundled_with": j_uid })).await?;
            return Ok(());
        }
        let claim = &extra["claimed"];
        let holder = claim["by_id"].as_i64();
        if state == "read" && claim["ack"] == true && claim["acked_at"].is_null() && claim["by_user"] != true {
            if let Some((holder_name, _)) = match holder {
                Some(h) => live_node(tx, org, h).await?,
                None => None,
            } {
                let c = publish_row(tx, org, std::slice::from_ref(&holder_name), row).await?;
                let own = insert_job(tx, org, project, name, row, "read", json!({ "bundled_with": j_uid })).await?;
                let via = json!({ "id": project, "name": name, "mail": own, "dog": claim["dog"], "ack": false, "outside": true, "followup": true, "job": j_uid });
                let uids: Vec<&str> = c.iter().map(|x| x.2.as_str()).collect();
                tx.execute(
                    "UPDATE ot.mail SET extra = extra || jsonb_build_object('outside_job', $2::text, 'via_project', $3::jsonb) WHERE uid = ANY($1)",
                    &[&uids, &j_uid, &via],
                )
                .await?;
                copies.extend(c);
                return Ok(());
            }
        }
    }
    let mail = insert_job(tx, org, project, name, row, "pending", json!({})).await?;
    jobs.push(Job { project, name: name.to_string(), mail });
    Ok(())
}

/// R9: the live relaying project a job (its `extra`) was relayed into while its relay claim is still open, and the child
/// job there still stands (not revoked). `None`: the job's own project decides.
#[logged]
async fn relayed_to(tx: &Transaction<'_>, extra: &Value) -> Result<Option<(i64, String)>> {
    let (claim, to) = (&extra["claimed"], &extra["relayed_to"]);
    if claim["by_project"].is_null() || !claim["acked_at"].is_null() || !extra["revoked"].is_null() { return Ok(None); }
    let (Some(q), Some(child)) = (to["project"].as_i64(), to["job"].as_str()) else { return Ok(None) };
    Ok(tx
        .query_opt(
            "SELECT p.name FROM ot.mail c JOIN ot.agents p ON p.id = c.recipient_agent_id AND p.kind = 'project' AND p.state = 'live'
              WHERE c.uid = $1 AND c.recipient_agent_id = $2 AND coalesce(c.extra->>'revoked', '') <> 'true'",
            &[&child, &q],
        )
        .await?
        .map(|r| (q, r.get(0))))
}

/// After commit: tell the projects' desks, then hand the jobs out (D8). Unwatched projects get the same
/// nudge a user post gets.
#[logged]
pub(super) fn wake_jobs(engine: &Arc<Engine>, org_id: i64, jobs: Vec<Job>) {
    if jobs.is_empty() {
        return;
    }
    let mut ch = vec![Change::OrgInbox];
    let mut projects: Vec<(i64, String)> = Vec::new();
    for j in &jobs {
        ch.push(Change::Mailbox(j.project));
        ch.push(Change::Spark { from: "org_inbox".into(), to: j.name.clone() });
        ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event(
            "mail.waiting",
            crate::runtime::watchdogs::events::Scope::Agent(org_id, j.project),
            json!({ "agent_id": j.project, "mail_id": j.mail }),
        )));
        if !projects.iter().any(|p| p.0 == j.project) {
            projects.push((j.project, j.name.clone()));
        }
    }
    changes::notify_id(engine, org_id, ch);
    for (id, name) in projects {
        let engine = engine.clone();
        tokio::spawn(async move {
            match crate::domain::projects::dispatch(&engine, org_id, id).await {
                Ok(handed) => {
                    if handed.is_empty() {
                        crate::domain::mail::nudge_unwatched(&engine, org_id, id, &name).await;
                    }
                }
                Err(error) => tracing::warn!(org_id, project = id, %error, "outside job dispatch deferred"),
            }
        });
    }
}

/// The outcome of D10's check for one outside send by an agent.
pub(super) enum Reply {
    /// the message answers outside mail the sender holds from a project queue; carries the job's uid
    Allowed(String),
    /// the message names no outside-job copy: the ordinary rules decide
    NotApplicable,
    /// it names one, but the right is gone or the target is not that job's sender
    Refused,
}

#[nolog]
fn bare(peer: &str) -> &str {
    peer.trim().trim_start_matches('@')
}

/// D10: an agent that is neither a holder nor top-level may still reply to the exact outside sender of a job
/// its project queue handed it: before the ACK in ACK mode, without limit otherwise, and only while it is still
/// a member of the job's project (D10a). The right comes from the copy's `extra.outside_job` and the job's claim,
/// never from the caller's arguments.
#[logged]
pub(super) async fn reply_right(engine: &Engine, org: i64, agent: i64, out: &Outgoing) -> Result<Reply> {
    let client = engine.db.get().await?;
    reply_right_tx(&**client, org, agent, out).await
}

/// The same check on the caller's own transaction: the job row is read `FOR SHARE`, so a concurrent ack,
/// reclaim or move cannot slip between this check and the send that relies on it (spec §5).
#[logged]
pub(super) async fn reply_right_tx(client: &impl tokio_postgres::GenericClient, org: i64, agent: i64, out: &Outgoing) -> Result<Reply> {
    if out.replies.len() > 1 {
        return Ok(Reply::NotApplicable);
    }
    let Some(id) = out.reply_to.as_ref().and_then(|q| q["id"].as_str()).or_else(|| out.replies.first().and_then(|q| q["id"].as_str())) else {
        return Ok(Reply::NotApplicable);
    };
    let Some(copy) = client
        .query_opt("SELECT sender, extra->>'outside_job' FROM ot.mail WHERE org_id=$1 AND uid=$2 AND recipient_agent_id=$3", &[&org, &id, &agent])
        .await?
    else {
        return Ok(Reply::NotApplicable);
    };
    let (sender, job): (String, Option<String>) = (copy.get(0), copy.get(1));
    let Some(job) = job else { return Ok(Reply::NotApplicable) };
    if bare(&sender) != bare(&out.to) {
        return Ok(Reply::Refused);
    }
    let Some(j) = client
        .query_opt(
            "SELECT j.state, j.extra->'claimed',
                    EXISTS (WITH RECURSIVE up(id, parent_id) AS (
                              SELECT a.id, a.parent_id FROM ot.agents a WHERE a.id = $3
                              UNION
                              SELECT a.id, a.parent_id FROM ot.agents a JOIN up ON a.id = up.parent_id)
                            SELECT 1 FROM up WHERE up.id = j.recipient_agent_id) AS member, j.extra->>'revoked'
               FROM ot.mail j JOIN ot.agents p ON p.id = j.recipient_agent_id AND p.kind = 'project' AND p.state = 'live'
              WHERE j.org_id=$1 AND j.uid=$2 AND j.extra ? 'org_inbox' FOR SHARE OF j",
            &[&org, &job, &agent],
        )
        .await?
    else {
        return Ok(Reply::Refused);
    };
    let (state, claim, member, revoked): (String, Option<Value>, bool, Option<String>) = (j.get(0), j.get(1), j.get(2), j.get(3));
    let claim = claim.unwrap_or(Value::Null);
    let held = state == "read" && claim["by_id"].as_i64() == Some(agent);
    let open = claim["ack"] != true || claim["acked_at"].is_null();
    // R5: a job the user took back from its relay keeps its worker, but not the reply right
    Ok(if held && open && member && revoked.as_deref() != Some("true") { Reply::Allowed(job) } else { Reply::Refused })
}

/// Inside the send's own transaction: the right the early check found must still hold, and is now locked.
#[logged]
pub(super) async fn recheck(client: &impl tokio_postgres::GenericClient, org: i64, agent: i64, out: &Outgoing, job: &str, to: &str) -> Result<()> {
    match reply_right_tx(client, org, agent, out).await? {
        Reply::Allowed(j) if j == job => Ok(()),
        _ => Err(reply_refusal(to)),
    }
}

/// The refusal for a failed D10 check.
#[nolog]
pub(super) fn reply_refusal(peer: &str) -> anyhow::Error {
    anyhow::Error::new(crate::domain::UserError::Forbidden(format!(
        "you may reply to {peer} only about outside mail a project queue handed you: name it with reply_to, and in ACK mode reply before you ack it (this one is acked / no longer yours / you are no longer in its project)")))
}

/// The result of a G3 follow-up that did not become a new job.
pub(crate) struct FollowedUp {
    /// the holder it was sent to (None: bundled with a pending job)
    pub holder: Option<i64>,
    pub note: String,
}

/// Is `job` still `holder`'s to answer for: in a live project the holder is a member of, claimed by it, un-ACKed
/// in ACK mode, and not revoked (R5)?
#[logged]
async fn job_open(client: &impl tokio_postgres::GenericClient, org: i64, holder: i64, job: &str) -> Result<bool> {
    let Some(j) = client
        .query_opt(
            "SELECT j.state, j.extra->'claimed', j.extra->>'revoked',
                    EXISTS (WITH RECURSIVE up(id, parent_id) AS (
                              SELECT a.id, a.parent_id FROM ot.agents a WHERE a.id = $3
                              UNION
                              SELECT a.id, a.parent_id FROM ot.agents a JOIN up ON a.id = up.parent_id)
                            SELECT 1 FROM up WHERE up.id = j.recipient_agent_id) AS member
               FROM ot.mail j JOIN ot.agents p ON p.id = j.recipient_agent_id AND p.kind = 'project' AND p.state = 'live'
              WHERE j.org_id=$1 AND j.uid=$2 FOR SHARE OF j",
            &[&org, &job, &holder],
        )
        .await?
    else {
        return Ok(false);
    };
    let (state, claim, revoked, member): (String, Option<Value>, Option<String>, bool) = (j.get(0), j.get(1), j.get(2), j.get(3));
    let claim = claim.unwrap_or(Value::Null);
    let held = state == "read" && claim["by_id"].as_i64() == Some(holder);
    let open = claim["ack"] != true || claim["acked_at"].is_null();
    Ok(held && open && member && revoked.as_deref() != Some("true"))
}

/// G1/G2 (relay spec 2b): the one reply route a project job gives. Returns the stamp for the reply (`{job, project}`)
/// when `out` is
/// * G1: the holder W of a job answering the job's exact sender S, naming W's copy (S may be the user; `target` is None
///   for "user"), or
/// * G2: S answering W's earlier job reply M (it carries `extra.job_reply`), naming M, to M's sender W.
/// A retired S or W is refused as an unknown name. It never grants anything and never runs before the normal rules.
#[logged]
pub(crate) async fn job_route(client: &impl tokio_postgres::GenericClient, org: i64, agent: i64, out: &Outgoing, target: Option<i64>) -> Result<Option<Value>> {
    if out.replies.len() > 1 {
        return Ok(None);
    }
    let Some(id) = out.reply_to.as_ref().and_then(|q| q["id"].as_str()).or_else(|| out.replies.first().and_then(|q| q["id"].as_str())) else {
        return Ok(None);
    };
    let Some(m) = client
        .query_opt("SELECT sender, sender_agent_id, extra FROM ot.mail WHERE org_id=$1 AND uid=$2 AND recipient_agent_id=$3", &[&org, &id, &agent])
        .await?
    else {
        return Ok(None);
    };
    let (sender, sender_agent, extra): (String, Option<i64>, Value) = (m.get(0), m.get(1), m.get(2));
    let to = bare(&out.to);
    let live = |who: i64| async move {
        let r = client.query_opt("SELECT state FROM ot.agents WHERE id=$1 AND org_id=$2", &[&who, &org]).await?;
        Ok::<bool, anyhow::Error>(r.is_some_and(|r| r.get::<_, String>(0) == "live"))
    };
    // G1: W's copy of a project job -> the job's sender
    let via = &extra["via_project"];
    if let Some(job) = via["job"].as_str().or_else(|| via["mail"].as_str()) {
        let Some(j) = client.query_opt("SELECT sender, sender_agent_id FROM ot.mail WHERE org_id=$1 AND uid=$2", &[&org, &job]).await? else {
            return Ok(None);
        };
        let (jsender, jagent): (String, Option<i64>) = (j.get(0), j.get(1));
        let aimed = match (bare(&jsender), jagent) {
            ("user", None) => target.is_none() && to == "user",
            (_, Some(sid)) if target.is_some() => {
                if target == Some(sid) && !live(sid).await? {
                    crate::refuse!(NotFound, "no live agent named {to}; nothing was sent");
                }
                target == Some(sid)
            }
            _ => false,
        };
        if aimed && job_open(client, org, agent, job).await? {
            return Ok(Some(json!({ "job": job, "project": via["name"] })));
        }
    }
    // G2: S answers W's job reply
    if let (Some(jr), Some(w), Some(t)) = (extra.get("job_reply"), sender_agent, target) {
        if t == w && bare(&sender) == to {
            if let Some(job) = jr["job"].as_str() {
                if !live(w).await? {
                    crate::refuse!(NotFound, "no live agent named {to}; nothing was sent");
                }
                if job_open(client, org, w, job).await? {
                    return Ok(Some(jr.clone()));
                }
            }
        }
    }
    Ok(None)
}

/// G3 (relay spec 2b): `sender` mails project `project` naming its OWN earlier mail there. While that job waits the
/// follow-up is bundled with it; while a holder has it un-ACKed (ACK mode) it goes straight to the holder, stamped so G1
/// holds; otherwise None (a new job, as before). Runs in the send's transaction; the caller commits.
#[logged]
pub(crate) async fn follow_up_plain(tx: &Transaction<'_>, org: i64, project: &crate::domain::projects::Project, out: &Outgoing, mail_uid: &str,
                                    sender: i64, generation: Option<i32>, job: &str) -> Result<Option<FollowedUp>> {
    // decided under the project row lock, as the queue's hand-out does, so a hand-out or an ACK cannot interleave
    tx.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND kind='project' FOR NO KEY UPDATE", &[&project.id]).await?;
    let Some(j) = tx
        .query_opt(
            "SELECT state, extra->'claimed', extra->>'revoked', extra ? 'org_inbox' FROM ot.mail
              WHERE org_id=$1 AND uid=$2 AND sender_agent_id=$3 AND recipient_agent_id=$4 AND NOT (extra ? 'bundled_with') FOR UPDATE",
            &[&org, &job, &sender, &project.id],
        )
        .await?
    else {
        return Ok(None);
    };
    let (state, claim, revoked, outside): (String, Option<Value>, Option<String>, bool) = (j.get(0), j.get(1), j.get(2), j.get(3));
    if outside || revoked.as_deref() == Some("true") {
        return Ok(None);
    }
    let claim = claim.unwrap_or(Value::Null);
    // R9/GR6: a relayed job's follow-up follows the child into the relaying project, the sender's own mail there
    if let Some(rt) = tx.query_opt("SELECT extra FROM ot.mail WHERE org_id=$1 AND uid=$2", &[&org, &job]).await? {
        let extra: Value = rt.get(0);
        if let Some((q, qname)) = relayed_to(tx, &extra).await? {
            let child = extra["relayed_to"]["job"].as_str().unwrap_or_default().to_string();
            let qp = crate::domain::projects::Project { id: q, name: qname, state: "live".into() };
            return Box::pin(follow_up_plain(tx, org, &qp, out, mail_uid, sender, generation, &child)).await;
        }
    }
    let name = out.from.name();
    if state == "pending" {
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id, recipient_name, kind,
                                  notice, body, attachments, reply_to, ev, state, read_at, replies, extra)
             VALUES ($1,$2,$3,$4,$5,'agent',$6,$7,$8,$9,$10,$11,$12,$13,'read',now(),$14,jsonb_build_object('bundled_with',$15::text))",
            &[&mail_uid, &org, &name, &sender, &generation, &project.id, &project.name, &out.kind, &out.notice, &out.body,
              &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &Value::Array(out.replies.clone()), &job],
        )
        .await?;
        return Ok(Some(FollowedUp { holder: None, note: format!("Bundled with your pending job in project {}; its holder gets both together.", project.name) }));
    }
    let holder = claim["by_id"].as_i64();
    if let (true, Some(h), true) = (state == "read", holder, claim["ack"] == true && claim["acked_at"].is_null()) {
        let hname: String = tx.query_one("SELECT name FROM ot.agents WHERE id=$1", &[&h]).await?.get(0);
        let via = json!({ "via_project": { "id": project.id, "name": project.name, "mail": job, "job": job, "ack": false, "followup": true } });
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id, recipient_name, kind,
                                  notice, body, attachments, reply_to, ev, state, replies, extra)
             VALUES ($1,$2,$3,$4,$5,'agent',$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15)",
            &[&mail_uid, &org, &name, &sender, &generation, &h, &hname, &out.kind, &out.notice, &out.body,
              &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &Value::Array(out.replies.clone()), &via],
        )
        .await?;
        return Ok(Some(FollowedUp { holder: Some(h), note: format!("Delivered to {hname}, who holds your job in project {}.", project.name) }));
    }
    Ok(None)
}
