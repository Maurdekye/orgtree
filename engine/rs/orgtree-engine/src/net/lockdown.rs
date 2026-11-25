//! Org mailbox lockdown (Mail hub 2.6.0 feature `lockdown`; docket
//! org-mailbox-lockdown-allow-list-mode-that-denies; USER 2026-11-25 13:26Z
//! m0388b64a9372 "a final last-straw defense against an onslaught of attackers
//! creating dozens of new accounts", answers 13:37Z mf95eda126994, 14:08Z
//! m0bad0b3358ae, 14:10Z m16ef9bb35e25 + m405b44961ff5). While it is on, only
//! the listed outside addresses reach the org mailbox.
//!
//! - **Policy** is `ot.net_lockdown`. The user's setting is On / Off / Org
//!   decides (the default). Under Org decides the org mailbox holders (primary
//!   or weak link) turn it on and off, edit the list and the set-aside flag;
//!   under On or Off agents change nothing (On: the user edits the list).
//!   Every change, off included, raises `rev`; the holder's link, the user's
//!   setting and the expected revision are checked in the edit's transaction.
//! - **Entries** are (hub, address): an address on one of the org's hubs,
//!   following that address there (user answer 7); the same name on another
//!   hub is someone else (review B3).
//! - **Hubs** enforce it (`reconcile`, each pass; register carries it so a new
//!   registration is never open) and acknowledge the revision they hold
//!   (`ot.net_lockdown_hubs`). A hub without the `lockdown` feature can't: while
//!   the org is locked, the org's route on it is suspended (`suspended`; user
//!   answer 5), shown as `unsupported`.
//! - **The engine** admits every inbound `@net:` letter before anything else
//!   happens to it (`admit`, review B2): an unlisted sender's letter is set
//!   aside (with the flag) or dropped and counted. Local `@org:` mail is never
//!   locked out (user 13:37Z, Q3); the closed org mailbox stops it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Value};

use super::{request, Part, HTTP};
use crate::changes::{self, Change};
use crate::engine::Engine;

pub const BY_USER: &str = super::blocks::BY_USER;

/// Addresses one hub's list may hold (the hub's own cap).
pub const MAX_ALLOWED: usize = 1_000;

/// How long a hub's `/healthz` word on `lockdown` is kept.
const FEATURE_TTL: Duration = Duration::from_secs(600);

/// The user's lockdown setting (USER 2026-11-25 14:10:49Z m405b44961ff5: "on, off, and org decides").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserMode {
    Org,
    On,
    Off,
}

impl UserMode {
    #[nolog]
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "org" | "org decides" | "org_decides" => Some(Self::Org),
            "on" => Some(Self::On),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
    #[nolog]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Org => "org",
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

/// Is the lockdown in force?
#[nolog]
pub fn effective(user: UserMode, org_on: bool) -> bool {
    match user {
        UserMode::On => true,
        UserMode::Off => false,
        UserMode::Org => org_on,
    }
}

/// May an agent change anything? Only under Org decides.
#[nolog]
pub fn agent_may_change(user: UserMode) -> bool {
    user == UserMode::Org
}

/// Who makes a change.
#[derive(Clone, Copy, Debug)]
pub enum Who<'a> {
    User,
    /// an agent by name: it must hold the org mailbox (primary or weak link)
    Agent(&'a str),
}

impl Who<'_> {
    #[nolog]
    fn label(&self) -> String {
        match self {
            Who::User => BY_USER.into(),
            Who::Agent(n) => (*n).into(),
        }
    }
}

/// One allow entry: an address on one of the org's hubs (its hub id).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Entry {
    pub hub: String,
    pub address: String,
}

/// A change. Fields left out stay as they are.
#[derive(Clone, Debug, Default)]
pub struct Edit {
    /// the user's setting (the user only)
    pub user_mode: Option<UserMode>,
    /// on/off under Org decides
    pub on: Option<bool>,
    /// replace the whole list
    pub allow: Option<Vec<Entry>>,
    pub add: Vec<Entry>,
    pub remove: Vec<Entry>,
    /// set unlisted mail aside to read one at a time, rather than drop it
    pub set_aside: Option<bool>,
    /// refuse unless the policy is still at this revision
    pub expect_rev: Option<i64>,
}

impl Edit {
    #[nolog]
    fn is_empty(&self) -> bool {
        self.user_mode.is_none() && self.on.is_none() && self.allow.is_none() && self.add.is_empty() && self.remove.is_empty() && self.set_aside.is_none()
    }
}

