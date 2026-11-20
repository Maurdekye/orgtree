//! `local-orgs.json` in the data root: the orgs this PC's Orgtree can open
//! that have a hub address, for other apps on this PC (desktop Hubchat's
//! contact info and mention chips open such an org through Orgtree). That is
//! the orgs this engine hosts and, after them, the remote orgs it has saved
//! (USER 2026-11-20 m725c710ca7b4; before 4.6.7 only the hosted ones). It
//! holds nothing secret: slugs, names and addresses are what the hub
//! directory already shows, and nothing says where a remote org runs. The
//! app feed keeps it current and writes it only when the listing changes.

use std::path::Path;

use serde_json::{json, Value};

/// The file's name in the data root.
pub const FILE: &str = "local-orgs.json";

/// The listing: `{"v": 1, "orgs": [{"slug", "name", "address"}]}`, in
/// registry order. An org is listed by its registry slug, and only when its
/// summary carries a hub address (`net_slug`). An imported org can keep the
/// address it was minted with under another slug, so a reader opens an org
/// by `slug` and never parses one out of an address.
///
/// After the local orgs come the remote ones (`remote`: each row's registry
/// record and summary, `remote::link::rows`), by alias, under the same
/// address rule and whether or not their engine is connected: the last
/// summary it sent still names the address, and opening the org is what
/// shows its state. `slug` is the alias, the name this PC's Orgtree opens it
/// by; `remote: {"slug"}` is its slug on its own engine, the one its own
/// mentions carry. Nothing else about the remote engine is written.
/// Not logged: the app feed calls it on every org change.
#[nolog]
pub fn listing<'a>(registry: &[Value], summary: impl Fn(i64) -> Option<&'a Value>, remote: &[(&Value, &Value)]) -> Value {
    let mut orgs: Vec<Value> = registry
        .iter()
        .filter_map(|row| {
            let body = summary(row["org_id"].as_i64()?)?;
            let address = body["net_slug"].as_str().filter(|a| !a.is_empty())?;
            Some(json!({ "slug": row["slug"], "name": body["name"], "address": address }))
        })
        .collect();
    let mut theirs: Vec<(&str, Value)> = remote
        .iter()
        .filter_map(|(row, body)| {
            let alias = row["slug"].as_str()?;
            let address = body["net_slug"].as_str().filter(|a| !a.is_empty())?;
            Some((alias, json!({ "slug": alias, "name": body["name"], "address": address,
                                 "remote": { "slug": row["remote"]["slug"] } })))
        })
        .collect();
    // rows come grouped by remote engine: one order whichever engine an org is on
    theirs.sort_by(|a, b| a.0.cmp(b.0));
    orgs.extend(theirs.into_iter().map(|(_, org)| org));
    json!({ "v": 1, "orgs": orgs })
}

/// The listing to write now. None while an org the registry lists is still
/// loading its summary (a boot reads every org after the registry and must
/// not write a listing that lacks them), or when it equals the one written.
/// An org that is not loading and has no summary (its read failed) does not
/// hold the others back: it is simply not listed. Remote orgs never hold a
/// listing back: their rows are whole when they arrive, and a boot that
/// writes before they do writes again when they come.
/// Not logged: the app feed calls it on every org change.
#[nolog]
pub fn due<'a>(registry: &[Value], summary: impl Fn(i64) -> Option<&'a Value>, loading: impl Fn(i64) -> bool,
               remote: &[(&Value, &Value)], written: Option<&Value>) -> Option<Value> {
    if registry.iter().filter_map(|row| row["org_id"].as_i64()).any(|id| summary(id).is_none() && loading(id)) {
        return None;
    }
    let next = listing(registry, &summary, remote);
    (written != Some(&next)).then_some(next)
}

