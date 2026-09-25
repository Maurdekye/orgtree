//! Name resolution is never a service verb (lead request 2026-09-25 11:49Z;
//! S3:2214, Q-ST4's unsafe control is exactly a name probe made outside the
//! transaction that acts on it). It lives in `orgtree_store::resolve` and
//! takes the command's own `Tx`.

use orgtree_store_service::handler::VERBS;

const RESOLUTION_WORDS: &[&str] = &["resolve", "name", "slug", "address", "lookup_id", "whois"];

#[test]
fn no_advertised_verb_resolves_a_name() {
    assert!(!VERBS.is_empty(), "the verb list is empty: this test would pass vacuously");
    for v in VERBS {
        for w in RESOLUTION_WORDS {
            assert!(!v.to_ascii_lowercase().contains(w), "service verb {v:?} looks like a resolution verb ({w})");
        }
    }
}

/// The dispatcher serves exactly the advertised verbs: no hidden arm.
#[test]
fn the_dispatcher_serves_exactly_the_advertised_verbs() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/handler.rs")).unwrap();
    let body = &src[src.find("match req.verb.as_str() {").expect("the dispatcher")..];
    let body = &body[..body.find("other =>").expect("the unknown-verb arm")];
    let mut arms: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('"') && l.contains("\" =>"))
        .map(|l| l.split('"').nth(1).unwrap())
        .collect();
    arms.sort_unstable();
    let mut verbs: Vec<&str> = VERBS.to_vec();
    verbs.sort_unstable();
    assert_eq!(arms, verbs);
}
