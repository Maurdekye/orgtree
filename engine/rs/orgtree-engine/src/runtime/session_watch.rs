//! Sign-in and sign-out notices (docket
//! let-agents-query-machine-sign-in-state-and-which; the user, 2026-10-16
//! 12:07Z: at sign-in and at sign-out every running turn is told, at its next
//! tool boundary, where its next turn will run; idle agents are told without
//! being woken).

/// Whether a steady reading of where new turns run (`signed-in` while the
/// sign-in helper hosts, else `session0`) is news to agents last told `last`:
/// Some(true) for the signed-in session, Some(false) for Session 0.
#[logged]
pub fn announce(last: &str, now: &str) -> Option<bool> {
    let _ = (last, now);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_change_from_what_agents_were_last_told_is_announced() {
        assert_eq!(announce("session0", "signed-in"), Some(true));
        assert_eq!(announce("signed-in", "session0"), Some(false));
        assert_eq!(announce("signed-in", "signed-in"), None);
        assert_eq!(announce("session0", "session0"), None);
    }
}
