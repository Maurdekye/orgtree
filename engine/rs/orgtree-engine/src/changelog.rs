//! The Changelog (docket changelog-window-one-row-per-version-pinnable-po, USER
//! 2026-10-24 22:13:55Z: "changelog window. structured identically to the
//! presentations panel, one row per version, latest at the top ... backfill from
//! existing github release descriptions"): one row per published release,
//! newest first, each with its release date & time and its GitHub description.
//! Published releases only (USER 2026-10-25 09:01:38Z, m91aeac18fae1:
//! "Published only"): a local alpha has no row of its own. A release is built
//! before GitHub publishes it, so a release build, which its own list cannot
//! have yet, lists itself.
//!
//! Everything is bundled at build time (build.rs), so it works offline and needs
//! no service:
//! - `RELEASE_NOTES`: `docs/release-notes-<x.y.z>.md`, each release's GitHub
//!   description (release.yml publishes the file; the 52 releases published
//!   before the panel existed were synced from GitHub, coordinator m2be2d725b614);
//! - `RELEASES`: `docs/releases.json`, the published releases and both of their
//!   times.
//!
//! The desktop reads it over HTTP (`http::changelog`). Agents read the same
//! notes in the glossary, beside the orgtree-app › app-shell › changelog page,
//! which `providers::skills` fills from `glossary_files`.

use std::cmp::Ordering;
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

include!(concat!(env!("OUT_DIR"), "/release_notes.rs"));

const RELEASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../docs/releases.json"
));
const RUNNING: &str = env!("CARGO_PKG_VERSION");
const BUILD_TIME: Option<&str> = option_env!("ORGTREE_BUILD_COMMIT_TIME");

/// Which of a published release's two times its row shows as the release date
/// & time: when GitHub published it, or the time of the commit its tag names.
/// USER 2026-10-25 09:01:38Z (m91aeac18fae1): "GitHub publish time". A release
/// build's own row, before its list has it, shows its build commit's time:
/// GitHub publishes the release after it is built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeSource {
    Published,
    Tagged,
}

pub const TIME_SOURCE: TimeSource = TimeSource::Published;

/// One row of the Changelog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    /// its release date & time; None when unknown (a build without a stamp)
    pub released_at: Option<DateTime<Utc>>,
    /// whether this build has its notes (`docs/release-notes-<version>.md`)
    pub has_notes: bool,
}

/// A pre-release identifier. Numbers sort before words, as semver orders them.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Ident {
    Num(u64),
    Text(String),
}

/// A version's place in the list, as semver orders versions: `x.y.z`, then a
/// release after its own pre-releases, `alpha.10` after `alpha.9`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Order {
    core: (u64, u64, u64),
    pre: Vec<Ident>,
}

impl Ord for Order {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| {
            match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            }
        })
    }
}

impl PartialOrd for Order {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[logged]
fn order(version: &str) -> Option<Order> {
    let version = version.split('+').next()?;
    let (core, pre) = version.split_once('-').unwrap_or((version, ""));
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let core = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    let pre = if pre.is_empty() {
        Vec::new()
    } else {
        pre.split('.')
            .map(|p| match p.parse::<u64>() {
                Ok(n) => Ident::Num(n),
                Err(_) => Ident::Text(p.to_string()),
            })
            .collect()
    };
    Some(Order { core, pre })
}

#[logged]
fn time(value: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?.trim())
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// The rows, newest first: the listed releases, and a release build itself
/// when its list does not have it yet, dated by its build commit. A
/// pre-release build adds nothing. Pure over its inputs, so the tests can hand
/// it a release list, notes, a running version and a build time of their own.
/// The desktop finds the newest row the same way (main/changelog-launch.ts
/// `newestListed`), to open the Changelog when it lists a newer release.
/// Not logged: `notes` holds every release's notes.
#[nolog]
fn rows(
    releases: &Value,
    notes: &[(&str, &[u8])],
    running: &str,
    build_time: Option<&str>,
    source: TimeSource,
) -> Vec<Release> {
    let has_notes = |version: &str| notes.iter().any(|(v, _)| *v == version);
    let field = match source {
        TimeSource::Published => "published_at",
        TimeSource::Tagged => "tagged_at",
    };
    let mut out: Vec<Release> = releases["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let version = r["version"].as_str()?;
            // a final version: GitHub's pre-releases stay out, as on the desktop
            order(version).filter(|o| o.pre.is_empty())?;
            Some(Release {
                version: version.to_string(),
                released_at: time(r[field].as_str()),
                has_notes: has_notes(version),
            })
        })
        .collect();
    let release_build = order(running).is_some_and(|o| o.pre.is_empty());
    if release_build && !out.iter().any(|r| r.version == running) {
        out.push(Release {
            version: running.to_string(),
            released_at: time(build_time),
            has_notes: has_notes(running),
        });
    }
    out.sort_by(|a, b| order(&b.version).cmp(&order(&a.version)));
    out.dedup_by(|a, b| a.version == b.version);
    out
}

