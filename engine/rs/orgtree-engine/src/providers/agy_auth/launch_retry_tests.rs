use super::*;
use std::{cell::Cell, future::ready};

#[tokio::test]
async fn agy_launch_recovers_each_transient_failure_once() {
    for failure in [Failure::Unavailable, Failure::Timeout] {
        let calls = Cell::new(0);
        let result = retry_launch(|| {
            calls.set(calls.get() + 1);
            ready(if calls.get() == 1 { Err(failure) } else { Ok(Stamp(42)) })
        }).await;
        assert_eq!(result.unwrap(), Stamp(42));
        assert_eq!(calls.get(), 2);
    }
}

#[tokio::test]
async fn agy_launch_never_retries_success_or_hard_refusal() {
    for outcome in [Ok(Stamp(42)), Err(Failure::SignedOut), Err(Failure::NotIsolated), Err(Failure::OutputLimit)] {
        let calls = Cell::new(0);
        let result = retry_launch(|| {
            calls.set(calls.get() + 1);
            ready(outcome)
        }).await;
        assert_eq!(calls.get(), 1);
        assert_eq!(format!("{result:?}"), format!("{outcome:?}"));
    }
}

#[tokio::test]
async fn agy_launch_stops_after_two_checks_and_preserves_final_reason() {
    for last in [Failure::Unavailable, Failure::Timeout, Failure::SignedOut, Failure::NotIsolated] {
        let calls = Cell::new(0);
        let result = retry_launch(|| {
            calls.set(calls.get() + 1);
            ready(Err(if calls.get() == 1 { Failure::Unavailable } else { last }))
        }).await;
        assert_eq!(calls.get(), 2);
        assert_eq!(format!("{:?}", result.unwrap_err()), format!("{last:?}"));
    }
}
