//! Audiences: who may write to whom beyond the chain of command. A grant
//! lets its grantee write to its grantor — an agent, the user (`@user`), or
//! the org inbox (`@extern`: mail from outside the org reaches its holders).
//! A request goes straight to whoever it names for a yes or a no; an
//! org-inbox request goes to the requester's top-level agent.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::mail::{self, From, Outgoing};
use crate::domain::ops::Actor;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::refuse;
use crate::util::iso_opt;

pub const USER: &str = "@user";
pub const EXTERN: &str = "@extern";

#[derive(Clone, Debug, serde::Serialize)]
pub struct EffectiveGrant {
    pub grantor: String,
    pub source_project: Option<String>,
}
pub type EffectiveAudiences = std::collections::HashMap<String, Vec<EffectiveGrant>>;

/// Same projection for the tree and agent state inspection.
#[nolog]
pub fn project_fields(o: &mut serde_json::Map<String, Value>, held: &[EffectiveGrant]) {
    let effective: std::collections::BTreeSet<_> = held.iter().map(|g| &g.grantor).collect();
    let explicit: std::collections::BTreeSet<_> = held.iter().filter(|g| g.source_project.is_none()).map(|g| &g.grantor).collect();
    let inherited: Vec<_> = held.iter().filter_map(|g| g.source_project.as_ref().map(|p| json!({"grantor":g.grantor,"project":p}))).collect();
    o.insert("audiences_held".into(), json!(effective));
    o.insert("audiences_explicit".into(), json!(explicit));
    o.insert("audiences_inherited".into(), json!(inherited));
}

/// Active explicit or direct-project-parent authority; never recursive.
#[logged]
pub(crate) async fn effective_holds(client: &impl tokio_postgres::GenericClient, org_id: i64, grantee: &str, grantor: &str) -> Result<bool> {
    Ok(client.query_opt("SELECT 1 FROM ot.effective_audiences WHERE org_id=$1 AND grantee=$2 AND grantor=$3 LIMIT 1",
        &[&org_id, &grantee, &grantor]).await?.is_some())
}

/// `user`, `extern`, an agent name — as the grantor column spells it.
#[logged]
pub fn party(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("") {
        "" | "user" | "@user" => USER.into(),
        "extern" | "@extern" | "org-inbox" | "org_inbox" => EXTERN.into(),
        other => other.trim_start_matches('@').to_string(),
    }
}

fn spoken(p: &str) -> String {
    match p {
        USER => "the user".into(),
        EXTERN => "the org inbox".into(),
        other => other.to_string(),
    }
}

/// A live seat and its nearest agent superior (placement stays separate).
#[logged]
async fn live(client: &impl tokio_postgres::GenericClient, org_id: i64, name: &str) -> Result<(i64, Option<i64>)> {
    let r = client
        .query_opt("SELECT id, ot.superior_of(id) FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org_id, &name])
        .await?;
    match r {
        Some(r) => Ok((r.get(0), r.get(1))),
        None => refuse!(NotFound, "no live agent or project named {name}"),
    }
}

/// Is `node` strictly below `root`?
#[logged]
async fn descends(client: &impl tokio_postgres::GenericClient, root: i64, node: i64) -> Result<bool> {
    Ok(client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2
               UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id WHERE up.depth < 1024)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = $1 AND depth > 0)",
            &[&root, &node],
        )
        .await?
        .get(0))
}

/// The top-level agent above (or at) `node`.
#[logged]
async fn top_of(client: &impl tokio_postgres::GenericClient, node: i64) -> Result<String> {
    Ok(client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, name, depth) AS (
               SELECT id, superior_id, name, 0 FROM ot.agent_reporting WHERE id = $1
               UNION ALL SELECT a.id, a.superior_id, a.name, up.depth + 1 FROM ot.agent_reporting a JOIN up ON a.id = up.parent_id WHERE up.depth < 1024)
             SELECT name FROM up WHERE parent_id IS NULL",
            &[&node],
        )
        .await?
        .get(0))
}

