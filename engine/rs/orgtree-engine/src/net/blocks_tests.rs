//! Blocking (Mail hub 2.6.0; user 2026-11-24 18:56Z/19:06Z): which hubs keep
//! blocks, the addresses a block may name, who may lift a block, and the
//! tool's group. The hub enforces the blocks; its own tests cover that.
use super::blocks::{bare_address, keeps_blocks, may_lift, BY_USER};

#[test]
fn only_a_2_6_hub_keeps_blocks() {
    for v in ["2.6.0", "2.6.0-alpha.1", "2.7.3", "3.0.0", "10.0.0"] {
        assert!(keeps_blocks(v), "{v}");
    }
    for v in ["", "2.5.1", "2.4.0", "1.9.9", "v1", "garbage"] {
        assert!(!keeps_blocks(v), "{v}");
    }
}

#[test]
fn a_block_names_one_hub_address() {
    assert_eq!(bare_address("@net:ann.3f9c2a").as_deref(), Some("ann.3f9c2a"));
    assert_eq!(bare_address(" ann.3f9c2a ").as_deref(), Some("ann.3f9c2a"));
    assert_eq!(bare_address("@ann.3f9c2a").as_deref(), Some("ann.3f9c2a"));
    for bad in ["", "@net:", "Ann.3F9C2A", "ann 3f9c2a", "@org:acme", &"a".repeat(129)] {
        assert_eq!(bare_address(bad), None, "{bad}");
    }
}

#[test]
fn only_the_user_lifts_the_users_block() {
    assert!(may_lift(Some(BY_USER), BY_USER));
    assert!(!may_lift(Some(BY_USER), "holder-agent"));
    assert!(may_lift(Some("holder-agent"), "other-agent"));
    assert!(may_lift(Some("holder-agent"), BY_USER));
    assert!(may_lift(None, "holder-agent"));
}

#[test]
fn orgtree_block_is_a_messaging_tool() {
    assert_eq!(crate::domain::tool_groups::required("orgtree_block"), Some(&["messaging"][..]));
    let cards = crate::tools::defs::implemented();
    assert!(cards.contains(&"orgtree_block"));
}
