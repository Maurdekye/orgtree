//! Polling-clock policy, extracted before changing the restart behavior.
use chrono::{DateTime, Utc};
use std::time::Duration;

// Baseline: every newly started runner checks immediately.
#[nolog]
pub(super) fn wait_until(_deadline:DateTime<Utc>,_now:DateTime<Utc>) -> Duration { Duration::ZERO }

// Baseline: sleeping starts a fresh interval after the last completed check.
#[nolog]
pub(super) fn next_slot(_deadline:DateTime<Utc>,period_s:i64,now:DateTime<Utc>) -> DateTime<Utc> {
    now+chrono::Duration::seconds(period_s.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    fn h(hour:i64)->DateTime<Utc>{Utc.timestamp_opt(1_800_000_000+hour*3600,0).unwrap()}

    #[test]
    fn restart_before_due_waits_for_the_persisted_slot() {
        assert_eq!(wait_until(h(6),h(5)),Duration::from_secs(3600));
    }
    #[test]
    fn six_hour_user_example_catches_up_at_seven_then_keeps_twelve() {
        // This restored deadline is h0 + 6h. Only one check is due on restart.
        let restored:DateTime<Utc>=serde_json::from_str(&serde_json::to_string(&h(6)).unwrap()).unwrap();
        assert_eq!(wait_until(restored,h(7)),Duration::ZERO);
        let next=next_slot(restored,6*3600,h(7));
        assert_eq!(next,h(12),"the catch-up must not shift the recurrence to h13");
        assert_eq!(wait_until(next,h(7)),Duration::from_secs(5*3600));
    }
    #[test]
    fn many_missed_slots_produce_one_catch_up_not_a_backlog() {
        let mut next=h(6);let mut queued=0;
        while wait_until(next,h(37)).is_zero() && queued<3 {
            queued+=1;next=next_slot(next,6*3600,h(37));
        }
        assert_eq!((queued,next),(1,h(42)));
    }
    #[test]
    fn an_early_quiet_check_does_not_move_the_next_poll_slot() {
        assert_eq!(next_slot(h(12),6*3600,h(7)),h(12));
    }
    #[test]
    fn exact_boundary_moves_to_the_first_strictly_future_slot() {
        assert_eq!(next_slot(h(6),6*3600,h(12)),h(18));
        assert_eq!(wait_until(h(6),h(6)),Duration::ZERO);
    }
    #[test]
    fn another_restart_keeps_the_same_future_deadline() {
        let saved=serde_json::to_string(&h(12)).unwrap();
        let restored=serde_json::from_str(&saved).unwrap();
        assert_eq!(wait_until(restored,h(8)),Duration::from_secs(4*3600));
        assert_eq!(wait_until(restored,h(9)),Duration::from_secs(3*3600));
    }
}