#[logged]
async fn holds(client: &impl tokio_postgres::GenericClient, org_id: i64, grantee: &str, grantor: &str) -> Result<bool> {
    effective_holds(client, org_id, grantee, grantor).await
}

/// A project is managed by its nearest real-agent superior, never its members.
#[logged]
async fn project_manager(client: &impl tokio_postgres::GenericClient, org_id: i64, name: &str) -> Result<Option<String>> {
    Ok(client.query_opt("SELECT coalesce(s.name, '@user') FROM ot.agents p LEFT JOIN ot.agents s ON s.id=ot.superior_of(p.id) WHERE p.org_id=$1 AND p.name=$2 AND p.kind='project' AND p.state='live'", &[&org_id, &name]).await?.map(|r| r.get(0)))
}

#[logged]
async fn notice_recipient(client: &impl tokio_postgres::GenericClient, org_id: i64, name: &str) -> Result<String> {
    Ok(project_manager(client, org_id, name).await?.unwrap_or_else(|| name.to_string()))
}

/// Both user project-send endpoints call this after a committed delivery.
#[logged]
pub async fn grant_user_audience_to_project(engine: &Arc<Engine>, org_id: i64, project_id: i64) -> Result<()> {
    let org = engine.orgs.by_id(org_id).ok_or_else(|| anyhow::anyhow!("organization not loaded"))?;
    let client = engine.db.get().await?;
    let row = client.query_opt("SELECT name FROM ot.agents WHERE org_id=$1 AND id=$2 AND kind='project' AND state='live'", &[&org_id, &project_id]).await?;
    let Some(row) = row else { refuse!(NotFound, "no live project in this organization"); };
    let name: String = row.get(0);
    drop(client);
    grant(engine, &org, &Actor::User, &name, Some(USER), "user messaged the project").await?;
    Ok(())
}

/// A note from the system to an agent (a notice unless it should act on it), with its card.
#[logged]
async fn tell(engine: &Arc<Engine>, org_id: i64, to: &str, body: String, wake: bool, ev: Option<Value>) {
    let recipient = match engine.db.get().await {
        Ok(client) => notice_recipient(&**client, org_id, to).await,
        Err(e) => Err(e.into()),
    };
    let recipient = match recipient { Ok(to) => to, Err(e) => { tracing::warn!(error=%e,"audience notice routing failed"); return; } };
    let mut out = Outgoing::new(From::System, &recipient, &body);
    out.kind = "system".into();
    out.notice = !wake;
    out.ev = ev;
    if let Err(e) = mail::send(engine, org_id, out).await {
        tracing::warn!(to, error = %format!("{e:#}"), "audience note failed");
    }
}

