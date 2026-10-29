//! Organization templates: a predefined tree of agents hired when a new
//! organization is created. The templates are the files in
//! ~/.orgtree/templates and nothing else; the built-ins (docs/templates) are
//! written into that folder once each, never over an existing file, and one
//! the user deletes stays deleted (ruling 2026-10-10). A template carries no folders and no accounts: both
//! are this machine's, and are resolved when the org is created.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::providers::catalog;

const BUNDLED: &[(&str, &str)] = &[
    ("devteam-claude.json", include_str!("../../../../docs/templates/devteam-claude.json")),
    ("devteam-codex.json", include_str!("../../../../docs/templates/devteam-codex.json")),
    ("devteam-muse.json", include_str!("../../../../docs/templates/devteam-muse.json")),
    ("devteam-antigravity.json", include_str!("../../../../docs/templates/devteam-antigravity.json")),
    ("heavy-dev-shop.json", include_str!("../../../../docs/templates/heavy-dev-shop.json")),
];
pub(crate) const FILE_MAX: u64 = 16 * 1024 * 1024;

#[derive(Deserialize, Debug, Clone)]
#[serde(try_from = "super::template_wire::Wire")]
pub struct Template {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// written to the new org's org.md
    #[serde(default)]
    pub org_md: Option<String>,
    #[serde(default)]
    pub agents: Vec<Slot>,
    /// Optional org-wide scratch AGENTS.md, never a path.
    #[serde(default)]
    pub shared_agents_md: Option<super::template_notes::Text>,
    /// Quick chat's starting superior, model and effort in the new org
    /// (user 2026-10-10 19:31Z); the org's own picks win once made
    #[serde(default)]
    pub quick_chat: Option<Value>,
    /// org-wide settings for the new org (user 2026-10-10 19:40Z): only
    /// `ORG_SETTINGS` keys
    #[serde(default)]
    pub settings: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub watchdogs: Vec<super::template_links::Dog>,
    #[serde(default)]
    pub audiences: Vec<super::template_links::Grant>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Provisional: inert definitions/initial JSON only, never saved copies or grants.
    #[serde(default)]
    pub apps: Vec<super::apps::templates::App>,
}

/// The org settings a template may carry: every Org settings key except
/// this computer's own (folders `dirs`, `default_account`,
/// `disabled_accounts`, hubs), the inert `headless`, and `quick_chat` (its
/// own part).
pub const PROJECT_SETTINGS: &[&str] = &["mail_queue", "exclude_sender", "ack_timeout", "max_attempts", "ack_reminders", "turn_end_reminder", "event_listeners"];

pub const ORG_SETTINGS: &[&str] = &[
    "max_top_grant", "default_top_grant", "compact_at", "default_tools", "default_visibility", "permission_mode",
    "default_effort", "auto_resume", "auto_resume_compact", "auto_cheap_compact",
    "org_inbox_enabled", "org_inbox_mode", "org_inbox_multi_holder", "account_fallback_default",
];

/// Org settings that moved to App settings > Runtime. An older template may still carry them: they are accepted
/// and ignored, and never exported.
pub use crate::feed::groups::RETIRED_SETTINGS;

#[derive(Deserialize, Debug, Clone)]
pub struct Slot {
    pub name: String,
    pub tier: String,
    /// tier=project denotes a structural container with no model or credits.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub slots: Option<i64>,
    #[serde(default)]
    pub peer_mail: Option<bool>,
    #[serde(default)]
    pub settings: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub audiences: Vec<String>,
    #[serde(default)]
    pub team_agents_md: Option<super::template_notes::Text>,
    #[serde(default)]
    pub scratch_agents_md: Option<super::template_notes::Text>,
    /// tried in order when `tier` cannot run on this machine
    #[serde(default)]
    pub fallback: Vec<String>,
    #[serde(default)]
    pub charter: Charter,
    #[serde(default)]
    pub team_charter: Option<String>,
    /// credits this agent keeps free; its grant adds its reports' seats and grants
    #[serde(default)]
    pub spare: f64,
    #[serde(default)]
    pub tools: Option<Value>,
    #[serde(default)]
    pub org_visibility: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub fast_mode: Option<bool>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub account_fallback: Option<bool>,
    /// a preferred account (saved templates only): used when it can run the
    /// slot's tier on this machine, else the normal choice applies
    #[serde(default)]
    pub account: Option<String>,
    /// folders (saved templates only), clamped to the new org's at creation
    #[serde(default)]
    pub add_dirs: Option<Vec<Value>>,
    /// a first message, sent only when the user asks for it at creation
    #[serde(default)]
    pub kickoff: Option<String>,
    /// Index of the preceding parent in Template.agents; never wire input.
    #[serde(skip)]
    pub parent: Option<usize>,
}

#[nolog]
impl Slot {
    pub fn project(&self) -> bool { self.tier == super::projects::TIER }
}

/// A charter preset by name, plain text, or both (preset first).
#[derive(Deserialize, Debug, Clone, Default)]
pub struct Charter {
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// What this machine can staff: tier → (seat, provider, eligible account
/// ids, whether the provider's own sign-in can run it).
#[derive(Debug, Clone)]
pub struct Avail {
    pub tiers: HashMap<String, Offer>,
    /// the tiers in the order the staffing options list them (a map has none)
    pub order: Vec<String>,
    /// the effective hire-default account, if any
    pub default_account: Option<String>,
    /// when the readings were judged (resets are compared with it)
    pub now: chrono::DateTime<chrono::Utc>,
    /// the first sign-in check has not landed: a missing Claude or Codex
    /// tier is unchecked, not signed out
    pub checking: bool,
    pub fast_tiers: HashSet<String>,
    pub harnesses: Vec<String>,
}

impl Default for Avail {
    fn default() -> Self {
        Avail { tiers: HashMap::new(), order: Vec::new(), default_account: None, now: chrono::Utc::now(), checking: false, fast_tiers: HashSet::new(), harnesses: Vec::new() }
    }
}

impl Avail {
    /// The offered tiers as a list is shown: the staffing options' order
    /// when it is known, then any other by the catalog's listing order, then
    /// by name, so the answer never depends on a map's iteration order.
    #[nolog]
    pub fn listed(&self) -> Vec<(&String, &Offer)> {
        let mut out: Vec<(&String, &Offer)> = self.tiers.iter().collect();
        let at = |k: &String| self.order.iter().position(|o| o == k).unwrap_or(usize::MAX);
        out.sort_by(|a, b| at(a.0).cmp(&at(b.0)).then(catalog::listed_rank(a.0).cmp(&catalog::listed_rank(b.0))).then(a.0.cmp(b.0)));
        out
    }
}

#[derive(Debug, Clone)]
pub struct Offer {
    pub seat: f64,
    pub provider: String,
    pub accounts: Vec<String>,
    pub default_ok: bool,
    /// the cached usage reading of each candidate (`primary` = the
    /// provider's own sign-in), for the balancing rule; none = unread
    pub readings: HashMap<String, Reading>,
}

/// What balancing reads from one login's cached usage, over the windows
/// the tier spends: the last of their resets (the window worth
/// preserving) and the highest percent used.
#[derive(Debug, Clone, Copy, Default)]
pub struct Reading {
    pub reset: Option<chrono::DateTime<chrono::Utc>>,
    pub used: Option<f64>,
}

/// A reset this close counts as soon: that capacity refreshes anyway, so it
/// is spent first (the user's balancing rule 2026-09-12, rule 2).
const SOON_HOURS: i64 = 24;

/// Order candidate logins by the balancing rule. Those whose reset is soon
/// come first, the sooner the earlier; the rest (reset far off or unknown)
/// by lower usage. Logins with no reading keep today's order after the read
/// ones, and with no reading at all the order is unchanged.
#[logged]
pub fn balance(order: &[String], readings: &HashMap<String, Reading>, now: chrono::DateTime<chrono::Utc>) -> Vec<String> {
    let read: Vec<(usize, &String, Reading)> = order.iter().enumerate()
        .filter_map(|(i, id)| readings.get(id).filter(|r| r.reset.is_some() || r.used.is_some()).map(|r| (i, id, *r)))
        .collect();
    let soon = |r: &Reading| r.reset.is_some_and(|t| t - now <= chrono::Duration::hours(SOON_HOURS));
    let mut near: Vec<_> = read.iter().filter(|(_, _, r)| soon(r)).collect();
    near.sort_by(|a, b| a.2.reset.cmp(&b.2.reset).then(a.0.cmp(&b.0)));
    let mut far: Vec<_> = read.iter().filter(|(_, _, r)| !soon(r)).collect();
    far.sort_by(|a, b| a.2.used.unwrap_or(f64::MAX).total_cmp(&b.2.used.unwrap_or(f64::MAX))
        .then(a.2.reset.cmp(&b.2.reset)).then(a.0.cmp(&b.0)));
    let mut out: Vec<String> = near.iter().chain(far.iter()).map(|(_, id, _)| (*id).clone()).collect();
    out.extend(order.iter().filter(|id| !out.contains(id)).cloned().collect::<Vec<_>>());
    out
}

/// The user's changes in the picker: per slot a different tier or name,
/// and slots taken out (with everything under them).
#[derive(Deserialize, Debug, Default, Clone)]
pub struct Choices {
    #[serde(default)]
    pub overrides: BTreeMap<String, SlotChoice>,
    #[serde(default)]
    pub removed: Vec<String>,
}

#[derive(Deserialize, Debug, Default, Clone)]
pub struct SlotChoice {
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub fast_mode: Option<bool>,
    #[serde(default)]
    pub harness: Option<String>,
}

fn user_dir() -> PathBuf {
    crate::rig::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".orgtree").join("templates")
}

#[logged]
pub fn folder() -> PathBuf {
    user_dir()
}

/// The note of the built-ins already written into the folder once.
const SEEDED: &str = ".seeded";

/// Write each built-in the folder has never had: at every engine start and
/// every listing. A file already there is never touched, and a built-in the
/// note names is not written again, so one the user deleted stays deleted.
#[logged]
pub fn seed() -> Result<Vec<String>, String> {
    seed_into(&user_dir())
}

#[logged]
fn seed_into(dir: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("the templates folder {} could not be created: {e}", dir.display()))?;
    let note = dir.join(SEEDED);
    let mut seeded: Vec<String> = std::fs::read_to_string(&note)
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    let before = seeded.len();
    let mut created = Vec::new();
    for (f, body) in BUNDLED {
        if seeded.iter().any(|s| s == f) {
            continue;
        }
        let p = dir.join(f);
        if !p.exists() {
            std::fs::write(&p, body).map_err(|e| format!("{f} could not be written: {e}"))?;
            created.push(f.to_string());
        }
        seeded.push(f.to_string());
    }
    if seeded.len() != before {
        let text = format!("# Built-in templates Orgtree has written here once; it does not write them again.
{}
", seeded.join("
"));
        std::fs::write(&note, text).map_err(|e| format!("{SEEDED} could not be written: {e}"))?;
    }
    Ok(created)
}

/// Every template: the folder's files, after seeding it.
#[logged]
pub fn list() -> Vec<(Result<Template, String>, &'static str, String)> {
    listing().0
}