/// What the engine does with an inbound `@net:` letter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Deliver,
    /// unlisted, flag off: not delivered, counted
    Drop,
    /// unlisted, flag on: kept out of delivery, to be read one at a time
    SetAside,
}

/// The address a tool or the app names, bare; None when it is not one.
#[nolog]
pub(super) fn bare_address(address: &str) -> Option<String> {
    super::blocks::bare_address(address)
}

/// A hub's `/healthz` answer lists the `lockdown` feature. Only the feature
/// counts: a 2.6.0 hub built before lockdown has none.
#[nolog]
pub(super) fn lists_lockdown(health: &Value) -> bool {
    health["features"].as_array().is_some_and(|f| f.iter().any(|x| x == "lockdown"))
}

/// Does the hub at `addr` keep lockdowns? Its `/healthz`, cached
/// `FEATURE_TTL`; an unreachable hub keeps the last word, else no.
#[logged]
pub(super) async fn supports(engine: &Engine, addr: &str) -> bool {
    let cached = engine.net.lockdown_feature.pin().get(addr).copied();
    if let Some((yes, at)) = cached {
        if at.elapsed() < FEATURE_TTL {
            return yes;
        }
    }
    match super::transport::healthz(addr, Duration::from_secs(5)).await {
        Some(health) => {
            let yes = lists_lockdown(&health);
            engine.net.lockdown_feature.pin().insert(addr.to_string(), (yes, Instant::now()));
            yes
        }
        None => cached.is_some_and(|c| c.0),
    }
}

/// The policy row as read.
#[derive(Clone, Debug)]
struct Row {
    user: UserMode,
    org_on: bool,
    set_aside: bool,
    rev: i64,
}

#[nolog]
fn row_of(r: &tokio_postgres::Row) -> Row {
    Row { user: UserMode::parse(r.get::<_, &str>(0)).unwrap_or(UserMode::Org), org_on: r.get(1), set_aside: r.get(2), rev: r.get(3) }
}

