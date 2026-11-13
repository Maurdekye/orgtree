//! Where the door stands, and when
//! (docs/rust-engine/remote-org.md, "Where the door listens").
//!
//! The door exists only while at least one organization is shared. It is
//! bound to this computer's Tailscale address and, by the owner's choice, to
//! its address on the private network. It is never bound to a public address,
//! to every address (`0.0.0.0`) or, outside the test rig, to loopback:
//! `plan` is the one place that decides, and it takes an address only for what
//! `remote::address::classify` says it is.
//!
//! What the owner changes (a switch, the port, the private-network choice)
//! takes effect at once. An address that moved by itself (Tailscale signed
//! out, another Wi-Fi) is followed only when two readings in a row agree, as
//! the phone door does (`phone::reconcile_door`), so one odd reading never
//! closes a door that people are working through.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::door::{self, PeerRule};
use super::text;
use crate::engine::Engine;
use crate::remote::address::{classify, Net};

/// How often this computer's addresses are read while something is shared.
const CHECK: Duration = Duration::from_secs(30);
/// How soon a changed address is read again, to confirm it.
const CONFIRM: Duration = Duration::from_secs(5);
/// How often who is connected is looked at while the door stands.
const PRESENCE: Duration = Duration::from_secs(5);
/// How often the registry is tidied while nothing is shared.
const IDLE: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Tailscale,
    Lan,
    /// This computer itself: the test rig and unit tests only (`PeerRule::with_loopback`).
    Rig,
}

#[nolog]
impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Tailscale => "tailscale",
            Kind::Lan => "lan",
            Kind::Rig => "rig",
        }
    }
}

/// One address the door should be bound to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Want {
    pub kind: Kind,
    pub at: SocketAddr,
}

/// This computer's addresses, as read at one moment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reading {
    /// Tailscale's IPv4 address of this computer. The outer `None`: Tailscale did not answer,
    /// so nothing is known and nothing about that address is changed.
    pub tailscale: Option<Option<Ipv4Addr>>,
    /// This computer's MagicDNS name, for the address the owner hands on.
    pub dns: Option<String>,
    /// This computer's address on its local network.
    pub lan: Option<Ipv4Addr>,
    /// Rig and tests only: this computer itself, bound instead of all of the above.
    pub rig: Option<IpAddr>,
}

/// Where the door should listen. This is the whole rule:
///
/// - nothing while no organization is shared;
/// - the Tailscale address, when it is one of Tailscale's;
/// - the private-network address too, when the owner chose that and it is a private one;
/// - nothing else, ever: no public address, no loopback, no `0.0.0.0`.
#[nolog]
pub fn plan(open: bool, lan: bool, port: u16, tailscale: Option<Ipv4Addr>, lan_ip: Option<Ipv4Addr>) -> Vec<Want> {
    let mut wants = Vec::new();
    if !open || port < 1024 {
        return wants;
    }
    if let Some(ip) = tailscale.filter(|ip| classify(IpAddr::V4(*ip)) == Net::Tailscale) {
        wants.push(Want { kind: Kind::Tailscale, at: SocketAddr::new(IpAddr::V4(ip), port) });
    }
    if lan {
        if let Some(ip) = lan_ip.filter(|ip| classify(IpAddr::V4(*ip)) == Net::Private) {
            wants.push(Want { kind: Kind::Lan, at: SocketAddr::new(IpAddr::V4(ip), port) });
        }
    }
    wants
}

/// What the owner decided, as far as the door's place goes: a change of any of it is the
/// owner's own doing and takes effect at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Owner {
    pub open: bool,
    pub lan: bool,
    pub port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// The door stands where it should.
    Keep,
    /// The addresses moved by themselves: read once more before following them.
    Confirm,
    /// Bind and close until the door stands at `want`.
    Apply,
}

/// What to do with a new plan. `applied` is what the owner had decided when the door was last
/// put in place, `pending` the plan a reading before this one asked to confirm.
#[nolog]
pub fn decide(applied: Owner, owner: Owner, standing: &[Want], want: &[Want], pending: Option<&[Want]>) -> Decision {
    let same = |a: &[Want], b: &[Want]| a.len() == b.len() && a.iter().all(|w| b.contains(w));
    if same(standing, want) {
        Decision::Keep
    } else if applied != owner || pending.is_some_and(|pending| same(pending, want)) {
        Decision::Apply
    } else {
        Decision::Confirm
    }
}

