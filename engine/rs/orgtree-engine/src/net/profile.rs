//! Telling a mail hub an org's new display name (`POST /api/profile`, Mail hub
//! 2.0.0 and later). `/api/register` carries the name once per hub; a rename
//! afterwards would leave the hub's roster (and so Hubchat and other
//! Orgtrees) on the old name. Each pass compares the org's name with its own
//! row in the cached roster of every hub it is registered on and sends the
//! name when they differ. Never sent: slug, address, username, blurb, kind.
//! A non-success HTTP answer (404 for a hub without the route, 422, ...) is
//! not retried for that name in this engine run.
use super::*;

/// The hub's own limit for a display name (`PROFILE_NAME_MAX`), in characters.
pub(crate) const NAME_MAX: usize = 48;

/// What was last sent, or refused, per (org id, hub id).
#[derive(Default)]
pub(crate) struct State {
    tried: papaya::HashMap<(i64, String), String>,
}

/// The name as the hub accepts it: the first `NAME_MAX` characters.
#[nolog]
pub(crate) fn wanted(name: &str) -> String {
    name.chars().take(NAME_MAX).collect()
}

/// Whether to send: our row is known, differs from `want`, and this name was
/// not already answered with a refusal.
#[nolog]
pub(crate) fn due(roster_name: Option<&str>, want: &str, tried: Option<&str>) -> bool {
    todo!()
}

/// Bring each registered hub's roster name in line with each org's name.
#[logged]
pub(super) async fn sync(engine: &Engine, parts: &[Part]) {
    todo!()
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
