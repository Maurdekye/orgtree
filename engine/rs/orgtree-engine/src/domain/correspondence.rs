//! Conversation recall (`orgtree_inbox` action=conversation): the mail one
//! agent and one correspondent exchanged, both directions, a page at a time
//! (newest page first, oldest to newest within it), so an agent on a fresh
//! session can pick up what it was discussing with someone.
//!
//! It reads only what the agent may already read, the same mail `reply_to`
//! accepts: mail it received or sent (to an agent or the user), and the
//! outside mail it sent from the org inbox. Each side of a conversation is
//! one short index range (migration 0015), so a page never scans the rest of
//! a long mailbox.

use anyhow::Result;
use chrono::{DateTime, Utc};
use postgres_types::ToSql;
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

use crate::engine::Engine;
use crate::refuse;
use crate::util::{gist, iso};

/// Messages a page holds when the caller names no limit, and at most.
pub const DEFAULT_PAGE: i64 = 20;
pub const MAX_PAGE: i64 = 100;
/// The longest preview of one body, and the characters of previews and
/// reply quotes one page may carry (the rest waits for the next page), so a
/// recall cannot flood the caller's context.
pub const PREVIEW_CHARS: usize = 500;
pub const PAGE_CHARS: usize = 16_000;
/// A reply's quote of what it answers.
const QUOTE_CHARS: usize = 120;
/// What a page reads of each body: enough for the preview, never a whole
/// long body.
const HEAD_CHARS: i32 = 2000;

/// Who the conversation is with.
#[derive(Debug, Clone, PartialEq)]
pub enum Peer {
    Agent { id: i64, name: String },
    User,
    /// `@org:<slug>` or `@net:<address>`, as the mail names it
    Outside(String),
}

#[logged]
impl Peer {
    /// The name the caller passes back as `peer`.
    pub fn label(&self) -> String {
        match self {
            Peer::Agent { name, .. } => name.clone(),
            Peer::User => "user".into(),
            Peer::Outside(a) => a.clone(),
        }
    }
}

/// The calling agent, as a conversation needs it.
pub struct Me {
    pub id: i64,
    pub org_id: i64,
    pub name: String,
}

/// Resolve `peer` the way mail resolves `to`: 'user', '@org:<slug>',
/// '@net:<address>', an agent of this org (retired ones too: the mail stays
/// theirs), else a bare outside name.
#[logged]
pub async fn resolve(engine: &Engine, client: &impl GenericClient, me: &Me, raw: &str) -> Result<Peer> {
    const WHAT: &str = "peer is an agent's name, 'user', '@org:<slug>' or '@net:<address>'";
    let p = raw.trim();
    let bare = p.trim_start_matches('@').trim();
    if bare.is_empty() {
        refuse!(BadRequest, "conversation needs a peer: {WHAT}");
    }
    if bare == "user" {
        return Ok(Peer::User);
    }
    for kind in ["org:", "net:"] {
        if let Some(rest) = bare.strip_prefix(kind) {
            let rest = rest.trim();
            if rest.is_empty() {
                refuse!(BadRequest, "peer needs the address after @{kind}");
            }
            return Ok(Peer::Outside(format!("@{kind}{rest}")));
        }
    }
    if p.starts_with('@') {
        refuse!(BadRequest, "{WHAT}");
    }
    let row = match client
        .query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&me.org_id, &p])
        .await?
    {
        Some(r) => Some(r),
        // a deleted agent's mail is still the caller's own
        None => client
            .query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1", &[&me.org_id, &p])
            .await?,
    };
    if let Some(r) = row {
        let id: i64 = r.get(0);
        if id == me.id {
            refuse!(BadRequest, "that is you; {WHAT}");
        }
        return Ok(Peer::Agent { id, name: r.get(1) });
    }
    if let Some(address) = crate::net::resolve_bare(p, engine.orgs.get(p).is_some(), &crate::net::remote_peers(engine))? {
        return Ok(Peer::Outside(address));
    }
    refuse!(NotFound, "no agent named {p} in this organization ({WHAT})");
}

/// A position in a conversation: the newest message the next page must be
/// older than. Bound to the agent that was given it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cursor {
    pub at: DateTime<Utc>,
    /// 0: `ot.mail`, 1: `ot.org_inbox` (ties at one instant)
    pub src: i32,
    pub id: i64,
}

#[logged]
impl Cursor {
    pub fn encode(&self, me: i64) -> String {
        format!("c:{me}:{}:{}:{}", self.at.timestamp_micros(), self.src, self.id)
    }

