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

/// A live agent of this org: (id, parent, name).
#[logged]
async fn live(client: &tokio_postgres::Client, org_id: i64, name: &str) -> Result<(i64, Option<i64>)> {
    let r = client
        .query_opt("SELECT id, parent_id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org_id, &name])
        .await?;
    match r {
        Some(r) => Ok((r.get(0), r.get(1))),
        None => refuse!(NotFound, "no live agent named {name}"),
    }
}

/// Is `node` strictly below `root`?
#[logged]
async fn descends(client: &tokio_postgres::Client, root: i64, node: i64) -> Result<bool> {
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
async fn top_of(client: &tokio_postgres::Client, node: i64) -> Result<String> {
    Ok(client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, name, depth) AS (
               SELECT id, parent_id, name, 0 FROM ot.agents WHERE id = $1
               UNION ALL SELECT a.id, a.parent_id, a.name, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id WHERE up.depth < 1024)
             SELECT name FROM up WHERE parent_id IS NULL",
            &[&node],
        )
        .await?
        .get(0))
}

#[logged]
async fn holds(client: &tokio_postgres::Client, org_id: i64, grantee: &str, grantor: &str) -> Result<bool> {
    Ok(client
        .query_opt(
            "SELECT 1 FROM ot.audiences WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL",
            &[&org_id, &grantee, &grantor],
        )
        .await?
        .is_some())
}

/// A note from the system to an agent (a notice unless it should act on it), with its card.
#[logged]
async fn tell(engine: &Arc<Engine>, org_id: i64, to: &str, body: String, wake: bool, ev: Option<Value>) {
    let mut out = Outgoing::new(From::System, to, &body);
    out.kind = "system".into();
    out.notice = !wake;
    out.ev = ev;
    if let Err(e) = mail::send(engine, org_id, out).await {
        tracing::warn!(to, error = %format!("{e:#}"), "audience note failed");
    }
}

/// `orgtree_audience request`: ask `target` (an agent, `user`, or `extern`) for an audience.
#[logged]
pub async fn request(engine: &Arc<Engine>, org: &Arc<OrgHandle>, me: (i64, &str), target: &str, reason: &str) -> Result<Value> {
    let (my_id, my_name) = me;
    let target = party(Some(target));
    let client = engine.db.get().await?;
    let (_, my_parent) = live(&client, org.id, my_name).await?;
    if target == my_name {
        refuse!(BadRequest, "you cannot ask yourself for an audience");
    }
    if holds(&client, org.id, my_name, &target).await? {
        refuse!(Conflict, "you already hold an audience with {}", spoken(&target));
    }
    let holder = match target.as_str() {
        USER => {
            if my_parent.is_none() {
                refuse!(Conflict, "you are a top-level agent: you can already write to the user");
            }
            USER.to_string()
        }
        EXTERN => {
            if my_parent.is_none() {
                refuse!(Conflict, "you are a top-level agent: grant the org inbox to yourself (orgtree_audience grant target=extern)");
            }
            top_of(&client, my_id).await?
        }
        name => {
            live(&client, org.id, name).await?;
            name.to_string()
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
            &[&org.id, &my_name, &my_id, &json!({ "target": target, "holder": holder, "reason": reason })],
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
                if target == EXTERN { " target=extern" } else { "" }
            ),
            true,
            Some(crate::events::audience_requested(&org.slug, my_name, &target, reason)),
        )
        .await;
    }
    changes::notify(engine, org, ch);
    Ok(json!({ "requested": target, "waiting_on": spoken(&holder), "status": "pending",
               "note": format!("{} decides; the answer arrives as mail.", spoken(&holder)) }))
}