/// Replace the file through a uniquely named temporary file, so a reader
/// sees the old listing or the new one, never part of either.
#[logged]
pub fn write(root: &Path, listing: &Value) -> std::io::Result<()> {
    crate::phone::replace_file(&root.join(FILE), &serde_json::to_vec_pretty(listing)?)
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
        assert_eq!(listing(&registry(), |id| s.get(&id), &[]), expected());
    }

    /// Remote rows as `remote::link::rows` makes them: (registry record, summary), by alias.
    fn remote_rows() -> Vec<(Value, Value)> {
        let record = |id: i64, alias: &str, theirs: &str, state: &str| json!({
            "org_id": id, "slug": alias, "org_uuid": format!("r{id}"), "state": "active", "attempts": 0,
            "remote": { "id": "e1", "name": "Tower", "tag": "tower", "slug": theirs, "state": state },
        });
        vec![
            // the alias differs from its slug on its own engine (a local org already has that slug)
            (record(-3, "alpha-tower", "alpha", "connected"),
             json!({ "name": "Alpha There", "net_slug": "alpha.other.aa11bb", "nodes": 3, "live": 1 })),
            // no hub address there
            (record(-2, "plain", "plain", "connected"), json!({ "name": "Plain", "net_slug": null, "nodes": 1 })),
            // not connected: the last summary it sent still names the address
            (record(-1, "zeta", "zeta", "offline"), json!({ "name": "Zeta", "net_slug": "zeta.other.cc22dd", "nodes": 0 })),
        ]
    }

    fn pairs(rows: &[(Value, Value)]) -> Vec<(&Value, &Value)> {
        rows.iter().map(|(record, summary)| (record, summary)).collect()
    }

    fn expected_with_remote() -> Value {
        json!({ "v": 1, "orgs": [
            { "slug": "alpha", "name": "Alpha Works", "address": "alpha.someone.1a2b3c" },
            { "slug": "gamma", "name": "Gamma Lab", "address": "old-name.someone.4d5e6f" },
            { "slug": "alpha-tower", "name": "Alpha There", "address": "alpha.other.aa11bb", "remote": { "slug": "alpha" } },
            { "slug": "zeta", "name": "Zeta", "address": "zeta.other.cc22dd", "remote": { "slug": "zeta" } },
        ] })
    }

    #[test]
    fn remote_orgs_that_have_a_hub_address_follow_the_local_ones_by_alias_connected_or_not() {
        let s = summaries();
        let rows = remote_rows();
        assert_eq!(listing(&registry(), |id| s.get(&id), &pairs(&rows)), expected_with_remote());
        // whatever order the rows come in (several remote engines), local orgs stay first and remote ones go by alias
        let mut reversed = rows.clone();
        reversed.reverse();
        assert_eq!(listing(&registry(), |id| s.get(&id), &pairs(&reversed)), expected_with_remote());
    }

    #[test]
    fn a_remote_org_without_a_hub_address_is_not_listed() {
        let s = summaries();
        let rows = remote_rows();
        let got = listing(&registry(), |id| s.get(&id), &pairs(&rows));
        assert_eq!(got["orgs"].as_array().unwrap().len(), 4);
        assert!(got["orgs"].as_array().unwrap().iter().all(|org| org["slug"] != "plain"));
        let mut none = rows.clone();
        none[0].1["net_slug"] = json!("");
        none[2].1.as_object_mut().unwrap().remove("net_slug");
        assert_eq!(listing(&registry(), |id| s.get(&id), &pairs(&none)), expected());
    }

    #[test]
    fn a_remote_org_is_listed_under_its_alias_and_says_its_slug_there() {
        let s = summaries();
        let rows = remote_rows();
        let got = listing(&registry(), |id| s.get(&id), &pairs(&rows));
        let org = got["orgs"].as_array().unwrap().iter().find(|org| org["address"] == "alpha.other.aa11bb").expect("listed");
        assert_eq!(org["slug"], "alpha-tower");
        assert_eq!(org["remote"], json!({ "slug": "alpha" }));
    }

    #[test]
    fn a_changed_remote_row_makes_the_listing_due() {
        let s = summaries();
        let mut rows = remote_rows();
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &pairs(&rows), Some(&expected())), Some(expected_with_remote()));
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &pairs(&rows), Some(&expected_with_remote())), None);
        // the remote minted an address for an org that had none
        rows[1].1["net_slug"] = json!("plain.other.ee33ff");
        let next = due(&registry(), |id| s.get(&id), |_| false, &pairs(&rows), Some(&expected_with_remote())).expect("due");
        assert_eq!(next["orgs"][3], json!({ "slug": "plain", "name": "Plain", "address": "plain.other.ee33ff", "remote": { "slug": "plain" } }));
        // the last remote org is gone (its connection was removed)
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &[], Some(&next)), Some(expected()));
    }

    #[test]
    fn an_org_carries_only_its_slug_name_and_address_and_a_remote_one_its_slug_there() {
        let s = summaries();
        let rows = remote_rows();
        let got = listing(&registry(), |id| s.get(&id), &pairs(&rows));
        let orgs = got["orgs"].as_array().unwrap();
        assert_eq!(orgs.len(), 4);
        for (at, org) in orgs.iter().enumerate() {
            let mut keys: Vec<&str> = org.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            if at < 2 {
                assert_eq!(keys, ["address", "name", "slug"]);
            } else {
                // nothing about the remote engine itself (its name, tag, id or link state)
                assert_eq!(keys, ["address", "name", "remote", "slug"]);
                assert_eq!(org["remote"].as_object().unwrap().keys().collect::<Vec<_>>(), ["slug"]);
            }
        }
    }

    #[test]
    fn nothing_is_due_while_a_listed_org_is_still_loading() {
        let mut s = summaries();
        s.remove(&3);
        // gamma's summary is being read: a boot must not write a listing without it
        assert_eq!(due(&registry(), |id| s.get(&id), |id| id == 3, &[], None), None);
    }

    #[test]
    fn a_changed_listing_is_due_and_an_unchanged_one_is_not() {
        let s = summaries();
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &[], None), Some(expected()));
        let stale = json!({ "v": 1, "orgs": [] });
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &[], Some(&stale)), Some(expected()));
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &[], Some(&expected())), None);
    }

    #[test]
    fn an_org_whose_summary_is_gone_does_not_hold_the_others_back() {
        let mut s = summaries();
        // its read failed or it was deleted: not loading, no summary
        s.remove(&1);
        let want = json!({ "v": 1, "orgs": [{ "slug": "gamma", "name": "Gamma Lab", "address": "old-name.someone.4d5e6f" }] });
        assert_eq!(due(&registry(), |id| s.get(&id), |_| false, &[], Some(&expected())), Some(want));
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