/// The folder's templates, and why the folder could not be seeded, if so.
#[logged]
pub fn listing() -> (Vec<(Result<Template, String>, &'static str, String)>, Option<String>) {
    let dir = user_dir();
    let problem = seed_into(&dir).err();
    (list_in(&dir), problem)
}

/// The `.json` files in `dir`, each with its problems (empty = usable).
#[logged]
fn list_in(dir: &Path) -> Vec<(Result<Template, String>, &'static str, String)> {
    let mut out = Vec::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json") && p.is_file()).collect())
        .unwrap_or_default();
    files.sort();
    for p in files {
        let file = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let parsed = if std::fs::metadata(&p).map(|m| m.len() > FILE_MAX).unwrap_or(true) {
            Err(format!("{file} exceeds 16 MiB ({FILE_MAX} bytes)"))
        } else {
            // Bound the actual read as well as metadata: an editor may grow a
            // file between stat and open. Parsing still checks the real length.
            (|| {
                let mut s=String::new();
                std::fs::File::open(&p).map_err(|e| e.to_string())?.take(FILE_MAX+1)
                    .read_to_string(&mut s).map_err(|e| e.to_string())?;
                parse(&s)
            })()
        };
        out.push((parsed, "folder", p.to_string_lossy().to_string()));
    }
    out
}

// Template text may contain private notes; never log the raw document.
#[nolog]
pub fn parse(s: &str) -> Result<Template, String> {
    if s.len() as u64 > FILE_MAX { return Err("template file exceeds 16 MiB".into()); }
    serde_json::from_str::<Template>(s).map_err(|e| format!("not a valid template: {e}"))
}

/// The usable template with this id.
#[logged]
pub fn find(id: &str) -> Result<Template, String> {
    for (t, _, _) in list() {
        if let Ok(t) = t {
            if t.id == id {
                let problems = validate(&t);
                if !problems.is_empty() {
                    return Err(format!("template '{id}' cannot be used: {}", problems.join("; ")));
                }
                return Ok(t);
            }
        }
    }
    Err(format!("no template '{id}'"))
}

#[nolog]
fn walk<'a>(slots: &'a [Slot], depth: usize, parent: Option<&'a str>, out: &mut Vec<(&'a Slot, usize, Option<&'a str>)>) {
    let mut depths = Vec::with_capacity(slots.len());
    for s in slots {
        let d = s.parent.map_or(depth, |p| depths[p] + 1);
        let p = s.parent.map(|p| slots[p].name.as_str()).or(parent);
        depths.push(d); out.push((s, d, p));
    }
}

/// Problems that make a template unusable on any machine.
#[logged]
pub fn validate(t: &Template) -> Vec<String> {
    let mut p = Vec::new();
    for d in &t.watchdogs {
        if let Err(e) = super::template_links::validate(d) { p.push(e); }
    }
    if t.id.trim().is_empty() || t.name.trim().is_empty() {
        p.push("a template needs an id and a name".to_string());
    }
    if t.agents.is_empty() {
        p.push("a template needs at least one agent".to_string());
    }
    let mut all = Vec::new();
    walk(&t.agents, 0, None, &mut all);

    if !all.iter().any(|(s,_,_)| !s.project()) { p.push("a template needs at least one agent".into()); }
    let mut names = HashSet::new();
    for (s, depth, _) in &all {

        match crate::domain::ops::valid_name(&s.name) {
            Ok(n) if !names.insert(n.to_lowercase()) => p.push(format!("{}: the name is used twice", s.name)),
            Ok(_) => {}
            Err(e) => p.push(format!("{}: {e}", s.name)),
        }
        if s.project() {
            if !s.fallback.is_empty() || s.spare != 0.0 || !s.audiences.is_empty() || s.kickoff.is_some()
                || s.tools.is_some() || s.effort.is_some() || s.fast_mode.is_some() || s.harness.is_some() || s.account.is_some() || s.add_dirs.is_some()
                || s.org_visibility.is_some() || s.permission_mode.is_some() || s.account_fallback.is_some()
                || s.charter.preset.is_some() || s.charter.text.is_some() || s.team_charter.is_some() || s.scratch_agents_md.is_some() {
                p.push(format!("{}: project slots cannot carry agent settings; use description for Summary", s.name));
            }
            if let Some(settings) = &s.settings {
                if let Err(e) = super::ops::project_setting_ops(&s.name, &Value::Object(settings.clone())) { p.push(format!("{}: {e}", s.name)); }
                if settings.keys().any(|k| !PROJECT_SETTINGS.contains(&k.as_str())) { p.push(format!("{}: only queue/event settings belong in project settings", s.name)); }
            }
            if s.slots.is_some_and(|n| !(0..=super::slots::MAX_CAPACITY).contains(&n)) {
                p.push(format!("{}: invalid project slots capacity", s.name));
            }
        } else if s.description.is_some() || s.slots.is_some() || s.peer_mail.is_some() || s.settings.is_some() {
            p.push(format!("{}: description, slots and peer_mail belong to project slots", s.name));
        }
        if s.audiences.len() > 64 || s.audiences.iter().any(|a| !matches!(a.as_str(), "user" | "extern")) {
            p.push(format!("{}: template audiences must be user or extern (at most 64)", s.name));
        }
        for tier in std::iter::once(&s.tier).chain(&s.fallback).filter(|_| !s.project()) {
            if catalog::tier(tier).is_none() && !catalog::is_openrouter(tier) && !catalog::is_langserver(tier) {
                p.push(format!("{}: unknown tier '{tier}'", s.name));
            }
        }
        if !(s.spare.is_finite() && s.spare >= 0.0) {
            p.push(format!("{}: spare credits must be 0 or more", s.name));
        }
        if let Some(preset) = &s.charter.preset {
            if crate::http::settings::preset_content(preset).is_none() {
                p.push(format!("{}: no charter preset '{preset}'", s.name));
            }
        }
        if s.kickoff.is_some() && *depth > 0 {
            p.push(format!("{}: only a top-level agent may carry a first message", s.name));
        }
    }
    let note_bytes = t.shared_agents_md.iter().chain(all.iter().flat_map(|(s, _, _)|
        s.team_agents_md.iter().chain(s.scratch_agents_md.iter()))).map(|n| n.0.len()).sum::<usize>();
    if note_bytes > super::template_notes::TOTAL_MAX {
        p.push(format!("standing notes exceed {} bytes in total", super::template_notes::TOTAL_MAX));
    }
    if let Some(q) = &t.quick_chat {
        if let Err(e) = quick_chat(q) {
            p.push(e);
        }
    }
    for k in t.settings.iter().flat_map(|s| s.keys()) {
        if !ORG_SETTINGS.contains(&k.as_str()) && !RETIRED_SETTINGS.contains(&k.as_str()) {
            p.push(format!("a template cannot set the org setting '{k}'"));
        }
    }
    p
}

/// Quick chat defaults as stored (an org setting, a template field): an
/// object holding only the fields that are set. `superior` null = top level
/// and `effort` '' = the org's default effort are real choices, kept.
#[logged]
pub fn quick_chat(v: &Value) -> Result<Value, String> {
    let o = v.as_object().ok_or("quick_chat is an object of superior, tier and effort")?;
    let mut out = serde_json::Map::new();
    for (k, x) in o {
        match k.as_str() {
            "superior" => match x {
                Value::Null => {
                    out.insert(k.clone(), Value::Null);
                }
                Value::String(n) => {
                    let n = crate::domain::ops::valid_name(n).map_err(|e| format!("quick_chat superior: {e}"))?;
                    out.insert(k.clone(), json!(n));
                }
                _ => return Err("quick_chat superior is an agent name or null (top level)".into()),
            },
            "tier" => match x.as_str() {
                Some(t) if catalog::tier(t).is_some() || catalog::is_openrouter(t) || catalog::is_langserver(t) => {
                    out.insert(k.clone(), json!(t));
                }
                Some(t) => return Err(format!("quick_chat: unknown tier '{t}'")),
                None => return Err("quick_chat tier is a tier name".into()),
            },
            "effort" => match x.as_str() {
                Some(e) if e.is_empty() || catalog::effort_rank(e).is_some() => {
                    out.insert(k.clone(), json!(e));
                }
                _ => return Err(format!("quick_chat effort must be '' (the org default) or one of {}", catalog::EFFORT_ORDER.join(", "))),
            },
            other => return Err(format!("quick_chat has no field '{other}'")),
        }
    }
    Ok(Value::Object(out))
}

/// A template's Quick chat defaults for the org created from it: the
/// superior follows its slot's final name, and one the layout no longer
/// holds (removed, or never in it) is top level.
#[logged]
pub fn quick_chat_for(t: &Template, planned: &[Planned]) -> Option<Value> {
    let mut q = quick_chat(t.quick_chat.as_ref()?).ok()?;
    if let Some(s) = q.get("superior").and_then(Value::as_str).map(str::to_string) {
        let found = planned.iter().find(|p| p.slot.name.eq_ignore_ascii_case(&s)).map(|p| p.name.clone());
        q["superior"] = found.map_or(Value::Null, |n| json!(n));
    }
    Some(q)
}

/// What this machine can staff now, from the staffing options every hire
/// surface reads.
#[logged]
pub fn avail(engine: &Engine, org_slug: &str) -> Avail {
    let opts = crate::domain::staffing::options(engine, org_slug);
    let mut tiers = HashMap::new();
    let mut order = Vec::new();
    for t in opts["tiers"].as_array().into_iter().flatten() {
        let Some(tier) = t["tier"].as_str() else { continue };
        order.push(tier.to_string());
        let accounts: Vec<String> = t["accounts"].as_array().into_iter().flatten().filter_map(|a| a["id"].as_str().map(str::to_string)).collect();
        let default_ok = t["default_ok"].as_bool().unwrap_or(false);
        let view = engine.accounts.view();
        let mut readings = HashMap::new();
        if default_ok {
            if let Some(r) = crate::usage::balance_reading(engine, None, tier) { readings.insert("primary".to_string(), r); }
        }
        for id in &accounts {
            if let Some(r) = view.get(id).and_then(|a| crate::usage::balance_reading(engine, Some(a), tier)) {
                readings.insert(id.clone(), r);
            }
        }
        tiers.insert(tier.to_string(), Offer {
            seat: t["seat"].as_f64().unwrap_or(0.0),
            provider: t["provider"].as_str().unwrap_or("").to_string(),
            accounts, default_ok, readings,
        });
    }
    let defaults = engine.settings.defaults();
    let eff = crate::feed::groups::effective_settings(&json!({}), &defaults);
    let st = engine.providers.state.load();
    let fast_tiers = tiers.keys().filter(|t| crate::providers::fast_mode::supported(&st, t, None)).cloned().collect();
    let harnesses = crate::harnesses::choices(engine, catalog::OPENROUTER).into_iter().map(|h| h.to_string()).collect();
    Avail { tiers, order, fast_tiers, harnesses, default_account: eff["default_account"].as_str().filter(|s| !s.is_empty()).map(str::to_string), now: chrono::Utc::now(),
            checking: opts["loading"].as_bool().unwrap_or(false) }
}

/// One planned hire.
#[derive(Debug, Clone)]
pub struct Planned {
    pub slot: Slot,
    pub name: String,
    pub parent: Option<String>,
    pub depth: usize,
    pub tier: Option<String>,
    pub note: Option<String>,
    /// `primary`, an account id, or None (OpenRouter bills its key; a
    /// language model server bills nobody)
    pub account: Option<String>,
    pub seat: f64,
    pub grant: f64,
    /// the folders asked for, after clamping; None inherits the superior's
    pub add_dirs: Option<Vec<Value>>,
    /// saved folders the new org does not hold
    pub dirs_dropped: Vec<String>,
}

/// Whether a tier missing from the offer is only unchecked: the first
/// sign-in check has not landed and the tier needs a signed-in CLI.
#[nolog]
fn checking(av: &Avail, tier: &str) -> bool {
    av.checking && matches!(catalog::provider_of(tier), catalog::CLAUDE | catalog::OPENAI)
}

