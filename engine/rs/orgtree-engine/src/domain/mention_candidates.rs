//! The @ menu's bounded read. USER 2026-10-27: m042c82fb0228 apps, panels and
//! presentations in the menu; mdb3b4aef1062 and m35d9b7cf74f6 a kind prefix
//! lists all of that kind; m79e889ce1609 every list newest first by the latest
//! of when each thing was mentioned, operated on or presented.
//!
//! Tickets, presentations, apps and panels come from here, ranked and paged.
//! Agents and projects are already in every window (the tree), which ranks
//! them itself with the node mention times a first page returns.
//!
//! Mentions are read from mail after it is written, in bounded batches through
//! one cursor (migration 0076), so no mail write path changes. Mail content is
//! private: nothing here logs it.
use std::collections::BTreeMap;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::Client;

/// The kinds this read lists.
pub const KINDS: [&str; 4] = ["item", "doc", "app", "panel"];
/// Rows one page holds, at most.
pub const LIMIT_MAX: i64 = 50;
/// Mail read for mentions per catch-up, and the ids read again behind the
/// cursor (a message can commit after a later one was read; reading it again
/// changes nothing).
const BATCH: i64 = 2000;
const OVERLAP: i64 = 200;
/// Characters of each body read for mentions.
const BODY_MAX: i32 = 65536;
/// Node mention times a first page carries.
const NODES_MAX: i64 = 200;

/// What one mail body mentions in its own org, as (kind, key): typed tokens of
/// that org (`@item:`, `@doc:`, `@app:`, `@panel:`, `@agent:`, `@project:`) and
/// bare `@names` (nodes). A token starts at the start or after anything but a
/// letter, a digit or `_ . % + - @`, as the renderer's do; another org's
/// tokens are its own. `@user` is not a node.
#[nolog]
pub fn scan(body: &str, org: &str) -> Vec<(&'static str, String)> {
    let b = body.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';
    let mut out: Vec<(&'static str, String)> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'@' { i += 1; continue; }
        let at = i;
        i += 1;
        if at > 0 && (b[at - 1].is_ascii_alphanumeric() || b"_.%+-@".contains(&b[at - 1])) { continue; }
        let mut j = i;
        while j < b.len() && (word(b[j])) { j += 1; }
        if j == i { continue; }
        let head = &body[i..j];
        if j < b.len() && b[j] == b':' {
            let kind = match head.to_ascii_lowercase().as_str() {
                "item" => "item", "doc" => "doc", "app" => "app", "panel" => "panel", "agent" | "project" => "node",
                _ => { i = j; continue; }
            };
            // <org>/<id>, a node's id may carry its @<generation>
            let mut k = j + 1;
            while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'-') { k += 1; }
            if k >= b.len() || b[k] != b'/' || &body[j + 1..k] != org { i = j; continue; }
            let start = k + 1;
            let mut end = start;
            while end < b.len() && (b[end].is_ascii_alphanumeric() || b[end] == b'-') { end += 1; }
            if end > start && end - start <= 200 && !(end < b.len() && (b[end] == b'_' || b[end] == b'/')) {
                out.push((kind, body[start..end].to_ascii_lowercase()));
            }
            i = end;
            continue;
        }
        // a bare name ends at a boundary: not a word, `/`, or a `.` before a letter (an address)
        let ends = j >= b.len() || !(b[j] == b'/' || (b[j] == b'.' && j + 1 < b.len() && b[j + 1].is_ascii_alphanumeric()));
        if ends && b[i].is_ascii_alphanumeric() && head.len() <= 200 && !head.eq_ignore_ascii_case("user") {
            out.push(("node", head.to_ascii_lowercase()));
        }
        i = j;
    }
    out.sort();
    out.dedup();
    out
}