/// `orgtree_audience request`: ask `target` (an agent, `user`, or `extern`) for an audience.
#[logged]
pub async fn request(engine: &Arc<Engine>, org: &Arc<OrgHandle>, me: (i64, &str), requester: Option<&str>, target: &str, reason: &str) -> Result<Value> {
    let (actor_id, actor_name) = me;
    let target = party(Some(target));
    if target == EXTERN { super::orginbox::require_enabled(engine, org.id).await?; }
    let client = engine.db.get().await?;
    let requester = requester.map(|s| s.trim().trim_start_matches('@')).filter(|s| !s.is_empty()).unwrap_or(actor_name);
    if requester != actor_name && project_manager(&**client, org.id, requester).await?.as_deref() != Some(actor_name) {
        refuse!(Forbidden, "only a project's nearest agent superior can request audiences for it");
    }
    let (my_id, _) = live(&**client, org.id, requester).await?;
    let my_name = requester;
    if target == EXTERN && project_manager(&**client, org.id, my_name).await?.is_some() {
        refuse!(Forbidden, "org-inbox audiences remain on real agents, not projects");
    }
    let (_, my_parent) = live(&**client, org.id, my_name).await?;
    if target == my_name {
        refuse!(BadRequest, "you cannot ask yourself for an audience");
    }
    if holds(&**client, org.id, my_name, &target).await? {
        refuse!(Conflict, "you already hold an audience with {}", spoken(&target));
    }
    let holder = match target.as_str() {
        USER => {
            if my_parent.is_none() && project_manager(&**client, org.id, my_name).await?.is_none() {
                refuse!(Conflict, "you are a top-level agent: you can already write to the user");
            }
            USER.to_string()
        }
        EXTERN => {
            if my_parent.is_none() {
                refuse!(Conflict, "you are a top-level agent: grant the org inbox to yourself (orgtree_audience grant target=extern)");
            }
            top_of(&**client, my_id).await?
        }
        name => {
            live(&**client, org.id, name).await?;
            notice_recipient(&**client, org.id, name).await?
        }
    };
    let reason = reason.trim();
    let updated = client
        .execute(
            "UPDATE ot.audience_requests SET reason = $4, at = now(), holder = $5
              WHERE org_id = $1 AND requester = $2 AND target = $3 AND status = 'pending'",
            &[&org.id, &my_name, &target, &reason, &holder],
        )
        .await?;
    if updated == 0 {
        client
            .execute(
                "INSERT INTO ot.audience_requests (org_id, requester, target, reason, holder) VALUES ($1, $2, $3, $4, $5)",
                &[&org.id, &my_name, &target, &reason, &holder],
            )
            .await?;
    }
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_request', $2, $3, $4)",
            &[&org.id, &actor_name, &actor_id, &json!({ "requester": my_name, "target": target, "holder": holder, "reason": reason })],
        )
        .await?;
    drop(client);
    let mut ch = vec![Change::Audiences, Change::Events];
    if holder == USER {
        ch.push(Change::UserMail);
    } else {
        let what = if target == EXTERN { "the org inbox (outside mail)".to_string() } else { "you".to_string() };
        let why = if reason.is_empty() { String::new() } else { format!(": {reason}") };
        tell(
            engine,
            org.id,
            &holder,
            format!(
                "{my_name} asks for an audience with {what}{why}\nAnswer with orgtree_audience: action=grant from={my_name}{} — or action=deny from={my_name}.",
                if target == EXTERN { " target=extern".to_string() } else if target != holder { format!(" target={target}") } else { String::new() }
            ),
            true,
            Some(crate::events::audience_requested(&org.slug, my_name, &target, reason)),
        )
        .await;
    }
    changes::notify(engine, org, ch);
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("audience.requested",crate::runtime::watchdogs::events::Scope::Agent(org.id,my_id),json!({"agent_id":my_id})));
    Ok(json!({ "requested": target, "waiting_on": spoken(&holder), "status": "pending",
               "note": format!("{} decides; the answer arrives as mail.", spoken(&holder)) }))
}

/// Give `grantee` an audience with `grantor`.
#[logged]
pub async fn grant(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, grantee: &str, target: Option<&str>, reason: &str) -> Result<Value> {
    for attempt in 1..=4 {
        match grant_once(engine,org,actor,grantee,target,reason).await {
            Err(e) if attempt<4 && super::ops::retryable(&e) => tokio::time::sleep(std::time::Duration::from_millis(20*attempt)).await,
            outcome => return outcome,
        }
    }
    unreachable!()
}

