//! Bounded cursor pages for the project's immutable ended-lease history.
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

const PAGE_SIZE: usize = 30;
const OLDER_PREDICATE: &str = "AND (l.ended_at, l.id) < ($2, $3)";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Cursor { ended: DateTime<Utc>, id: i64 }

impl Cursor {
    #[nolog]
    fn encode(&self) -> String { format!("{}|{}", self.id, self.ended.to_rfc3339()) }
    #[nolog]
    fn parse(value: Option<&str>) -> Result<Option<Self>> {
        let Some(value) = value else { return Ok(None) };
        let parsed = value.split_once('|').and_then(|(id, ended)| {
            Some(Self { id: id.parse::<i64>().ok().filter(|id| *id > 0)?, ended: ended.parse().ok()? })
        });
        match parsed {
            Some(cursor) => Ok(Some(cursor)),
            None => crate::refuse!(BadRequest, "invalid slot history cursor"),
        }
    }
}

#[nolog]
fn finish(mut rows: Vec<(Cursor, Value)>) -> Value {
    let more = rows.len() > PAGE_SIZE;
    rows.truncate(PAGE_SIZE);
    let next = if more { rows.last().map(|(cursor, _)| cursor.encode()) } else { None };
    json!({"history": rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>(), "history_next": next})
}

/// Both status and older-page reads share this bounded indexed seek. End times
/// never change after release; the id breaks timestamp ties without losing precision.
#[logged]
pub async fn page(client: &impl GenericClient, project: i64, before: Option<&str>) -> Result<Value> {
    let before = Cursor::parse(before)?;
    let predicate = if before.is_some() { OLDER_PREDICATE } else { "" };
    let sql = format!("SELECT l.id, l.ended_at, l.uid, a.name, l.slot_no, l.reason, l.granted_at,
        l.end_reason, l.ended_by, l.queued_at
        FROM ot.slot_leases l JOIN ot.agents a ON a.id = l.holder_agent_id
        WHERE l.project_id = $1 AND l.ended_at IS NOT NULL {predicate}
        ORDER BY l.ended_at DESC, l.id DESC LIMIT 31");
    let rows = if let Some(cursor) = before {
        client.query(&sql, &[&project, &cursor.ended, &cursor.id]).await?
    } else { client.query(&sql, &[&project]).await? };
    let rows = rows.into_iter().map(|r| {
        let ended: DateTime<Utc> = r.get(1);
        let cursor = Cursor { id: r.get(0), ended };
        let row = json!({"lease":r.get::<_,String>(2),"agent":r.get::<_,String>(3),"slot":r.get::<_,i32>(4),
            "reason":r.get::<_,Option<String>>(5),"since":crate::util::iso(r.get::<_,DateTime<Utc>>(6)),
            "ended":crate::util::iso(ended),"how":r.get::<_,Option<String>>(7),"by":r.get::<_,Option<String>>(8),
            "queued":r.get::<_,Option<DateTime<Utc>>>(9).map(crate::util::iso)});
        (cursor, row)
    }).collect();
    Ok(finish(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(id: i64) -> Cursor {
        Cursor { id, ended: "2026-10-19T12:00:00.123456Z".parse().unwrap() }
    }

    #[test]
    fn cursor_preserves_sub_millisecond_ties_and_large_ids() {
        let c = cursor(9007199254740993);
        assert_eq!(Cursor::parse(Some(&c.encode())).unwrap(), Some(c));
        assert_eq!(Cursor::parse(None).unwrap(), None);
    }

    #[test]
    fn malformed_history_cursors_are_refused() {
        for token in ["", "abc", "0|2026-10-19T12:00:00Z", "-1|2026-10-19T12:00:00Z", "1|bad", "9223372036854775808|2026-10-19T12:00:00Z"] {
            assert!(Cursor::parse(Some(token)).is_err(), "bad cursor {token}");
        }
    }

    #[test]
    fn lookahead_cursor_resumes_without_duplicates_when_new_holds_arrive() {
        let rows = |ids: Vec<i64>| ids.into_iter().map(|id| (cursor(id), json!({"lease": format!("s{id}")}))).collect();
        let first = finish(rows((40..=70).rev().collect()));
        assert_eq!(first["history"].as_array().unwrap().len(), PAGE_SIZE);
        assert_eq!(first["history"][0]["lease"], "s70");
        let before = Cursor::parse(first["history_next"].as_str()).unwrap().unwrap();
        assert_eq!(before, cursor(41));
        // Same timestamp, larger id: new top rows never move this keyset boundary.
        let older: Vec<i64> = (1..=75).rev().filter(|id| (cursor(*id).ended, *id) < (before.ended, before.id)).take(31).collect();
        let second = finish(rows(older));
        assert_eq!(second["history"][0]["lease"], "s40");
        assert_eq!(second["history"][29]["lease"], "s11");
        assert!(finish(rows(vec![10,9]))["history_next"].is_null());
        assert!(finish(rows(vec![]))["history_next"].is_null());
    }

    #[test]
    fn history_uses_a_timestamp_and_id_keyset() {
        assert_eq!(OLDER_PREDICATE, "AND (l.ended_at, l.id) < ($2, $3)");
    }
}
