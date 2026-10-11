//! orgtree_message / orgtree_send_notice / orgtree_status / orgtree_inbox.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::{arg_str, me, need_str, Done};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::runtime::Caller;
use crate::util::{gist, iso};

const KINDS: &[&str] = &["message", "question", "request", "decision", "status"];

/// The agent's working folder.
#[logged]
pub async fn scratch_of(engine: &Engine, client: &tokio_postgres::Client, caller: &Caller, agent_id: i64) -> Result<PathBuf> {
    let r = client.query_one("SELECT name, scratch_dir FROM ot.agents WHERE id = $1", &[&agent_id]).await?;
    let name: String = r.get(0);
    Ok(r.get::<_, Option<String>>(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| engine.cfg.scratch_root(&caller.org_slug).join(name)))
}

/// How many recipients one orgtree_message may name.
const MAX_RECIPIENTS: usize = 10;

/// What a send carries to every recipient alike.
struct Letter {
    me: super::Me,
    body: String,
    kind: String,
    notice: bool,
    urgent_reason: Option<String>,
    attachments: Vec<Value>,
    reply: Option<Value>,
}

/// One recipient's delivery.
struct Delivered {
    text: String,
    uid: String,
    box_name: String,
}

/// `to` is one recipient or a list; a list sends the same message to each,
/// one delivery per recipient, every reach rule checked per recipient.
#[logged]
pub async fn message(engine: &Arc<Engine>, caller: &Caller, args: &Value, force_notice: bool) -> Result<Done> {
    let list = match args.get("to") {
        Some(Value::Array(a)) => Some(recipients(a)?),
        _ => None,
    };
    let to = match &list {
        Some(l) if l.len() == 1 => l[0].clone(),
        Some(_) => String::new(),
        None => need_str(args, "to")?.to_string(),
    };
    let single = list.as_ref().is_none_or(|l| l.len() == 1);
    let body = args.get("body").and_then(Value::as_str).unwrap_or("").to_string();
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    drop(client);
    let kind = arg_str(args, "kind").unwrap_or("message");
    if !KINDS.contains(&kind) {
        crate::refuse!(BadRequest, "kind must be one of {}", KINDS.join(", "));
    }
    let mut urgent_reason = None;
    if args["urgent"].as_bool().unwrap_or(false) {
        if single && !is_user(&to) {
            crate::refuse!(BadRequest, "urgent is only for mail to the user");
        }
        let Some(reason) = arg_str(args, "urgent_reason") else {
            crate::refuse!(BadRequest, "urgent needs urgent_reason: one line telling the user why this interrupts them now");
        };
        urgent_reason = Some(gist(reason, 300));
    }
    let attachments = args["attachments"].as_array().cloned().unwrap_or_default();
    if attachments.len() > 10 { crate::refuse!(BadRequest, "at most 10 attachments"); }
    let mut letter = Letter {
        me, body, kind: kind.to_string(), urgent_reason, attachments, reply: None,
        notice: force_notice || args["notice"].as_bool().unwrap_or(false),
    };
    if single {
        let d = send_one(engine, &letter, &to, true, arg_str(args, "reply_to")).await?;
        return Ok(Done { text: d.text, card: Some(json!({ "mail": { "id": d.uid, "to": d.box_name } })) });
    }
    if let Some(r) = arg_str(args, "reply_to") {
        letter.reply = Some(mail::agent_reply_quote(engine, letter.me.org_id, letter.me.id, &letter.me.name, r).await?);
    }
    let list = list.unwrap_or_default();
    let mut lines = Vec::new();
    let mut mails = Vec::new();
    for to in &list {
        match send_one(engine, &letter, to, false, None).await {
            Ok(d) => {
                lines.push(format!("- {to}: {}", d.text));
                mails.push(json!({ "id": d.uid, "to": d.box_name }));
            }
            Err(e) => match e.downcast_ref::<crate::domain::UserError>() {
                Some(why) => lines.push(format!("- {to}: refused: {why}")),
                None => lines.push(format!("- {to}: failed: {e}")),
            },
        }
    }
    let mut text = format!("Sent to {} of {} recipients:\n{}", mails.len(), list.len(), lines.join("\n"));
    for n in list_notes(&letter, &list) {
        text.push('\n');
        text.push_str(&n);
    }
    if mails.is_empty() {
        crate::refuse!(Forbidden, "{text}");
    }
    let first = mails[0].clone();
    Ok(Done { text, card: Some(json!({ "mail": first, "mails": mails })) })
}

