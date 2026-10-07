//! What a write changed, said once at the write; this module fans it out to
//! everything that shows it: the org feed's records, the org room (pulses,
//! mail sparks) and the app feed (org summaries, desktop notices).
//!
//! The declarative style is galaxy-star's: there each model registers its
//! change handlers (`@on_save(Court)`) and those broadcast the object to the
//! rooms that show it. The trigger differs: galaxy-star reacts to MongoDB
//! change streams, while here the engine is the only writer and announces
//! its changes in-process. PostgreSQL's own change notification
//! (LISTEN/NOTIFY) serializes every committing notifier on one global queue
//! lock, which the engine's no-global-locks rule rules out.

use serde_json::{json, Value};

use crate::engine::Engine;
use crate::feed::Key;
use crate::orgs::OrgHandle;

#[derive(Debug, Clone)]
pub enum Change {
    EngineEvent(crate::runtime::watchdogs::events::Event),
    /// an agent's own record (status, scope, credits, state, account, freeze, halt)
    Agent(i64),
    /// an agent's mailbox (and the waiting-mail count on its card)
    Mailbox(i64),
    /// Receipt bookkeeping, without an engine-event echo of watchdog alerts.
    MailboxQuiet(i64),
    /// the user's inbox, read log or sent box
    UserMail,
    /// an agent's history (events about it)
    History(i64),
    /// the org's event log
    Events,
    /// credits moved (the cost and audit header groups)
    Credits,
    /// org settings, folders, killswitch: every record of the org
    Org,
    /// the org inbox (outside mail)
    OrgInbox,
    /// audience grants and requests
    Audiences,
    /// the tiers on offer
    Tiers,
    /// questions and requests for the user
    Asks,
    /// the docket
    Docket,
    /// watchdogs
    Watchdogs,
    /// presented documents of an agent
    Documents(i64),
    /// the mail spark on the canvas, sender → recipient
    Spark { from: String, to: String },
    /// a pulse on an agent's card (`turn_done`, `frozen`, `renamed`)
    Pulse { node: String, event: &'static str, extra: Option<Value> },
    /// the org list (create, delete, rename)
    Registry,
    /// mail hub connections and rosters (the org's `net` record)
    Net,
}

/// Fan changes out to the feed, the rooms and the app feed.
#[logged]
pub fn notify(engine: &Engine, org: &OrgHandle, changes: Vec<Change>) {
    org.docket.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut keys: Vec<Key> = Vec::with_capacity(changes.len() + 2);
    let mut app = false;
    let mut registry = false;
    for c in changes {
        crate::runtime::watchdogs::events::change(engine,org.id,&c);
        match c {
            Change::EngineEvent(e) => crate::runtime::watchdogs::events::emit(engine,e),
            Change::Agent(id) => {
                keys.push(Key::Agent(id));
                // live/frozen counts and frozen-agent notices
                app = true;
            }
            Change::Mailbox(id) | Change::MailboxQuiet(id) => {
                keys.push(Key::Mailbox(id));
                keys.push(Key::Agent(id));
            }
            Change::UserMail => {
                keys.push(Key::UserMail);
                app = true;
            }
            Change::History(id) => keys.push(Key::History(id)),
            Change::Events => keys.push(Key::Events),
            Change::Credits => {
                keys.push(Key::Group("cost"));
                keys.push(Key::Group("audit"));
                app = true;
            }
            Change::Org => {
                keys.push(Key::Org);
                app = true;
            }
            Change::OrgInbox => {
                keys.push(Key::Group("org_inbox"));
                app = true;
            }
            Change::Audiences => keys.push(Key::Audiences),
            Change::Tiers => keys.push(Key::Group("tiers")),
            Change::Asks => {
                keys.push(Key::Group("asks"));
                app = true;
            }
            Change::Docket => {
                keys.push(Key::Group("work_summary"));
                app = true;
            }
            Change::Watchdogs => keys.push(Key::Group("watchdogs")),
            Change::Documents(id) => {
                keys.push(Key::Agent(id));
                app = true;
            }
            Change::Spark { from, to } => org.emit(json!({ "type": "mail", "from": from, "to": to })),
            Change::Pulse { node, event, extra } => {
                let mut frame = json!({ "type": "node_event", "node": node, "event": event });
                if let (Some(f), Some(Value::Object(x))) = (frame.as_object_mut(), extra) {
                    for (k, v) in x {
                        f.insert(k, v);
                    }
                }
                org.emit(frame);
            }
            Change::Registry => registry = true,
            Change::Net => keys.push(Key::Group("net")),
        }
    }
    if !keys.is_empty() {
        org.invalidate(keys);
    }
    if app {
        engine.app.org_changed(org.id);
    }
    if registry {
        engine.app.registry_changed();
    }
}

/// The same, for code holding only the org's id.
#[logged]
pub fn notify_id(engine: &Engine, org_id: i64, changes: Vec<Change>) {
    if let Some(org) = engine.orgs.by_id(org_id) {
        notify(engine, &org, changes);
    }
}
