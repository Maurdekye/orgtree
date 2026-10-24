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
    assert_eq!(release_of("4.4.5-alpha.3"), "4.4.5");
    assert_eq!(release_of("4.4.4"), "4.4.4");
}

#[test]
fn an_alpha_is_one_more_row_on_top_with_its_commit_time_and_the_draft_it_leads_to() {
    let rows = rows(&list(), NOTES, "4.4.5-alpha.3", Some("2026-10-25T00:34:25+03:00"), TimeSource::Tagged);
    assert_eq!(versions(&rows), ["4.4.5-alpha.3", "4.4.4", "4.4.3", "2.1.10", "2.1.9"]);
    let top = &rows[0];
    assert!(top.unpublished);
    assert_eq!(top.released_at, at("2026-10-24T21:34:25Z"));
    assert_eq!(top.notes_version.as_deref(), Some("4.4.5"));
    assert!(rows[1..].iter().all(|r| !r.unpublished));
    assert_eq!(rows[1].released_at, at("2026-10-24T02:58:37Z"));
    assert_eq!(rows[1].notes_version.as_deref(), Some("4.4.4"));
    // a published release without a notes file still has its row, with no notes
    assert_eq!(rows[3].notes_version, None);
}

#[test]
fn the_time_source_picks_which_time_a_published_row_shows() {
    let published = rows(&list(), NOTES, "4.4.4", None, TimeSource::Published);
    assert_eq!(published[0].released_at, at("2026-10-24T05:23:13Z"));
    let tagged = rows(&list(), NOTES, "4.4.4", None, TimeSource::Tagged);
    assert_eq!(tagged[0].released_at, at("2026-10-24T02:58:37Z"));
}

#[test]
fn a_published_build_adds_no_row_and_a_release_build_is_not_unpublished() {
    let rows_444 = rows(&list(), NOTES, "4.4.4", Some("2026-10-24T05:58:37+03:00"), TimeSource::Tagged);
    assert_eq!(versions(&rows_444), ["4.4.4", "4.4.3", "2.1.10", "2.1.9"]);
    let release = rows(&list(), NOTES, "4.4.5", Some("2026-10-26T10:00:00Z"), TimeSource::Published);
    assert_eq!(versions(&release)[0], "4.4.5");
    assert!(!release[0].unpublished);
    assert_eq!(release[0].released_at, at("2026-10-26T10:00:00Z"));
    assert_eq!(release[0].notes_version.as_deref(), Some("4.4.5"));
    // an unstamped build has no time, and an alpha whose release has no draft has no notes
    let bare = rows(&list(), NOTES, "4.5.0-alpha.1", None, TimeSource::Tagged);
    assert_eq!((bare[0].released_at, bare[0].notes_version.clone()), (None, None));
}

#[test]
fn notes_are_lf_without_a_bom_and_end_in_one_newline() {
    assert_eq!(notes_in(NOTES, "4.4.5").as_deref(), Some("# Orgtree 4.4.5\n\nDraft.\n"));
    assert_eq!(notes_in(NOTES, "9.9.9"), None);
}

#[test]
fn the_glossary_copy_indexes_every_row_and_carries_each_set_of_notes_once() {
    let rows = rows(&list(), NOTES, "4.4.5-alpha.3", Some("2026-10-25T00:34:25+03:00"), TimeSource::Tagged);
    let files = glossary_from(&rows, NOTES);
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, [
        "app-shell/changelog/releases/4.4.5.md",
        "app-shell/changelog/releases/4.4.4.md",
        "app-shell/changelog/releases/4.4.3.md",
        "app-shell/changelog/releases/index.md",
    ]);
    let index = String::from_utf8(files.last().unwrap().1.clone()).unwrap();
    assert!(index.contains("| 4.4.5-alpha.3 (unpublished build) | 2026-10-24 21:34 UTC | [4.4.5.md](4.4.5.md), the draft for 4.4.5 |"), "{index}");
    assert!(index.contains("| 4.4.4 | 2026-10-24 02:58 UTC | [4.4.4.md](4.4.4.md) |"), "{index}");
    assert!(index.contains("| 2.1.10 | 2026-09-21 16:00 UTC | none |"), "{index}");
}

#[test]
fn this_build_bundles_every_published_release_and_no_pre_release_draft() {
    let rows = releases();
    let published: Vec<&Release> = rows.iter().filter(|r| !r.unpublished && r.version != RUNNING).collect();
    assert!(published.len() >= 52, "{} published rows", published.len());
    assert!(published.iter().all(|r| r.notes_version.as_deref() == Some(r.version.as_str())),
        "a published release without notes: {:?}", published.iter().find(|r| r.notes_version.is_none()));
    assert!(published.iter().all(|r| r.released_at.is_some()));
    assert!(rows.windows(2).all(|w| order(&w[0].version) > order(&w[1].version)), "{:?}", versions(rows));
    assert_eq!(rows.last().map(|r| r.version.as_str()), Some("2.0.0"));
    assert!(RELEASE_NOTES.iter().all(|(v, _)| order(v).is_some_and(|o| o.pre.is_empty())));
    for v in ["4.3.2", "2.1.14", "2.0.0"] {
        assert!(notes(v).is_some_and(|n| n.starts_with('#') || n.starts_with("Orgtree")), "{v}");
    }
    // the build the engine is has its row, whatever version this checkout is at
    let own = rows.iter().find(|r| r.version == RUNNING).expect("this build's own row");
    // a stamped build (ORGTREE_BUILD_COMMIT) dates an unlisted own row by its commit (build.rs)
    if option_env!("ORGTREE_BUILD_COMMIT").is_some() && own.unpublished {
        assert!(BUILD_TIME.is_some() && own.released_at == time(BUILD_TIME), "{BUILD_TIME:?} {own:?}");
    }
}