struct Bound {
    want: Want,
    stop: CancellationToken,
}

#[derive(Default)]
struct State {
    bound: Vec<Bound>,
    /// An address the door could not be bound to, and why (the port is taken).
    failed: Vec<(Want, String)>,
    applied: Owner,
    pending: Option<Vec<Want>>,
    reading: Reading,
    /// Who was connected when it was last looked at (computer ids).
    connected: Vec<String>,
}

/// The door's place and what is known about it.
#[derive(Default)]
pub struct Doors {
    /// One step at a time: the loop and the owner's routes both take it.
    step: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    /// Rig and tests only: the reading to go by instead of asking the computer.
    fixed: Mutex<Option<Reading>>,
    /// Wakes the loop out of its wait (`wake`, `rest`).
    woken: tokio::sync::Notify,
}

#[nolog]
impl Doors {
    /// Rig and tests only: go by this reading instead of asking the computer.
    #[cfg(any(test, debug_assertions))]
    pub fn fix(&self, reading: Reading) {
        if let Ok(mut fixed) = self.fixed.lock() {
            *fixed = Some(reading);
        }
    }

    /// The addresses the door stands at now.
    pub fn standing(&self) -> Vec<Want> {
        self.state.lock().map(|state| state.bound.iter().map(|bound| bound.want).collect()).unwrap_or_default()
    }

    fn fixed(&self) -> Option<Reading> {
        self.fixed.lock().ok().and_then(|fixed| fixed.clone())
    }

    /// The owner changed something: the loop looks again from now. While nothing is shared it
    /// rests a minute at a time, and a switch that has just gone on must not wait that minute
    /// out before anybody looks at who is connected. A wake that finds the loop busy is kept
    /// for its next rest.
    pub fn wake(&self) {
        self.woken.notify_one();
    }
}

/// The loop's rest between two looks: `wait` long, or until an owner's change wakes it. False
/// when the engine stops.
#[nolog]
pub(super) async fn rest(engine: &Engine, wait: Duration) -> bool {
    tokio::select! {
        _ = engine.shutdown.cancelled() => false,
        _ = engine.access.doors.woken.notified() => true,
        _ = tokio::time::sleep(wait) => true,
    }
}

/// This computer's addresses now. In a unit test nothing of the computer is ever asked: the
/// reading is the one the test fixed, or nothing at all. In a rig run the door goes to the
/// loopback address the run names (`ORGTREE_RIG_REMOTE_DOOR`) or nowhere: a rig run never
/// listens beyond this computer.
#[nolog]
pub async fn read(engine: &Engine) -> Reading {
    if let Some(reading) = engine.access.doors.fixed() {
        return reading;
    }
    if cfg!(test) {
        return Reading::default();
    }
    if crate::rig::active() {
        let rig = std::env::var("ORGTREE_RIG_REMOTE_DOOR").ok().and_then(|at| at.parse::<IpAddr>().ok()).filter(IpAddr::is_loopback);
        return Reading { rig: if cfg!(debug_assertions) { rig } else { None }, ..Reading::default() };
    }
    let tailscale = crate::phone::tailscale(engine).await;
    let answered = tailscale.error.is_none() && tailscale.backend.as_deref() != Some("NoDaemon");
    Reading {
        tailscale: answered.then(|| tailscale.ipv4.as_deref().and_then(|ip| ip.parse().ok())),
        dns: tailscale.dns.clone().filter(|_| answered),
        lan: crate::phone::lan_ipv4().and_then(|ip| ip.parse().ok()),
        rig: None,
    }
}

/// May the door stand anywhere with this reading and this choice? The sentence says why not.
#[nolog]
pub fn way_in(reading: &Reading, lan: bool) -> Result<(), &'static str> {
    if reading.rig.is_some() || !plan(true, lan, 1024, reading.tailscale.flatten(), reading.lan).is_empty() {
        Ok(())
    } else if lan {
        Err(text::NO_WAY_IN_LAN)
    } else {
        Err(text::NO_WAY_IN)
    }
}

/// Read this computer's addresses and put the door where it should stand. The loop calls this,
/// and so does every owner's route that changed something, so its answer shows the door as it
/// is from now.
#[nolog]
pub async fn refresh(engine: &Arc<Engine>) {
    let _one = engine.access.doors.step.lock().await;
    let reading = read(engine).await;
    step(engine, reading).await;
}