/// The orgs in lockdown now (for `participants`).
#[logged]
pub(super) async fn locked_orgs<C: tokio_postgres::GenericClient + Sync>(c: &C) -> Result<BTreeSet<i64>> {
    Ok(c.query("SELECT org_id FROM ot.net_lockdown WHERE user_mode = 'on' OR (user_mode = 'org' AND org_on)", &[])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

/// Is the org's route on the hub at `addr` suspended? Only while the org is
/// locked and the hub can't enforce it (user 2026-11-25 14:08Z, answer 5).
#[logged]
pub(super) async fn suspended(engine: &Engine, locked: bool, addr: &str) -> bool {
    locked && !supports(engine, addr).await
}

/// What to do with an inbound `@net:` letter from `from`, received on the
/// org's hub `hub` (review B2: before staging, phone setup, publication or any
/// wake; asked again when staged mail is published). A dropped letter is
/// counted here.
#[logged]
pub async fn admit<C: tokio_postgres::GenericClient + Sync>(c: &C, org_id: i64, hub: &str, from: &str) -> Result<Admission> {
    let from = from.trim().trim_start_matches("@net:");
    let row = c
        .query_opt(
            "SELECT l.user_mode, l.org_on, l.set_aside, l.rev,
                    EXISTS (SELECT 1 FROM ot.net_lockdown_allow a WHERE a.org_id = l.org_id AND a.hub = $2 AND a.address = $3)
               FROM ot.net_lockdown l WHERE l.org_id = $1",
            &[&org_id, &hub, &from],
        )
        .await?;
    let Some(r) = row else { return Ok(Admission::Deliver) };
    let p = row_of(&r);
    if !effective(p.user, p.org_on) || r.get::<_, bool>(4) {
        return Ok(Admission::Deliver);
    }
    if p.set_aside {
        return Ok(Admission::SetAside);
    }
    c.execute("UPDATE ot.net_lockdown SET refused = refused + 1 WHERE org_id = $1", &[&org_id]).await?;
    Ok(Admission::Drop)
}

/// The org's hubs from its settings: (id, address as configured).
#[logged]
async fn org_hubs<C: tokio_postgres::GenericClient + Sync>(c: &C, org_id: i64) -> Result<Vec<(String, String)>> {
    let net: Value = c.query_one("SELECT net FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    Ok(net["hubs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|h| Some((h["id"].as_str()?.to_string(), h["address"].as_str().unwrap_or("").trim_end_matches('/').to_string())))
        .collect())
}

/// The entries an address names: on `hub` when given (an id, an address or a
/// hub's name), else on every hub of the org whose roster lists it, else on
/// the org's only hub. Several hubs and no roster word: the caller must name
/// the hub (review B3: never the same name on every hub blindly).
#[logged]
pub async fn entries(engine: &Engine, org_id: i64, address: &str, hub: Option<&str>) -> Result<Vec<Entry>> {
    let Some(address) = bare_address(address) else {
        crate::refuse!(BadRequest, "address must be a mail hub address (@net:<address>)");
    };
    let hubs = org_hubs(&**engine.db.get().await?, org_id).await?;
    if hubs.is_empty() {
        crate::refuse!(BadRequest, "the org is on no mail hub");
    }
    let names = engine.net.names.pin();
    let name_of = |a: &str| names.get(a).cloned();
    if let Some(h) = hub.map(str::trim).filter(|h| !h.is_empty()) {
        let h = h.trim_end_matches('/');
        let Some((id, _)) = hubs.iter().find(|(id, a)| id == h || a == h || name_of(a).as_deref() == Some(h)) else {
            crate::refuse!(BadRequest, "hub {h} is not one of the org's mail hubs");
        };
        return Ok(vec![Entry { hub: id.clone(), address }]);
    }
    let rosters = engine.net.rosters.pin();
    let seen: Vec<Entry> = hubs
        .iter()
        .filter(|(_, a)| rosters.get(a.as_str()).is_some_and(|r| r.iter().any(|x| x["slug"].as_str() == Some(address.as_str()))))
        .map(|(id, _)| Entry { hub: id.clone(), address: address.clone() })
        .collect();
    if !seen.is_empty() {
        return Ok(seen);
    }
    if hubs.len() == 1 {
        return Ok(vec![Entry { hub: hubs[0].0.clone(), address }]);
    }
    crate::refuse!(BadRequest, "@net:{address} is on none of the org's hub rosters; name the hub it is on (hub=<id or address>)")
}

/// Change the policy (the caller resolved entries with `entries`). Returns
/// the status.
#[logged]
pub async fn change(engine: &Arc<Engine>, org_id: i64, who: Who<'_>, edit: Edit) -> Result<Value> {
    if edit.is_empty() {
        crate::refuse!(BadRequest, "nothing to change");
    }
    let by = who.label();
    let mut conn = engine.db.get().await?;
    let tx = conn.transaction().await?;
    tx.execute("INSERT INTO ot.net_lockdown (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING", &[&org_id]).await?;
    let was = row_of(&tx.query_one("SELECT user_mode, org_on, set_aside, rev FROM ot.net_lockdown WHERE org_id = $1 FOR UPDATE", &[&org_id]).await?);
    if let Some(expect) = edit.expect_rev {
        if expect != was.rev {
            crate::refuse!(Conflict, "the lockdown changed meanwhile (now rev {}); read it again", was.rev);
        }
    }
    if let Who::Agent(name) = who {
        if crate::domain::orginbox::mailbox_link(&*tx, org_id, name).await?.is_none() {
            crate::refuse!(Forbidden, "only an agent holding the org mailbox (primary or weak link) may change the lockdown; ask the holder or @user");
        }
        if edit.user_mode.is_some() {
            crate::refuse!(Forbidden, "only the user changes the lockdown setting (On / Off / Org decides)");
        }
        if !agent_may_change(was.user) {
            crate::refuse!(Forbidden, "the user set the lockdown {}; only the user can change it", if was.user == UserMode::On { "on" } else { "off" });
        }
    }
    let user = edit.user_mode.unwrap_or(was.user);
    let org_on = edit.on.unwrap_or(was.org_on);
    let set_aside = edit.set_aside.unwrap_or(was.set_aside);
    if let Some(list) = &edit.allow {
        tx.execute("DELETE FROM ot.net_lockdown_allow WHERE org_id = $1", &[&org_id]).await?;
        add(&tx, org_id, list, &by).await?;
    }
    add(&tx, org_id, &edit.add, &by).await?;
    for e in &edit.remove {
        tx.execute("DELETE FROM ot.net_lockdown_allow WHERE org_id = $1 AND hub = $2 AND address = $3", &[&org_id, &e.hub, &e.address]).await?;
    }
    let over: Option<String> = tx
        .query_opt("SELECT hub FROM ot.net_lockdown_allow WHERE org_id = $1 GROUP BY hub HAVING count(*) > $2 LIMIT 1", &[&org_id, &(MAX_ALLOWED as i64)])
        .await?
        .map(|r| r.get(0));
    if let Some(h) = over {
        crate::refuse!(BadRequest, "a lockdown may list at most {MAX_ALLOWED} addresses per hub (hub {h})");
    }
    let rev = tx
        .query_one(
            "UPDATE ot.net_lockdown SET user_mode = $2, org_on = $3, set_aside = $4, set_by = $5, set_at = now(), rev = rev + 1
              WHERE org_id = $1 RETURNING rev",
            &[&org_id, &user.as_str(), &org_on, &set_aside, &by],
        )
        .await?
        .get::<_, i64>(0);
    tx.execute("UPDATE ot.net_lockdown_hubs SET state = 'pending', detail = NULL, at = now() WHERE org_id = $1 AND state <> 'unsupported'", &[&org_id]).await?;
    let (on_before, on_now) = (effective(was.user, was.org_on), effective(user, org_on));
    // Q5 cutover: set-aside starts now, for what waits as well as what arrives
    let moved = if on_now && set_aside && !(on_before && was.set_aside) { cutover(&tx, org_id).await? } else { Cutover::default() };
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, detail, via) VALUES ($1, 'lockdown', $2, $3, $4)",
        &[&org_id, &by, &json!({ "rev": rev, "setting": user.as_str(), "on": on_now, "set_aside": set_aside }), &crate::caller::via()],
    )
    .await?;
    tx.commit().await?;
    drop(conn);
    if let Some(o) = engine.orgs.by_id(org_id) {
        changes::notify(engine, &o, vec![Change::OrgInbox, Change::Net, Change::Org]);
    }
    super::kick(engine);
    if moved.copies > 0 || moved.jobs > 0 {
        changes::notify_id(engine, org_id, moved.agents.iter().map(|a| Change::Mailbox(*a)).collect());
    }
    let mut status = status(engine, org_id).await?;
    if moved.letters > 0 || moved.copies > 0 || moved.jobs > 0 {
        status["set_aside_now"] = json!({ "letters": moved.letters, "unread_copies": moved.copies, "unclaimed_jobs": moved.jobs });
    }
    let policy_changed = on_before != on_now || user != was.user || set_aside != was.set_aside;
    if policy_changed || on_now {
        notice(engine, org_id, &by, &status, policy_changed).await;
    }
    Ok(status)
}

