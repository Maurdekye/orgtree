//! Bounded cursor pages for the project's immutable ended-lease history.
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

const PAGE_SIZE: usize = 30;
const OLDER_PREDICATE: &str = "AND l.id < $2";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Cursor { ended: DateTime<Utc>, id: i64 }

impl Cursor {
    #[nolog]
    fn encode(&self) -> String { format!("{}|{}", self.id, self.ended.to_rfc3339()) }
    #[nolog]
    fn parse(_value: Option<&str>) -> Result<Option<Self>> { Ok(None) }
}

#[nolog]
fn finish(rows: Vec<(Cursor, Value)>) -> Value {
    json!({"history": rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>(), "history_next": null})
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