/// One step with a reading that was taken. Not for callers: `refresh` holds the lock.
#[nolog]
async fn step(engine: &Arc<Engine>, reading: Reading) {
    let doors = &engine.access.doors;
    let (port, lan) = engine.access.registry.listening();
    let owner = Owner { open: engine.access.any_open(), lan, port };
    let (decision, want, standing) = {
        let Ok(mut state) = doors.state.lock() else { return };
        let standing: Vec<Want> = state.bound.iter().map(|bound| bound.want).collect();
        let want = match reading.rig {
            Some(ip) => if owner.open && ip.is_loopback() { vec![Want { kind: Kind::Rig, at: SocketAddr::new(ip, owner.port) }] } else { Vec::new() },
            None => {
                // Tailscale that did not answer says nothing: its address is taken to be what the door has
                let tailscale = match reading.tailscale {
                    Some(known) => known,
                    None => standing.iter().find(|w| w.kind == Kind::Tailscale).and_then(|w| match w.at.ip() { IpAddr::V4(ip) => Some(ip), IpAddr::V6(_) => None }),
                };
                plan(owner.open, owner.lan, owner.port, tailscale, reading.lan)
            }
        };
        // an address the door could not be bound to is tried again at every step, without waiting
        let retry = state.failed.iter().any(|(failed, _)| want.contains(failed));
        let decision = if retry { Decision::Apply } else { decide(state.applied, owner, &standing, &want, state.pending.as_deref()) };
        state.reading = reading;
        match decision {
            Decision::Keep => state.pending = None,
            Decision::Confirm => state.pending = Some(want.clone()),
            Decision::Apply => {
                state.pending = None;
                state.applied = owner;
            }
        }
        (decision, want, standing)
    };
    if decision != Decision::Apply {
        return;
    }
    // close what is no longer wanted
    let closing: Vec<Want> = standing.iter().filter(|w| !want.contains(w)).copied().collect();
    if !closing.is_empty() {
        if let Ok(mut state) = doors.state.lock() {
            state.bound.retain(|bound| {
                let keep = want.contains(&bound.want);
                if !keep {
                    bound.stop.cancel();
                }
                keep
            });
        }
        // whoever came in through an address that is gone comes back through one that stands
        engine.access.registry.close_all();
        tracing::info!(closed = closing.len(), "remote access: the door no longer listens where it did");
    }
    // bind what is wanted and not standing
    let mut failed = Vec::new();
    for wanted in want.iter().filter(|w| !standing.contains(w)) {
        match tokio::net::TcpListener::bind(wanted.at).await {
            Ok(listener) => {
                let stop = CancellationToken::new();
                let rule = match wanted.kind {
                    #[cfg(any(test, debug_assertions))]
                    Kind::Rig => PeerRule::with_loopback(owner.lan),
                    _ => PeerRule::new(owner.lan),
                };
                let (ending, stopping) = (engine.shutdown.clone(), stop.clone());
                let both = CancellationToken::new();
                let ended = both.clone();
                tokio::spawn(async move {
                    tokio::select! { _ = ending.cancelled() => {}, _ = stopping.cancelled() => {} }
                    ended.cancel();
                });
                door::serve(engine.clone(), listener, rule, both);
                if let Ok(mut state) = doors.state.lock() {
                    state.bound.push(Bound { want: *wanted, stop });
                }
            }
            Err(error) => {
                tracing::warn!(address = %wanted.at, error = %error, "remote access: the door could not be bound");
                failed.push((*wanted, error.to_string()));
            }
        }
    }
    if let Ok(mut state) = doors.state.lock() {
        state.failed = failed;
    }
}

/// The door as the owner's app is shown it: `state` is `closed` (nothing is shared), `open`,
/// `waiting` (something is shared but this computer has no address the door may stand at) or
/// `blocked` (the port is taken); `addresses` are where it stands, each as the other computer
/// types it; `firewall` is what is known of the Windows Firewall rules the door needs
/// (`firewall::Firewall::shown`).
#[nolog]
pub fn status(engine: &Engine) -> Value {
    let (port, lan) = engine.access.registry.listening();
    let open = engine.access.any_open();
    let Ok(state) = engine.access.doors.state.lock() else { return json!({ "state": "closed", "addresses": [] }) };
    let addresses: Vec<Value> = state.bound.iter().map(|bound| {
        let ip = bound.want.at.ip().to_string();
        let host = match bound.want.kind {
            Kind::Tailscale => state.reading.dns.clone().unwrap_or_else(|| ip.clone()),
            _ => ip.clone(),
        };
        json!({ "kind": bound.want.kind.as_str(), "ip": ip, "port": bound.want.at.port(), "url": format!("http://{host}:{}", bound.want.at.port()),
                "encrypted": bound.want.kind == Kind::Tailscale })
    }).collect();
    let (name, reason) = if !open {
        ("closed", None)
    } else if !addresses.is_empty() {
        ("open", state.failed.first().map(|(want, _)| text::port_taken(want.at.port())))
    } else if let Some((want, _)) = state.failed.first() {
        ("blocked", Some(text::port_taken(want.at.port())))
    } else {
        ("waiting", way_in(&state.reading, lan).err().map(str::to_string))
    };
    json!({ "state": name, "reason": reason, "addresses": addresses, "port": port, "lan": lan,
            "firewall": engine.access.firewall.shown(port, lan) })
}