/// What the cutover took out of delivery.
#[derive(Debug, Default)]
struct Cutover {
    letters: i64,
    copies: i64,
    jobs: i64,
    agents: Vec<i64>,
}

/// Set-aside begins (USER 2026-11-25 13:37Z Q5 "unqueues all mail queued from unlisted addresses before and after
/// the lockdown"; 14:08Z answer 2: unread copies already delivered to agents too). In the policy's own
/// transaction: every inbound letter from an unlisted `@net:` sender that nobody has read or claimed is set aside
/// (waiting, held by Do not disturb, or delivered but unread), its pending agent copies and unclaimed project jobs
/// are retracted. A letter one recipient already read or a job a worker claimed stays where it is.
#[logged]
async fn cutover(tx: &tokio_postgres::Transaction<'_>, org_id: i64) -> Result<Cutover> {
    let unlisted = "i.org_id = $1 AND i.dir = 'in' AND i.set_aside_at IS NULL AND i.peer LIKE '@net:%' AND NOT i.read AND i.pulled_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM ot.net_lockdown_allow a WHERE a.org_id = i.org_id AND a.hub = i.hub AND '@net:' || a.address = i.peer)";
    let taken = "EXISTS (SELECT 1 FROM ot.mail m WHERE m.org_id = i.org_id AND m.sender = i.peer AND m.state IN ('delivering', 'delivered', 'read')
        AND ((m.net_id = i.net_id AND m.net_hub IS NOT DISTINCT FROM i.hub) OR m.extra->'org_inbox'->>'uid' = i.uid))";
    let rows = tx
        .query(&format!("SELECT i.uid, i.net_id, i.hub, i.peer FROM ot.org_inbox i WHERE {unlisted} AND NOT {taken} ORDER BY i.id FOR UPDATE"), &[&org_id])
        .await?;
    let mut out = Cutover::default();
    for r in &rows {
        let (uid, net_id, hub, peer): (String, Option<String>, Option<String>, String) = (r.get(0), r.get(1), r.get(2), r.get(3));
        let copies = tx
            .query(
                "UPDATE ot.mail SET state = 'retracted' WHERE org_id = $1 AND recipient_kind = 'agent' AND state = 'pending' AND sender = $2
                   AND net_id = $3 AND net_hub IS NOT DISTINCT FROM $4 RETURNING recipient_agent_id",
                &[&org_id, &peer, &net_id, &hub],
            )
            .await?;
        let jobs = tx
            .query(
                "UPDATE ot.mail SET state = 'retracted' WHERE org_id = $1 AND state = 'pending' AND extra->'org_inbox'->>'uid' = $2 RETURNING recipient_agent_id",
                &[&org_id, &uid],
            )
            .await?;
        tx.execute("UPDATE ot.org_inbox SET set_aside_at = now(), dnd_held = false WHERE org_id = $1 AND uid = $2", &[&org_id, &uid]).await?;
        out.letters += 1;
        out.copies += copies.len() as i64;
        out.jobs += jobs.len() as i64;
        out.agents.extend(copies.iter().chain(jobs.iter()).filter_map(|r| r.get::<_, Option<i64>>(0)));
    }
    out.agents.sort_unstable();
    out.agents.dedup();
    Ok(out)
}