/// Reads the mail written since the last catch-up for mentions, at most BATCH
/// messages, and keeps each thing's newest mention. A catch-up already running
/// elsewhere is not waited for.
#[nolog]
pub async fn catch_up(client: &mut Client) -> Result<()> {
    let newest: Option<i64> = client.query_one("SELECT max(id) FROM ot.mail", &[]).await?.get(0);
    let tx = client.transaction().await?;
    let Some(state) = tx.query_opt("SELECT mail_id FROM ot.mention_recency_state WHERE id = 1 FOR UPDATE SKIP LOCKED", &[]).await? else { return Ok(()) };
    let from: i64 = state.get(0);
    if newest.is_none_or(|n| n <= from) { return Ok(()) }
    let rows = tx.query("SELECT m.id, m.org_id, o.slug, left(m.body, $3), m.created_at FROM ot.mail m JOIN ot.orgs o ON o.id = m.org_id
        WHERE m.id > $1 ORDER BY m.id LIMIT $2", &[&(from - OVERLAP).max(0), &BATCH, &BODY_MAX]).await?;
    let Some(last) = rows.last().map(|r| r.get::<_, i64>(0)) else { return Ok(()) };
    let mut seen: BTreeMap<(i64, &'static str, String), DateTime<Utc>> = BTreeMap::new();
    for row in &rows {
        let (org, slug, body, at): (i64, String, String, DateTime<Utc>) = (row.get(1), row.get(2), row.get(3), row.get(4));
        for (kind, key) in scan(&body, &slug) {
            let newest = seen.entry((org, kind, key)).or_insert(at);
            if at > *newest { *newest = at; }
        }
    }
    if !seen.is_empty() {
        let (mut orgs, mut kinds, mut keys, mut ats) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for ((org, kind, key), at) in seen { orgs.push(org); kinds.push(kind.to_string()); keys.push(key); ats.push(at); }
        // An old id names the thing by its id now; rows go in one order, so two
        // catch-ups never wait on each other's rows the other way round. A time
        // that is not newer writes nothing.
        tx.execute("INSERT INTO ot.mention_recency (org_id, kind, key, at)
            SELECT o, k, key, max(at) FROM (
              SELECT u.o, u.k, CASE u.k
                       WHEN 'doc' THEN coalesce((SELECT d.slug FROM ot.documents d WHERE d.id = ot.document_ref(u.o, u.key)), u.key)
                       WHEN 'app' THEN coalesce(ot.custom_app_ref(u.o, u.key), u.key)
                       WHEN 'panel' THEN coalesce(ot.custom_panel_ref(u.o, u.key), u.key)
                       ELSE u.key END AS key, u.at
                FROM unnest($1::bigint[], $2::text[], $3::text[], $4::timestamptz[]) AS u(o, k, key, at)) c
            GROUP BY o, k, key ORDER BY o, k, key
            ON CONFLICT (org_id, kind, key) DO UPDATE SET at = EXCLUDED.at WHERE EXCLUDED.at > ot.mention_recency.at",
            &[&orgs, &kinds, &keys, &ats]).await?;
    }
    tx.execute("UPDATE ot.mention_recency_state SET mail_id = greatest(mail_id, $1) WHERE id = 1", &[&last]).await?;
    tx.commit().await?;
    Ok(())
}

/// One page's request: kinds, the typed words, the cursor after the last row shown.
pub struct Ask {
    pub kinds: Vec<String>,
    pub words: Vec<String>,
    pub after: Option<Cursor>,
    pub limit: i64,
}

/// A position in the order: newest first (milliseconds, the precision every
/// time the engine sends has, so the list's own order agrees), then by the name in
/// the database's lower case, kind and id.
#[derive(Clone, Debug, PartialEq)]
pub struct Cursor { pub at_ms: i64, pub label: String, pub kind: String, pub id: String }

impl Cursor {
    #[nolog]
    pub fn encode(&self) -> String { json!([self.at_ms, self.label, self.kind, self.id]).to_string() }
    #[nolog]
    pub fn decode(raw: &str) -> Option<Self> {
        if raw.len() > 1000 { return None }
        let v: Value = serde_json::from_str(raw).ok()?;
        let a = v.as_array().filter(|a| a.len() == 4)?;
        Some(Self { at_ms: a[0].as_i64()?, label: a[1].as_str()?.to_owned(), kind: a[2].as_str()?.to_owned(), id: a[3].as_str()?.to_owned() })
    }
}

/// The typed text's words: lower case, split at spaces and the marks slugs use.
#[nolog]
pub fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| c.is_whitespace() || "-_./".contains(c)).filter(|w| !w.is_empty()).map(str::to_owned).collect()
}

/// Live things only: tickets the docket lists outside its archive (as the @
/// menu always offered), presentations not dismissed, every app and saved
/// panel. Each is ranked by the latest of its own time (a ticket's last
/// change, a presentation's last presenting, an app's last change or its
/// copies' last use, a panel's last use or change) and its last mention.
const CANDIDATES_SQL: &str = "WITH cand AS (
    SELECT 'item'::text AS kind, w.slug AS id, w.title AS label,
           greatest(w.updated_at, coalesce(w.docket_at, w.updated_at)) AS operated, jsonb_build_object('status', w.status) AS extra
      FROM ot.work_items w
     WHERE 'item' = ANY($2::text[]) AND w.org_id = $1 AND w.archived_at IS NULL
       AND NOT coalesce((w.extra->>'deleted')::boolean, false) AND w.status <> 'dropped'
       AND NOT (w.status IN ('done','superseded') AND coalesce(w.docket_at, w.updated_at, w.created_at) < now() - interval '1 hour')
    UNION ALL
    SELECT 'doc', d.slug, d.title, d.at, jsonb_build_object('format', d.format)
      FROM ot.documents d WHERE 'doc' = ANY($2::text[]) AND d.org_id = $1 AND NOT d.dismissed
    UNION ALL
    SELECT 'app', a.id, a.name,
           greatest(a.updated_at, (SELECT max(p.used_at) FROM ot.custom_panels p WHERE p.org_id = a.org_id AND p.app_id = a.id)), '{}'::jsonb
      FROM ot.custom_apps a WHERE 'app' = ANY($2::text[]) AND a.org_id = $1
    UNION ALL
    SELECT 'panel', p.id, a.name || ' · ' || p.label, greatest(p.used_at, p.updated_at),
           jsonb_build_object('app', p.app_id, 'app_name', a.name, 'panel_label', p.label)
      FROM ot.custom_panels p JOIN ot.custom_apps a ON a.org_id = p.org_id AND a.id = p.app_id
     WHERE 'panel' = ANY($2::text[]) AND p.org_id = $1
  ), ranked AS (
    SELECT c.kind, c.id, c.label, c.extra, greatest(c.operated, r.at) AS at,
           floor(extract(epoch FROM greatest(c.operated, r.at)) * 1000)::bigint AS at_ms
      FROM cand c LEFT JOIN ot.mention_recency r ON r.org_id = $1 AND r.kind = c.kind AND r.key = c.id
     WHERE NOT EXISTS (SELECT 1 FROM unnest($3::text[]) t WHERE position(t IN lower(c.label || ' ' || c.id)) = 0)
  )
  SELECT kind, id, label, extra, at, at_ms, lower(label) FROM ranked
   WHERE $4::bigint IS NULL OR at_ms < $4 OR (at_ms = $4 AND (lower(label), kind, id) > ($5::text, $6::text, $7::text))
   ORDER BY at_ms DESC, lower(label), kind, id LIMIT $8";