    pub fn decode(me: i64, raw: &str) -> Result<Cursor> {
        let bad = || anyhow::Error::new(crate::domain::UserError::BadRequest("invalid conversation cursor (pass next_cursor from the previous page unchanged)".into()));
        let v: Vec<&str> = raw.trim().split(':').collect();
        if v.len() != 5 || v[0] != "c" || v[1] != me.to_string() {
            return Err(bad());
        }
        let at = v[2].parse::<i64>().ok().and_then(DateTime::<Utc>::from_timestamp_micros).ok_or_else(bad)?;
        let src = v[3].parse::<i32>().ok().filter(|s| *s == 0 || *s == 1).ok_or_else(bad)?;
        let id = v[4].parse::<i64>().ok().filter(|i| *i >= 0).ok_or_else(bad)?;
        Ok(Cursor { at, src, id })
    }
}

/// One message of a conversation, as read.
#[derive(Debug, Clone)]
pub struct Msg {
    pub key: Cursor,
    pub uid: String,
    /// the caller sent it (else received it)
    pub sent: bool,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub notice: bool,
    pub state: Option<String>,
    /// the start of the body (HEAD_CHARS) and its whole length in characters
    pub head: String,
    pub chars: i64,
    pub attachments: Value,
    pub reply_to: Option<Value>,
}

/// One side of a conversation (one direction, one table), newest first:
/// `cond` uses $1.. for `params`; the cursor and the limit follow them.
#[logged]
async fn side(
    client: &impl GenericClient,
    src: i32,
    sent: bool,
    cond: &str,
    params: &[&(dyn ToSql + Sync)],
    cursor: Option<&Cursor>,
    n: i64,
) -> Result<Vec<Msg>> {
    let (cols, table, t) = if src == 0 {
        ("uid, created_at, sender, recipient_name, kind, notice, state, left(body, $H), length(body)::int8, attachments, reply_to, id", "ot.mail", "created_at")
    } else {
        ("uid, at, coalesce(by_name, 'user'), peer, kind, false, state, left(body, $H), length(body)::int8, attachments, reply_to, id", "ot.org_inbox", "at")
    };
    let mut args: Vec<&(dyn ToSql + Sync)> = params.to_vec();
    let mut sql = format!("SELECT {cols} FROM {table} WHERE {cond}");
    if let Some(c) = cursor {
        let k = args.len();
        sql.push_str(&format!(
            " AND {t} <= ${a} AND ({t}, {src}::int4, id) < (${a}::timestamptz, ${b}::int4, ${c}::int8)",
            a = k + 1,
            b = k + 2,
            c = k + 3
        ));
        args.push(&c.at);
        args.push(&c.src);
        args.push(&c.id);
    }
    sql.push_str(&format!(" ORDER BY {t} DESC, id DESC LIMIT ${}", args.len() + 1));
    args.push(&n);
    let sql = sql.replace("$H", &format!("${}", args.len() + 1));
    args.push(&HEAD_CHARS);
    let rows = client.query(sql.as_str(), &args).await?;
    Ok(rows
        .iter()
        .map(|r| Msg {
            key: Cursor { at: r.get(1), src, id: r.get(11) },
            uid: r.get(0),
            sent,
            from: r.get(2),
            to: r.get(3),
            kind: r.get(4),
            notice: r.get(5),
            state: r.get(6),
            head: r.get(7),
            chars: r.get(8),
            attachments: r.get(9),
            reply_to: r.get(10),
        })
        .collect())
}

/// Up to `n` messages between the caller and `peer` older than `cursor`
/// (the newest when none), newest first, and whether older ones exist.
#[logged]
pub async fn page(client: &impl GenericClient, me: &Me, peer: &Peer, cursor: Option<&Cursor>, n: i64) -> Result<(Vec<Msg>, bool)> {
    let more = n + 1;
    let (received, sent) = match peer {
        Peer::Agent { id, .. } => (
            side(client, 0, false, "recipient_agent_id = $1 AND sender_agent_id = $2 AND state <> 'retracted'", &[&me.id, id], cursor, more).await?,
            side(client, 0, true, "recipient_agent_id = $2 AND sender_agent_id = $1", &[&me.id, id], cursor, more).await?,
        ),
        Peer::User => (
            side(client, 0, false, "recipient_agent_id = $1 AND sender_agent_id IS NULL AND sender = '@user' AND state <> 'retracted'", &[&me.id], cursor, more).await?,
            side(client, 0, true, "recipient_agent_id IS NULL AND sender_agent_id = $1 AND recipient_kind = 'user'", &[&me.id], cursor, more).await?,
        ),
        Peer::Outside(address) => {
            // sent from the org inbox under the caller's name, since the
            // caller existed (a deleted namesake's mail is not its own)
            let born: DateTime<Utc> = client.query_one("SELECT created_at FROM ot.agents WHERE id = $1", &[&me.id]).await?.get(0);
            (
                side(client, 0, false, "recipient_agent_id = $1 AND sender_agent_id IS NULL AND sender = $2 AND state <> 'retracted'", &[&me.id, address], cursor, more).await?,
                side(client, 1, true, "org_id = $1 AND dir = 'out' AND by_name = $2 AND peer = $3 AND at >= $4", &[&me.org_id, &me.name, address, &born], cursor, more).await?,
            )
        }
    };
    let mut all: Vec<Msg> = received.into_iter().chain(sent).collect();
    all.sort_by(|a, b| (b.key.at, b.key.src, b.key.id).cmp(&(a.key.at, a.key.src, a.key.id)));
    let has_more = all.len() as i64 > n;
    all.truncate(n as usize);
    Ok((all, has_more))
}