/// May `agent` read set-aside mail, and which (USER 2026-11-25 14:08Z answer 8: "set-aside readers are the user and
/// real holders, weak/acting links only their own mail")? None: not at all; Some(None): all; Some(Some(name)): only
/// letters answering mail that agent sent.
#[logged]
async fn reader<C: tokio_postgres::GenericClient + Sync>(c: &C, org_id: i64, agent: &str) -> Result<Option<Option<String>>> {
    Ok(match crate::domain::orginbox::mailbox_link(c, org_id, agent).await? {
        Some("primary") => Some(None),
        Some(_) => Some(Some(agent.to_string())),
        None => None,
    })
}

/// The SQL that limits set-aside rows to a weak link's own: replies to mail it sent.
const OWN: &str = "($3::text IS NULL OR EXISTS (SELECT 1 FROM ot.org_inbox o WHERE o.org_id = i.org_id AND o.dir = 'out' AND o.by_name = $3
    AND o.net_id = i.set_aside_meta->>'reply_to'))";

/// Set-aside letters, newest first, as envelopes only (no bodies): a page, and the senders with the most.
/// `who`: None is the user.
#[logged]
pub async fn set_aside_list(engine: &Engine, org_id: i64, who: Option<&str>, limit: i64, before: Option<&str>) -> Result<Value> {
    let c = engine.db.get().await?;
    let own: Option<String> = match who {
        None => None,
        Some(a) => match reader(&**c, org_id, a).await? {
            Some(o) => o,
            None => crate::refuse!(Forbidden, "only the user and agents holding the org mailbox read set-aside mail"),
        },
    };
    let limit = limit.clamp(1, 100);
    let before_id: i64 = match before {
        Some(u) => c.query_opt("SELECT id FROM ot.org_inbox WHERE org_id = $1 AND uid = $2", &[&org_id, &u]).await?.map_or(i64::MAX, |r| r.get(0)),
        None => i64::MAX,
    };
    let rows = c
        .query(
            &format!("SELECT i.uid, i.peer, i.hub, i.at, length(i.body), i.set_aside_read_by, i.set_aside_meta->'files' FROM ot.org_inbox i
               WHERE i.org_id = $1 AND i.set_aside_at IS NOT NULL AND i.id < $2 AND {OWN} ORDER BY i.id DESC LIMIT $4"),
            &[&org_id, &before_id, &own, &(limit + 1)],
        )
        .await?;
    let more = rows.len() as i64 > limit;
    let items: Vec<Value> = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            let at: chrono::DateTime<chrono::Utc> = r.get(3);
            json!({ "id": r.get::<_, String>(0), "from": r.get::<_, String>(1), "hub": r.get::<_, Option<String>>(2), "at": at.to_rfc3339(),
                    "chars": r.get::<_, i32>(4), "read_by": r.get::<_, Option<String>>(5), "files": r.get::<_, Option<Value>>(6) })
        })
        .collect();
    let totals = c
        .query_one(
            &format!("SELECT count(*), count(*) FILTER (WHERE i.set_aside_read_by IS NULL) FROM ot.org_inbox i
               WHERE i.org_id = $1 AND i.set_aside_at IS NOT NULL AND $2::bigint IS NOT NULL AND {OWN}"),
            &[&org_id, &0i64, &own],
        )
        .await?;
    let senders: Vec<Value> = c
        .query(
            &format!("SELECT i.peer, count(*) FROM ot.org_inbox i WHERE i.org_id = $1 AND i.set_aside_at IS NOT NULL AND $2::bigint IS NOT NULL AND {OWN}
               GROUP BY i.peer ORDER BY count(*) DESC, i.peer LIMIT 20"),
            &[&org_id, &0i64, &own],
        )
        .await?
        .iter()
        .map(|r| json!({ "from": r.get::<_, String>(0), "letters": r.get::<_, i64>(1) }))
        .collect();
    Ok(json!({
        "set_aside": items, "total": totals.get::<_, i64>(0), "unread": totals.get::<_, i64>(1), "top_senders": senders,
        "next_before": if more { items.last().map(|i| i["id"].clone()) } else { None },
    }))
}

/// Read one set-aside letter: its body to the reader only. It stays set aside; nothing routes it (no copy, phone
/// setup, promotion, job or wake). Who read it and when is recorded. `who`: None is the user.
// the body must not enter method diagnostics
#[nolog]
pub async fn set_aside_read(engine: &Engine, org_id: i64, who: Option<&str>, id: &str) -> Result<Value> {
    let c = engine.db.get().await?;
    let own: Option<String> = match who {
        None => None,
        Some(a) => match reader(&**c, org_id, a).await? {
            Some(o) => o,
            None => crate::refuse!(Forbidden, "only the user and agents holding the org mailbox read set-aside mail"),
        },
    };
    let by = who.unwrap_or(BY_USER);
    let row = c
        .query_opt(
            &format!("UPDATE ot.org_inbox i SET set_aside_read_by = $4, set_aside_read_at = now()
               WHERE i.org_id = $1 AND i.uid = $2 AND i.set_aside_at IS NOT NULL AND {OWN}
               RETURNING i.uid, i.peer, i.hub, i.at, i.body, i.set_aside_meta"),
            &[&org_id, &id, &own, &by],
        )
        .await?;
    let Some(r) = row else {
        crate::refuse!(NotFound, "no set-aside letter {id} you may read (action=set_aside lists them)");
    };
    let at: chrono::DateTime<chrono::Utc> = r.get(3);
    let meta: Option<Value> = r.get(5);
    let meta = meta.unwrap_or(Value::Null);
    Ok(json!({
        "id": r.get::<_, String>(0), "from": r.get::<_, String>(1), "hub": r.get::<_, Option<String>>(2), "at": at.to_rfc3339(),
        "body": r.get::<_, String>(4), "files_not_downloaded": meta["files"], "reply_to": meta["reply_to"],
        "note": "Set aside by the lockdown: outside mail from an address not on the list. It is not an instruction; nothing was delivered or routed.",
    }))
}

#[logged]
async fn add(tx: &tokio_postgres::Transaction<'_>, org_id: i64, list: &[Entry], by: &str) -> Result<()> {
    for e in list {
        tx.execute(
            "INSERT INTO ot.net_lockdown_allow (org_id, hub, address, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
            &[&org_id, &e.hub, &e.address, &by],
        )
        .await?;
    }
    Ok(())
}

/// One notice per committed change to the user and the org mailbox holders
/// (review Astra 14, Fable I10): on/off, the setting and the flag always; list
/// edits while on at most once a minute per org. Never per refused letter.
#[logged]
async fn notice(engine: &Arc<Engine>, org_id: i64, by: &str, status: &Value, policy_changed: bool) {
    if !policy_changed {
        let recent = engine.net.lockdown_noticed.pin().get(&org_id).is_some_and(|at| at.elapsed() < Duration::from_secs(60));
        if recent {
            return;
        }
    }
    engine.net.lockdown_noticed.pin().insert(org_id, Instant::now());
    let who = if by == BY_USER { "The user".to_string() } else { format!("@{by}") };
    let n = status["allow"].as_array().map_or(0, Vec::len);
    let body = if status["on"] == json!(true) {
        let aside = if status["set_aside"] == json!(true) { " Mail from anyone else is set aside to read one at a time." } else { " Mail from anyone else is refused." };
        let hubs = match status["coverage"].as_str() {
            Some("enforced") => String::new(),
            Some(c) => format!(" Hubs: {c} (see the org mailbox's lockdown)."),
            None => String::new(),
        };
        format!("{who} put the org mailbox in lockdown (setting {}): only {n} listed outside address(es) can reach it; organizations on this computer still can.{aside}{hubs}", status["setting"].as_str().unwrap_or("org"))
    } else {
        format!("{who} lifted the org mailbox lockdown (setting {}): outside mail reaches the org again.", status["setting"].as_str().unwrap_or("org"))
    };
    if let Err(e) = super::blocks::tell(engine, org_id, None, &body, json!({ "lockdown": status["rev"], "on": status["on"] })).await {
        tracing::warn!(error = %format!("{e:#}"), "could not tell the org about its lockdown");
    }
}

/// The policy as the tool and the app show it.
#[logged]
pub async fn status(engine: &Engine, org_id: i64) -> Result<Value> {
    let c = engine.db.get().await?;
    let row = c
        .query_opt("SELECT user_mode, org_on, set_aside, rev, set_by, set_at, refused FROM ot.net_lockdown WHERE org_id = $1", &[&org_id])
        .await?;
    let Some(r) = row else {
        return Ok(json!({ "setting": "org", "on": false, "org_on": false, "set_aside": false, "rev": 0, "allow": [], "hubs": [], "coverage": "off", "refused": 0 }));
    };
    let p = row_of(&r);
    let on = effective(p.user, p.org_on);
    let hubs_cfg = org_hubs(&**c, org_id).await?;
    // hub id -> the name its hub gave itself (no map guard is held across an await)
    let named: BTreeMap<String, String> = {
        let names = engine.net.names.pin();
        hubs_cfg.iter().filter_map(|(id, a)| names.get(a.as_str()).map(|n| (id.clone(), n.clone()))).collect()
    };
    let hub_name = |id: &str| named.get(id).cloned().unwrap_or_else(|| id.to_string());
    let allow: Vec<Value> = c
        .query("SELECT hub, address, added_by, at FROM ot.net_lockdown_allow WHERE org_id = $1 ORDER BY address, hub", &[&org_id])
        .await?
        .iter()
        .map(|r| {
            let at: chrono::DateTime<chrono::Utc> = r.get(3);
            let hub: String = r.get(0);
            json!({ "hub": hub, "hub_name": hub_name(&hub), "address": r.get::<_, String>(1), "added_by": r.get::<_, String>(2), "at": at.to_rfc3339() })
        })
        .collect();
    let acks: BTreeMap<String, (Option<i64>, String, Option<String>)> = c
        .query("SELECT hub, rev, state, detail FROM ot.net_lockdown_hubs WHERE org_id = $1", &[&org_id])
        .await?
        .iter()
        .map(|r| (r.get(0), (r.get(1), r.get(2), r.get(3))))
        .collect();
    let hubs: Vec<Value> = hubs_cfg
        .iter()
        .map(|(id, _)| {
            let (rev, state, detail) = acks.get(id).cloned().unwrap_or((None, "pending".into(), None));
            let state = if state == "enforced" && rev != Some(p.rev) { "pending".to_string() } else { state };
            json!({ "hub": id, "hub_name": hub_name(id), "state": state, "rev": rev, "detail": detail })
        })
        .collect();
    let states: BTreeSet<&str> = hubs.iter().filter_map(|h| h["state"].as_str()).collect();
    let coverage = if hubs.is_empty() {
        "no hubs"
    } else if states.len() == 1 && states.contains("enforced") {
        "enforced"
    } else if states.contains("enforced") {
        "partial"
    } else {
        "pending"
    };
    let at: Option<chrono::DateTime<chrono::Utc>> = r.get(5);
    Ok(json!({
        "setting": p.user.as_str(), "on": on, "org_on": p.org_on, "set_aside": p.set_aside, "rev": p.rev,
        "set_by": r.get::<_, Option<String>>(4), "set_at": at.map(|t| t.to_rfc3339()), "refused": r.get::<_, i64>(6),
        "agents_may_change": agent_may_change(p.user),
        "allow": allow, "hubs": hubs, "coverage": if on { coverage } else { "off" },
    }))
}

/// What register carries for the org on hub `hub` (None: no lockdown row).
#[logged]
pub(super) async fn for_hub(engine: &Engine, org_id: i64, hub: &str) -> Result<Option<Value>> {
    let c = engine.db.get().await?;
    let Some(r) = c.query_opt("SELECT user_mode, org_on, set_aside, rev FROM ot.net_lockdown WHERE org_id = $1", &[&org_id]).await? else {
        return Ok(None);
    };
    let p = row_of(&r);
    let on = effective(p.user, p.org_on);
    let allow: Vec<String> = if on {
        c.query("SELECT address FROM ot.net_lockdown_allow WHERE org_id = $1 AND hub = $2 ORDER BY address", &[&org_id, &hub])
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect()
    } else {
        vec![]
    };
    Ok(Some(json!({ "on": on, "allow": allow, "rev": p.rev })))
}

/// A hub's answer to a lockdown change (or register's `lockdown`): the
/// revision it holds now.
#[logged]
pub(super) async fn acked(engine: &Engine, org_id: i64, hub: &str, rev: Option<i64>, state: &str, detail: Option<&str>) -> Result<()> {
    engine
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO ot.net_lockdown_hubs (org_id, hub, rev, state, detail) SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM ot.net_lockdown WHERE org_id = $1)
             ON CONFLICT (org_id, hub) DO UPDATE SET rev = EXCLUDED.rev, state = EXCLUDED.state, detail = EXCLUDED.detail, at = now()",
            &[&org_id, &hub, &rev, &state, &detail],
        )
        .await?;
    Ok(())
}

