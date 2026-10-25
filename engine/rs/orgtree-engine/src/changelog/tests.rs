use super::*;

const NOTES: &[(&str, &[u8])] = &[
    ("4.4.5", b"\xEF\xBB\xBF# Orgtree 4.4.5\r\n\r\nDraft.\r\n\r\n"),
    ("4.4.4", b"# Orgtree 4.4.4\n\nShipped.\n"),
    ("4.4.3", b"# Orgtree 4.4.3\n"),
];

fn list() -> Value {
    json!({ "releases": [
        { "version": "4.4.3", "published_at": "2026-10-23T15:29:30Z", "tagged_at": "2026-10-23T13:05:20Z" },
        { "version": "4.4.4", "published_at": "2026-10-24T05:23:13Z", "tagged_at": "2026-10-24T02:58:37Z" },
        { "version": "2.1.10", "published_at": "2026-09-21T17:02:57Z", "tagged_at": "2026-09-21T16:00:00Z" },
        { "version": "2.1.9", "published_at": "2026-09-20T14:09:00Z", "tagged_at": "2026-09-20T13:00:00Z" },
    ]})
}

fn at(s: &str) -> Option<DateTime<Utc>> {
    Some(DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc))
}

fn versions(rows: &[Release]) -> Vec<&str> {
    rows.iter().map(|r| r.version.as_str()).collect()
}

#[test]
fn versions_order_as_semver() {
    let mut v = vec!["4.4.4", "4.4.5-alpha.9", "2.1.10", "4.4.5", "4.4.5-alpha.10", "2.1.9", "4.4.5-beta.1"];
    v.sort_by(|a, b| order(b).cmp(&order(a)));
    assert_eq!(v, ["4.4.5", "4.4.5-beta.1", "4.4.5-alpha.10", "4.4.5-alpha.9", "4.4.4", "2.1.10", "2.1.9"]);
    assert_eq!(order("4.4"), None);
    assert_eq!(order("4.4.4.4"), None);
    assert_eq!(order("v4.4.4"), None);
}

/// USER 2026-10-25 09:01:38Z (m91aeac18fae1): "GitHub publish time".
#[test]
fn a_row_shows_when_github_published_its_release() {
    assert_eq!(TIME_SOURCE, TimeSource::Published);
    let published = rows(&list(), NOTES, "4.4.4", None, TIME_SOURCE);
    assert_eq!(published[0].released_at, at("2026-10-24T05:23:13Z"));
    assert_eq!(published[1].released_at, at("2026-10-23T15:29:30Z"));
    assert_eq!(row_json(&published[0])["released_at"], json!("2026-10-24T05:23:13.000Z"));
    // the tag's commit time stays selectable in code
    let tagged = rows(&list(), NOTES, "4.4.4", None, TimeSource::Tagged);
    assert_eq!(tagged[0].released_at, at("2026-10-24T02:58:37Z"));
}

/// USER 2026-10-25 09:01:38Z: "Published only". A local alpha is no published
/// release, so it has no row: it lists the releases published before it.
#[test]
fn a_local_alpha_lists_the_published_releases_and_no_row_of_its_own() {
    for alpha in ["4.4.5-alpha.3", "4.5.0-alpha.1"] {
        let alpha_rows = rows(&list(), NOTES, alpha, Some("2026-10-25T00:34:25+03:00"), TIME_SOURCE);
        assert_eq!(versions(&alpha_rows), ["4.4.4", "4.4.3", "2.1.10", "2.1.9"], "{alpha}");
    }
    let top = row_json(&rows(&list(), NOTES, "4.4.5-alpha.3", None, TIME_SOURCE)[0]);
    assert_eq!(top, json!({ "version": "4.4.4", "released_at": "2026-10-24T05:23:13.000Z", "notes": true }));
}