#[nolog]
fn checking_note(tier: &str) -> String {
    format!("{tier}: checking the {} sign-in; this updates in a moment", catalog::provider_label(catalog::provider_of(tier)))
}

/// Resolve a template against what this machine can run. Each slot takes
/// the user's tier, else the first of its tier and fallbacks on offer; a
/// slot with none is blocked. Grants are worked out bottom-up from each
/// slot's spare credits and its reports' seats and grants.
#[logged]
pub fn plan(t: &Template, choices: &Choices, av: &Avail, org_dirs: &[Value]) -> Result<(Vec<Planned>, Vec<String>), String> {
    let removed: HashSet<&str> = choices.removed.iter().map(String::as_str).collect();
    for r in &removed {
        if t.agents.iter().any(|a| super::template_wire::is_layout_root(a) && a.name == *r) {
            return Err(format!("{r} is the top of the layout and cannot be removed; choose Empty instead"));
        }
    }
    let mut all = Vec::new();
    walk(&t.agents, 0, None, &mut all);
    for (s,_,_) in all {
        if s.project() && choices.overrides.get(&s.name).and_then(|c| c.tier.as_deref()).is_some_and(|tier| tier != super::projects::TIER) {
            return Err(format!("{} is a project and cannot select a model", s.name));
        }
    }
    let mut out: Vec<Planned> = Vec::new();
    let mut blocked = Vec::new();
    let mut positions: Vec<Option<usize>> = vec![None; t.agents.len()];
    let mut depths = vec![0; t.agents.len()];
    let mut ceilings: Vec<Vec<Value>> = vec![Vec::new(); t.agents.len()];
    for (index, s) in t.agents.iter().enumerate() {
            if removed.contains(s.name.as_str()) || s.parent.is_some_and(|p| positions[p].is_none()) { continue; }
            let depth = s.parent.map_or(0, |p| depths[p] + 1); depths[index] = depth;
            let parent = s.parent.and_then(|p| positions[p]).map(|p: usize| out[p].name.clone());
            let ceiling = s.parent.map_or(org_dirs, |p| ceilings[p].as_slice());
            let ch = choices.overrides.get(&s.name).cloned().unwrap_or_default();
            let name = ch.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&s.name).to_string();
            if s.project() {
                let at = out.len();
                out.push(Planned { slot: s.clone(), name: name.clone(), parent: parent.clone(), depth,
                    tier: Some(super::projects::TIER.to_string()), note: None, account: None, seat: 0.0, grant: 0.0,
                    add_dirs: None, dirs_dropped: Vec::new() });
                positions[index] = Some(at); ceilings[index] = ceiling.to_vec();
                continue;
            }
            let (tier, note) = match ch.tier.as_deref().filter(|x| !x.is_empty()) {
                Some(x) if av.tiers.contains_key(x) => (Some(x.to_string()), (x != s.tier).then(|| "chosen by you".to_string())),
                Some(x) if checking(av, x) => (None, Some(checking_note(x))),
                Some(x) => (None, Some(format!("{x} cannot run on this computer now"))),
                None => match std::iter::once(&s.tier).chain(&s.fallback).find(|x| av.tiers.contains_key(*x)) {
                    Some(x) if *x == s.tier => (Some(x.clone()), None),
                    Some(x) => (Some(x.clone()), Some(format!("{} → {x}: {} is not available", s.tier, s.tier))),
                    None if catalog::is_langserver(&s.tier) => (None, Some(format!(
                        "{} cannot run on this computer now (no language model server here offers it, or its server is turned off)", s.tier))),
                    None if checking(av, &s.tier) => (None, Some(checking_note(&s.tier))),
                    None => (None, Some(format!("{} cannot run on this computer now ({} is not signed in or turned off)",
                        s.tier, catalog::provider_label(catalog::provider_of(&s.tier))))),
                },
            };
            let offer = tier.as_ref().and_then(|x| av.tiers.get(x));
            if offer.is_none() {
                blocked.push(name.clone());
            }
            let mut note = note;
            let account = offer.and_then(|o| {
                let fits = |a: &str| (a == "primary" && o.default_ok) || o.accounts.iter().any(|x| x == a);
                // a language model server bills nobody (an OpenRouter tier is placed
                // on its keys like any login: `primary` is the original key)
                if o.provider == catalog::LANGSERVER {
                    None
                } else if let Some(a) = s.account.as_ref().filter(|a| fits(a)) {
                    Some(a.clone())
                } else {
                    // today's order (the hire default, the provider's own
                    // sign-in, the rest by id), re-ranked by cached usage
                    let mut order: Vec<String> = av.default_account.iter().filter(|d| o.accounts.contains(d)).cloned().collect();
                    if o.default_ok { order.push("primary".to_string()); }
                    let rest: Vec<String> = o.accounts.iter().filter(|a| !order.contains(a)).cloned().collect();
                    order.extend(rest);
                    balance(&order, &o.readings, av.now).into_iter().next()
                }
            });
            if let (Some(want), Some(got)) = (&s.account, &account) {
                if want != got {
                    note = Some([note.clone(), Some(format!("saved account {want} cannot run it here; using {got}"))]
                        .into_iter().flatten().collect::<Vec<_>>().join("; "));
                }
            }
            let (add_dirs, dirs_dropped) = match &s.add_dirs {
                None => (None, Vec::new()),
                Some(want) => {
                    let kept = crate::domain::scope::clamp_dirs(want, ceiling);
                    let dropped = want.iter().filter_map(|d| d["path"].as_str())
                        .filter(|p| !kept.iter().any(|k| k["path"].as_str() == Some(*p))).map(str::to_string).collect();
                    (Some(kept), dropped)
                }
            };
            ceilings[index] = add_dirs.clone().unwrap_or_else(|| ceiling.to_vec());
            let seat = offer.map(|o| o.seat).unwrap_or(0.0);
            let at = out.len();
            let mut slot = s.clone();
            slot.fast_mode = ch.fast_mode.or(slot.fast_mode);
            slot.harness = ch.harness.clone().or(slot.harness);
            if slot.fast_mode == Some(true) && !tier.as_ref().is_some_and(|t| av.fast_tiers.contains(t)) {
                blocked.push(name.clone()); note = Some("saved fast mode is unavailable for this model; turn it off or choose another model".into());
            }
            if let Some(pin) = &slot.harness {
                if tier.as_deref().is_some_and(catalog::is_openrouter) {
                    if !av.harnesses.contains(pin) { blocked.push(name.clone()); note = Some(format!("pinned harness {pin} is unavailable here; choose an installed harness")); }
                } else { slot.harness = None; note = Some("saved OpenRouter harness pin does not apply to the selected provider".into()); }
            }
            out.push(Planned { slot, name: name.clone(), parent: parent.clone(), depth, tier, note, account,
                               seat, grant: 0.0, add_dirs, dirs_dropped });
            positions[index] = Some(at);
    }
    let mut costs = vec![0.0; out.len()];
    for index in (0..t.agents.len()).rev() {
        let Some(at) = positions[index] else { continue };
        let grant = if out[at].slot.project() { 0.0 } else { round2(out[at].slot.spare + costs[at]) };
        out[at].grant = grant;
        let cost = if out[at].slot.project() { costs[at] } else { out[at].seat + grant };
        if let Some(parent) = t.agents[index].parent.and_then(|p| positions[p]) { costs[parent] += cost; }
    }
    let mut names = HashSet::new();
    for p in &out {
        match crate::domain::ops::valid_name(&p.name) {
            Ok(n) if !names.insert(n.to_lowercase()) => return Err(format!("{}: the name is used twice", p.name)),
            Ok(_) => {}
            Err(e) => return Err(format!("{}: {e}", p.name)),
        }
    }
    Ok((out, blocked))
}