/// Who is connected now, by organization: looked at from the loop, and written into each
/// organization's history when someone came or went.
#[nolog]
fn presence(engine: &Arc<Engine>) -> bool {
    let rows = engine.access.registry.rows(None);
    let now: Vec<String> = rows.iter().filter(|row| row["connected"] == true).filter_map(|row| row["id"].as_str().map(str::to_string)).collect();
    let before = match engine.access.doors.state.lock() {
        Ok(mut state) => std::mem::replace(&mut state.connected, now.clone()),
        Err(_) => return false,
    };
    let mut changed = false;
    for row in &rows {
        let Some(id) = row["id"].as_str() else { continue };
        let what = match (before.iter().any(|b| b == id), now.iter().any(|n| n == id)) {
            (false, true) => "connected",
            (true, false) => "disconnected",
            _ => continue,
        };
        changed = true;
        let via = crate::caller::Origin::client(id, row["name"].as_str().unwrap_or_default(), None).json();
        for org in row["orgs"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|org| engine.access.is_open(org)) {
            super::record(engine, org, what, Some(row), Some(via.clone()));
        }
    }
    // a computer that was revoked while connected is gone from the rows: that is a change too
    changed || before.iter().any(|id| !rows.iter().any(|row| row["id"] == id.as_str()))
}

/// Tell this desktop's own windows what is shared and who is connected (`remote_access`, an app
/// value of this computer; never sent to another computer).
#[nolog]
pub fn publish(engine: &Engine) {
    engine.app.set_value("remote_access", super::api::overview_of(engine));
    // and each computer that is connected is sent what it may open now
    engine.app.members_changed();
}

