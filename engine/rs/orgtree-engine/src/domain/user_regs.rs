//! The user's own registrations on a project, shared helpers (docket
//! let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
//! 13:03Z-13:22Z; ops: `domain/ops/user_regs.rs`). A registration is a
//! watchdog or slot lease with no agent owner (`owner_kind` / `holder_kind`
//! 'user', migration 0046). The user's data name is the reserved word
//! `"user"` (no agent can be named it); the desk shows it as "you".
//!
//! Fires and queued jobs reach the user as ordinary mail in their inbox
//! (USER 13:04Z "they both arrive as normal mail in your inbox").
use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::util::{gist, iso};

/// The user's data name; the desk renders it as "you".
pub const USER: &str = "user";

/// Fires a dog keeps in its `events` ring (as every kind).
const EVENTS_KEEP: i64 = 50;

/// Fire one of the user's armed dogs (a listener watch reaching its count):
/// record the fire (a one-shot is spent with it) and put it in the user's
/// inbox as a watchdog mail. There is no agent to wake and no runner to stop:
/// the user's dogs are never armed in the watchdog runtime. Returns whether
/// the dog was one-shot (spent). A dog already spent or removed is left alone.
#[logged]
pub async fn fire_dog(engine: &Arc<Engine>, org_id: i64, row: i64, prefix: &str, lines: Vec<String>) -> Result<bool> {
    let ring: Vec<Value> = lines.iter().take(20).map(|l| json!({ "at": iso(Utc::now()), "gist": gist(l, 200) })).collect();
    let fired = {
        let client = engine.db.get().await?;
        client
            .query_opt(
                "UPDATE ot.watchdogs SET fired = fired + 1, last_fired = now(),
                        events = (SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (
                            SELECT x, n FROM jsonb_array_elements(events || $2) WITH ORDINALITY AS e(x, n)
                             ORDER BY n DESC LIMIT $3) s),
                        spent_at = CASE WHEN once THEN now() ELSE spent_at END,
                        state = CASE WHEN once THEN 'spent' ELSE state END
                  WHERE id = $1 AND state = 'armed' AND owner_kind = 'user'
                  RETURNING uid, name, kind, target, once, fired",
                &[&row, &Value::Array(ring), &EVENTS_KEEP],
            )
            .await?
    };
    let Some(r) = fired else { return Ok(false) };
    let (uid, name, kind, target, once, count): (String, String, String, String, bool, i32) =
        (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5));
    let mut body = format!("Watchdog \"{name}\" fired{prefix} ({kind} · {target}), fire #{count}:\n");
    let shown: Vec<String> = lines.iter().take(40).cloned().collect();
    for l in &shown {
        body.push_str("  ");
        body.push_str(l);
        body.push('\n');
    }
    if once {
        body.push_str("This was a ONE-SHOT registration: it removed itself with this fire.\n");
    }
    let slug = engine.orgs.by_id(org_id).map(|o| o.slug.clone()).unwrap_or_default();
    let ev = crate::events::watchdog_fired(&slug, &uid, &name, USER, prefix.trim(), &shown, once, None);
    let mut out = Outgoing::new(From::Watchdog { key: crate::domain::watchdogs::handle(USER, &uid), name }, USER, &body);
    out.kind = "watchdog".into();
    out.ev = Some(ev);
    if let Err(e) = mail::send(engine, org_id, out).await {
        tracing::warn!(watchdog = %uid, error = %format!("{e:#}"), "mailing the user their own registration's fire failed");
    }
    changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::UserMail]);
    Ok(once)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user's data name is a word no agent can be given, so a row named
    /// "user" in a slot list, a line or a listener table is always the user.
    #[test]
    fn the_users_data_name_is_a_reserved_word() {
        assert_eq!(USER, "user");
        assert!(crate::domain::ops::valid_name(USER).is_err());
    }
}
