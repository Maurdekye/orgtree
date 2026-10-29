//! `local-orgs.json` in the data root: the orgs this engine hosts that have a
//! hub address, for other apps on this PC (desktop Hubchat's contact info
//! opens a local org through Orgtree's taskbar argument). It holds nothing
//! secret: slugs, names and addresses are what the hub directory already
//! shows. The app feed keeps it current and writes it only when the listing
//! changes.

use std::path::Path;

use serde_json::{json, Value};

/// The file's name in the data root.
pub const FILE: &str = "local-orgs.json";

/// The listing: `{"v": 1, "orgs": [{"slug", "name", "address"}]}`.
/// Not logged: the app feed calls it on every org change.
#[nolog]
pub fn listing<'a>(_registry: &[Value], _summary: impl Fn(i64) -> Option<&'a Value>) -> Value {
    json!({ "v": 1, "orgs": [] })
}

/// The listing to write now, if any.
/// Not logged: the app feed calls it on every org change.
#[nolog]
pub fn due<'a>(_registry: &[Value], _summary: impl Fn(i64) -> Option<&'a Value>, _loading: impl Fn(i64) -> bool,
               _written: Option<&Value>) -> Option<Value> {
    None
}

/// Replace the file.
#[logged]
pub fn write(_root: &Path, _listing: &Value) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("orgtree-local-orgs-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("orgtree-local-orgs-"));
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    /// Registry rows as `read_registry` makes them: active orgs, by slug.
    fn registry() -> Vec<Value> {
        ["alpha", "beta", "gamma"].iter().enumerate()
            .map(|(i, slug)| json!({ "org_id": i as i64 + 1, "slug": slug, "org_uuid": format!("u{i}"), "state": "active" }))
            .collect()
    }

    /// Summary bodies as `read_org` makes them.
    fn summaries() -> HashMap<i64, Value> {
        HashMap::from([
            (1, json!({ "name": "Alpha Works", "net_slug": "alpha.someone.1a2b3c", "nodes": 4, "live": 1,
                        "cost_usd_total": 2.5, "attention": 0, "logo_sha256": null })),
            // no hub address yet
            (2, json!({ "name": "Beta", "net_slug": null, "nodes": 1 })),
            // an imported org keeps the address it was minted with under another slug
            (3, json!({ "name": "Gamma Lab", "net_slug": "old-name.someone.4d5e6f", "nodes": 2 })),
            // the last summary of an org the registry no longer lists (deleted)
            (4, json!({ "name": "Deleted", "net_slug": "deleted.someone.777777" })),
        ])
    }

    fn expected() -> Value {
        json!({ "v": 1, "orgs": [
            { "slug": "alpha", "name": "Alpha Works", "address": "alpha.someone.1a2b3c" },
            { "slug": "gamma", "name": "Gamma Lab", "address": "old-name.someone.4d5e6f" },
        ] })
    }

    #[test]
    fn lists_the_registry_orgs_that_have_a_hub_address_by_their_own_slug() {
        let s = summaries();
        assert_eq!(listing(&registry(), |id| s.get(&id)), expected());
    }

    #[test]
    fn an_org_carries_only_its_slug_name_and_address() {
        let s = summaries();
        let got = listing(&registry(), |id| s.get(&id));
        let orgs = got["orgs"].as_array().unwrap();
        assert!(!orgs.is_empty());
        for org in orgs {
            let mut keys: Vec<&str> = org.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["address", "name", "slug"]);
        }
    }

    #[test]
    fn nothing_is_due_while_a_listed_org_is_still_loading() {
        let mut s = summaries();
        s.remove(&3);
        // gamma's summary is being read: a boot must not write a listing without it
        assert_eq!(due(&registry(), |id| s.get(&id), |id| id == 3, None), None);
    }

    #[test]
    fn a_changed_listing_is_due_and_an_unchanged_one_is_not() {
        let s = summaries();
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, None), Some(expected()));
        let stale = json!({ "v": 1, "orgs": [] });
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, Some(&stale)), Some(expected()));
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, Some(&expected())), None);
    }

    #[test]
    fn an_org_whose_summary_is_gone_does_not_hold_the_others_back() {
        let mut s = summaries();
        // its read failed or it was deleted: not loading, no summary
        s.remove(&1);
        let want = json!({ "v": 1, "orgs": [{ "slug": "gamma", "name": "Gamma Lab", "address": "old-name.someone.4d5e6f" }] });
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, Some(&expected())), Some(want));
    }

    #[test]
    fn write_replaces_the_file_and_leaves_nothing_beside_it() {
        let root = Root::new();
        let read = || -> Value { serde_json::from_slice(&std::fs::read(root.0.join(FILE)).unwrap()).unwrap() };
        write(&root.0, &expected()).unwrap();
        assert_eq!(read(), expected());
        let empty = json!({ "v": 1, "orgs": [] });
        write(&root.0, &empty).unwrap();
        assert_eq!(read(), empty);
        let names: Vec<String> =
            std::fs::read_dir(&root.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [FILE]);
    }
}