#[logged]
async fn grant_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, grantee: &str, target: Option<&str>, reason: &str) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::Serializable).start().await?;
    let inherited_before = super::audience_notices::snapshot(&*tx, org.id).await?;
    let (out, gid) = grant_tx(engine, &*tx, org, actor, grantee, target, reason).await?;
    let inherited_after = super::audience_notices::snapshot(&*tx, org.id).await?;
    let inherited_recipients = super::audience_notices::record_delta_tx(&*tx, org.id, &inherited_before, &inherited_after).await?;
    let recipient = notice_recipient(&*tx, org.id, out["grantee"].as_str().unwrap_or(grantee)).await?;
    let notice_id: Option<i64> = tx.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND kind='agent' AND state='live'", &[&org.id, &recipient]).await?.map(|r| r.get(0));
    tx.commit().await?;
    drop(client);
    if out["granted"] != true && out["answered"] != true { return Ok(out); }
    let mut changes = vec![Change::Audiences, Change::OrgInbox, Change::Events, Change::Agent(gid), Change::Mailbox(gid), Change::UserMail];
    changes.extend(inherited_recipients.into_iter().map(Change::Mailbox));
    if let Some(id) = notice_id { if id != gid { changes.push(Change::Mailbox(id)); } }
    changes::notify(engine, org, changes);
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("audience.granted",crate::runtime::watchdogs::events::Scope::Agent(org.id,gid),json!({"agent_id":gid})));
    if out["answered"] == true {
        if let Some(id) = notice_id { crate::runtime::wake(engine, org.id, id); }
    }
    Ok(out)
}

