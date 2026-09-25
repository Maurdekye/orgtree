//! Dev-cluster conventions that need no database.

use orgtree_pg_custodian::dev;
use std::collections::BTreeMap;

#[test]
fn ports_are_deterministic_in_range_and_spread() {
    let agents = ["p03-ws1-pgservice", "p03-ws2-storecore", "p02-contacts-opus55", "p03-lead-opus55", "p03-ws6-feed"];
    let mut seen = std::collections::BTreeSet::new();
    for a in agents {
        let p = dev::port_for(a);
        assert_eq!(p, dev::port_for(a));
        assert!((41000..49000).contains(&p), "{a} -> {p}");
        seen.insert(p);
    }
    assert_eq!(seen.len(), agents.len(), "today's agent names must not collide");
    // Pinned value: changing the derivation silently moves every cluster.
    // Values computed independently (Python FNV-1a 32, mod 8000, +41000).
    assert_eq!(dev::port_for("p03-ws1-pgservice"), 45891);
    assert_eq!(dev::port_for("p03-ws2-storecore"), 48380);
}

#[test]
fn agent_names_are_confined() {
    for bad in ["", "..", "a/b", "a\\b", "C:", "UPPER", "-x", &"x".repeat(65)] {
        assert_eq!(dev::check_agent(bad).unwrap_err().code, "dev.bad_agent", "{bad:?}");
    }
    dev::check_agent("p03-ws1-pgservice").unwrap();
}

#[test]
fn env_rendering() {
    let mut v = BTreeMap::new();
    v.insert("P03_PG_ADMIN_URL".to_string(), "postgresql://a:b@127.0.0.1:1/orgtree?sslmode=disable".to_string());
    assert_eq!(dev::render_env(&v, "ps").unwrap(), "$env:P03_PG_ADMIN_URL='postgresql://a:b@127.0.0.1:1/orgtree?sslmode=disable'\n");
    assert_eq!(dev::render_env(&v, "sh").unwrap(), "export P03_PG_ADMIN_URL='postgresql://a:b@127.0.0.1:1/orgtree?sslmode=disable'\n");
    assert_eq!(dev::render_env(&v, "cmd").unwrap_err().code, "cli.usage");
}
