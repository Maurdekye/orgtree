//! C1 retry classification (CONTRACT-M1 §3.4).

use std::time::Duration;

use crate::session::DbError;

/// Conflict-detector constraints every family may retry on: the receipt key
/// (E7), the pair-order key (E-D1) and the audience grant key (C4). Families
/// add their own in [`crate::exec::Family::retry_unique`].
pub const GLOBAL_RETRY_UNIQUE: &[&str] = &[
    "operation_receipts_original_key",
    "mail_sent_pair_seq",
    "audience_grants_key",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Retry the whole attempt with the same operation identity.
    Retry(&'static str),
    /// `55P03`: a bounded lock wait expired. Not looped: answered truthfully.
    LockTimeout,
    /// Fail at once: a defect or a non-retryable server error.
    Fatal,
}

/// Classify a statement or commit error that is NOT a lost COMMIT (that one
/// is an unknown outcome, handled by the executor).
pub fn classify(e: &DbError, allowed_unique: &dyn Fn(&str) -> bool, retry_any_unique: bool) -> Class {
    match e {
        DbError::ConnectionLost { .. } => Class::Retry("connection_lost"),
        DbError::Sql { code, constraint, .. } => match code.as_str() {
            "40001" => Class::Retry("serialization_failure"),
            "40P01" => Class::Retry("deadlock"),
            "23505" => {
                if retry_any_unique {
                    return Class::Retry("unique_violation_any");
                }
                match constraint {
                    Some(c) if allowed_unique(c) => Class::Retry("unique_violation_allowlisted"),
                    _ => Class::Fatal,
                }
            }
            "55P03" => Class::LockTimeout,
            _ => Class::Fatal,
        },
    }
}

/// Exponential backoff with full jitter, capped.
pub fn backoff(attempt: u32, base: Duration, cap: Duration) -> Duration {
    let exp = base.saturating_mul(1u32 << attempt.saturating_sub(1).min(16));
    let ceiling = exp.min(cap).as_micros() as u128;
    if ceiling == 0 {
        return Duration::ZERO;
    }
    let r = uuid::Uuid::new_v4().as_u128() % (ceiling + 1);
    Duration::from_micros(r as u64)
}