#[logged]
pub(crate) async fn grant_tx(engine: &Engine, client: &impl tokio_postgres::GenericClient, org: &Arc<OrgHandle>, actor: &Actor,
                            grantee: &str, target: Option<&str>, reason: &str) -> Result<(Value, i64)> {
    let grantee = grantee.trim().trim_start_matches('@').to_string();
    if grantee.is_empty() {
        refuse!(BadRequest, "name who receives the audience (from)");
    }
    let (gid, _) = live(client, org.id, &grantee).await?;
    let grantor = match actor {
        Actor::User => party(target),
        Actor::Agent { id, name } => {
            if project_manager(client, org.id, &grantee).await?.is_some() && descends(client, gid, *id).await? {
                refuse!(Forbidden, "project members do not manage the project's grants");
            }
            let (_, my_parent) = live(client, org.id, name).await?;
            let grantor = match target.map(str::trim).filter(|t| !t.is_empty()) {
                None => name.clone(),
                Some(t) => party(Some(t)),
            };
            let asked_me = client
                .query_opt(
                    "SELECT 1 FROM ot.audience_requests WHERE org_id = $1 AND requester = $2 AND status = 'pending' AND holder = $3 AND target=$4",
                    &[&org.id, &grantee, &name, &grantor],
                )
                .await?
                .is_some();
            let below = descends(client, *id, gid).await?;
            match grantor.as_str() {
                g if g == name.as_str() => {
                    if !(below || asked_me) {
                        refuse!(Forbidden, "you grant audiences with yourself to your reports, or to an agent that asked you for one");
                    }
                }
                USER => {
                    if my_parent.is_some() {
                        refuse!(Forbidden, "only a top-level agent grants an audience with the user");
                    }
                    if !below {
                        refuse!(Forbidden, "{grantee} is not in your subtree");
                    }
                }
                EXTERN => {
                    if my_parent.is_some() && !(holds(client, org.id, name, EXTERN).await? && below) {
                        refuse!(Forbidden, "the org inbox is granted by a top-level agent (or passed down by a holder)");
                    }
                    if gid != *id && !below && !asked_me {
                        refuse!(Forbidden, "{grantee} is not in your subtree");
                    }
                }
                other => {
                    if let Some(manager) = project_manager(client, org.id, other).await? {
                        if manager != *name || !(below || asked_me) {
                            refuse!(Forbidden, "only the project's nearest agent superior grants its audiences to reports or requesters");
                        }
                        // The actual caller remains the audited actor; no project impersonation.
                    } else {
                    // with a live peer or my own superior, for my report
                    let (oid, _) = live(client, org.id, other).await?;
                    // Coworker delegation follows the physical peer relation,
                    // not the agent reporting graph (USER 2026-10-19 20:35Z).
                    let peer: bool = client.query_one("SELECT a.parent_id IS NOT DISTINCT FROM b.parent_id
                        FROM ot.agents a JOIN ot.agents b ON b.id=$2 WHERE a.id=$1", &[id,&oid]).await?.get(0);
                    let peer = peer && oid != *id;
                    let superior = my_parent == Some(oid);
                    // Sibling delegation also requires the physical parent;
                    // only the superior relation skips project wrappers.
                    let relation=client.query_one("SELECT a.parent_id,b.parent_id,ot.superior_of(a.id),ot.superior_of(b.id)
                        FROM ot.agents a JOIN ot.agents b ON b.id=$2 WHERE a.id=$1", &[&gid,&oid]).await?;
                    let delegated=super::peer_mail::delegate(*id,relation.get(0),relation.get(1),relation.get(2),relation.get(3));
                    if !(peer || superior || delegated) {
                        refuse!(Forbidden, "you grant audiences with yourself, a live peer, your direct superior, the user (top-level), the org inbox, or between direct tree siblings whose nearest agent superior is you");
                    }
                    if !below {
                        refuse!(Forbidden, "{grantee} is not in your subtree");
                    }
                    }
                }
            }
            grantor
        }
    };
    if grantor == grantee {
        refuse!(BadRequest, "an agent needs no audience with itself");
    }
    if grantor == EXTERN && project_manager(client, org.id, &grantee).await?.is_some() {
        refuse!(Forbidden, "org-inbox audiences remain on real agents, not projects");
    }
    if grantor != USER && grantor != EXTERN {
        live(client, org.id, &grantor).await?;
    }
    let by = match actor {
        Actor::User => USER.to_string(),
        Actor::Agent { name, .. } => name.clone(),
    };
    let raw: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1 FOR NO KEY UPDATE", &[&org.id]).await?.get(0);
    if grantor == EXTERN { super::orginbox::check(&raw)?; }
    let settings = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults());
    let fresh = client.query_opt("SELECT 1 FROM ot.audiences WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL AND NOT paused LIMIT 1",
        &[&org.id, &grantee, &grantor]).await?.is_none();
    if grantor == EXTERN && !settings["org_inbox_multi_holder"].as_bool().unwrap_or(false) {
        client.execute("UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantor = '@extern' AND grantee <> $2 AND revoked_at IS NULL", &[&org.id, &grantee]).await?;
    }
    if fresh {
        client
            .execute(
                "INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1, $2, $3, $4)",
                &[&org.id, &grantee, &grantor, &reason.trim()],
            )
            .await?;
    }
    let answered = client
        .execute(
            "UPDATE ot.audience_requests SET status = 'granted', resolved_at = now()
              WHERE org_id = $1 AND requester = $2 AND target = $3 AND status = 'pending'",
            &[&org.id, &grantee, &grantor],
        )
        .await?;
    if !fresh && answered == 0 {
        return Ok((json!({"ok":true,"grantee":grantee,"grantor":grantor,"granted":false,"answered":false}),gid));
    }
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_grant', $2, $3, $4)",
            &[&org.id, &by, &gid, &json!({ "grantee": grantee, "grantor": grantor })],
        )
        .await?;
    if answered > 0 {
        let body = format!("{} granted your requested audience with {}.", spoken(&by), spoken(&grantor));
        let ev = crate::events::audience_decided(&org.slug, &grantee, &grantor, true, &by);
        decision_notice_tx(client, org.id, &grantee, &body, false, Some(ev)).await?;
    }
    if fresh {
        let generation = client.query_one("SELECT generation FROM ot.agents WHERE id = $1", &[&gid]).await?.get::<_, i32>(0) as i64;
        grant_notice_tx(client, org.id, &org.slug, gid, &grantee, generation, &by, &grantor).await?;
    }
    Ok((json!({ "ok": true, "grantee": grantee, "grantor": grantor, "granted": fresh, "answered": answered > 0 }), gid))
}

