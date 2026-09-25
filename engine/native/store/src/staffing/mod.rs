//! WS3a: the staffing doors in the SERIALIZABLE island (S3 §4.8-§4.10;
//! r7 C2a). `staffing.hire` / `operator.hire` ([`hire`]); the staff door and
//! quick staff follow as later increments.
//!
//! Shared island helpers are WS3b's (`crate::island`); funding is WS4's
//! (`crate::funding`, `orgtree-funding-core`); mail and the P8 heads are
//! WS5's (`crate::sent`, `crate::mail::mailbox`). Nothing here copies them.

use serde_json::Value;

use crate::exec::{Family, Isolation};
use crate::island::declared::{entry, receipts, rel, R, RW, SHARE, SHARE_LOCK_W, W};
use crate::island::ISLAND_RETRY_UNIQUE;

pub mod fund;
pub mod hire;
pub mod scope;

/// The island family of every WS3a verb.
pub static STAFFING: Family = Family { name: "staffing", isolation: Isolation::Serializable, retry_unique: ISLAND_RETRY_UNIQUE };

/// ONLY for the unsafe controls that run a hire READ COMMITTED outside the
/// island (Q-ST1, Q-ST4, Q-OP3); never used by a real door.
pub static STAFFING_RC: Family = Family { name: "staffing", isolation: Isolation::ReadCommitted, retry_unique: ISLAND_RETRY_UNIQUE };

/// Unsafe controls compiled into this module (static list for the handshake).
pub const CONTROLS: &[&str] = &[
    // the READ COMMITTED variants (hire::RC_CONTROLS)
    "Q-ST1.rc_count_first",
    "Q-ST4.probe_outside_no_index",
    "Q-OP3.rc_acting_prechecked",
    // P3: only the destination's scope row share-locked
    "Q-ST5.share_destination_only",
    // P2 (WS4's control, also armed at the hire's own payer update)
    "Q-C8.lock_not_update",
];

/// Family-specific pause points (`<family>.<verb>.<point>`).
pub const POINTS: &[&str] = &[
    "staffing.hire.children_counted",
    "staffing.hire.after_funding_locks",
    "staffing.hire.name_probe.before",
    "staffing.hire.name_probe.after",
    "staffing.operator_hire.children_counted",
    "staffing.operator_hire.after_funding_locks",
    "staffing.operator_hire.name_probe.before",
    "staffing.operator_hire.name_probe.after",
];

/// `"<family>.<verb>" → spec` for every WS3a verb (CONTRACT-M1 §5 r4).
/// Relations touched only on some branches (a deep hire's bubbling, a kiosk
/// org's pool, a charter, a kickoff) are `required: false`.
pub fn declared() -> Value {
    let hire = |p01: &str| {
        entry(
            vec![
                receipts(),
                // C3 caller/acting/destination anchors; the new seat's row
                ("authority_epoch", rel(&["read", "for_share", "write"], true)),
                ("org_controls", rel(SHARE, true)),
                ("topology_edges", rel(&["read", "for_share", "write"], true)),
                ("agent_names", rel(RW, true)),
                ("agents", rel(RW, true)),
                ("scope_rows", rel(&["read", "for_share", "write"], true)),
                ("catalog_current", rel(SHARE, true)),
                ("price_catalog", rel(R, true)),
                ("funding_edges", rel(SHARE_LOCK_W, true)),
                ("issuer_capacity", rel(SHARE_LOCK_W, true)),
                ("kiosk_pool", rel(&["read", "for_no_key_update", "write"], false)),
                ("lineage_bearers", rel(R, false)),
                ("runtime_state", rel(W, true)),
                ("seat_config", rel(W, true)),
                ("charter_versions", rel(W, false)),
                ("charter_heads", rel(W, false)),
                ("mailboxes", rel(RW, true)),
                ("mail_sent", rel(RW, false)),
                ("mail_pair_highwater", rel(R, false)),
                ("outgoing_intents", rel(W, false)),
                ("audience_grants", rel(R, false)),
                ("restrictions", rel(W, false)),
                ("restriction_obligations", rel(W, false)),
                ("read_service_registrations", rel(R, false)),
            ],
            Some(p01),
            "engine/native/store/src/staffing/hire.rs hire_in + staffing/fund.rs (S3 §4.8 hire row, §4.9; r7 C2a P2/P3/P6)",
        )
    };
    let mut m = serde_json::Map::new();
    m.insert("staffing.hire".into(), hire("staffing.hire"));
    m.insert("staffing.operator_hire".into(), hire("operator.hire"));
    Value::Object(m)
}
