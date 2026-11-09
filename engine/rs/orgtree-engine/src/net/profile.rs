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
    !want.is_empty() && roster_name.is_some_and(|n| n != want) && tried != Some(want)
}

/// Bring each registered hub's roster name in line with each org's name.
#[logged]
pub(super) async fn sync(engine: &Engine, parts: &[Part]) {
    run(engine, parts, true).await
}

/// `isolated` false skips the org-mailbox isolation gate (it reads the
/// database; a test has none) and sends directly.
#[nolog]
async fn run(engine: &Engine, parts: &[Part], isolated: bool) {
    for p in parts {
        let want = wanted(&p.name);
        for (hid, addr) in &p.hubs {
            if !p.registered.contains(hid) || backed_off(engine, addr) {
                continue;
            }
            let Some(roster) = engine.net.rosters.pin().get(addr).cloned() else { continue };
            let Some(at) = roster.iter().position(|r| r["slug"].as_str() == Some(p.net_slug.as_str())) else { continue };
            let key = (p.org_id, hid.clone());
            let tried = engine.net.profile.tried.pin().get(&key).cloned();
            if !due(Some(roster[at]["org_name"].as_str().unwrap_or("")), &want, tried.as_deref()) {
                continue;
            }
            let req = HTTP
                .post(format!("{addr}/api/profile"))
                .timeout(Duration::from_secs(10))
                .header("X-Org-Auth", p.auth())
                .json(&json!({ "slug": p.net_slug, "name": want }));
            let res = if isolated { request(engine, &[p.org_id], req).await } else { transport::send(req).await };
            match res {
                Ok(r) if r.status().is_success() => {
                    succeeded(engine, addr);
                    // our row follows at once, so the next pass sends nothing
                    let mut next = roster.as_ref().clone();
                    next[at]["org_name"] = json!(want);
                    set_roster(engine, addr, None, None, next);
                }
                // a hub without the route (404), a refused name (422), ...: once per name and run
                Ok(r) => {
                    engine.net.profile.tried.pin().insert(key, want.clone());
                    tracing::warn!(org = %p.slug, hub = %hid, status = r.status().as_u16(), "the hub refused the org's display name");
                }
                Err(e) => {
                    failed(engine, addr);
                    tracing::debug!(org = %p.slug, hub = %hid, error = %request_error(&e), "could not send the hub the org's display name");
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