#[logged]
pub(super) async fn decision_notice_tx(client: &impl tokio_postgres::GenericClient, org_id: i64, grantee: &str, body: &str, notice: bool, ev: Option<Value>) -> Result<()> {
    let to = notice_recipient(client, org_id, grantee).await?;
    let id: Option<i64> = if to == USER { None } else {
        Some(client.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live'", &[&org_id, &to]).await?.get(0))
    };
    let kind = if id.is_some() { "agent" } else { "user" };
    client.execute("INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_agent_id, recipient_name, kind, notice, body, ev, state)
        VALUES ($1,$2,'@system',$3,$4,$5,'system',$6,$7,$8,'pending')",
        &[&crate::util::uid("m"), &org_id, &kind, &id, &to, &notice, &crate::util::pg_text(body).as_ref(), &crate::util::pg_json_option(&ev).as_ref()]).await?;
    Ok(())
}

/// The canonical access notice, shared by explicit grants and user direct contact.
#[logged]
pub(super) async fn grant_notice_tx(
    client: &impl tokio_postgres::GenericClient, org_id: i64, org_slug: &str,
    gid: i64, grantee: &str, generation: i64, by: &str, grantor: &str,
) -> Result<()> {
    let outcome = match grantor {
        USER => "user_audience",
        EXTERN => "org_inbox",
        _ => "audience_with",
    };
    let ev = crate::events::audience_changed(org_slug, &grantee, generation, outcome, &by, &grantor, None);
    let body = match grantor {
        USER => "You now hold an audience with the user: you may write to the user (to=user), ask the user, and present documents.".to_string(),
        EXTERN => "You now hold the org inbox: mail from outside the organization (@org:/@net:) reaches you, and you may write outside.".to_string(),
        g => format!("{g} granted you an audience: you may now write to {g} directly."),
    };
    let body = if project_manager(client, org_id, grantee).await?.is_some() {
        format!("Project {grantee}: {body} Its direct members inherit this audience; nested projects do not relay it.")
    } else { body };
    let _ = gid;
    decision_notice_tx(client, org_id, grantee, &body, true, ev).await?;
    Ok(())
}

/// Decline a pending request (the agent or user it waits on).
#[logged]
pub async fn deny(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, requester: &str, target: Option<&str>) -> Result<Value> {
    let requester = requester.trim().trim_start_matches('@').to_string();
    let holder = match actor {
        Actor::User => USER.to_string(),
        Actor::Agent { name, .. } => name.clone(),
    };
    let client = engine.db.get().await?;
    let rows = client
        .query(
            "UPDATE ot.audience_requests q SET status = 'denied', resolved_at = now()
              WHERE org_id = $1 AND requester = $2 AND status = 'pending'
                AND CASE WHEN EXISTS (SELECT 1 FROM ot.agents p WHERE p.org_id=q.org_id AND p.name=q.target AND p.kind='project')
                  THEN EXISTS (SELECT 1 FROM ot.agents p LEFT JOIN ot.agents s ON s.id=ot.superior_of(p.id)
                    WHERE p.org_id=q.org_id AND p.name=q.target AND p.state='live' AND coalesce(s.name,'@user')=$3)
                  ELSE holder=$3 END
                AND ($4::text IS NULL OR target = $4)
              RETURNING target",
            &[&org.id, &requester, &holder, &target.map(|t| party(Some(t)))],
        )
        .await?;
    if rows.is_empty() {
        refuse!(NotFound, "no audience request from {requester} is waiting on {}", spoken(&holder));
    }
    let sought: String = rows[0].get(0);
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'audience_deny', $2, $3)",
            &[&org.id, &holder, &json!({ "requester": requester, "target": sought })],
        )
        .await?;
    drop(client);
    tell(
        engine,
        org.id,
        &requester,
        format!("{} declined your request for an audience with {}.", spoken(&holder), spoken(&sought)),
        true,
        Some(crate::events::audience_decided(&org.slug, &requester, &sought, false, &holder)),
    )
    .await;
    changes::notify(engine, org, vec![Change::Audiences, Change::Events, Change::UserMail]);
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("audience.denied",crate::runtime::watchdogs::events::Scope::NamedAgent(org.id,requester.clone()),json!({"agent":requester})));
    Ok(json!({ "ok": true, "denied": requester, "target": sought }))
}