/// The Changelog as this build has it.
#[nolog]
pub fn releases() -> &'static [Release] {
    static ROWS: OnceLock<Vec<Release>> = OnceLock::new();
    ROWS.get_or_init(|| {
        let releases = serde_json::from_str(RELEASES).unwrap_or(Value::Null);
        rows(&releases, RELEASE_NOTES, RUNNING, BUILD_TIME, TIME_SOURCE)
    })
}

/// One version's notes, Markdown with `\n` line ends (a Windows checkout's
/// files are CRLF). Not logged, nor is anything below that carries notes:
/// they run to tens of kilobytes.
#[nolog]
pub fn notes(version: &str) -> Option<String> {
    notes_in(RELEASE_NOTES, version)
}

#[nolog]
fn notes_in(notes: &[(&str, &[u8])], version: &str) -> Option<String> {
    let (_, bytes) = notes.iter().find(|(v, _)| *v == version)?;
    let text = String::from_utf8_lossy(bytes);
    Some(
        text.trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .trim_end()
            .to_string()
            + "\n",
    )
}

#[logged]
pub fn row_json(r: &Release) -> Value {
    json!({
        "version": r.version,
        "released_at": crate::util::iso_opt(r.released_at),
        "notes": r.has_notes,
    })
}

/// The glossary's copy, beside its changelog page (`orgtree-app/` relative
/// paths): `releases/index.md` lists every row, newest first, and
/// `releases/<version>.md` holds each row's notes.
#[nolog]
pub fn glossary_files() -> Vec<(String, Vec<u8>)> {
    glossary_from(releases(), RELEASE_NOTES)
}

#[nolog]
fn glossary_from(rows: &[Release], notes: &[(&str, &[u8])]) -> Vec<(String, Vec<u8>)> {
    const DIR: &str = "app-shell/changelog/releases";
    let mut index = String::from(
        "# Orgtree releases\n\nEvery row of the Changelog panel, newest first: each \
         published release, when GitHub published it (UTC), and its notes file, the \
         GitHub release description exactly as the panel shows it. A release's own \
         build lists it before this list has its publication, dated by the commit it \
         was built from.\n\n| Version | Released | Notes |\n| --- | --- | --- |\n",
    );
    let mut files = Vec::new();
    for r in rows {
        let v = &r.version;
        let when = r
            .released_at
            .map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string())
            .unwrap_or_else(|| "unknown".into());
        let text = r.has_notes.then(|| notes_in(notes, v)).flatten();
        let link = if text.is_some() { format!("[{v}.md]({v}.md)") } else { "none".into() };
        index.push_str(&format!("| {v} | {when} | {link} |\n"));
        if let Some(text) = text {
            files.push((format!("{DIR}/{v}.md"), text.into_bytes()));
        }
    }
    files.push((format!("{DIR}/index.md"), index.into_bytes()));
    files
}

#[cfg(test)]
mod tests;