/// One page of the org's candidates, and on a first page the node mention times.
#[nolog]
pub async fn page(client: &Client, org: i64, ask: &Ask) -> Result<Value> {
    let limit = ask.limit.clamp(1, LIMIT_MAX);
    let (c_at, c_label, c_kind, c_id) = match &ask.after {
        Some(c) => (Some(c.at_ms), c.label.clone(), c.kind.clone(), c.id.clone()),
        None => (None, String::new(), String::new(), String::new()),
    };
    let rows = client.query(CANDIDATES_SQL, &[&org, &ask.kinds, &ask.words, &c_at, &c_label, &c_kind, &c_id, &(limit + 1)]).await?;
    let more = rows.len() > limit as usize;
    let mut items = Vec::new();
    let mut next = None;
    for row in rows.iter().take(limit as usize) {
        let (kind, id, label, extra, at, at_ms, sort): (String, String, String, Value, DateTime<Utc>, i64, String) =
            (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4), row.get(5), row.get(6));
        let mut item = json!({ "kind": kind, "id": id, "label": label, "at": crate::util::iso(at) });
        if let (Some(o), Some(e)) = (item.as_object_mut(), extra.as_object()) { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
        items.push(item);
        next = Some(Cursor { at_ms, label: sort, kind, id });
    }
    let mut out = json!({ "items": items, "next_cursor": if more { next.map(|c| json!(c.encode())) } else { None } });
    if ask.after.is_none() {
        let nodes = client.query("SELECT key, at FROM ot.mention_recency WHERE org_id = $1 AND kind = 'node' ORDER BY at DESC, key LIMIT $2",
            &[&org, &NODES_MAX]).await?;
        out["nodes"] = json!(nodes.iter().map(|r| json!({ "name": r.get::<_, String>(0), "at": crate::util::iso(r.get::<_, DateTime<Utc>>(1)) })).collect::<Vec<_>>());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_finds_this_orgs_tokens_and_bare_names_at_boundaries_only() {
        let body = "See @item:acme/fix-login, @doc:acme/weekly-status and @app:acme/caption-board \
            (@panel:acme/caption-board-panel-1). Ask @Boss and @agent:acme/writer@3 or @project:acme/build-slot. \
            Not @item:other/x, not a@b.com, not x@writer, not @user, `@doc:acme/in-code` counts, @doc:acme/a/b does not.";
        let got = scan(body, "acme");
        let want: Vec<(&str, String)> = vec![("app", "caption-board".into()), ("doc", "in-code".into()), ("doc", "weekly-status".into()),
            ("item", "fix-login".into()), ("node", "boss".into()), ("node", "build-slot".into()), ("node", "writer".into()),
            ("panel", "caption-board-panel-1".into())];
        assert_eq!(got, want);
        // an address and a name inside a word are not mentions; an unknown kind is not a token
        assert!(scan("mail a@b.c or x@y", "acme").is_empty());
        assert_eq!(scan("@note:acme/x", "acme"), vec![]);
        assert_eq!(scan("@a.b", "acme"), vec![]);
        assert_eq!(scan("end @ali.", "acme"), vec![("node", "ali".to_string())]);
    }

    #[test]
    fn the_cursor_round_trips_and_refuses_anything_else() {
        let c = Cursor { at_ms: 1_793_000_000_123, label: "Caption board · Panel 1".into(), kind: "panel".into(), id: "caption-board-panel-1".into() };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
        for bad in ["", "[]", "[1,2,3,4]", "{\"a\":1}", "not json"] { assert_eq!(Cursor::decode(bad), None, "{bad}"); }
        assert_eq!(Cursor::decode(&"x".repeat(1001)), None);
    }

    #[test]
    fn words_split_like_slugs() {
        assert_eq!(words("  Caption BOARD-panel_1 "), vec!["caption", "board", "panel", "1"]);
        assert!(words("").is_empty());
    }
}