/// Give `grantee` an audience with `grantor`.
#[logged]
pub async fn grant(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, grantee: &str, target: Option<&str>, reason: &str) -> Result<Value> {
    let grantee = grantee.trim().trim_start_matches('@').to_string();
    if grantee.is_empty() {
        refuse!(BadRequest, "name who receives the audience (from)");
    }
    let client = engine.db.get().await?;
    let (gid, _) = live(&client, org.id, &grantee).await?;
    let grantor = match actor {
        Actor::User => party(target),
        Actor::Agent { id, name } => {
            let (_, my_parent) = live(&client, org.id, name).await?;
            let grantor = match target.map(str::trim).filter(|t| !t.is_empty()) {
                None => name.clone(),
                Some(t) => party(Some(t)),
            };
            let asked_me = client
                .query_opt(
                    "SELECT 1 FROM ot.audience_requests WHERE org_id = $1 AND requester = $2 AND status = 'pending' AND holder = $3",
                    &[&org.id, &grantee, &name],
                )
                .await?
                .is_some();
            let below = descends(&client, *id, gid).await?;
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
                    if my_parent.is_some() && !(holds(&client, org.id, name, EXTERN).await? && below) {
                        refuse!(Forbidden, "the org inbox is granted by a top-level agent (or passed down by a holder)");
                    }
                    if gid != *id && !below && !asked_me {
                        refuse!(Forbidden, "{grantee} is not in your subtree");
                    }
                }
                other => {
                    // with a live peer or my own superior, for my report
                    let (oid, oparent) = live(&client, org.id, other).await?;
                    let peer = oparent == my_parent && oid != *id;
                    let superior = my_parent == Some(oid);
                    if !(peer || superior) {
                        refuse!(Forbidden, "you grant audiences with yourself, a live peer, your direct superior, the user (top-level) or the org inbox");
                    }
                    if !below {
                        refuse!(Forbidden, "{grantee} is not in your subtree");
                    }
                }
            }
            grantor
        }
    };
    if grantor == grantee {
        refuse!(BadRequest, "an agent needs no audience with itself");
    }
    if grantor != USER && grantor != EXTERN {
        live(&client, org.id, &grantor).await?;
    }
    let by = match actor {
        Actor::User => USER.to_string(),
        Actor::Agent { name, .. } => name.clone(),
    };
    let fresh = !holds(&client, org.id, &grantee, &grantor).await?;
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
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_grant', $2, $3, $4)",
            &[&org.id, &by, &gid, &json!({ "grantee": grantee, "grantor": grantor })],
        )
        .await?;
    drop(client);
    if answered > 0 {
        tell(engine,org.id,&grantee,format!("{} granted your requested audience with {}.",spoken(&by),spoken(&grantor)),true,
            Some(crate::events::audience_decided(&org.slug,&grantee,&grantor,true,&by))).await;
    }
    if fresh {
        let generation: i64 = {
            let client = engine.db.get().await?;
            client.query_one("SELECT generation FROM ot.agents WHERE id = $1", &[&gid]).await?.get::<_, i32>(0) as i64
        };
        let outcome = match grantor.as_str() {
            USER => "user_audience",
            EXTERN => "org_inbox",
            _ => "audience_with",
        };
        let ev = crate::events::audience_changed(&org.slug, &grantee, generation, outcome, &by, &grantor, None);
        let body = match grantor.as_str() {
            USER => "You now hold an audience with the user: you may write to the user (to=user), ask the user, and present documents.".to_string(),
            EXTERN => "You now hold the org inbox: mail from outside the organization (@org:/@net:) reaches you, and you may write outside.".to_string(),
            g => format!("{g} granted you an audience: you may now write to {g} directly."),
        };
        tell(engine, org.id, &grantee, body, false, ev).await;
    }
    changes::notify(engine, org, vec![Change::Audiences, Change::Events, Change::Agent(gid), Change::UserMail]);
    Ok(json!({ "ok": true, "grantee": grantee, "grantor": grantor, "granted": fresh }))
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
            "UPDATE ot.audience_requests SET status = 'denied', resolved_at = now()
              WHERE org_id = $1 AND requester = $2 AND holder = $3 AND status = 'pending'
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
    Ok(json!({ "ok": true, "denied": requester, "target": sought }))
}

/// Rescind a grant: its grantor, the user, a holder of the org inbox for
/// itself, and a top-level agent for user and org-inbox grants in its subtree.
#[logged]
pub async fn revoke(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, grantee: &str, grantor: Option<&str>) -> Result<Value> {
    let grantee = grantee.trim().trim_start_matches('@').to_string();
    let client = engine.db.get().await?;
    let grantor = match (actor, grantor.map(str::trim).filter(|g| !g.is_empty())) {
        (Actor::Agent { name, .. }, None) => name.clone(),
        (_, g) => party(g),
    };
    if let Actor::Agent { id, name } = actor {
        let allowed = if grantor == *name {
            true
        } else if grantor == EXTERN && grantee == *name {
            true
        } else if grantor == EXTERN || grantor == USER {
            let (_, my_parent) = live(&client, org.id, name).await?;
            let gid: Option<i64> = client
                .query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2", &[&org.id, &grantee])
                .await?
                .map(|r| r.get(0));
            my_parent.is_none() && match gid {
                Some(g) => descends(&client, *id, g).await?,
                None => false,
            }
        } else {
            false
        };
        if !allowed {
            refuse!(Forbidden, "you can rescind only audiences you granted (and, top-level, user and org-inbox grants in your subtree)");
        }
    }
    let n = client
        .execute(
            "UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL",
            &[&org.id, &grantee, &grantor],
        )
        .await?;
    if n == 0 {
        refuse!(NotFound, "{grantee} holds no audience with {}", spoken(&grantor));
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
    drop(client);
    if gid.is_some() && by != grantee {
        let generation: i64 = {
            let client = engine.db.get().await?;
            client
                .query_opt("SELECT generation FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org.id, &grantee])
                .await?
                .map(|r| r.get::<_, i32>(0) as i64)
                .unwrap_or(1)
        };
        let ev = crate::events::audience_changed(&org.slug, &grantee, generation, "rescinded", &by, &grantor, None);
        tell(engine, org.id, &grantee, format!("Your audience with {} was rescinded by {}.", spoken(&grantor), spoken(&by)), false, ev).await;
    }
    let mut ch = vec![Change::Audiences, Change::Events];
    if let Some(g) = gid {
        ch.push(Change::Agent(g));
    }
    changes::notify(engine, org, ch);
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
    let reqs = client
        .query(
            "SELECT requester, target, reason, at, holder FROM ot.audience_requests WHERE org_id = $1 AND status = 'pending' ORDER BY id",
            &[&org_id],
        )
        .await?;
    Ok(json!({
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