/// The notes under a list send's per-recipient lines.
#[logged]
fn list_notes(letter: &Letter, list: &[String]) -> Vec<String> {
    let mut notes = Vec::new();
    let others: Vec<&str> = list.iter().filter(|t| !is_user(t)).map(String::as_str).collect();
    if letter.urgent_reason.is_some() && !others.is_empty() {
        notes.push(format!("urgent applies only to the user; ignored for {}.", others.join(", ")));
    }
    if let Some(q) = &letter.reply {
        let without: Vec<&str> = list.iter().filter(|t| !quote_belongs(q, t)).map(String::as_str).collect();
        if !without.is_empty() {
            notes.push(format!(
                "reply_to: the message you answer is not part of your conversation with {}, so they get it without the quote.",
                without.join(", ")));
        }
    }
    let images = relative_images(&letter.body);
    if !images.is_empty() && !others.is_empty() {
        notes.push(format!(
            "Warning: the body has relative image paths ({}); they render only for the user. {} cannot see them: send the file or name the path instead.",
            images.join(", "), others.join(", ")));
    }
    notes
}

/// The recipients of a list `to`: strings, duplicates collapsed, bounded.
#[logged]
fn recipients(list: &[Value]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for v in list {
        let Some(s) = v.as_str() else { crate::refuse!(BadRequest, "`to` must be a name or a list of names"); };
        let s = s.trim();
        if s.is_empty() { continue; }
        let s = if is_user(s) { "user".to_string() } else { s.to_string() };
        if !out.contains(&s) { out.push(s); }
    }
    if out.is_empty() { crate::refuse!(BadRequest, "`to` needs at least one recipient"); }
    if out.len() > MAX_RECIPIENTS {
        crate::refuse!(BadRequest, "at most {MAX_RECIPIENTS} recipients per message ({} given)", out.len());
    }
    Ok(out)
}

#[nolog]
fn is_user(to: &str) -> bool {
    to.trim().trim_start_matches('@') == "user"
}

/// Was the quoted message part of this recipient's conversation with the sender?
#[logged]
fn quote_belongs(q: &Value, to: &str) -> bool {
    let to = to.trim();
    if is_user(to) {
        return q["box"] == "user" || q["from"].as_str().is_some_and(is_user);
    }
    match q["box"].as_str() {
        Some("org") => to.starts_with("@org:") || to.starts_with("@net:"),
        _ => q["from"].as_str() == Some(to) || q["node"].as_str() == Some(to),
    }
}

/// Markdown image targets in `body` that are relative paths: they resolve
/// against the reader's own folder, so only the user's desk renders them.
#[logged]
fn relative_images(body: &str) -> Vec<String> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"!\[[^\]]*\]\(\s*<?([^)>\s]+)").expect("image regex"));
    let mut out: Vec<String> = Vec::new();
    for c in RE.captures_iter(body) {
        let t = c[1].to_string();
        let absolute = t.contains("://") || t.starts_with("data:") || t.starts_with('/') || t.starts_with('\\')
            || t.as_bytes().get(1) == Some(&b':');
        if !absolute && !out.contains(&t) { out.push(t); }
    }
    out
}

