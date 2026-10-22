//! Private OpenCode hook transport and durable delivery custody. No mail body,
//! native history content, provider credential or raw database error is logged.
use anyhow::{anyhow, ensure, Result};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_postgres::{Client, Row};
use tokio_util::sync::CancellationToken;

pub const WARNING: &str = "may already have been delivered mid-turn";

#[derive(Debug, PartialEq, Eq)]
pub enum Evidence {
    Admitted,
    Absent,
    Unknown,
}

#[derive(Debug)]
pub enum Request {
    Claim { session: String },
    Ack { session: String, id: String },
}

// Contains private mail; deliberately neither Debug nor Serialize.
pub struct Batch {
    pub agent: i64,
    pub org: i64,
    pub generation: i32,
    pub turn: i64,
    pub id: String,
    pub session: String,
    pub text: String,
}

#[nolog]
pub fn supported(version: Option<&str>) -> bool {
    version == Some("2.0.28")
}

#[nolog]
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[nolog]
pub fn request(v: &Value) -> Option<Request> {
    if v["protocol"] != 1 {
        return None;
    }
    let session = v["sessionID"]
        .as_str()
        .filter(|s| identifier(s))?
        .to_owned();
    match v["op"].as_str()? {
        "claim" => Some(Request::Claim { session }),
        "ack" => {
            let id = v["id"]
                .as_str()
                .filter(|s| s.starts_with("msg_") && identifier(s))?
                .to_owned();
            Some(Request::Ack { session, id })
        }
        _ => None,
    }
}

#[nolog]
fn private_error(_: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("OpenCode mail custody unavailable")
}

#[nolog]
fn batch(row: Row) -> Batch {
    Batch {
        agent: row.get(0),
        org: row.get(1),
        generation: row.get(2),
        turn: row.get(3),
        id: row.get(4),
        session: row.get(5),
        text: row.get(6),
    }
}

#[nolog]
pub async fn load(client: &Client, agent: i64) -> Result<Option<Batch>> {
    Ok(client
        .query_opt(
            "SELECT agent_id,org_id,generation,turn_id,message_id,session_id,text
        FROM ot.opencode_mail_batches WHERE agent_id=$1",
            &[&agent],
        )
        .await
        .map_err(private_error)?
        .map(batch))
}