#[nolog]
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// The charter a slot is hired with: the preset's text (a user copy first),
/// then any extra text.
#[logged]
pub fn charter_of(s: &Slot) -> String {
    let preset = s.charter.preset.as_deref().and_then(crate::http::settings::preset_content);
    [preset, s.charter.text.clone()].into_iter().flatten().filter(|t| !t.trim().is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// The hire request for one planned slot (a user hire: anything the template
/// leaves out takes the org's hire defaults, folders included).
#[logged]
pub fn hire_request(p: &Planned, kickoff: bool) -> Value {
    let s = &p.slot;
    if s.project() {
        let mut req = json!({ "op": "create_project", "name": p.name,
            "parent": p.parent.clone().unwrap_or_else(|| "user".to_string()) });
        if let Some(description) = &s.description { req["description"] = json!(description); }
        return req;
    }
    let mut req = json!({
        "op": "hire",
        "name": p.name,
        "tier": p.tier,
        "grant": p.grant,
        "parent": p.parent.clone().unwrap_or_else(|| "user".to_string()),
        "charter": charter_of(s),
    });
    if !s.audiences.is_empty() { req["audiences"] = json!(s.audiences); }
    if let Some(a) = &p.account { req["account"] = json!(a); }
    if let Some(tc) = s.team_charter.as_ref().filter(|t| !t.trim().is_empty()) { req["team_charter"] = json!(tc); }
    match &s.tools {
        Some(Value::String(all)) if all == "all" => {
            req["tools"] = json!({ "bash": true, "web": true, "edit": true, "subagents": true });
        }
        Some(v @ Value::Object(_)) => req["tools"] = v.clone(),
        _ => {}
    }
    if let Some(v) = &s.org_visibility { req["org_visibility"] = json!(v); }
    if let Some(v) = &s.permission_mode { req["permission_mode"] = json!(v); }
    if let Some(v) = &s.effort { req["effort"] = json!(v); }
    if let Some(v) = s.fast_mode { req["fast_mode"] = json!(v); }
    if let Some(v) = &s.harness { req["harness"] = json!(v); }
    if let Some(b) = s.account_fallback { req["account_fallback"] = json!(b); }
    if let Some(d) = &p.add_dirs { req["add_dirs"] = json!(d); }
    if kickoff && p.depth == 0 {
        if let Some(k) = s.kickoff.as_ref().filter(|k| !k.trim().is_empty()) { req["kickoff"] = json!(k); }
    }
    req
}

/// A project is created and configured through the same canonical operations as tools/UI.
#[logged]
pub fn creation_requests(p: &Planned, kickoff: bool) -> Vec<Value> {
    let mut out = vec![hire_request(p, kickoff)];
    if p.slot.project() {
        let mut settings = json!(p.slot.settings.clone().unwrap_or_default());
        if let Some(n) = p.slot.slots { settings["slots"] = json!(n); }
        if let Some(on) = p.slot.peer_mail { settings["peer_mail"] = json!(on); }
        if !settings.as_object().unwrap().is_empty() {
            out.push(json!({ "op": "configure_project", "node": p.name, "settings": settings }));
        }
    }
    out
}

/// One inherited-audience boundary around the canonical template node steps.
/// Explicit template grants still follow these steps through grant_tx; their
/// notices and checks are unchanged. Nothing publishes Effects before commit.
#[logged]
pub(crate) async fn create_nodes(engine: &std::sync::Arc<Engine>, org: &std::sync::Arc<crate::orgs::OrgHandle>,
                                tx: &tokio_postgres::Transaction<'_>, planned: &[Planned], kickoff: bool,
                                fx: &mut super::ops::Effects) -> anyhow::Result<(Vec<Value>, Vec<Value>)> {
    let before = super::audience_notices::snapshot(tx, org.id).await?;
    let mut hired = Vec::new();
    let mut projects = Vec::new();
    for p in planned {
        for (index, req) in creation_requests(p, kickoff).into_iter().enumerate() {
            let out = super::ops::run_in_tx_without_audience_notices(engine, org, tx, &super::ops::Actor::User, &req, fx)
                .await.map_err(|err| err.context(format!("could not create {} from the template", p.name)))?;
            if index == 0 {
                if p.slot.project() { projects.push(out["node"].clone()); }
                else { hired.push(out["node"].clone()); }
            }
        }
    }
    super::ops::record_audience_delta(tx, org.id, &before, fx).await?;
    Ok((hired, projects))
}

/// The preview the picker shows.
#[logged]
pub fn plan_json(t: &Template, planned: &[Planned], blocked: &[String]) -> Value {
    let links = super::template_links::plan(t, planned);
    let rows: Vec<Value> = planned.iter().map(|p| json!({
        "slot": p.slot.name, "name": p.name, "parent": p.parent, "depth": p.depth,
        "tier": p.tier, "requested_tier": p.slot.tier, "note": p.note, "account": p.account,
        "provider": p.tier.as_deref().filter(|_| !p.slot.project()).map(catalog::provider_of),
        "seat": p.seat, "grant": p.grant, "fast_mode": p.slot.fast_mode, "harness": p.slot.harness,
        "charter": match (&p.slot.charter.preset, &p.slot.charter.text) {
            (Some(n), _) => format!("preset: {n}"), (None, Some(_)) => "text".to_string(), _ => "none".to_string() },
        "team_charter": p.slot.team_charter, "kickoff": p.slot.kickoff.is_some() && p.depth == 0,
        "blocked": p.tier.is_none() || blocked.contains(&p.name), "dirs_dropped": p.dirs_dropped,
        "watchdogs": links.dogs.iter().filter(|d| d.owner == p.name).count(),
        "audiences": p.slot.audiences.iter().cloned().chain(links.audiences.iter().filter(|g| g.grantee == p.name).map(|g| g.grantor.clone())).collect::<Vec<_>>(),
    })).collect();
    let top: f64 = planned.iter().filter(|p| p.depth == 0).map(|p| p.grant).sum();
    let mut out = json!({ "id": t.id, "name": t.name, "agents": rows, "org_md": t.org_md.is_some(), "blocked": blocked, "ok": blocked.is_empty(), "top_grant": round2(top), "apps":t.apps.len() });
    let notes = usize::from(t.shared_agents_md.is_some()) + planned.iter().map(|p|
        usize::from(p.slot.team_agents_md.is_some()) + usize::from(p.slot.scratch_agents_md.is_some())).sum::<usize>();
    if notes > 0 { out["standing_notes"] = json!(notes); }
    out["warnings"] = json!(links.warnings);
    out
}

/// A nonempty preset is unavailable only after checking, with no offered slot.
#[nolog]
pub fn unusable_here(planned: &[Planned], checking: bool) -> bool {
    let agents: Vec<_> = planned.iter().filter(|p| !p.slot.project()).collect();
    !checking && !agents.is_empty() && agents.iter().all(|p| p.tier.is_none())
}

/// Add machine availability without changing file validation or ordering.
#[logged]
pub fn summary_with_availability(t: &Result<Template, String>, source: &str, path: &str, av: &Avail) -> Value {
    let mut out = summary(t, source, path);
    if let Ok(t) = t {
        if validate(t).is_empty() {
            if let Ok((planned, _)) = plan(t, &Choices::default(), av, &[]) {
                let unusable = unusable_here(&planned, av.checking);
                let providers: BTreeMap<String, ()> = planned.iter().filter(|p| !p.slot.project()).flat_map(|p|
                    std::iter::once(&p.slot.tier).chain(&p.slot.fallback))
                    .map(|tier| (catalog::provider_label(catalog::provider_of(tier)).to_string(), ())).collect();
                let reason = unusable.then(|| format!("needs {}", providers.keys().cloned().collect::<Vec<_>>().join(" or ")));
                out["availability"] = json!({ "unusable": unusable, "checking": av.checking, "reason": reason });
            }
        }
    }
    out
}

#[logged]
pub fn summary(t: &Result<Template, String>, source: &str, path: &str) -> Value {
    match t {
        Ok(t) => {
            let mut all = Vec::new();
            walk(&t.agents, 0, None, &mut all);
            let agents: Vec<Value> = all.iter().map(|(s, d, p)| json!({ "name": s.name, "tier": s.tier, "depth": d, "parent": p })).collect();
            json!({ "id": t.id, "name": t.name, "description": t.description, "source": source, "path": path,
                    "agents": agents, "apps":t.apps.len(), "problems": validate(t) })
        }
        Err(e) => json!({ "id": null, "name": path.rsplit(['/', '\\']).next().unwrap_or(path), "source": source, "path": path,
                          "agents": [], "problems": [e] }),
    }
}

/// What "Save as template" copies from an org. The tree, names and tiers
/// are always copied; accounts and folders are this machine's and are off
/// unless asked for.
#[derive(Deserialize, Debug, Clone)]
pub struct Include {
    #[serde(default = "yes")]
    pub charters: bool,
    #[serde(default = "yes")]
    pub credits: bool,
    #[serde(default = "yes")]
    pub effort: bool,
    /// tool switches, visibility and permission mode
    #[serde(default = "yes")]
    pub tools: bool,
    #[serde(default = "yes")]
    pub org_md: bool,
    /// the account binding and the account-fallback switch
    #[serde(default)]
    pub accounts: bool,
    #[serde(default)]
    pub folders: bool,
    /// Quick chat's defaults for this org (what it shows now)
    #[serde(default = "yes")]
    pub quick_chat: bool,
    /// the org-wide settings the org set itself (`ORG_SETTINGS` only)
    #[serde(default = "yes")]
    pub settings: bool,
    /// Opt-in: only fixed scratch AGENTS.md files, with bounded credential checks.
    #[serde(default)]
    pub standing_notes: bool,
    #[serde(default = "yes")]
    pub watchdogs: bool,
    #[serde(default)]
    pub machine_watchdogs: bool,
    #[serde(default = "yes")]
    pub audiences: bool,
}

#[nolog]
fn yes() -> bool {
    true
}

impl Default for Include {
    fn default() -> Self {
        Include { charters: true, credits: true, effort: true, tools: true, org_md: true, accounts: false, folders: false, quick_chat: true, settings: true, standing_notes: false, watchdogs: true, machine_watchdogs: false, audiences: true }
    }
}

/// One live agent as the save reads it.
#[derive(Debug, Clone)]
pub struct Row {
    pub id: i64,
    pub parent: Option<i64>,
    pub name: String,
    pub tier: String,
    pub account: Option<String>,
    pub seat: f64,
    pub grant: f64,
    pub charter: Option<String>,
    pub team_charter: Option<String>,
    pub scope: Value,
    pub extra: Value,
}

/// Build a template from an org's live agents (in sibling order). An agent
/// whose superior is not live is placed at the top level.
#[logged]
pub fn from_rows(
    id: &str, name: &str, description: Option<&str>, rows: &[Row], org_md: Option<String>, quick: Option<&Value>, settings: &Value,
    inc: &Include,
) -> Result<super::template_wire::Export, String> {
    let ids: HashMap<_, _> = rows.iter().enumerate().map(|(i,r)| (r.id,i)).collect();
    let mut children = vec![Vec::new(); rows.len()]; let mut roots = Vec::new();
    for (i,r) in rows.iter().enumerate() { if let Some(p) = r.parent.and_then(|p| ids.get(&p)) { children[*p].push(i); } else { roots.push(i); } }
    let mut order = Vec::new(); let mut todo: Vec<_> = roots.iter().rev().copied().collect();
    while let Some(i) = todo.pop() { order.push(i); todo.extend(children[i].iter().rev()); }
    if order.len() != rows.len() { return Err("layout contains a parent cycle".into()); }
    let mut held = vec![0.0; rows.len()];
    for &i in order.iter().rev() {
        let cost = if rows[i].tier == super::projects::TIER { held[i] } else { rows[i].seat + rows[i].grant };
        if let Some(p) = rows[i].parent.and_then(|p| ids.get(&p)) { held[*p] += cost; }
    }
    let mut nodes = Vec::with_capacity(rows.len());
    for (index, r) in rows.iter().enumerate() {
        if r.tier == super::projects::TIER {
            let mut v = json!({ "name": r.name, "tier": super::projects::TIER,
                "slots": super::slots::capacity(&r.scope), "peer_mail": super::peer_mail::enabled(&r.scope) });
            if inc.charters { if let Some(description) = &r.charter { v["description"] = json!(description); } }
            if inc.settings { v["settings"] = json!({
                "mail_queue": if super::projects::ack_mode(&r.scope) { "ack" } else { "round_robin" },
                "exclude_sender": super::projects::exclude_sender(&r.scope), "ack_timeout": super::projects::ack_timeout(&r.scope),
                "max_attempts": super::projects::max_attempts(&r.scope), "ack_reminders": super::projects::ack_reminders(&r.scope),
                "turn_end_reminder": super::projects::turn_end_reminder(&r.scope), "event_listeners": super::listeners::enabled(&r.scope)
            }); }
            nodes.push(v); continue;
        }
        let held = held[index];
        let mut v = json!({ "name": r.name, "tier": r.tier,
                            "spare": if inc.credits { round2((r.grant - held).max(0.0)) } else { 0.0 } });
        if inc.charters {
            if let Some(c) = r.charter.as_ref().filter(|c| !c.trim().is_empty()) { v["charter"] = json!({ "text": c }); }
            if let Some(c) = r.team_charter.as_ref().filter(|c| !c.trim().is_empty()) { v["team_charter"] = json!(c); }
        }
        if inc.effort {
            if let Some(on) = r.scope["fast_mode"].as_bool() { v["fast_mode"] = json!(on); }
            // a hire's `harness` pins OpenRouter seats only: a server seat's own
            // harness (its Model tab) is not exported
            if catalog::is_openrouter(&r.tier) {
                if let Some(h) = crate::harnesses::seat_pin(&r.extra) { v["harness"] = json!(h); }
            }
            if let Some(e) = r.scope["effort"].as_str().filter(|e| !e.is_empty()) { v["effort"] = json!(e); }
        }
        if inc.tools {
            if r.scope["tools"].is_object() { v["tools"] = r.scope["tools"].clone(); }
            for k in ["org_visibility", "permission_mode"] {
                if let Some(x) = r.scope[k].as_str() { v[k] = json!(x); }
            }
        }
        if inc.accounts {
            if let Some(a) = r.account.as_ref().filter(|a| !a.is_empty()) { v["account"] = json!(a); }
            if let Some(b) = r.scope["account_fallback"].as_bool() { v["account_fallback"] = json!(b); }
        }
        if inc.folders {
            if let Some(d) = r.scope["add_dirs"].as_array() { v["add_dirs"] = json!(d); }
        }
        nodes.push(v);
    }
    let mut t = json!({ "id": id, "name": name, "version": 1 });
    // optional: a blank one is left out, and the picker shows no line for it
    if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
        t["description"] = json!(d);
    }
    if inc.org_md {
        if let Some(md) = org_md.filter(|m| !m.trim().is_empty()) { t["org_md"] = json!(md); }
    }
    // a superior the saved layout does not hold is saved as top level
    if let Some(mut q) = quick.filter(|_| inc.quick_chat).and_then(|q| quick_chat(q).ok()) {
        if let Some(s) = q.get("superior").and_then(Value::as_str) {
            if !rows.iter().any(|r| r.name == s) {
                q["superior"] = Value::Null;
            }
        }
        if q.as_object().is_some_and(|o| !o.is_empty()) {
            t["quick_chat"] = q;
        }
    }
    // only what the org set itself: app-wide defaults stay app-wide
    if inc.settings {
        let s: serde_json::Map<String, Value> = settings.as_object().into_iter().flatten()
            .filter(|(k, v)| ORG_SETTINGS.contains(&k.as_str()) && !v.is_null())
            .map(|(k, v)| (k.clone(), v.clone())).collect();
        if !s.is_empty() {
            t["settings"] = Value::Object(s);
        }
    }
    Ok(super::template_wire::Export {root:t, nodes, children, roots})
}

/// "Restore default templates": write every built-in the folder lacks, also
/// one the user deleted; never over an existing file.
#[logged]
pub fn populate() -> Result<Value, String> {
    let dir = user_dir();
    seed_into(&dir)?;
    let (mut created, mut existing) = (Vec::new(), Vec::new());
    for (f, body) in BUNDLED {
        let p = dir.join(f);
        if p.exists() {
            existing.push(f.to_string());
        } else if std::fs::write(&p, body).is_ok() {
            created.push(f.to_string());
        }
    }
    Ok(json!({ "dir": dir.to_string_lossy(), "created": created, "existing": existing }))
}

/// Save a template file as `<id>.json` in the templates folder.
// Serialized templates may contain private standing notes.
#[nolog]
pub fn write(id: &str, body: &str, replace: bool) -> Result<PathBuf, (u16, String)> {
    if body.len() as u64 > FILE_MAX { return Err((422, "template file exceeds 16 MiB".into())); }
    let dir = user_dir();
    crate::http::settings::plain_path(&dir).map_err(|e| (409, e))?;
    std::fs::create_dir_all(&dir).map_err(|e| (500, format!("could not create the templates folder: {e}")))?;
    let target = dir.join(format!("{id}.json"));
    crate::http::settings::plain_path(&target).map_err(|e| (409, e))?;
    if target.exists() && !replace {
        return Err((409, format!("a template file {id}.json already exists")));
    }
    std::fs::write(&target, body.as_bytes()).map_err(|e| (503, format!("could not save the template: {e}")))?;
    Ok(std::path::absolute(&target).unwrap_or(target))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn from_rows(id:&str,name:&str,description:Option<&str>,rows:&[Row],md:Option<String>,quick:Option<&Value>,settings:&Value,inc:&Include)->Value {
        serde_json::from_str(&super::from_rows(id,name,description,rows,md,quick,settings,inc).unwrap().body().unwrap()).unwrap()
    }

    #[test]
    fn project_slots_are_transparent_for_credits_and_model_availability() {
        let t: Template = serde_json::from_value(json!({"id":"t","name":"T","agents":[
            {"name":"liaison","tier":"opus","spare":2,"reports":[
                {"name":"coordinator","tier":"opus","spare":3,"audiences":["user"],"reports":[
                    {"name":"build-slot","tier":"project","description":"Build permit","slots":3,"peer_mail":true,"reports":[
                        {"name":"developer","tier":"sonnet"}
                    ]}
                ]}
            ]}
        ]})).unwrap();
        assert!(validate(&t).is_empty(), "{:?}",validate(&t));
        let (planned, blocked) = plan(&t, &Choices::default(), &claude_only(), &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(planned.iter().map(|p| (p.name.as_str(),p.seat,p.grant)).collect::<Vec<_>>(),
            [("liaison",4.0,11.0),("coordinator",4.0,5.0),("build-slot",0.0,0.0),("developer",2.0,0.0)]);
        assert_eq!(hire_request(&planned[1],false)["audiences"],json!(["user"]));
        assert_eq!(hire_request(&planned[2],false),
            json!({"op":"create_project","name":"build-slot","parent":"coordinator","description":"Build permit"}));
        let mut choices = Choices::default();
        choices.overrides.insert("build-slot".into(), SlotChoice { name:Some("builds".into()),tier:None, ..Default::default() });
        let (renamed,_) = plan(&t,&choices,&claude_only(),&[]).unwrap();
        assert_eq!(renamed[3].parent.as_deref(),Some("builds"));
        let (unavailable,blocked) = plan(&t,&Choices::default(),&Avail::default(),&[]).unwrap();
        assert_eq!(blocked.len(),3);
        assert!(unusable_here(&unavailable,false));
        assert!(!plan_json(&t,&planned,&[])["agents"][2]["blocked"].as_bool().unwrap());
    }

    #[test]
    fn project_configuration_uses_canonical_steps() {
        let t:Template=serde_json::from_value(json!({"id":"t","name":"T","agents":[{"name":"lead","tier":"opus","reports":[{"name":"build-slot","tier":"project","slots":3,"peer_mail":true}]}]})).unwrap();
        let (p,_)=plan(&t,&Choices::default(),&claude_only(),&[]).unwrap();
        assert_eq!(creation_requests(&p[1],false)[1],json!({"op":"configure_project","node":"build-slot","settings":{"slots":3,"peer_mail":true}}));
    }

    #[test]
    fn saved_project_shape_keeps_transparent_funding_and_summary() {
        let mut project=row(3,Some(2),"build-slot","project",0.0,0.0);
        project.charter=Some("Build agreement".into());
        project.scope=json!({"slots_capacity":3,"peer_mail":true});
        let rows=vec![row(1,None,"liaison","opus",4.0,11.0),row(2,Some(1),"coordinator","opus",4.0,5.0),
            project,row(4,Some(3),"developer","sonnet",2.0,0.0)];
        let saved=from_rows("t","T",None,&rows,None,None,&Value::Null,&Include::default());
        assert_eq!(saved["agents"][0]["spare"],2.0);
        assert_eq!(saved["agents"][0]["reports"][0]["spare"],3.0);
        assert_eq!(saved["agents"][0]["reports"][0]["reports"][0]["slots"],3);
        let t:Template=serde_json::from_value(saved).unwrap();
        assert!(validate(&t).is_empty(),"{:?}",validate(&t));
        let (p,b)=plan(&t,&Choices::default(),&claude_only(),&[]).unwrap();
        assert!(b.is_empty());
        assert_eq!(p[0].grant,11.0);
    }

    #[test]
    fn projects_cannot_smuggle_agent_fields_or_unbounded_notes() {
        for extra in [json!({"effort":"max"}),json!({"spare":1}),json!({"slots":10000000}),json!({"audiences":["user"]}),json!({"scratch_agents_md":"personal"})] {
            let mut slot=json!({"name":"builds","tier":"project"});
            slot.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let t:Template=serde_json::from_value(json!({"id":"t","name":"T","agents":[{"name":"lead","tier":"opus","reports":[slot]}]})).unwrap();
            assert!(!validate(&t).is_empty());
        }
        let t:Template=serde_json::from_value(json!({"id":"t","name":"T","agents":[{"name":"lead","tier":"opus","audiences":["unknown"]}]})).unwrap();
        assert!(!validate(&t).is_empty());
        let oversized=json!({"id":"t","name":"T","shared_agents_md":"x".repeat(super::super::template_notes::FILE_MAX+1),"agents":[{"name":"lead","tier":"opus"}]});
        assert!(serde_json::from_value::<Template>(oversized).is_err());
        assert!(!Include::default().standing_notes);
    }

    #[test]
    fn availability_summary_handles_none_partial_fallback_checking_and_empty() {
        let codex = bundled("devteam-codex");
        let av = claude_only();
        let summary = |t: Template, av: &Avail| summary_with_availability(&Ok(t), "folder", "fixture.json", av);
        let missing = summary(codex.clone(), &av);
        assert_eq!(missing["availability"]["unusable"], true);
        assert!(missing["availability"]["reason"].as_str().unwrap().starts_with("needs "));
        let mut partial = codex.clone();
        partial.agents[0].tier = "opus".into();
        assert_eq!(summary(partial, &av)["availability"]["unusable"], false);
        let mut fallback = codex.clone();
        fallback.agents[0].fallback = vec!["opus".into()];
        assert_eq!(summary(fallback, &av)["availability"]["unusable"], false);
        let checking = Avail { checking: true, ..Avail::default() };
        let pending = summary(codex.clone(), &checking);
        assert_eq!(pending["availability"]["unusable"], false);
        assert_eq!(pending["availability"]["checking"], true);
        let mut empty = codex;
        empty.agents.clear();
        assert!(!unusable_here(&[], false));
        assert!(summary(empty, &av)["availability"].is_null()); // validation remains separate
    }

    /// A fresh folder of its own under the system temp folder.
    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orgtree-templates-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_fresh_folder_is_seeded_and_lists_only_its_files() {
        let d = scratch("fresh");
        let made = seed_into(&d).unwrap();
        assert_eq!(made, vec!["devteam-claude.json", "devteam-codex.json", "devteam-muse.json", "devteam-antigravity.json", "heavy-dev-shop.json"]);
        let mut ids: Vec<String> = list_in(&d).into_iter().filter_map(|(t, _, _)| t.ok().map(|t| t.id)).collect();
        ids.sort();
        assert_eq!(ids, vec!["devteam-antigravity", "devteam-claude", "devteam-codex", "devteam-muse", "heavy-dev-shop"]);
        std::fs::write(d.join("mine.json"), r#"{"id":"mine","name":"Mine","agents":[{"name":"a","tier":"opus"}]}"#).unwrap();
        let mine = list_in(&d).into_iter().filter_map(|(t, _, _)| t.ok()).find(|t| t.id == "mine").unwrap();
        assert_eq!(mine.description, "");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_edited_built_in_is_kept_and_a_deleted_one_stays_deleted() {
        let d = scratch("kept");
        seed_into(&d).unwrap();
        let edited = BUNDLED[0].1.replace("devteam (claude)", "my devteam");
        std::fs::write(d.join(BUNDLED[0].0), &edited).unwrap();
        std::fs::remove_file(d.join(BUNDLED[1].0)).unwrap();
        assert!(seed_into(&d).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(d.join(BUNDLED[0].0)).unwrap(), edited);
        assert!(!d.join(BUNDLED[1].0).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_built_in_new_to_the_note_is_written_unless_a_file_is_there() {
        let d = scratch("upgrade");
        std::fs::create_dir_all(&d).unwrap();
        // an older version wrote only the first; the user has their own file under the second name
        std::fs::write(d.join(SEEDED), format!("{}
", BUNDLED[0].0)).unwrap();
        std::fs::write(d.join(BUNDLED[1].0), "{}").unwrap();
        // only the later ones, which neither the note nor a file has, are written
        assert_eq!(seed_into(&d).unwrap(), vec![BUNDLED[2].0.to_string(), BUNDLED[3].0.to_string(), BUNDLED[4].0.to_string()]);
        assert_eq!(std::fs::read_to_string(d.join(BUNDLED[1].0)).unwrap(), "{}");
        assert!(!d.join(BUNDLED[0].0).exists());
        let note = std::fs::read_to_string(d.join(SEEDED)).unwrap();
        assert!(note.contains(BUNDLED[1].0));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The Muse built-in reaches an install made before it existed (its note
    /// names only the Claude and Codex ones) exactly once: a Codex file the
    /// user deleted stays deleted, and the Muse one deleted later does too.
    #[test]
    fn the_muse_built_in_reaches_an_existing_install_once() {
        let d = scratch("muse-upgrade");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(SEEDED), format!("{}
{}
", BUNDLED[0].0, BUNDLED[1].0)).unwrap();
        std::fs::write(d.join(BUNDLED[0].0), BUNDLED[0].1).unwrap();
        assert_eq!(seed_into(&d).unwrap(), vec!["devteam-muse.json".to_string(), "devteam-antigravity.json".to_string(), "heavy-dev-shop.json".to_string()]);
        assert_eq!(std::fs::read_to_string(d.join("devteam-muse.json")).unwrap(), BUNDLED[2].1);
        assert!(!d.join(BUNDLED[1].0).exists());
        assert!(std::fs::read_to_string(d.join(SEEDED)).unwrap().contains("devteam-muse.json"));
        assert!(seed_into(&d).unwrap().is_empty());
        std::fs::remove_file(d.join("devteam-muse.json")).unwrap();
        assert!(seed_into(&d).unwrap().is_empty());
        assert!(!d.join("devteam-muse.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_saved_description_is_optional() {
        let rows = vec![row(1, None, "lead", "opus", 1.0, 2.0)];
        let blank = from_rows("t", "T", Some("  "), &rows, None, None, &Value::Null, &Include::default());
        assert!(blank.get("description").is_none());
        let given = from_rows("t", "T", Some(" Our team "), &rows, None, None, &Value::Null, &Include::default());
        assert_eq!(given["description"], "Our team");
    }

    fn row(id: i64, parent: Option<i64>, name: &str, tier: &str, seat: f64, grant: f64) -> Row {
        Row { extra: Value::Null, id, parent, name: name.into(), tier: tier.into(), account: Some("claude-5".into()), seat, grant,
              charter: Some(format!("be {name}")), team_charter: None,
              scope: json!({ "effort": "high", "org_visibility": "subtree", "tools": { "bash": true },
                             "add_dirs": [{ "path": "E:\\x", "mode": "rw" }] }) }
    }

    #[test]
    fn a_saved_layout_round_trips_through_the_plan() {
        let rows = vec![row(1, None, "lead", "opus", 4.0, 20.0), row(2, Some(1), "dev", "sonnet", 2.0, 3.0),
                        row(3, Some(1), "qa", "sonnet", 2.0, 0.0)];
        let v = from_rows("my-team", "My team", Some("  "), &rows, Some("org rules".into()), None, &Value::Null, &Include::default());
        assert!(v["agents"][0]["account"].is_null() && v["agents"][0]["add_dirs"].is_null());
        assert_eq!(v["org_md"], "org rules");
        let t: Template = serde_json::from_value(v).unwrap();
        assert!(validate(&t).is_empty(), "{:?}", validate(&t));
        assert_eq!(t.agents[0].spare, 20.0 - 5.0 - 2.0);
        let (p, blocked) = plan(&t, &Choices::default(), &claude_only(), &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p[0].grant, 20.0);
        assert_eq!(p[1].grant, 3.0);
    }

    #[test]
    fn saved_folders_are_clamped_and_accounts_are_preferences() {
        let rows = vec![row(1, None, "lead", "opus", 4.0, 10.0)];
        let inc = Include { accounts: true, folders: true, ..Include::default() };
        let t: Template = serde_json::from_value(from_rows("t", "T", None, &rows, None, None, &Value::Null, &inc)).unwrap();
        assert_eq!(t.agents[0].account.as_deref(), Some("claude-5"));
        let (p, _) = plan(&t, &Choices::default(), &claude_only(), &[json!({ "path": "E:\\other", "mode": "rw" })]).unwrap();
        assert_eq!(p[0].dirs_dropped, vec!["E:\\x".to_string()]);
        assert_eq!(p[0].add_dirs.as_ref().unwrap().len(), 0);
        assert_eq!(p[0].account.as_deref(), Some("primary"));
        assert!(p[0].note.as_deref().unwrap().contains("saved account claude-5"));
        let (p, _) = plan(&t, &Choices::default(), &claude_only(), &[json!({ "path": "E:\\", "mode": "ro" })]).unwrap();
        assert_eq!(p[0].add_dirs.as_ref().unwrap()[0]["mode"], "ro");
    }

    #[test]
    fn unticked_groups_are_left_out() {
        let rows = vec![row(1, None, "lead", "opus", 4.0, 10.0)];
        let inc = Include { charters: false, credits: false, effort: false, tools: false, org_md: false, accounts: false, folders: false, quick_chat: false, settings: false, standing_notes: false, watchdogs: false, machine_watchdogs: false, audiences: false };
        let v = from_rows("t", "T", None, &rows, Some("x".into()), None, &Value::Null, &inc);
        let a = &v["agents"][0];
        assert!(a["charter"].is_null() && a["effort"].is_null() && a["tools"].is_null() && v["org_md"].is_null());
        assert_eq!(a["spare"], 0.0);
    }

    fn offer(seat: f64, provider: &str) -> Offer {
        Offer { seat, provider: provider.into(), accounts: vec![], default_ok: true, readings: HashMap::new() }
    }

    fn claude_only() -> Avail {
        let mut tiers = HashMap::new();
        tiers.insert("opus".into(), offer(4.0, "claude"));
        tiers.insert("sonnet".into(), offer(2.0, "claude"));
        Avail { tiers, ..Avail::default() }
    }

    /// A machine whose Muse login offers all three Muse tiers at the ruled seat costs.
    fn muse_only() -> Avail {
        let mut tiers = HashMap::new();
        tiers.insert("wonder".into(), offer(4.0, "muse"));
        tiers.insert("wonder-full".into(), offer(10.0, "muse"));
        tiers.insert("spark".into(), offer(2.0, "muse"));
        Avail { tiers, ..Avail::default() }
    }

    #[test]
    fn offered_tiers_list_in_the_staffing_order_then_the_catalog_listing() {
        let mut av = muse_only();
        for t in ["fable", "or-b-model", "ls-s-m"] {
            av.tiers.insert(t.into(), offer(1.0, "x"));
        }
        fn keys(av: &Avail) -> Vec<&str> {
            av.listed().into_iter().map(|(k, _)| k.as_str()).collect()
        }
        // no order known: the catalog's listing (dearest first within Muse), then the rest by name
        assert_eq!(keys(&av), ["fable", "wonder-full", "wonder", "spark", "ls-s-m", "or-b-model"]);
        // the staffing options' own order wins, whatever a map would iterate
        av.order = vec!["wonder".into(), "or-b-model".into(), "fable".into()];
        assert_eq!(keys(&av), ["wonder", "or-b-model", "fable", "wonder-full", "spark", "ls-s-m"]);
    }

    fn bundled(id: &str) -> Template {
        BUNDLED.iter().map(|(_, b)| parse(b).unwrap()).find(|t| t.id == id).unwrap()
    }

    /// The Antigravity built-in reaches an install seeded with the three
    /// earlier ones exactly once, and stays deleted once the user deletes it.
    #[test]
    fn the_antigravity_built_in_reaches_an_existing_install_once() {
        let d = scratch("agy-upgrade");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(SEEDED), format!("{}\n{}\n{}\n", BUNDLED[0].0, BUNDLED[1].0, BUNDLED[2].0)).unwrap();
        assert_eq!(seed_into(&d).unwrap(), vec!["devteam-antigravity.json".to_string(), "heavy-dev-shop.json".to_string()]);
        assert_eq!(std::fs::read_to_string(d.join("devteam-antigravity.json")).unwrap(), BUNDLED[3].1);
        assert!(seed_into(&d).unwrap().is_empty());
        std::fs::remove_file(d.join("devteam-antigravity.json")).unwrap();
        assert!(seed_into(&d).unwrap().is_empty());
        assert!(!d.join("devteam-antigravity.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn every_built_in_is_valid_and_named_after_its_file() {
        let ids: Vec<String> = BUNDLED.iter().map(|(_, b)| parse(b).unwrap().id).collect();
        assert_eq!(ids, ["devteam-claude", "devteam-codex", "devteam-muse", "devteam-antigravity", "heavy-dev-shop"]);
        for (file, body) in BUNDLED {
            let t = parse(body).unwrap();
            assert_eq!(*file, format!("{}.json", t.id));
            assert!(validate(&t).is_empty(), "{file}: {:?}", validate(&t));
            if t.id == "heavy-dev-shop" { continue; }
            let names: Vec<_> = t.agents.iter().map(|s| s.name.as_str()).collect();
            assert_eq!(names, ["coordinator", "implementer", "redteam", "curator"], "{file}");
        }
    }

    // Keep test-home changes in a child process: other tests may read home
    // concurrently. Never fall through to the user's real charter directory.
    fn in_preset_test_home(test: &str, developer_override: Option<&str>) -> bool {
        const CHILD: &str = "ORGTREE_PRESET_HOME_TEST_CHILD";
        if std::env::var(CHILD).ok().as_deref() == Some(test) { return false; }
        let home = std::env::temp_dir().join(format!("orgtree-preset-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        if let Some(text) = developer_override {
            let dir = home.join(".orgtree").join("charters");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("developer.md"), text).unwrap();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture", "--test-threads=1"])
            .env(CHILD, test)
            .env("ORGTREE_TEST_HOME", &home)
            .output();
        let cleanup = std::fs::remove_dir_all(&home);
        let output = output.expect("run preset assertion in its own test home");
        cleanup.expect("remove only the home created for this child");
        assert!(output.status.success(), "isolated preset assertion failed: {}\n{}\n{}",
            output.status, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "the isolated test must actually execute");
        true
    }

    #[test]
    fn heavy_dev_shop_bundled_assertion_ignores_user_preset_override() {
        const TEST: &str = "domain::templates::tests::heavy_dev_shop_bundled_assertion_ignores_user_preset_override";
        const OVERRIDE: &str = "Synthetic Developer override: preserve custom preset precedence.";
        if in_preset_test_home(TEST, Some(OVERRIDE)) { return; }
        let home = crate::rig::home_dir().unwrap();
        let override_file = home.join(".orgtree").join("charters").join("developer.md");
        assert_eq!(crate::http::settings::preset_content("developer").as_deref(), Some(OVERRIDE));
        heavy_dev_shop_has_all_ruled_seats_efforts_audience_and_notes();
        assert_eq!(crate::rig::home_dir().unwrap(), home, "child isolation must not change the parent's home");
        assert_eq!(std::fs::read_to_string(override_file).unwrap(), OVERRIDE);
        assert_eq!(crate::http::settings::preset_content("developer").as_deref(), Some(OVERRIDE));
    }

    #[test]
    fn heavy_dev_shop_has_all_ruled_seats_efforts_audience_and_notes() {
        const TEST: &str = "domain::templates::tests::heavy_dev_shop_has_all_ruled_seats_efforts_audience_and_notes";
        if in_preset_test_home(TEST, None) { return; }
        let t=bundled("heavy-dev-shop");
        assert!(validate(&t).is_empty(),"{:?}",validate(&t));
        let mut av=claude_only();
        for (tier,cost,provider) in [("astra",10.0,"openai"),("sol",2.0,"openai"),("argon",2.0,"google")] {
            av.tiers.insert(tier.into(),offer(cost,provider));
        }
        let (p,b)=plan(&t,&Choices::default(),&av,&[]).unwrap();
        assert!(b.is_empty());
        assert_eq!(p.len(),16); // fifteen seats plus one project, below the 24-node limit
        assert_eq!(p.iter().filter(|p| !p.slot.project()).count(),15);
        assert_eq!(p.iter().map(|p|p.seat).sum::<f64>(),64.0);
        assert_eq!(p[0].name,"liaison");
        assert_eq!(p[0].grant,80.0);
        assert_eq!(p[1].grant,72.0);
        let developers:Vec<_>=p.iter().filter(|p|p.name.starts_with("developer-")).collect();
        assert_eq!(developers.len(),11);
        for tier in ["opus","sol","astra"] { assert_eq!(developers.iter().filter(|p|p.tier.as_deref()==Some(tier)).count(),3); }
        for tier in ["sonnet","argon"] { assert_eq!(developers.iter().filter(|p|p.tier.as_deref()==Some(tier)).count(),1); }
        assert_eq!(developers.iter().filter(|p|p.slot.effort.as_deref()==Some("medium")).count(),5);
        assert_eq!(developers.iter().filter(|p|p.slot.effort.as_deref()==Some("high")).count(),4);
        let mut max_names:Vec<_>=developers.iter().filter(|p|p.slot.effort.as_deref()==Some("max")).map(|p|p.name.as_str()).collect();
        max_names.sort();
        assert_eq!(max_names,vec!["developer-astra-max","developer-opus-max"]);
        assert_eq!(p[1].parent.as_deref(),Some("liaison"));
        assert_eq!(hire_request(&p[1],false)["audiences"],json!(["user"]));
        assert_eq!(p[2].name,"build-slot");
        assert!(p[2].slot.project());
        assert_eq!(p[2].slot.slots,Some(3));
        assert_eq!(p[2].slot.peer_mail,Some(true));
        assert!(p[3..].iter().all(|p|p.parent.as_deref()==Some("build-slot")));
        for p in p.iter().filter(|p|!p.slot.project()) {
            let expected=match p.name.as_str() {"developer-opus-max"|"developer-astra-max"=>"max","developer-sol-1"|"developer-sol-2"|"developer-sol-3"|"developer-argon"|"test-rig"|"curator"=>"high",_=>"medium"};
            assert_eq!(p.slot.effort.as_deref(),Some(expected));
            if p.name.starts_with("developer-") {
                assert_eq!(p.slot.charter.preset.as_deref(),Some("developer"));
                assert_eq!(charter_of(&p.slot),include_str!("../../../../docs/charters/developer.md"));
            } else {
                assert!(p.slot.charter.preset.is_none(),"other roles keep detailed practices in notes");
                assert!(charter_of(&p.slot).len()<700);
            }
        }
        assert_eq!(plan_json(&t,&p,&[])["standing_notes"],7);
        assert!(t.description.contains("develop Orgtree itself"));
        assert!(!Include::default().standing_notes);
    }

    #[test]
    fn bundled_templates_parse_and_carry_the_ruled_tiers() {
        let c = bundled("devteam-claude");
        let tiers: Vec<_> = c.agents.iter().map(|s| (s.name.as_str(), s.tier.as_str())).collect();
        assert_eq!(tiers, [("coordinator", "opus"), ("implementer", "opus"), ("redteam", "opus"), ("curator", "sonnet")]);
        let x = bundled("devteam-codex");
        let tiers: Vec<_> = x.agents.iter().map(|s| (s.name.as_str(), s.tier.as_str())).collect();
        assert_eq!(tiers, [("coordinator", "sol"), ("implementer", "astra"), ("redteam", "sol"), ("curator", "luna")]);
        let m = bundled("devteam-muse");
        assert_eq!(m.name, "devteam (muse)");
        let tiers: Vec<_> = m.agents.iter().map(|s| (s.name.as_str(), s.tier.as_str())).collect();
        assert_eq!(tiers, [("coordinator", "wonder"), ("implementer", "wonder-full"), ("redteam", "wonder"), ("curator", "spark")]);
        assert!(m.agents.iter().all(|s| catalog::is_muse(&s.tier) && s.fallback.is_empty()));
        // user 2026-10-14 17:55Z: Argon for everything except the curator, which runs Flash
        let g = bundled("devteam-antigravity");
        assert_eq!(g.name, "devteam (antigravity)");
        let tiers: Vec<_> = g.agents.iter().map(|s| (s.name.as_str(), s.tier.as_str())).collect();
        assert_eq!(tiers, [("coordinator", "argon"), ("implementer", "argon"), ("redteam", "argon"), ("curator", "flash")]);
        assert!(g.agents.iter()
            .all(|s| catalog::tier(&s.tier).is_some_and(|t| t.provider == catalog::GOOGLE) && s.fallback.is_empty()));
    }

    /// A machine whose Antigravity lists Argon, plus Flash.
    fn agy_only() -> Avail {
        let mut tiers = HashMap::new();
        tiers.insert("argon".into(), offer(2.0, "google"));
        tiers.insert("flash".into(), offer(1.0, "google"));
        Avail { tiers, ..Avail::default() }
    }

    #[test]
    fn the_antigravity_built_in_is_planned_on_argon_and_flash() {
        let (p, blocked) = plan(&bundled("devteam-antigravity"), &Choices::default(), &agy_only(), &[]).unwrap();
        assert!(blocked.is_empty());
        let got: Vec<_> = p.iter().map(|x| (x.name.as_str(), x.tier.as_deref(), x.seat)).collect();
        assert_eq!(got, [("coordinator", Some("argon"), 2.0), ("implementer", Some("argon"), 2.0),
                         ("redteam", Some("argon"), 2.0), ("curator", Some("flash"), 1.0)]);
        assert_eq!(p[0].grant, 10.0 + 2.0 + 2.0 + 1.0);
        assert!(p[1..].iter().all(|x| x.grant == 0.0 && x.parent.as_deref() == Some("coordinator") && x.note.is_none()));
        assert_eq!(quick_chat_for(&bundled("devteam-antigravity"), &p), Some(json!({ "superior": "coordinator", "tier": "argon" })));
        // Argon is conditional on Antigravity listing it: unlisted, its slots block until another tier is picked
        let mut av = agy_only();
        av.tiers.remove("argon");
        let (p, blocked) = plan(&bundled("devteam-antigravity"), &Choices::default(), &av, &[]).unwrap();
        assert_eq!(blocked, vec!["coordinator".to_string(), "implementer".to_string(), "redteam".to_string()]);
        assert_eq!(p[3].tier.as_deref(), Some("flash"));
    }

    #[test]
    fn grants_add_the_reports_seats() {
        let (p, blocked) = plan(&bundled("devteam-claude"), &Choices::default(), &claude_only(), &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p[0].grant, 10.0 + 4.0 + 4.0 + 2.0);
        assert_eq!(p[0].account.as_deref(), Some("primary"));
        assert!(p[1..].iter().all(|x| x.grant == 0.0 && x.parent.as_deref() == Some("coordinator")));
    }

    #[test]
    fn the_muse_built_in_is_planned_on_the_offered_muse_seats() {
        let (p, blocked) = plan(&bundled("devteam-muse"), &Choices::default(), &muse_only(), &[]).unwrap();
        assert!(blocked.is_empty());
        let got: Vec<_> = p.iter().map(|x| (x.name.as_str(), x.tier.as_deref(), x.seat)).collect();
        assert_eq!(got, [("coordinator", Some("wonder"), 4.0), ("implementer", Some("wonder-full"), 10.0),
                         ("redteam", Some("wonder"), 4.0), ("curator", Some("spark"), 2.0)]);
        // the coordinator's grant is its spare plus its reports' seats, as for the other built-ins
        assert_eq!(p[0].grant, 10.0 + 10.0 + 4.0 + 2.0);
        assert_eq!(p[0].account.as_deref(), Some("primary"));
        assert!(p[1..].iter().all(|x| x.grant == 0.0 && x.parent.as_deref() == Some("coordinator") && x.note.is_none()));
        assert_eq!(quick_chat_for(&bundled("devteam-muse"), &p), Some(json!({ "superior": "coordinator", "tier": "wonder" })));
    }

    #[test]
    fn a_muse_tier_the_login_does_not_offer_blocks_its_slot_until_another_is_picked() {
        let mut av = muse_only();
        av.tiers.remove("wonder-full");
        let (p, blocked) = plan(&bundled("devteam-muse"), &Choices::default(), &av, &[]).unwrap();
        assert_eq!(blocked, vec!["implementer".to_string()]);
        assert!(p[1].tier.is_none());
        assert!(p[1].note.as_deref().unwrap().contains("wonder-full cannot run on this computer now (Muse is not signed in or turned off)"));
        assert!(p.iter().filter(|x| x.name != "implementer").all(|x| x.tier.is_some()));
        let mut ch = Choices::default();
        ch.overrides.insert("implementer".into(), SlotChoice { tier: Some("wonder".into()), name: None, ..Default::default() });
        let (p, blocked) = plan(&bundled("devteam-muse"), &ch, &av, &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p[1].tier.as_deref(), Some("wonder"));
        assert_eq!(p[1].note.as_deref(), Some("chosen by you"));
        assert_eq!(p[0].grant, 10.0 + 4.0 + 4.0 + 2.0);
    }

    #[test]
    fn a_language_server_slot_is_valid_and_bills_no_account() {
        let rows = vec![row(1, None, "lead", "opus", 4.0, 1.0), row(2, Some(1), "local", "ls-ollama-qwen3-8-27b", 0.1, 0.0)];
        let inc = Include { accounts: true, ..Include::default() };
        let t: Template = serde_json::from_value(from_rows("t", "T", None, &rows, None, None, &Value::Null, &inc)).unwrap();
        assert!(validate(&t).is_empty(), "{:?}", validate(&t));
        let mut av = claude_only();
        av.tiers.insert("ls-ollama-qwen3-8-27b".into(), offer(0.1, "langserver"));
        let (p, blocked) = plan(&t, &Choices::default(), &av, &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p[1].tier.as_deref(), Some("ls-ollama-qwen3-8-27b"));
        assert_eq!(p[1].account, None);
        // a server that is gone: blocked, and the note says why in its words
        let (p, blocked) = plan(&t, &Choices::default(), &claude_only(), &[]).unwrap();
        assert_eq!(blocked, vec!["local".to_string()]);
        assert!(p[1].note.as_deref().unwrap().contains("no language model server here offers it"));
    }

    #[test]
    fn an_unavailable_provider_blocks_every_slot_without_a_fallback() {
        let (p, blocked) = plan(&bundled("devteam-codex"), &Choices::default(), &claude_only(), &[]).unwrap();
        assert_eq!(blocked.len(), 4);
        assert!(p.iter().all(|x| x.tier.is_none()));
        // the same for Muse, with no Muse login offering a tier, and the other way round
        let (p, blocked) = plan(&bundled("devteam-muse"), &Choices::default(), &claude_only(), &[]).unwrap();
        assert_eq!(blocked.len(), 4);
        assert!(p.iter().all(|x| x.tier.is_none() && x.note.as_deref().is_some_and(|n| n.contains("Muse is not signed in or turned off"))));
        let (p, blocked) = plan(&bundled("devteam-claude"), &Choices::default(), &muse_only(), &[]).unwrap();
        assert_eq!(blocked.len(), 4);
        assert!(p.iter().all(|x| x.tier.is_none()));
    }

    #[test]
    fn before_the_first_sign_in_check_a_missing_lane_is_checking_not_signed_out() {
        let checking = Avail { checking: true, ..Avail::default() };
        let (p, blocked) = plan(&bundled("devteam-claude"), &Choices::default(), &checking, &[]).unwrap();
        assert_eq!(blocked.len(), 4);
        assert!(p.iter().all(|x| x.tier.is_none() && x.note.as_deref().is_some_and(|n| n.contains("checking the Claude sign-in"))));
        let (p, _) = plan(&bundled("devteam-codex"), &Choices::default(), &checking, &[]).unwrap();
        assert!(p.iter().all(|x| x.note.as_deref().is_some_and(|n| n.contains("checking the Codex sign-in"))));
        // once checked, the same gap is a real "not signed in"
        let (p, _) = plan(&bundled("devteam-claude"), &Choices::default(), &Avail::default(), &[]).unwrap();
        assert!(p.iter().all(|x| x.note.as_deref().is_some_and(|n| n.contains("not signed in"))));
    }

    #[test]
    fn overrides_and_removals_recompute_the_grant() {
        let mut ch = Choices::default();
        ch.overrides.insert("coordinator".into(), SlotChoice { tier: Some("opus".into()), name: None, ..Default::default() });
        ch.overrides.insert("implementer".into(), SlotChoice { tier: Some("sonnet".into()), name: Some("builder".into()), ..Default::default() });
        ch.overrides.insert("redteam".into(), SlotChoice { tier: Some("opus".into()), name: None, ..Default::default() });
        ch.removed.push("curator".into());
        let (p, blocked) = plan(&bundled("devteam-codex"), &ch, &claude_only(), &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p.len(), 3);
        assert_eq!(p[1].name, "builder");
        assert_eq!(p[0].grant, 10.0 + 2.0 + 4.0);
        assert_eq!(p[1].parent.as_deref(), Some("coordinator"));
    }

    #[test]
    fn the_top_slot_cannot_be_removed() {
        let ch = Choices { removed: vec!["coordinator".into()], ..Default::default() };
        assert!(plan(&bundled("devteam-claude"), &ch, &claude_only(), &[]).is_err());
    }

    #[test]
    fn a_fallback_is_taken_when_the_first_tier_cannot_run() {
        let mut t = bundled("devteam-codex");
        t.agents[0].fallback = vec!["opus".into()];
        let (p, _) = plan(&t, &Choices::default(), &claude_only(), &[]).unwrap();
        assert_eq!(p[0].tier.as_deref(), Some("opus"));
        assert!(p[0].note.as_deref().unwrap().contains("sol → opus"));
    }

    #[test]
    fn the_default_account_is_used_when_eligible() {
        let mut av = claude_only();
        av.tiers.get_mut("opus").unwrap().accounts = vec!["claude-5".into()];
        av.default_account = Some("claude-5".into());
        let (p, _) = plan(&bundled("devteam-claude"), &Choices::default(), &av, &[]).unwrap();
        assert_eq!(p[0].account.as_deref(), Some("claude-5"));
        assert_eq!(p[3].account.as_deref(), Some("primary"));
    }

    /// Several OpenRouter keys (ruling 2026-10-11): an OpenRouter slot is
    /// placed on its keys like any login, the original key being `primary`,
    /// and the balancing rule ranks the keys by their spend readings.
    #[test]
    fn an_openrouter_slot_is_placed_on_its_keys() {
        let rows = vec![row(1, None, "lead", "opus", 4.0, 1.0), row(2, Some(1), "or", "or-qwen-qwen3", 0.5, 0.0)];
        let t: Template = serde_json::from_value(from_rows("t", "T", None, &rows, None, None, &Value::Null, &Include::default())).unwrap();
        let mut av = claude_only();
        av.tiers.insert("or-qwen-qwen3".into(), offer(0.5, "openrouter"));
        // one key: the original, as before several keys
        let (p, blocked) = plan(&t, &Choices::default(), &av, &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p[1].account.as_deref(), Some("primary"));
        // an added key with less of its cap spent comes first
        let o = av.tiers.get_mut("or-qwen-qwen3").unwrap();
        o.accounts = vec!["openrouter-2".into()];
        o.readings.insert("primary".into(), Reading { reset: None, used: Some(80.0) });
        o.readings.insert("openrouter-2".into(), Reading { reset: None, used: Some(10.0) });
        let (p, _) = plan(&t, &Choices::default(), &av, &[]).unwrap();
        assert_eq!(p[1].account.as_deref(), Some("openrouter-2"));
        // only added keys left (the original removed or switched off)
        let o = av.tiers.get_mut("or-qwen-qwen3").unwrap();
        o.default_ok = false;
        o.readings.clear();
        let (p, blocked) = plan(&t, &Choices::default(), &av, &[]).unwrap();
        assert!(blocked.is_empty());
        assert_eq!(p[1].account.as_deref(), Some("openrouter-2"));
    }

    #[test]
    fn quick_chat_defaults_keep_explicit_choices_and_refuse_bad_ones() {
        let q = quick_chat(&json!({ "superior": null, "effort": "" })).unwrap();
        assert_eq!(q, json!({ "superior": null, "effort": "" }));
        assert_eq!(quick_chat(&json!({})).unwrap(), json!({}));
        assert!(quick_chat(&json!({ "tier": "nope" })).is_err());
        assert!(quick_chat(&json!({ "effort": "huge" })).is_err());
        assert!(quick_chat(&json!({ "position": "top" })).is_err());
        assert!(quick_chat(&json!("opus")).is_err());
        let mut t = bundled("devteam-claude");
        t.quick_chat = Some(json!({ "tier": "nope" }));
        assert!(validate(&t).iter().any(|p| p.contains("unknown tier 'nope'")));
    }

    #[test]
    fn the_built_ins_start_quick_chat_on_their_coordinator() {
        assert_eq!(bundled("devteam-claude").quick_chat, Some(json!({ "superior": "coordinator", "tier": "opus" })));
        assert_eq!(bundled("devteam-codex").quick_chat, Some(json!({ "superior": "coordinator", "tier": "sol" })));
        assert_eq!(bundled("devteam-muse").quick_chat, Some(json!({ "superior": "coordinator", "tier": "wonder" })));
    }

    #[test]
    fn the_quick_chat_superior_follows_a_rename_and_falls_back_to_top_level() {
        let t = bundled("devteam-claude");
        let (p, _) = plan(&t, &Choices::default(), &claude_only(), &[]).unwrap();
        assert_eq!(quick_chat_for(&t, &p), Some(json!({ "superior": "coordinator", "tier": "opus" })));
        let mut ch = Choices::default();
        ch.overrides.insert("coordinator".into(), SlotChoice { tier: None, name: Some("boss".into()), ..Default::default() });
        let (p, _) = plan(&t, &ch, &claude_only(), &[]).unwrap();
        assert_eq!(quick_chat_for(&t, &p).unwrap()["superior"], json!("boss"));
        let mut t2 = t.clone();
        t2.quick_chat = Some(json!({ "superior": "curator" }));
        let mut ch = Choices::default();
        ch.removed.push("curator".into());
        let (p, _) = plan(&t2, &ch, &claude_only(), &[]).unwrap();
        assert_eq!(quick_chat_for(&t2, &p), Some(json!({ "superior": null })));
        t2.quick_chat = Some(json!({ "superior": "ghost", "effort": "" }));
        assert_eq!(quick_chat_for(&t2, &p), Some(json!({ "superior": null, "effort": "" })));
        t2.quick_chat = None;
        assert_eq!(quick_chat_for(&t2, &p), None);
    }

    #[test]
    fn a_saved_template_carries_quick_chat_unless_unticked() {
        let rows = vec![row(1, None, "boss", "opus", 4.0, 10.0), row(2, Some(1), "dev", "sonnet", 2.0, 0.0)];
        let q = json!({ "superior": "dev", "tier": "sonnet", "effort": "high" });
        let v = from_rows("t", "T", None, &rows, None, Some(&q), &Value::Null, &Include::default());
        assert_eq!(v["quick_chat"], q);
        let gone = json!({ "superior": "archived-one", "tier": "opus" });
        let v = from_rows("t", "T", None, &rows, None, Some(&gone), &Value::Null, &Include::default());
        assert_eq!(v["quick_chat"], json!({ "superior": null, "tier": "opus" }));
        let inc = Include { quick_chat: false, ..Include::default() };
        assert!(from_rows("t", "T", None, &rows, None, Some(&q), &Value::Null, &inc).get("quick_chat").is_none());
        assert!(from_rows("t", "T", None, &rows, None, None, &Value::Null, &Include::default()).get("quick_chat").is_none());
        let t: Template = serde_json::from_value(from_rows("t", "T", None, &rows, None, Some(&q), &Value::Null, &Include::default())).unwrap();
        assert!(validate(&t).is_empty());
    }

    #[test]
    fn a_saved_template_carries_the_org_set_settings_but_nothing_of_this_computer() {
        let rows = vec![row(1, None, "boss", "opus", 4.0, 10.0)];
        let settings = json!({ "dirs": [{ "path": "C:/work", "mode": "rw" }], "default_account": "claude-5",
            "disabled_accounts": ["openai-1"], "headless": false, "quick_chat": { "tier": "opus" },
            "max_top_grant": 40, "default_effort": "high", "permission_mode": "default", "auto_resume": false,
            "cascade_hire": false, "default_top_grant": null });
        let v = from_rows("t", "T", None, &rows, None, None, &settings, &Include::default());
        assert_eq!(v["settings"], json!({ "max_top_grant": 40, "default_effort": "high", "permission_mode": "default", "auto_resume": false }));
        let inc = Include { settings: false, ..Include::default() };
        assert!(from_rows("t", "T", None, &rows, None, None, &settings, &inc).get("settings").is_none());
        assert!(from_rows("t", "T", None, &rows, None, None, &json!({ "dirs": [] }), &Include::default()).get("settings").is_none());
        let t: Template = serde_json::from_value(v).unwrap();
        assert!(validate(&t).is_empty());
        let mut t2 = t.clone();
        t2.settings.as_mut().unwrap().insert("dirs".into(), json!([]));
        assert!(validate(&t2).iter().any(|p| p.contains("'dirs'")));
    }

    #[test]
    fn a_renamed_slot_may_not_collide() {
        let mut ch = Choices::default();
        ch.overrides.insert("curator".into(), SlotChoice { tier: None, name: Some("redteam".into()), ..Default::default() });
        assert!(plan(&bundled("devteam-claude"), &ch, &claude_only(), &[]).is_err());
    }

    fn rd(hours: Option<i64>, used: Option<f64>, now: chrono::DateTime<chrono::Utc>) -> Reading {
        Reading { reset: hours.map(|h| now + chrono::Duration::hours(h)), used }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn balancing_spends_the_sooner_reset_then_the_lower_usage() {
        let now = chrono::Utc::now();
        let order = ids(&["primary", "claude-5", "claude-6"]);
        // no readings: today's order
        assert_eq!(balance(&order, &HashMap::new(), now), order);
        // all far from reset: lower usage first
        let far = HashMap::from([("primary".to_string(), rd(Some(90), Some(67.0), now)),
                                 ("claude-5".to_string(), rd(Some(70), Some(53.0), now)),
                                 ("claude-6".to_string(), rd(Some(100), Some(80.0), now))]);
        assert_eq!(balance(&order, &far, now), ids(&["claude-5", "primary", "claude-6"]));
        // one resets within a day: it goes first even at higher usage
        let mut near = far.clone();
        near.insert("claude-6".to_string(), rd(Some(5), Some(95.0), now));
        assert_eq!(balance(&order, &near, now), ids(&["claude-6", "claude-5", "primary"]));
        // an unread login stays after the read ones, in today's order
        let partial = HashMap::from([("claude-6".to_string(), rd(Some(80), Some(10.0), now))]);
        assert_eq!(balance(&order, &partial, now), ids(&["claude-6", "primary", "claude-5"]));
    }

    #[test]
    fn the_plan_picks_the_balanced_account() {
        let mut av = claude_only();
        let now = av.now;
        let opus = av.tiers.get_mut("opus").unwrap();
        opus.accounts = vec!["claude-5".into()];
        opus.readings = HashMap::from([("primary".to_string(), rd(Some(90), Some(73.0), now)),
                                       ("claude-5".to_string(), rd(Some(67), Some(55.0), now))]);
        let (p, _) = plan(&bundled("devteam-claude"), &Choices::default(), &av, &[]).unwrap();
        assert_eq!(p[0].account.as_deref(), Some("claude-5"));
        // sonnet has no readings: the provider's own sign-in, as before
        assert_eq!(p[3].account.as_deref(), Some("primary"));
    }
}

#[cfg(test)]
#[path = "template_scale_tests.rs"]
mod scale_tests;

#[cfg(test)]
#[path = "template_scale_http_tests.rs"]
mod scale_http_tests;