/// Send the letter to one recipient. `single` keeps the one-recipient
/// behaviour exactly (its reply_to resolved after the attachment checks);
/// in a list the shared reply quote rides only where it belongs.
#[logged]
async fn send_one(engine: &Arc<Engine>, letter: &Letter, to: &str, single: bool, reply_to: Option<&str>) -> Result<Delivered> {
    let me = &letter.me;
    let mut out = Outgoing::new(From::Agent { id: me.id, name: me.name.clone(), generation: me.generation }, to, &letter.body);
    out.kind = letter.kind.clone();
    out.notice = letter.notice;
    let to_user = is_user(to);
    if to_user {
        if let Some(reason) = &letter.urgent_reason {
            out.urgent = true;
            out.urgent_reason = Some(reason.clone());
        }
    }
    if !letter.attachments.is_empty() {
        out.to = mail::attachment_recipient(engine, me.org_id, to).await?;
        let network = out.to.trim().trim_start_matches('@').starts_with("net:");
        if !to_user && !network {
            crate::refuse!(BadRequest, "attachments ride mail to the user or @net: peers; for local recipients use paths");
        }
        let org = engine.orgs.by_id(me.org_id).ok_or_else(|| anyhow::anyhow!("organization not open"))?;
        let presenter = crate::domain::docs::presenter(engine, &org, me.id).await?;
        if to_user && !presenter.may_present { crate::refuse!(Forbidden, "mail to the user needs a user audience"); }
        let limit = if network { Some(crate::net::attachment_limit(engine, me.org_id, &out.to).await?) } else { None };
        for a in &letter.attachments {
            let Some(path) = a.as_str() else { crate::refuse!(BadRequest, "attachment paths must be strings"); };
            let owner = presenter.clone();
            let path = path.to_owned();
            out.attachments.push(tokio::task::spawn_blocking(move || crate::domain::docs::snapshot(&owner, &path, limit.as_ref())).await??);
        }
    }
    out.reply_to = match reply_to {
        Some(r) => Some(mail::agent_reply_quote(engine, me.org_id, me.id, &me.name, r).await?),
        None => letter.reply.clone().filter(|q| single || quote_belongs(q, to)),
    };
    // a reply over the hub links to what it answers only when that came over a hub
    let local_reply = out.reply_to.as_ref().is_some_and(|q| q.get("net_id").is_none());
    let sent = mail::send(engine, me.org_id, out).await?;
    let box_name = if to_user { "user_inbox".to_string() } else { sent.to.clone() };
    let mut text = if single {
        format!("Sent to {} (id {}). {}", sent.to, sent.uid, sent.delivery)
    } else {
        format!("sent (id {}). {}", sent.uid, sent.delivery)
    };
    if local_reply && sent.to.starts_with("@net:") {
        text.push_str(" The message it answers did not come over the mail hub, so the recipient gets the reply without a link to it.");
    }
    Ok(Delivered { text, uid: sent.uid, box_name })
}

#[logged]
pub async fn status(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let status = need_str(args, "status")?;
    if !["working", "done", "blocked", "idle"].contains(&status) {
        crate::refuse!(BadRequest, "status must be working, done, blocked or idle");
    }
    let summary = gist(arg_str(args, "summary").unwrap_or(""), 600);
    // "done" is a report, not a state: the agent is idle afterwards
    let state = if status == "done" { "idle" } else { status };
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let rec = json!({ "status": state, "summary": summary, "at": iso(chrono::Utc::now()) });
    client
        .execute(
            "UPDATE ot.agents SET prev_status = last_status, last_status = $2, row_version = row_version + 1 WHERE id = $1",
            &[&me.id, &rec],
        )
        .await?;
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'status', $2, $3, $4)",
            &[&me.org_id, &me.name, &me.id, &json!({ "status": status, "summary": summary })],
        )
        .await?;
    // 3.x: a top-level agent's report goes nowhere — the user already gets
    // its own reply mail, and a second [DONE] digest was pure duplication
    // (user ruling); its status chip is the record
    let superior: Option<String> = match me.parent_id {
        Some(p) => client.query_opt("SELECT name FROM ot.agents WHERE id = $1", &[&p]).await?.map(|r| r.get(0)),
        None => None,
    };
    let top_level = me.parent_id.is_none();
    drop(client);
    changes::notify_id(engine, me.org_id, vec![Change::Agent(me.id), Change::Events, Change::History(me.id)]);
    let mut told = String::new();
    if status == "done" || status == "blocked" {
        if let Some(sup) = superior {
            let mut out = Outgoing::new(
                From::Agent { id: me.id, name: me.name.clone(), generation: me.generation },
                &sup,
                &format!("Status: {status} — {summary}"),
            );
            out.kind = "status".into();
            out.notice = true;
            out.ev = Some(crate::events::status_report(&caller.org_slug, &me.name, me.generation as i64, status, &summary));
            if mail::send(engine, me.org_id, out).await.is_ok() {
                told = format!(" {sup} gets it as a notice at its next turn.");
            }
        } else if top_level {
            told = " Status chip only — report your actual results to the user via orgtree_message.".to_string();
        }
    }
    let shown = if status == "done" { "done (you are idle now)" } else { status };
    Done::text(format!("Status recorded: {shown}.{told}"))
}