/// One message as the caller reads it: a preview, never the whole body.
#[logged]
pub fn shown(m: &Msg) -> (Value, usize) {
    let preview = gist(&m.head, PREVIEW_CHARS);
    // gist collapses whitespace: compare the collapsed length
    let flat = m.head.split_whitespace().map(|w| w.chars().count() + 1).sum::<usize>().saturating_sub(1);
    let cut = flat > PREVIEW_CHARS || m.chars > m.head.chars().count() as i64;
    let mut o = json!({
        "id": m.uid,
        "at": iso(m.key.at),
        "direction": if m.sent { "sent" } else { "received" },
        "from": m.from,
        "to": m.to,
        "kind": m.kind,
        "preview": preview,
        "chars": m.chars,
    });
    let mut spent = preview.chars().count();
    if cut {
        o["cut"] = json!(true);
    }
    if m.notice {
        o["notice"] = json!(true);
    }
    if let Some(s) = &m.state {
        o["state"] = json!(s);
    }
    if let Some(q) = m.reply_to.as_ref().filter(|q| q.is_object()) {
        let mut r = json!({});
        for k in ["id", "from", "net_id"] {
            if let Some(v) = q.get(k).filter(|v| !v.is_null()) {
                r[k] = v.clone();
            }
        }
        if let Some(g) = q["gist"].as_str() {
            let g = gist(g, QUOTE_CHARS);
            spent += g.chars().count();
            r["gist"] = json!(g);
        }
        if q["kind"].as_str().is_some_and(|k| k != "mail") {
            r["kind"] = q["kind"].clone();
        }
        o["reply_to"] = r;
    }
    let names: Vec<Value> = m
        .attachments
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    x["name"].as_str().map(str::to_string).or_else(|| {
                        x["path"].as_str().and_then(|p| std::path::Path::new(p).file_name()).map(|f| f.to_string_lossy().into_owned())
                    })
                })
                .map(Value::from)
                .collect()
        })
        .unwrap_or_default();
    if !names.is_empty() {
        o["attachments"] = Value::Array(names);
    }
    (o, spent)
}

/// The correspondents an agent exchanged mail with most recently (its
/// newest mail each way), newest first: an agent's current name, 'user', or
/// an outside address, with the time of the latest message. Engine notices
/// and watchdog mail are not correspondents.
#[logged]
pub async fn recent_peers(client: &impl GenericClient, agent_id: i64, most: usize) -> Result<Vec<(String, DateTime<Utc>)>> {
    let rows = client
        .query(
            "WITH me AS (SELECT org_id, name, created_at FROM ot.agents WHERE id = $1)
             (SELECT sender_agent_id, sender, created_at FROM ot.mail
               WHERE recipient_agent_id = $1 AND recipient_kind = 'agent' AND state <> 'retracted' ORDER BY id DESC LIMIT 200)
             UNION ALL
             (SELECT recipient_agent_id, recipient_name, created_at FROM ot.mail
               WHERE sender_agent_id = $1 ORDER BY id DESC LIMIT 200)
             UNION ALL
             (SELECT NULL::bigint, o.peer, o.at FROM ot.org_inbox o, me
               WHERE o.org_id = me.org_id AND o.dir = 'out' AND o.by_name = me.name AND o.at >= me.created_at
               ORDER BY o.at DESC LIMIT 50)",
            &[&agent_id],
        )
        .await?;
    let ids: Vec<i64> = rows.iter().filter_map(|r| r.get::<_, Option<i64>>(0)).collect();
    let names: std::collections::HashMap<i64, String> = if ids.is_empty() {
        Default::default()
    } else {
        client
            .query("SELECT id, name FROM ot.agents WHERE id = ANY($1)", &[&ids])
            .await?
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    };
    let mut latest: std::collections::HashMap<String, DateTime<Utc>> = Default::default();
    for r in &rows {
        let other: String = r.get(1);
        let who = match r.get::<_, Option<i64>>(0) {
            Some(id) => match names.get(&id) {
                Some(n) => n.clone(),
                None => continue,
            },
            None if other == "@user" => "user".to_string(),
            None if other.starts_with("@org:") || other.starts_with("@net:") => other,
            // the engine's own notices, a watchdog's mail
            None => continue,
        };
        let at: DateTime<Utc> = r.get(2);
        let e = latest.entry(who).or_insert(at);
        if at > *e {
            *e = at;
        }
    }
    let mut out: Vec<(String, DateTime<Utc>)> = latest.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.truncate(most);
    Ok(out)
}
