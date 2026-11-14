//! Refused tokens at the door, counted per address
//! (docs/rust-engine/remote-org.md, "The door's guard").
//!
//! Whoever presents no token the door knows is counted by the address the
//! connection came from. After `strikes` refusals within `window` the door
//! answers that address 429 for `block`, to every request that shows no token
//! it knows: guessing costs a minute per ten tries. A token the door knows
//! is never counted, whatever it was refused for, and is never shut out
//! (`admit`): behind a tunnel, a proxy or a shared router many callers have
//! one address.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

/// Addresses remembered at a time; beyond that the idle ones are forgotten.
const MAX_PEERS: usize = 4096;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Refusals within `window` that close the door to an address.
    pub strikes: usize,
    pub window: Duration,
    /// How long the door then answers that address 429.
    pub block: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { strikes: 10, window: Duration::from_secs(60), block: Duration::from_secs(60) }
    }
}

#[derive(Default)]
struct Peer {
    refused: VecDeque<Instant>,
    blocked_until: Option<Instant>,
}

#[derive(Default)]
pub struct Limiter {
    limits: RwLock<Limits>,
    peers: Mutex<HashMap<IpAddr, Peer>>,
}

#[nolog]
impl Limiter {
    /// Other limits than the ones a running app has (tests).
    pub fn set(&self, limits: Limits) {
        if let Ok(mut current) = self.limits.write() {
            *current = limits;
        }
    }

    fn limits(&self) -> Limits {
        self.limits.read().map(|limits| *limits).unwrap_or_default()
    }

    /// Is the door closed to this address now?
    pub fn blocked(&self, ip: IpAddr) -> bool {
        self.blocked_at(ip, Instant::now())
    }

    pub(crate) fn blocked_at(&self, ip: IpAddr, now: Instant) -> bool {
        let Ok(mut peers) = self.peers.lock() else { return false };
        match peers.get_mut(&ip) {
            Some(peer) => match peer.blocked_until {
                Some(until) if now < until => true,
                Some(_) => {
                    // the minute is over: the address starts from nothing
                    peers.remove(&ip);
                    false
                }
                None => false,
            },
            None => false,
        }
    }

    /// One refused token from this address. Answers whether the door is closed to it from now.
    pub fn strike(&self, ip: IpAddr) -> bool {
        self.strike_at(ip, Instant::now())
    }

    pub(crate) fn strike_at(&self, ip: IpAddr, now: Instant) -> bool {
        let limits = self.limits();
        let Ok(mut peers) = self.peers.lock() else { return false };
        if peers.len() >= MAX_PEERS && !peers.contains_key(&ip) {
            peers.retain(|_, peer| peer.blocked_until.is_some_and(|until| now < until)
                || peer.refused.back().is_some_and(|last| now.duration_since(*last) < limits.window));
            if peers.len() >= MAX_PEERS {
                // every remembered address is active: this one is not counted rather than let the table grow
                return false;
            }
        }
        let peer = peers.entry(ip).or_default();
        while peer.refused.front().is_some_and(|first| now.duration_since(*first) >= limits.window) {
            peer.refused.pop_front();
        }
        peer.refused.push_back(now);
        if peer.refused.len() >= limits.strikes {
            peer.refused.clear();
            peer.blocked_until = Some(now + limits.block);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn ten_refusals_in_a_minute_close_the_door_to_that_address_for_a_minute() {
        let limiter = Limiter::default();
        let start = Instant::now();
        let (guesser, other) = (ip("100.64.0.9"), ip("100.64.0.10"));
        for n in 0..9 {
            assert!(!limiter.strike_at(guesser, start + Duration::from_secs(n)), "refusal {}", n + 1);
        }
        assert!(!limiter.blocked_at(guesser, start + Duration::from_secs(9)));
        assert!(limiter.strike_at(guesser, start + Duration::from_secs(9)), "the tenth closes it");
        assert!(limiter.blocked_at(guesser, start + Duration::from_secs(10)));
        assert!(limiter.blocked_at(guesser, start + Duration::from_secs(68)));
        assert!(!limiter.blocked_at(other, start + Duration::from_secs(10)), "another address is not touched");
        assert!(!limiter.blocked_at(guesser, start + Duration::from_secs(69)), "a minute after the tenth it is open again");
        assert!(!limiter.strike_at(guesser, start + Duration::from_secs(70)), "and counts from nothing");
    }

    #[test]
    fn refusals_spread_over_more_than_a_minute_close_nothing() {
        let limiter = Limiter::default();
        let start = Instant::now();
        for n in 0..40 {
            assert!(!limiter.strike_at(ip("192.168.1.7"), start + Duration::from_secs(n * 7)), "one every 7 s: refusal {}", n + 1);
        }
    }

    #[test]
    fn the_table_of_addresses_does_not_grow_without_end() {
        let limiter = Limiter::default();
        let start = Instant::now();
        for n in 0..(MAX_PEERS as u32 + 500) {
            limiter.strike_at(IpAddr::from(std::net::Ipv4Addr::from(0x0a00_0000 + n)), start);
        }
        assert!(limiter.peers.lock().unwrap().len() <= MAX_PEERS);
        // later the idle ones make room
        assert!(!limiter.strike_at(ip("100.64.0.1"), start + Duration::from_secs(120)));
        assert!(limiter.peers.lock().unwrap().len() <= 2);
    }
}