/// Rescind a grant: its grantor, the user, a holder of the org inbox for
/// itself, and a top-level agent for user and org-inbox grants in its subtree.
#[logged]
pub async fn revoke(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, grantee: &str, grantor: Option<&str>) -> Result<Value> {
    for attempt in 1..=4 {
        match revoke_once(engine,org,actor,grantee,grantor).await {
            Err(e) if attempt<4 && super::ops::retryable(&e) => tokio::time::sleep(std::time::Duration::from_millis(20*attempt)).await,
            outcome => return outcome,
        }
    }
    unreachable!()
}

#[logged]
async fn revoke_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, grantee: &str, grantor: Option<&str>) -> Result<Value> {
    let grantee = grantee.trim().trim_start_matches('@').to_string();
    let mut connection = engine.db.get().await?;
    let tx = connection.build_transaction().isolation_level(tokio_postgres::IsolationLevel::Serializable).start().await?;
    let client = &*tx;
    let grantor = match (actor, grantor.map(str::trim).filter(|g| !g.is_empty())) {
        (Actor::Agent { name, .. }, None) => name.clone(),
        (_, g) => party(g),
    };
    if let Actor::Agent { id, name } = actor {
        if project_manager(client, org.id, &grantee).await?.is_some() {
            let (gid, _) = live(client, org.id, &grantee).await?;
            if descends(client, gid, *id).await? { refuse!(Forbidden, "project members do not manage the project's grants"); }
        }
        let allowed = if grantor == *name {
            true
        } else if grantor == EXTERN && grantee == *name {
            true
        } else if grantor == EXTERN || grantor == USER {
            let (_, my_parent) = live(client, org.id, name).await?;
            let gid: Option<i64> = client
                .query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2", &[&org.id, &grantee])
                .await?
                .map(|r| r.get(0));
            my_parent.is_none() && match gid {
                Some(g) => descends(client, *id, g).await?,
                None => false,
            }
        } else {
            project_manager(client, org.id, &grantor).await?.as_deref() == Some(name.as_str())
        };
        if !allowed {
            refuse!(Forbidden, "you can rescind only audiences you granted (and, top-level, user and org-inbox grants in your subtree)");
        }
    }
    let inherited_before = super::audience_notices::snapshot(client, org.id).await?;
    let n = client
        .execute(
            "UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL",
            &[&org.id, &grantee, &grantor],
        )
        .await?;
    if n == 0 {
        refuse!(NotFound, "{grantee} holds no explicit audience with {}; inherited project access is unchanged", spoken(&grantor));
    }
    let by = match actor {
        Actor::User => USER.to_string(),
        Actor::Agent { name, .. } => name.clone(),
    };
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'audience_revoke', $2, $3)",
            &[&org.id, &by, &json!({ "grantee": grantee, "grantor": grantor })],
        )
        .await?;
    let gid: Option<i64> = client
        .query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org.id, &grantee])
        .await?
        .map(|r| r.get(0));
    let inherited_after = super::audience_notices::snapshot(client, org.id).await?;
    let inherited_recipients = super::audience_notices::record_delta_tx(client, org.id, &inherited_before, &inherited_after).await?;
    let mut explicit_recipient = None;
    if gid.is_some() && by != grantee {
        let generation: i64 = client
                .query_opt("SELECT generation FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org.id, &grantee])
                .await?
                .map(|r| r.get::<_, i32>(0) as i64)
                .unwrap_or(1);
        let held = gid.and_then(|id| inherited_after.get(&id)).map(|h|h.grants.as_slice()).unwrap_or(&[]);
        let sources = super::audience_notices::inherited_pairs(held);
        let project = sources.iter().find(|(target,_)|target==&grantor).map(|(_,p)|p.as_str());
        // Empty source means a checked absence; None on historical events means unknown.
        let ev = crate::events::audience_changed(&org.slug, &grantee, generation, "rescinded", &by, &grantor, Some(project.unwrap_or("")));
        let body = super::audience_notices::revoke_body(&grantor, &by, held);
        decision_notice_tx(client, org.id, &grantee, &body, true, ev).await?;
        let recipient = notice_recipient(client, org.id, &grantee).await?;
        explicit_recipient = client.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live' AND kind='agent'", &[&org.id,&recipient]).await?.map(|r|r.get::<_,i64>(0));
    }
    tx.commit().await?;
    drop(connection);
    let mut ch = vec![Change::Audiences, Change::Events, Change::UserMail];
    ch.extend(inherited_recipients.into_iter().map(Change::Mailbox));
    if let Some(id) = explicit_recipient { ch.push(Change::Mailbox(id)); }
    if let Some(g) = gid {
        ch.push(Change::Agent(g));
    }
    changes::notify(engine, org, ch);
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("audience.revoked",crate::runtime::watchdogs::events::Scope::NamedAgent(org.id,grantee.clone()),json!({"agent":grantee})));
    Ok(json!({ "ok": true, "revoked": grantee, "grantor": grantor }))
}

