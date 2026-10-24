//! Shared by the engine adapter and the windowless sign-in broker.
use std::time::Duration;

pub const LOOKUP: Duration = Duration::from_secs(20);
pub const PIPE: Duration = Duration::from_secs(25);
pub const REQUEST: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[nolog]
    fn credential_deadline_leaves_room_for_lookup_cleanup_and_transport() {
        assert!(LOOKUP > Duration::from_millis(6500));
        assert!(PIPE >= LOOKUP + Duration::from_secs(5));
        // A request can first wait for a slot and for a busy pipe instance.
        assert!(REQUEST > PIPE + Duration::from_secs(3));
        assert!(REQUEST <= Duration::from_secs(30));
    }
}