/// Preview at most 32 ordered eligible rows for formatting. Custody is acquired
/// atomically with the durable batch below; a failed formatter claims nothing.
#[nolog]
pub async fn claim(client: &Client, agent: i64, turn: i64) -> Result<Vec<Value>> {
    let rows = client.query("SELECT to_jsonb(ot.mail.*) FROM ot.mail
        WHERE recipient_agent_id=$1 AND state='pending' AND $2::bigint>0
        AND (urgent OR NOT ot.agent_dnd($1))
        AND extra->>'opencode_ambiguous' IS DISTINCT FROM 'true'
        AND NOT EXISTS(SELECT 1 FROM ot.opencode_mail_batches WHERE agent_id=$1)
        AND ((sender NOT LIKE '@org:%' AND sender NOT LIKE '@net:%'
          AND COALESCE(ev->>'variant','') <> 'runtime.external_unroutable' AND extra->>'transfer_failure' IS NULL)
          OR NOT EXISTS(SELECT 1 FROM ot.orgs o WHERE o.id=ot.mail.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
        ORDER BY id LIMIT 32",
        &[&agent,&turn]).await.map_err(private_error)?;
    let mut raw: Vec<Value> = rows.into_iter().map(|r| r.get(0)).collect();
    raw.sort_by_key(|r| r["id"].as_i64());
    Ok(raw)
}

/// Formatting precedes atomic selection + insert + custody. Eligibility is
/// rechecked under row locks: manual reads or DND changes during formatting
/// cannot leave unoffered mail in the generic turn's delivered set.
#[nolog]
pub async fn persist(
    client: &Client,
    agent: i64,
    turn: i64,
    session: &str,
    text: &str,
    raw: &[Value],
    transcript: &Value,
) -> Result<Batch> {
    ensure!(
        identifier(session) && !text.is_empty() && text.len() <= 128_000,
        "invalid OpenCode mail batch"
    );
    let ids: Vec<i64> = raw.iter().filter_map(|r| r["id"].as_i64()).collect();
    ensure!(
        !ids.is_empty() && ids.len() <= 32 && ids.len() == raw.len(),
        "invalid OpenCode mail selection"
    );
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    ensure!(
        serde_json::to_vec(
            &json!({"protocol":1,"batch":{"id":id,"sessionID":session,"text":text}})
        )?
        .len()
            < 262_144,
        "OpenCode mail frame exceeds limit"
    );
    let row = client.query_opt("WITH eligible AS MATERIALIZED (
        SELECT id FROM ot.mail WHERE recipient_agent_id=$1 AND state='pending' AND id=ANY($6)
          AND (urgent OR NOT ot.agent_dnd($1))
          AND extra->>'opencode_ambiguous' IS DISTINCT FROM 'true'
          AND ((sender NOT LIKE '@org:%' AND sender NOT LIKE '@net:%'
            AND COALESCE(ev->>'variant','') <> 'runtime.external_unroutable' AND extra->>'transfer_failure' IS NULL)
            OR NOT EXISTS(SELECT 1 FROM ot.orgs o WHERE o.id=ot.mail.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
        ORDER BY id FOR UPDATE
      ), held AS (
        INSERT INTO ot.opencode_mail_batches
        (agent_id,org_id,generation,turn_id,message_id,session_id,text,mail_ids,transcript)
        SELECT a.id,a.org_id,a.generation,$2,$3,$4,$5,$6,$7 FROM ot.agents a
        WHERE a.id=$1 AND EXISTS(SELECT 1 FROM ot.turns WHERE id=$2 AND agent_id=$1)
          AND (SELECT count(*) FROM eligible)=cardinality($6)
        RETURNING *
      ), claimed AS (
        UPDATE ot.mail m SET state='delivering',turn_id=h.turn_id FROM held h
        WHERE m.id=ANY(h.mail_ids) AND m.recipient_agent_id=h.agent_id RETURNING m.id
      ) SELECT agent_id,org_id,generation,turn_id,message_id,session_id,text FROM held
        WHERE (SELECT count(*) FROM claimed)=cardinality(mail_ids)",
        &[&agent,&turn,&id,&session,&text,&ids,&transcript]).await.map_err(private_error)?;
    row.map(batch)
        .ok_or_else(|| anyhow!("OpenCode mail selection lost custody"))
}

/// One statement commits transcript, exact rows and deletion of outstanding
/// custody. A failing transcript write rolls back all three. The actor serializes
/// its transcript writes; recovery runs before actors start.
#[nolog]
pub async fn acknowledge(client: &Client, agent: i64, session: &str, id: &str) -> Result<Vec<Row>> {
    client.query("WITH held AS (
        DELETE FROM ot.opencode_mail_batches WHERE agent_id=$1 AND session_id=$2 AND message_id=$3 RETURNING *
      ), delivered AS (
        UPDATE ot.mail m SET state='delivered',delivered_at=coalesce(m.delivered_at,now())
        FROM held h WHERE m.recipient_agent_id=h.agent_id AND m.turn_id=h.turn_id
          AND m.id=ANY(h.mail_ids) AND m.state='delivering'
        RETURNING m.uid,m.kind,m.org_id,m.net_id,m.net_hub
      ), counters AS (
        SELECT coalesce(max(seq),0)+1 AS seq,coalesce(max(ver),0)+1 AS ver FROM ot.convo WHERE agent_id=$1
      ), saved AS (
        INSERT INTO ot.convo(agent_id,seq,ver,body,tool_inputs)
        SELECT h.agent_id,c.seq,c.ver,h.transcript || jsonb_build_object('seq',c.seq,'row_id','r'||c.seq,
          'event_id','e'||c.seq,'convo_revision',c.ver),'{}'::jsonb FROM held h CROSS JOIN counters c
        WHERE EXISTS(SELECT 1 FROM delivered) RETURNING seq,ver,body
      ) SELECT d.uid,d.kind,d.org_id,d.net_id,d.net_hub,s.seq,s.ver,s.body
        FROM delivered d CROSS JOIN saved s",
        &[&agent,&session,&id]).await.map_err(private_error)
}

/// Unknown admission has a bounded end: one ordinary next-turn delivery carrying
/// the warning. Excluding the marker from hook claims prevents an in-turn loop.
#[nolog]
pub async fn release(client: &Client, agent: i64, id: &str, ambiguous: bool) -> Result<bool> {
    let rows = client.query("WITH held AS (
        DELETE FROM ot.opencode_mail_batches WHERE agent_id=$1 AND message_id=$2 RETURNING *
      ) UPDATE ot.mail m SET state='pending',turn_id=NULL,
        extra=m.extra || jsonb_build_object('opencode_ambiguous',$3::boolean,'input_budget_deferred',true)
        FROM held h WHERE m.recipient_agent_id=h.agent_id AND m.turn_id=h.turn_id
          AND m.id=ANY(h.mail_ids) AND m.state='delivering' RETURNING m.id",
        &[&agent,&id,&ambiguous]).await.map_err(private_error)?;
    Ok(!rows.is_empty())
}

/// Called only on an engine-owned profile path. Read-only SQLite includes WAL;
/// immutable mode would incorrectly miss admitted but uncheckpointed messages.
/// Exact native row identity, never its payload, is read in a single snapshot.
#[nolog]
pub fn native_evidence(path: &Path, session: &str, id: &str) -> Evidence {
    let read = || -> rusqlite::Result<Evidence> {
        use rusqlite::OptionalExtension;
        let mut db = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.busy_timeout(Duration::from_millis(100))?;
        let tx = db.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_v2 WHERE id=?1)",
            [session],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(Evidence::Unknown);
        }
        let pending: Option<(String, String)> = tx
            .query_row(
                "SELECT session_id,type FROM session_inbox WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let promoted: Option<(String, String)> = tx
            .query_row(
                "SELECT session_id,type FROM session_message WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let rows: Vec<_> = pending.into_iter().chain(promoted).collect();
        if rows.iter().any(|(s, t)| s != session || t != "user") {
            return Ok(Evidence::Unknown);
        }
        Ok(if rows.is_empty() {
            Evidence::Absent
        } else {
            Evidence::Admitted
        })
    };
    read().unwrap_or(Evidence::Unknown)
}

/// Recovery never accepts a path supplied by a CLI. The profile identity was
/// captured from the agent row, and all readers use that same owned root.
#[nolog]
pub async fn recover_agent(
    engine: &crate::engine::Engine,
    client: &Client,
    agent: i64,
    writer_stopped: bool,
) -> Result<Vec<Row>> {
    let Some(b) = load(client, agent).await? else {
        return Ok(Vec::new());
    };
    let evidence = if writer_stopped {
        let path = engine
            .cfg
            .path("profiles")
            .join("opencode")
            .join(b.org.to_string())
            .join(b.agent.to_string())
            .join(b.generation.to_string())
            .join("data/opencode/opencode.db");
        let session = b.session.clone();
        let id = b.id.clone();
        tokio::task::spawn_blocking(move || native_evidence(&path, &session, &id))
            .await
            .unwrap_or(Evidence::Unknown)
    } else {
        // After an unclean engine restart the old hosted child might still be
        // stopping. Without proof of quiescence, absence is not non-admission.
        Evidence::Unknown
    };
    if evidence == Evidence::Admitted {
        return acknowledge(client, agent, &b.session, &b.id).await;
    }
    if release(client, agent, &b.id, evidence == Evidence::Unknown).await?
        && evidence == Evidence::Unknown
    {
        tracing::warn!(agent, "OpenCode mail admission unresolved; next-turn delivery may already have been delivered mid-turn");
    }
    Ok(Vec::new())
}

#[nolog]
pub async fn recover_all(
    engine: &crate::engine::Engine,
    client: &Client,
    turns: Option<&[i64]>,
    writer_stopped: bool,
) -> Result<()> {
    loop {
        let rows = client
            .query(
                "SELECT agent_id FROM ot.opencode_mail_batches
            WHERE ($1::bigint[] IS NULL OR turn_id=ANY($1)) ORDER BY agent_id LIMIT 64",
                &[&turns],
            )
            .await
            .map_err(private_error)?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            let agent = row.get(0);
            let receipts = recover_agent(engine, client, agent, writer_stopped).await?;
            let delivered = crate::domain::mail::consumed(engine, &receipts);
            if let Some(row) = receipts.first() {
                super::watchdogs::events::mail_delivered(engine, row.get(2), agent, delivered);
            }
        }
    }
}