/// UTF-8 chunks concatenate exactly; the handle binds reads to an immutable body digest.
#[logged]
fn mail_chunk(body: &str, index: usize) -> Result<Value> {
    use sha2::{Digest, Sha256};
    let mut spans = Vec::new();
    let mut start = 0;
    loop {
        let mut end = (start + 64 * 1024).min(body.len());
        while !body.is_char_boundary(end) { end -= 1; }
        spans.push((start, end));
        if end == body.len() { break; }
        start = end;
    }
    let Some(&(start, end)) = spans.get(index) else { crate::refuse!(BadRequest, "chunk_index is outside this message"); };
    let content = &body[start..end];
    Ok(json!({"body_bytes": body.len(), "body_sha256": hex::encode(Sha256::digest(body.as_bytes())),
        "chunk_index": index, "chunk_total": spans.len(), "chunk_sha256": hex::encode(Sha256::digest(content.as_bytes())),
        "content": content, "content_state": "present", "complete": spans.len() == 1}))
}

#[logged]
pub async fn inbox(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let action = need_str(args, "action")?;
    let allowed = match action {
        "list" => vec!["action", "cursor", "limit"], "fetch" => vec!["action", "message_ids"],
        "chunk" => vec!["action", "delivery_id", "message_id", "chunk_index"],
        "conversation" => vec!["action", "peer", "cursor", "limit"],
        _ => crate::refuse!(BadRequest, "action must be list, fetch, chunk or conversation"),
    };
    if args.as_object().map(|a| a.keys().any(|k| !allowed.contains(&k.as_str()))).unwrap_or(true) {
        if action == "conversation" {
            crate::refuse!(BadRequest, "conversation reads your own mail with one correspondent; it takes peer, cursor and limit only");
        }
        crate::refuse!(BadRequest, "the manual inbox reads only your own mailbox; it takes no agent, node, org or mailbox argument");
    }
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    if action == "conversation" {
        return conversation(engine, &client, &me, args).await;
    }
    if action == "list" {
        let limit = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
        let after = match args["cursor"].as_str() {
            None => 0,
            Some(c) => {
                let values: Vec<&str> = c.split(':').collect();
                if values.len() != 2 || values[0] != me.id.to_string() { crate::refuse!(BadRequest, "invalid inbox cursor"); }
                values[1].parse::<i64>().ok().filter(|x| *x >= 0).ok_or_else(|| anyhow::Error::new(crate::domain::UserError::BadRequest("invalid inbox cursor".into())))?
            }
        };
        let rows = client.query("SELECT id, uid, sender, kind, state, created_at, body, notice FROM ot.mail
            WHERE recipient_agent_id = $1 AND state IN ('pending','delivering') AND id > $2 ORDER BY id LIMIT $3",
            &[&me.id, &after, &(limit + 1)]).await?;
        let has_more = rows.len() > limit as usize;
        let rows = &rows[..rows.len().min(limit as usize)];
        let items: Vec<Value> = rows.iter().map(|r| json!({"id":r.get::<_,String>(1), "message_id":r.get::<_,String>(1),
            "from":r.get::<_,String>(2), "kind":r.get::<_,String>(3), "state":r.get::<_,String>(4),
            "at":iso(r.get(5)), "preview":gist(&r.get::<_,String>(6),200), "notice":r.get::<_,bool>(7)})).collect();
        let cursor = if has_more { rows.last().map(|r| format!("{}:{}", me.id, r.get::<_,i64>(0))) } else { None };
        return Done::json(&json!({"messages":items, "next_cursor":cursor, "has_more":has_more}));
    }
    let ids: Vec<String> = if action == "chunk" { vec![need_str(args,"message_id")?.to_string()] } else {
        let a = args["message_ids"].as_array().ok_or_else(|| anyhow::anyhow!("fetch needs message_ids"))?;
        if a.is_empty() || a.len() > 20 || a.iter().any(|v| !v.is_string()) { crate::refuse!(BadRequest,"fetch needs 1 to 20 message IDs"); }
        let mut ids = Vec::new();
        for id in a.iter().filter_map(Value::as_str) { if !ids.iter().any(|i| i == id) { ids.push(id.to_string()); } }
        ids
    };
    // mail you received or sent, and outside mail you sent from the org inbox
    // (what conversation lists; the same mail reply_to accepts)
    let rows = client.query("SELECT uid, sender, kind, state, created_at, body, attachments, coalesce(recipient_agent_id = $1, false), recipient_name
          FROM ot.mail WHERE uid = ANY($2) AND (recipient_agent_id = $1 OR sender_agent_id = $1)
        UNION ALL
        SELECT o.uid, coalesce(o.by_name, 'user'), o.kind, coalesce(o.state, 'queued'), o.at, o.body, o.attachments, false, o.peer
          FROM ot.org_inbox o JOIN ot.agents a ON a.id = $1
         WHERE o.uid = ANY($2) AND o.org_id = a.org_id AND o.dir = 'out' AND o.by_name = a.name AND o.at >= a.created_at
        LIMIT 40", &[&me.id,&ids]).await?;
    let mut items = Vec::new();
    let mut missing = Vec::new();
    let mut deferred = Vec::new();
    let mut budget = 256 * 1024usize;
    for id in ids {
        let Some(r) = rows.iter().find(|r| r.get::<_,String>(0) == id) else { missing.push(id); continue; };
        let body: String = r.get(5);
        let index = if action == "chunk" { args["chunk_index"].as_u64().ok_or_else(|| anyhow::anyhow!("chunk needs a nonnegative chunk_index"))? as usize } else { 0 };
        let mut item = mail_chunk(&body,index)?;
        let did = format!("inbox:{}:{}:{}", me.id, id, item["body_sha256"].as_str().unwrap());
        if action == "chunk" && args["delivery_id"].as_str() != Some(&did) { crate::refuse!(BadRequest,"delivery_id does not match this message and body"); }
        let bytes = item["content"].as_str().unwrap().len();
        if bytes > budget { deferred.push(id); continue; }
        budget -= bytes;
        item["id"] = json!(id); item["message_id"] = json!(id); item["delivery_id"] = json!(did);
        item["from"] = json!(r.get::<_,String>(1)); item["kind"] = json!(r.get::<_,String>(2));
        let state: String = r.get(3);
        item["state"] = json!(state); item["at"] = json!(iso(r.get(4)));
        item["attachments"] = Value::Array(r.get::<_,Value>(6).as_array().into_iter().flatten().filter(|a| a["transfer_removed"] != true).cloned().collect());
        if r.get::<_,bool>(7) {
            item["direction"] = json!("received");
            item["will_redeliver"] = json!(state == "pending" || state == "delivering");
            item["will_redeliver_reason"] = json!("Manual reads leave delivery state unchanged; waiting mail still follows normal automatic delivery.");
        } else {
            // its state is the recipient's
            item["direction"] = json!("sent");
            item["to"] = json!(r.get::<_,String>(8));
            item["will_redeliver"] = json!(false);
        }
        items.push(item);
    }
    if action == "chunk" {
        if items.is_empty() { crate::refuse!(NotFound,"message not found in your mailbox"); }
        return Done::json(&items[0]);
    }
    Done::json(&json!({"messages":items, "not_found":missing, "deferred_ids":deferred}))
}

/// The mail the caller and one correspondent exchanged, both directions:
/// the newest page first, oldest to newest within it, previews only.
#[logged]
async fn conversation(engine: &Arc<Engine>, client: &tokio_postgres::Client, me: &super::Me, args: &Value) -> Result<Done> {
    use crate::domain::correspondence as c;
    let who = c::Me { id: me.id, org_id: me.org_id, name: me.name.clone() };
    let peer = c::resolve(engine, client, &who, need_str(args, "peer")?).await?;
    let limit = match args.get("limit").filter(|v| !v.is_null()) {
        None => c::DEFAULT_PAGE,
        Some(v) => v
            .as_i64()
            .or_else(|| v.as_f64().map(|f| f as i64))
            .ok_or_else(|| anyhow::Error::new(crate::domain::UserError::BadRequest("limit must be a number".into())))?
            .clamp(1, c::MAX_PAGE),
    };
    let cursor = match args.get("cursor").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => Some(c::Cursor::decode(me.id, v.as_str().unwrap_or(""))?),
    };
    let (rows, older) = c::page(client, &who, &peer, cursor.as_ref(), limit).await?;
    // newest first until the page's character budget is spent (always one)
    let mut shown: Vec<(Value, c::Cursor)> = Vec::new();
    let mut spent = 0usize;
    for m in &rows {
        let (v, cost) = c::shown(m);
        if !shown.is_empty() && spent + cost > c::PAGE_CHARS {
            break;
        }
        spent += cost;
        shown.push((v, m.key));
    }
    let budget_cut = shown.len() < rows.len();
    let has_more = older || budget_cut;
    let label = peer.label();
    let next = if has_more { shown.last().map(|(_, k)| k.encode(me.id)) } else { None };
    let cut = shown.iter().any(|(v, _)| v["cut"].as_bool() == Some(true));
    let mut note = if shown.is_empty() {
        if cursor.is_some() { format!("No older mail with {label}.") } else { format!("You have no mail with {label}.") }
    } else {
        format!("{} messages with {label}, oldest to newest.", shown.len())
    };
    if budget_cut {
        note.push_str(&format!(" This page stopped there to stay within {} characters of previews.", c::PAGE_CHARS));
    }
    if let Some(n) = &next {
        note.push_str(&format!(" Older mail with {label} exists: orgtree_inbox action=conversation peer={label} cursor={n} gives the page before these."));
    } else if !shown.is_empty() {
        note.push_str(&format!(" This is the start of your mail with {label}."));
    }
    if cut {
        note.push_str(&format!(
            " Previews stop at {} characters; a message marked cut is longer: orgtree_inbox action=fetch message_ids=[its id] gives the whole text.",
            c::PREVIEW_CHARS
        ));
    }
    let messages: Vec<Value> = shown.into_iter().rev().map(|(v, _)| v).collect();
    Done::json(&json!({ "peer": label, "messages": messages, "has_more": has_more, "next_cursor": next, "note": note }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipients_collapse_duplicates_and_are_bounded() {
        let l = recipients(&[json!("a"), json!(" a "), json!("@user"), json!("user"), json!("@net:x.1")]).unwrap();
        assert_eq!(l, vec!["a", "user", "@net:x.1"]);
        assert!(recipients(&[]).is_err());
        assert!(recipients(&[json!(3)]).is_err());
        let many: Vec<Value> = (0..11).map(|i| json!(format!("n{i}"))).collect();
        assert!(recipients(&many).is_err());
        assert_eq!(recipients(&many[..10]).unwrap().len(), 10);
    }

    #[test]
    fn a_quote_rides_only_its_own_conversation() {
        let node = json!({ "box": "node", "from": "boss", "node": "me" });
        assert!(quote_belongs(&node, "boss"));
        assert!(!quote_belongs(&node, "user"));
        assert!(!quote_belongs(&node, "@net:x.1"));
        let user = json!({ "box": "user", "from": "me" });
        assert!(quote_belongs(&user, "user"));
        assert!(!quote_belongs(&user, "boss"));
        let org = json!({ "box": "org", "from": "@net:x.1" });
        assert!(quote_belongs(&org, "@net:x.1"));
        assert!(!quote_belongs(&org, "user"));
    }

    #[test]
    fn relative_images_are_found() {
        let b = r"![a](outbox/p.png) ![b](<C:\x y\q.png>) ![c](https://e/x.png) ![d](/abs.png) ![e](outbox/p.png)";
        assert_eq!(relative_images(b), vec!["outbox/p.png"]);
        assert!(relative_images("no images [link](rel.md)").is_empty());
    }
}

/// Transfer tools use the caller's identity, never a requested agent or org.
#[logged]
pub async fn transfers(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    if args.as_object().map(|a| a.keys().any(|k| !["action","id","cursor"].contains(&k.as_str()))).unwrap_or(true) {
        crate::refuse!(BadRequest,"transfers takes action, id and cursor only");
    }
    let c = engine.db.get().await?;
    let actor = me(&c,caller).await?;
    drop(c);
    let action = need_str(args,"action")?;
    let value = match action {
        "list" => crate::net::control::page(engine,actor.org_id,Some(actor.id),None,args.get("cursor").filter(|v| !v.is_null()).map(|v| v.as_str().unwrap_or(""))).await?,
        "get" => crate::net::control::inspect(engine,actor.org_id,Some(actor.id),Some(need_str(args,"id")?)).await?,
        "retry" | "cancel" | "remove" => crate::net::control::change(engine,actor.org_id,Some(actor.id),need_str(args,"id")?,action).await?,
        _ => crate::refuse!(BadRequest,"action must be list, get, retry, cancel or remove"),
    };
    Done::json(&value)
}