/// The grants and the pending requests (`GET /audiences`).
#[logged]
pub async fn snapshot(engine: &Engine, org_id: i64) -> Result<Value> {
    let client = engine.db.get().await?;
    let grants = client
        .query(
            "SELECT grantee, grantor, granted_at, reason, paused FROM ot.audiences WHERE org_id = $1 AND revoked_at IS NULL ORDER BY id",
            &[&org_id],
        )
        .await?;
    let effective = crate::feed::compute::audiences_held(&**client, org_id).await?;
    let reqs = client
        .query(
            "SELECT requester, target, reason, at, holder FROM ot.audience_requests WHERE org_id = $1 AND status = 'pending' ORDER BY id",
            &[&org_id],
        )
        .await?;
    Ok(json!({
        "effective_audiences": effective,
        "audiences": grants.iter().map(|r| json!({
            "grantee": r.get::<_, String>(0), "grantor": r.get::<_, String>(1), "granted_at": iso_opt(r.get(2)),
            "reason": r.get::<_, String>(3), "paused": r.get::<_, bool>(4),
        })).collect::<Vec<_>>(),
        "requests": reqs.iter().map(|r| json!({
            "from": r.get::<_, String>(0), "node": r.get::<_, String>(0), "target": r.get::<_, String>(1),
            "reason": r.get::<_, String>(2), "at": iso_opt(r.get(3)),
            "currently_at": r.get::<_, Option<String>>(4).unwrap_or_else(|| r.get::<_, String>(1)),
        })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod project_audiences_tests {
    use super::*;

    #[test]
    fn inherited_user_access_is_effective_but_not_an_explicit_revocation_target() {
        let mut o = serde_json::Map::new();
        project_fields(&mut o, &[EffectiveGrant {grantor:USER.into(), source_project:Some("alpha".into())}]);
        assert_eq!(o["audiences_held"], json!([USER]));
        assert_eq!(o["audiences_explicit"], json!([]));
        assert_eq!(o["audiences_inherited"], json!([{"grantor":USER,"project":"alpha"}]));
    }

    #[test]
    fn overlapping_explicit_and_inherited_routes_keep_both_provenances() {
        let mut o = serde_json::Map::new();
        project_fields(&mut o, &[
            EffectiveGrant {grantor:USER.into(), source_project:None},
            EffectiveGrant {grantor:USER.into(), source_project:Some("alpha".into())},
        ]);
        assert_eq!(o["audiences_held"], json!([USER]));
        assert_eq!(o["audiences_explicit"], json!([USER]));
        assert_eq!(o["audiences_inherited"].as_array().unwrap().len(), 1);
    }
}