struct Endpoint {
    engine: Arc<crate::engine::Engine>,
    caller: super::Caller,
    owner: uuid::Uuid,
    ready: Arc<AtomicBool>,
    cancel: CancellationToken,
    capacity: Arc<tokio::sync::Semaphore>,
}

/// One short request per connection, with both bytes and parallelism bounded.
/// Handshake is independent of the actor: launch waits for plugin setup while
/// that actor is still busy constructing the process.
#[nolog]
async fn connection<S>(
    endpoint: Arc<Endpoint>,
    stream: S,
    _permit: tokio::sync::OwnedSemaphorePermit,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let work = async {
        let (read, mut write) = tokio::io::split(stream);
        let mut bytes = Vec::new();
        BufReader::new(read)
            .take(4097)
            .read_until(b'\n', &mut bytes)
            .await
            .ok()?;
        if bytes.len() > 4096 || bytes.last() != Some(&b'\n') {
            return None;
        }
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        let out = if value["protocol"] == 1 && value["op"] == "ready" {
            endpoint.ready.store(true, Ordering::Release);
            json!({"protocol":1,"ready":true})
        } else {
            let input = request(&value)?;
            let handle = endpoint.engine.agents.get(endpoint.caller.agent_id)?;
            let (reply, receive) = tokio::sync::oneshot::channel();
            if !handle.send(super::AgentMsg::OpenCodeMail {
                owner: endpoint.owner,
                input,
                reply,
            }) {
                return None;
            }
            receive.await.ok()?
        };
        let mut body = serde_json::to_vec(&out).ok()?;
        if body.len() > 262_143 {
            return None;
        }
        body.push(b'\n');
        write.write_all(&body).await.ok()?;
        write.shutdown().await.ok()
    };
    tokio::select! {
        _ = endpoint.cancel.cancelled() => {},
        _ = endpoint.engine.shutdown.cancelled() => {},
        _ = tokio::time::timeout(Duration::from_secs(2),work) => {},
    }
}