/// The loop. A desktop only: a standalone engine has no door of this kind.
#[nolog]
pub fn start(engine: &Arc<Engine>) {
    if engine.cfg.standalone {
        return;
    }
    let engine = engine.clone();
    tokio::spawn(async move {
        let mut read_at: Option<tokio::time::Instant> = None;
        publish(&engine);
        loop {
            let open = engine.access.any_open();
            let standing = !engine.access.doors.standing().is_empty();
            let confirming = engine.access.doors.state.lock().map(|state| state.pending.is_some()).unwrap_or(false);
            // the addresses are read every CHECK (a changed one sooner); who is connected, every PRESENCE
            let due = read_at.is_none_or(|at| at.elapsed() >= if confirming { CONFIRM } else { CHECK });
            if (open || standing) && due {
                read_at = Some(tokio::time::Instant::now());
                let before = engine.access.doors.standing();
                refresh(&engine).await;
                if before != engine.access.doors.standing() {
                    publish(&engine);
                }
            }
            if presence(&engine) {
                publish(&engine);
            }
            engine.access.registry.tidy();
            let confirming = engine.access.doors.state.lock().map(|state| state.pending.is_some()).unwrap_or(false);
            let wait = if confirming { CONFIRM } else if open || standing { PRESENCE } else { IDLE };
            if !rest(&engine, wait).await {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(text: &str) -> Option<Ipv4Addr> {
        Some(text.parse().unwrap())
    }

    fn at(kind: Kind, text: &str) -> Want {
        Want { kind, at: text.parse().unwrap() }
    }

    #[test]
    fn the_door_is_planned_at_the_tailscale_address_and_the_private_one_by_choice_and_nowhere_else() {
        // nothing is shared: no door, whatever the addresses
        assert!(plan(false, true, 7431, v4("100.64.0.1"), v4("192.168.1.20")).is_empty());
        // Tailscale only (the default): the private address is not used
        assert_eq!(plan(true, false, 7431, v4("100.64.0.1"), v4("192.168.1.20")), vec![at(Kind::Tailscale, "100.64.0.1:7431")]);
        // and this private network, by choice
        assert_eq!(plan(true, true, 7431, v4("100.64.0.1"), v4("192.168.1.20")),
            vec![at(Kind::Tailscale, "100.64.0.1:7431"), at(Kind::Lan, "192.168.1.20:7431")]);
        assert_eq!(plan(true, true, 7440, None, v4("10.0.0.5")), vec![at(Kind::Lan, "10.0.0.5:7440")]);
        // Tailscale is not running and the private network was not chosen: nowhere
        assert!(plan(true, false, 7431, None, v4("192.168.1.20")).is_empty());
        // an address that is not what it should be is never bound, in either place
        for public in ["8.8.8.8", "0.0.0.0", "127.0.0.1", "169.254.10.1", "100.128.0.1", "172.32.0.1"] {
            assert!(plan(true, true, 7431, v4(public), v4(public)).is_empty(), "{public}");
        }
        // a private address is not taken for Tailscale's, nor Tailscale's for the private network's
        assert!(plan(true, false, 7431, v4("192.168.1.20"), None).is_empty());
        assert!(plan(true, true, 7431, None, v4("100.64.0.1")).is_empty());
        // every address the plan names is one the door's own peer rule would call Tailscale or private
        for want in plan(true, true, 7431, v4("100.101.102.103"), v4("172.16.4.4")) {
            assert!(matches!(classify(want.at.ip()), Net::Tailscale | Net::Private) && !want.at.ip().is_unspecified());
        }
        assert!(plan(true, true, 80, v4("100.64.0.1"), v4("192.168.1.20")).is_empty(), "never a low port");
    }

    #[test]
    fn what_the_owner_changes_is_at_once_and_an_address_that_moved_is_confirmed_first() {
        let owner = Owner { open: true, lan: false, port: 7431 };
        let (home, moved) = ([at(Kind::Tailscale, "100.64.0.1:7431")], [at(Kind::Tailscale, "100.64.0.2:7431")]);
        assert_eq!(decide(owner, owner, &home, &home, None), Decision::Keep);
        // the owner switched something on: at once
        assert_eq!(decide(Owner::default(), owner, &[], &home, None), Decision::Apply);
        // the owner switched everything off, changed the port or the choice: at once
        assert_eq!(decide(owner, Owner { open: false, ..owner }, &home, &[], None), Decision::Apply);
        assert_eq!(decide(owner, Owner { port: 7440, ..owner }, &home, &[at(Kind::Tailscale, "100.64.0.1:7440")], None), Decision::Apply);
        // the address moved by itself: once is not enough, twice the same is
        assert_eq!(decide(owner, owner, &home, &moved, None), Decision::Confirm);
        assert_eq!(decide(owner, owner, &home, &moved, Some(&moved)), Decision::Apply);
        // Tailscale went away: the same patience before the door is closed
        assert_eq!(decide(owner, owner, &home, &[], None), Decision::Confirm);
        assert_eq!(decide(owner, owner, &home, &[], Some(&[])), Decision::Apply);
        // a reading that disagrees with the one before starts the count again
        assert_eq!(decide(owner, owner, &home, &moved, Some(&[])), Decision::Confirm);
        // and one that is back to where the door stands needs nothing
        assert_eq!(decide(owner, owner, &home, &home, Some(&moved)), Decision::Keep);
    }

    #[test]
    fn the_switch_says_why_when_there_is_nowhere_for_the_door_to_stand() {
        let nothing = Reading::default();
        assert_eq!(way_in(&nothing, false), Err(text::NO_WAY_IN));
        assert_eq!(way_in(&nothing, true), Err(text::NO_WAY_IN_LAN));
        let private_only = Reading { tailscale: Some(None), lan: "192.168.1.20".parse().ok(), ..Reading::default() };
        assert_eq!(way_in(&private_only, false), Err(text::NO_WAY_IN));
        assert_eq!(way_in(&private_only, true), Ok(()));
        let tailscale = Reading { tailscale: Some("100.64.0.1".parse().ok()), ..Reading::default() };
        assert_eq!(way_in(&tailscale, false), Ok(()));
        let public = Reading { tailscale: Some("8.8.8.8".parse().ok()), lan: "8.8.4.4".parse().ok(), ..Reading::default() };
        assert_eq!(way_in(&public, true), Err(text::NO_WAY_IN_LAN));
    }
}