/// Make each registered hub hold the org's policy at its revision (each
/// pass). A hub without `lockdown` is marked `unsupported` (its route is
/// suspended while locked). A 409 means the hub holds a newer revision (a
/// restored database): the policy's revision moves past it, sent next pass.
#[logged]
pub(super) async fn reconcile(engine: &Arc<Engine>, parts: &[Part]) {
    let Ok(c) = engine.db.get().await else { return };
    let Ok(rows) = c.query("SELECT org_id, rev FROM ot.net_lockdown", &[]).await else { return };
    let revs: BTreeMap<i64, i64> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    let acks: BTreeMap<(i64, String), (Option<i64>, String)> = match c.query("SELECT org_id, hub, rev, state FROM ot.net_lockdown_hubs", &[]).await {
        Ok(rows) => rows.iter().map(|r| ((r.get(0), r.get(1)), (r.get(2), r.get(3)))).collect(),
        Err(_) => return,
    };
    drop(c);
    for p in parts {
        let Some(rev) = revs.get(&p.org_id).copied() else { continue };
        for (hid, addr) in &p.hubs {
            if !p.registered.contains(hid) {
                continue;
            }
            let ack = acks.get(&(p.org_id, hid.clone()));
            if ack.is_some_and(|(r, s)| *r == Some(rev) && s == "enforced") {
                continue;
            }
            if !supports(engine, addr).await {
                if ack.is_none_or(|(_, s)| s != "unsupported") {
                    let _ = acked(engine, p.org_id, hid, None, "unsupported", Some("this mail hub can't enforce a lockdown (needs mail hub 2.6.0 with lockdown)")).await;
                    notify(engine, p.org_id);
                }
                continue;
            }
            let Ok(Some(mut body)) = for_hub(engine, p.org_id, hid).await else { continue };
            body["slug"] = json!(p.net_slug);
            let res = request(
                engine,
                &[p.org_id],
                HTTP.post(format!("{addr}/api/lockdown")).timeout(Duration::from_secs(10)).header("X-Org-Auth", p.auth()).json(&body),
            )
            .await;
            match res {
                Ok(r) if r.status().is_success() => {
                    let held = r.json::<Value>().await.ok().and_then(|v| v["rev"].as_i64());
                    let _ = acked(engine, p.org_id, hid, held.or(Some(rev)), "enforced", None).await;
                    notify(engine, p.org_id);
                }
                Ok(r) if r.status().as_u16() == 409 => {
                    let theirs = r.json::<Value>().await.ok().and_then(|v| v["rev"].as_i64()).unwrap_or(rev);
                    if let Ok(c) = engine.db.get().await {
                        let _ = c.execute("UPDATE ot.net_lockdown SET rev = GREATEST(rev, $2 + 1) WHERE org_id = $1", &[&p.org_id, &theirs]).await;
                    }
                    super::kick(engine);
                }
                Ok(r) if r.status().is_client_error() && r.status().as_u16() != 401 => {
                    let code = r.status().as_u16();
                    let detail = r.json::<Value>().await.ok().and_then(|v| v["detail"].as_str().map(str::to_string)).unwrap_or_else(|| format!("HTTP {code}"));
                    let _ = acked(engine, p.org_id, hid, None, "failed", Some(&detail)).await;
                    notify(engine, p.org_id);
                }
                _ => {}
            }
        }
    }
}

/// RED STUBS (E3)
#[nolog]
pub(super) fn locked_view(_data: &Value, _slug: &str) -> BTreeMap<String, String> { BTreeMap::new() }
#[logged]
pub async fn summary<C: tokio_postgres::GenericClient + Sync>(_c: &C, _org_id: i64) -> Result<Value> { Ok(json!({})) }

#[nolog]
fn notify(engine: &Arc<Engine>, org_id: i64) {
    if let Some(o) = engine.orgs.by_id(org_id) {
        changes::notify(engine, &o, vec![Change::OrgInbox, Change::Net]);
    }
}