#[nolog]
pub fn serve(
    engine: Arc<crate::engine::Engine>,
    caller: super::Caller,
    owner: uuid::Uuid,
    cancel: CancellationToken,
) -> Result<(String, Arc<AtomicBool>)> {
    let ready = Arc::new(AtomicBool::new(false));
    let endpoint = Arc::new(Endpoint {
        engine,
        caller,
        owner,
        ready: ready.clone(),
        cancel,
        capacity: Arc::new(tokio::sync::Semaphore::new(4)),
    });
    let name = listen(endpoint)?;
    Ok((name, ready))
}

#[cfg(windows)]
#[nolog]
fn listen(endpoint: Arc<Endpoint>) -> Result<String> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = format!(r"\\.\pipe\orgtree-mail-{}", crate::util::random_hex(16));
    // a CLI the sign-in helper hosts in the user's session connects too,
    // whatever this engine's rights (`create_user_pipe`)
    let first = crate::winproc::create_user_pipe(ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true), &name)?;
    let pipe = name.clone();
    tokio::spawn(async move {
        let mut server = first;
        loop {
            tokio::select! {
                _=endpoint.cancel.cancelled()=>break,
                _=endpoint.engine.shutdown.cancelled()=>break,
                r=server.connect()=>if r.is_err(){break},
            }
            let conn = server;
            server = match crate::winproc::create_user_pipe(ServerOptions::new().reject_remote_clients(true), &pipe) {
                Ok(s) => s,
                Err(_) => break,
            };
            if let Ok(permit) = endpoint.capacity.clone().try_acquire_owned() {
                tokio::spawn(connection(endpoint.clone(), conn, permit));
            }
        }
    });
    Ok(name)
}

#[cfg(unix)]
#[nolog]
fn listen(endpoint: Arc<Endpoint>) -> Result<String> {
    for dir in crate::bridge::socket_dirs(&endpoint.engine.cfg.data_root) {
        let path = dir.join(format!("orgtree-mail-{}", crate::util::random_hex(8)));
        let Ok((listener, name)) = crate::bridge::listen(&dir, &path) else {
            continue;
        };
        tokio::spawn(async move {
            struct Unlink(std::path::PathBuf);
            impl Drop for Unlink {
                fn drop(&mut self) {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
            let _unlink = Unlink(path);
            loop {
                let conn = tokio::select! {
                    _=endpoint.cancel.cancelled()=>break,
                    _=endpoint.engine.shutdown.cancelled()=>break,
                    result=listener.accept()=>match result {Ok((s,_))=>s,Err(_)=>break},
                };
                if conn.peer_cred().map(|c| c.uid()).ok() != Some(unsafe { libc::geteuid() }) {
                    continue;
                }
                if let Ok(permit) = endpoint.capacity.clone().try_acquire_owned() {
                    tokio::spawn(connection(endpoint.clone(), conn, permit));
                }
            }
        });
        return Ok(name);
    }
    Err(anyhow!("private OpenCode mail socket unavailable"))
}

#[cfg(test)]
#[path = "opencode_mail_tests.rs"]
mod tests;