/// A release is built before GitHub publishes it, so its own build's list does
/// not have it yet: that build lists itself, dated by the commit it was built
/// from, until a later list has its publish time.
#[test]
fn a_release_build_lists_itself_by_its_commit_time_until_the_list_has_it() {
    let release = rows(&list(), NOTES, "4.4.5", Some("2026-10-26T10:00:00Z"), TIME_SOURCE);
    assert_eq!(versions(&release), ["4.4.5", "4.4.4", "4.4.3", "2.1.10", "2.1.9"]);
    assert_eq!(release[0].released_at, at("2026-10-26T10:00:00Z"));
    assert_eq!(row_json(&release[0])["notes"], json!(true));
    let listed = rows(&list(), NOTES, "4.4.4", Some("2026-10-24T05:58:37+03:00"), TIME_SOURCE);
    assert_eq!(versions(&listed), ["4.4.4", "4.4.3", "2.1.10", "2.1.9"]);
    assert_eq!(listed[0].released_at, at("2026-10-24T05:23:13Z"), "once listed, the list's time");
    // a published release without a notes file keeps its row, without notes; an unstamped build has no time
    assert_eq!(row_json(&listed[2])["notes"], json!(false));
    let bare = rows(&list(), NOTES, "4.5.0", None, TIME_SOURCE);
    assert_eq!((bare[0].version.as_str(), bare[0].released_at), ("4.5.0", None));
}

#[test]
fn notes_are_lf_without_a_bom_and_end_in_one_newline() {
    assert_eq!(notes_in(NOTES, "4.4.5").as_deref(), Some("# Orgtree 4.4.5\n\nDraft.\n"));
    assert_eq!(notes_in(NOTES, "9.9.9"), None);
}

#[test]
fn the_glossary_copy_indexes_every_row_and_carries_each_set_of_notes_once() {
    let alpha = rows(&list(), NOTES, "4.4.5-alpha.3", Some("2026-10-25T00:34:25+03:00"), TIME_SOURCE);
    let files = glossary_from(&alpha, NOTES);
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, [
        "app-shell/changelog/releases/4.4.4.md",
        "app-shell/changelog/releases/4.4.3.md",
        "app-shell/changelog/releases/index.md",
    ]);
    let index = String::from_utf8(files.last().unwrap().1.clone()).unwrap();
    assert!(index.contains("| 4.4.4 | 2026-10-24 05:23 UTC | [4.4.4.md](4.4.4.md) |"), "{index}");
    assert!(index.contains("| 2.1.10 | 2026-09-21 17:02 UTC | none |"), "{index}");
    assert!(index.contains("when GitHub published"), "{index}");
    assert!(!index.contains("unpublished") && !index.contains("draft"), "{index}");
}

#[test]
fn this_build_bundles_every_published_release_and_no_row_for_a_pre_release() {
    let rows = releases();
    let listed: Vec<&Release> = rows.iter().filter(|r| r.version != RUNNING).collect();
    assert!(listed.len() >= 52, "{} listed rows", listed.len());
    assert!(listed.iter().all(|r| row_json(r)["notes"] == json!(true)),
        "a published release without notes: {:?}", listed.iter().find(|r| row_json(r)["notes"] != json!(true)));
    assert!(listed.iter().all(|r| r.released_at.is_some()));
    assert!(rows.windows(2).all(|w| order(&w[0].version) > order(&w[1].version)), "{:?}", versions(rows));
    assert_eq!(rows.last().map(|r| r.version.as_str()), Some("2.0.0"));
    assert!(RELEASE_NOTES.iter().all(|(v, _)| order(v).is_some_and(|o| o.pre.is_empty())));
    for v in ["4.3.2", "2.1.14", "2.0.0"] {
        assert!(notes(v).is_some_and(|n| n.starts_with('#') || n.starts_with("Orgtree")), "{v}");
    }
    // published only: a development build (a pre-release version) has no row of its own; a release build has one
    let own = rows.iter().find(|r| r.version == RUNNING);
    let pre_release = order(RUNNING).is_some_and(|o| !o.pre.is_empty());
    assert_eq!(own.is_some(), !pre_release, "{RUNNING}: {own:?}");
    // a stamped release build (ORGTREE_BUILD_COMMIT) dates its own unlisted row by its commit (build.rs)
    let in_list = serde_json::from_str::<Value>(RELEASES).unwrap()["releases"]
        .as_array()
        .is_some_and(|all| all.iter().any(|r| r["version"] == RUNNING));
    if let Some(own) = own.filter(|_| !in_list && option_env!("ORGTREE_BUILD_COMMIT").is_some()) {
        assert!(BUILD_TIME.is_some() && own.released_at == time(BUILD_TIME), "{BUILD_TIME:?} {own:?}");
    }
}
