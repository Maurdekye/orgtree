//! The model-tier catalog: a tier is a price band (one chip on the canvas);
//! a model version is a subcategory inside a tier.

pub const CLAUDE: &str = "claude";
pub const OPENAI: &str = "openai";
pub const GOOGLE: &str = "google";
pub const OPENROUTER: &str = "openrouter";
/// Models on the user's own (local or self-hosted) language model servers, driven
/// by Claude Code or Codex (`crate::langserver`).
pub const LANGSERVER: &str = "langserver";
/// Meta's Muse Code CLI, driven over its Muse Session Protocol (`muse serve`;
/// `crate::runtime::muse`), on the CLI's own sign-in.
pub const MUSE: &str = "muse";

pub struct Tier {
    pub tier: &'static str,
    pub provider: &'static str,
    /// credits per seat
    pub seat: f64,
    /// default model id
    pub model: &'static str,
    /// model versions: (version key, model id)
    pub versions: &'static [(&'static str, &'static str)],
    pub letter: &'static str,
    pub context: Option<i64>,
    /// takes a mid-turn effort change over the control channel
    pub live_effort: bool,
    /// known but never offered for a new hire
    pub legacy: bool,
    /// offered only when the provider's live model list names the model
    pub conditional: bool,
    /// API prices per million tokens: (input, cached input, output)
    pub prices: Option<(f64, f64, f64)>,
}

pub static TIERS: &[Tier] = &[
    // `model` stays 5.1: what "no version saved" has always meant for a seat that exists. Fable 5.2 leads `versions`
    // and is what a NEW hire gets (`new_hire_version`).
    Tier { tier: "fable", provider: CLAUDE, seat: 10.0, model: "claude-fable-5-1",
        versions: &[("5.2", "claude-fable-5-2"), ("5.1", "claude-fable-5-1"), ("5", "claude-fable-5")], letter: "F",
        context: Some(1_000_000), live_effort: true, legacy: false, conditional: false, prices: None },
    Tier { tier: "opus", provider: CLAUDE, seat: 4.0, model: "claude-opus-5-5",
        versions: &[("5.5", "claude-opus-5-5"), ("5", "claude-opus-5"), ("4.8", "claude-opus-4-8")], letter: "O",
        context: Some(1_000_000), live_effort: true, legacy: false, conditional: false, prices: None },
    Tier { tier: "sonnet", provider: CLAUDE, seat: 2.0, model: "claude-sonnet-5-5",
        versions: &[("5.5", "claude-sonnet-5-5"), ("5", "claude-sonnet-5")], letter: "S",
        context: Some(1_000_000), live_effort: true, legacy: false, conditional: false, prices: None },
    Tier { tier: "haiku", provider: CLAUDE, seat: 0.5, model: "claude-haiku-5-5",
        versions: &[("5.5", "claude-haiku-5-5"), ("4.5", "claude-haiku-4-5")], letter: "H",
        context: Some(1_000_000), live_effort: true, legacy: false, conditional: false, prices: None },
    Tier { tier: "astra", provider: OPENAI, seat: 10.0, model: "gpt-6-astra",
        versions: &[("6", "gpt-6-astra")], letter: "A",
        context: Some(1_050_000), live_effort: false, legacy: false, conditional: false, prices: Some((10.0, 1.0, 50.0)) },
    Tier { tier: "sol", provider: OPENAI, seat: 2.0, model: "gpt-6.1-sol",
        versions: &[("6.1", "gpt-6.1-sol"), ("6", "gpt-6-sol"), ("5.6", "gpt-5.6-sol")], letter: "S",
        context: Some(1_050_000), live_effort: false, legacy: false, conditional: false, prices: Some((2.0, 0.10, 10.0)) },
    // GPT-6.1 Terra (user 2026-10-26 "get 4.4.6 out with this", then "make
    // sure to take terra out of the legacy models checkbox"): a current tier
    // again, with 5.6 kept as a pin. Seated by the input-price rule ($1 → 1).
    Tier { tier: "terra", provider: OPENAI, seat: 1.0, model: "gpt-6.1-terra",
        versions: &[("6.1", "gpt-6.1-terra"), ("5.6", "gpt-5.6-terra")], letter: "T",
        context: Some(1_050_000), live_effort: false, legacy: false, conditional: false, prices: Some((1.0, 0.05, 5.0)) },
    Tier { tier: "luna", provider: OPENAI, seat: 0.1, model: "gpt-6-luna",
        versions: &[("6", "gpt-6-luna"), ("5.6", "gpt-5.6-luna")], letter: "L",
        context: None, live_effort: false, legacy: false, conditional: false, prices: Some((0.10, 0.01, 0.60)) },
    Tier { tier: "gpt-reserve", provider: OPENAI, seat: 0.2, model: "gpt-reserve",
        versions: &[], letter: "R",
        context: None, live_effort: false, legacy: true, conditional: false, prices: Some((0.20, 0.02, 1.20)) },
    // Flash is LEGACY since Hydrogen (user 2026-11-13 md16909f83245 "Now"): behind "Show legacy models" on the
    // desktop, out of list_tiers and the staffing options. Seats on it keep running and it is still placed by name.
    Tier { tier: "flash", provider: GOOGLE, seat: 1.0, model: "gemini-3.8-flash",
        versions: &[("3.8", "gemini-3.8-flash"), ("3.7", "gemini-3.7-flash"), ("3.6", "gemini-3.6-flash")], letter: "F",
        context: Some(1_000_000), live_effort: false, legacy: true, conditional: false, prices: None },
    // Gemini 4 Hydrogen (user 2026-11-12 m6b3dbb2cfa71; unreleased): Flash's successor. ALWAYS offered, whether
    // or not the account's `agy models` lists it (user 2026-11-13 m6258781910ea "make hydrogen always available
    // unconditionally regardless of the check"); a turn the account cannot run ends with a plain reason
    // (`runtime::agy::unavailable_model_error`). PLACEHOLDERS until a real turn: the id is the user's word, seat 1
    // by the input-price rule ($1.5 per million), efforts low/medium/high/xhigh, the Gemini pool. Declared right after Flash
    // so it takes Flash's place in the default order.
    Tier { tier: "hydrogen", provider: GOOGLE, seat: 1.0, model: "gemini-4-hydrogen",
        versions: &[("4", "gemini-4-hydrogen")], letter: "H",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: false, prices: None },
    Tier { tier: "pro", provider: GOOGLE, seat: 2.0, model: "gemini-3.1-pro",
        versions: &[("3.1", "gemini-3.1-pro")], letter: "P",
        context: Some(1_000_000), live_effort: false, legacy: true, conditional: false, prices: None },
    Tier { tier: "argon", provider: GOOGLE, seat: 2.0, model: "gemini-4-argon",
        versions: &[("4", "gemini-4-argon")], letter: "A",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
    Tier { tier: "krypton", provider: GOOGLE, seat: 2.0, model: "gemini-4-krypton",
        versions: &[("4", "gemini-4-krypton")], letter: "K",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
    // Gemini 4 Carbon (speculative 2026-10-10, confirmed on a real turn 2026-11-11): offered only while the
    // account's `agy models` lists it. Seat 4 by the user's ruling (2026-11-12 m18bc0505e597 "change carbon's
    // credit cost to 4"), no longer the placeholder 2 copied from Pro; seats hired at 2 keep it until rehired.
    Tier { tier: "carbon", provider: GOOGLE, seat: 4.0, model: "gemini-4-carbon",
        versions: &[("4", "gemini-4-carbon")], letter: "C",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
    Tier { tier: "agy-sonnet", provider: GOOGLE, seat: 2.0, model: "claude-sonnet-5-5-high",
        versions: &[("5.5", "claude-sonnet-5-5-high")], letter: "S",
        context: None, live_effort: false, legacy: false, conditional: false, prices: None },
    Tier { tier: "agy-opus", provider: GOOGLE, seat: 4.0, model: "claude-opus-5-5-high",
        versions: &[("5.5", "claude-opus-5-5-high")], letter: "O",
        context: None, live_effort: false, legacy: false, conditional: false, prices: None },
    // Muse Code (2026-10-12): every Muse tier is offered only while the
    // signed-in account's authenticated catalog (`model/list`, source
    // providerCatalog) lists its model as visible; the window and the effort
    // variants come from that catalog, never from here. Subscription
    // turns publish no price (cost unknown, never $0).
    Tier { tier: "wonder", provider: MUSE, seat: 4.0, model: "muse-wonder-1.0",
        versions: &[("1.0", "muse-wonder-1.0")], letter: "W",
        context: None, live_effort: false, legacy: false, conditional: true, prices: None },
    Tier { tier: "wonder-full", provider: MUSE, seat: 10.0, model: "muse-wonder-full-1.0",
        versions: &[("1.0", "muse-wonder-full-1.0")], letter: "F",
        context: None, live_effort: false, legacy: false, conditional: true, prices: None },
    Tier { tier: "spark", provider: MUSE, seat: 2.0, model: "muse-spark-1.3",
        versions: &[("1.3", "muse-spark-1.3"), ("1.2", "muse-spark-1.2")], letter: "S",
        context: None, live_effort: false, legacy: false, conditional: true, prices: None },
];

pub const SEAT_FLOOR: f64 = 0.10;
/// Claude Code's effort levels, as its own `--effort` names them (measured on
/// the installed CLI 2026-10-12: low, medium, high, xhigh, max).
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
pub const DEFAULT_EFFORT: &str = "high";
/// Muse Code's persistent effort tiers as its bundled settings contract names
/// them (Muse 1.4.6). Which ones a model takes is its catalog row's
/// `variants`; `ultra` (max on the wire plus proactive workflows) and the
/// wire-only `none` are never offered to an agent.
pub const MUSE_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];
/// Every effort level name a harness here exposes, lowest first: Claude
/// Code's (`EFFORTS`), Codex's (its `model/list` `supportedReasoningEfforts`,
/// which can include `none` and `minimal`) and Muse's (its catalog
/// `variants`). Each tier offers its own harness and model's subset under
/// their own names (user 2026-10-12); the order is what a compatibility
/// mapping compares. A name outside it is not offered.
pub const EFFORT_ORDER: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Where a level name stands in `EFFORT_ORDER`.
#[nolog]
pub fn effort_rank(level: &str) -> Option<usize> {
    EFFORT_ORDER.iter().position(|l| *l == level)
}

/// The effort an agent's turns launch with (3.x `Org.effective_effort`): its
/// own level, else the org default (`settings` = the org's effective
/// settings), else DEFAULT_EFFORT. Never empty, and a stored level no harness
/// names reads as DEFAULT_EFFORT, not as the org default. Each launcher then
/// sends the name its own harness and model take (`launch_effort`).
#[logged]
pub fn effective_effort(scope: &serde_json::Value, settings: &serde_json::Value) -> String {
    let own = scope.get("effort").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let level = own.or_else(|| settings.get("default_effort").and_then(|v| v.as_str())).unwrap_or("");
    if effort_rank(level).is_some() { level.to_string() } else { DEFAULT_EFFORT.to_string() }
}

/// The compatibility mapping (user 2026-10-12: harness-native names, stored
/// meaning kept): the name a turn is sent when its harness and model offer
/// `offered`, and whether it differs from the saved level. A level offered
/// under its own name goes as it is; otherwise the highest offered level at
/// or below its rank, else the lowest offered: the same clamp the effort
/// bar shows. The saved value itself is never rewritten, so switching back
/// restores it. An empty offered list means this model accepts no effort
/// argument; callers represent an unknown offer as `None` before reaching it.
#[logged]
pub fn launch_effort(level: &str, offered: &[String]) -> (String, bool) {
    if offered.is_empty() {
        return (String::new(), false);
    }
    if offered.iter().any(|o| o == level) {
        return (level.to_string(), false);
    }
    let ranked: Vec<(usize, &String)> = offered.iter().filter_map(|o| effort_rank(o).map(|r| (r, o))).collect();
    let Some(lowest) = ranked.iter().min_by_key(|(r, _)| *r) else { return (level.to_string(), false) };
    let pick = effort_rank(level)
        .and_then(|want| ranked.iter().filter(|(r, _)| *r <= want).max_by_key(|(r, _)| *r))
        .unwrap_or(lowest);
    (pick.1.clone(), true)
}

/// The level a Muse turn is sent, and whether it differs from the agent's:
/// `launch_effort` over the model's catalog `variants`. With no catalog row,
/// the level stands if it is a Muse name, else the catalog default, else
/// Muse's own baseline `high`.
#[logged]
pub fn muse_effort(level: &str, variants: Option<&[String]>, default: Option<&str>) -> (String, bool) {
    match variants {
        Some(v) if v.is_empty() => (String::new(), false),
        Some(v) => launch_effort(level, v),
        None if MUSE_EFFORTS.contains(&level) => (level.to_string(), false),
        None => (default.filter(|d| MUSE_EFFORTS.contains(d)).unwrap_or(DEFAULT_EFFORT).to_string(), true),
    }
}

/// Match the verified Antigravity CLI vocabulary; larger inherited levels clamp
/// to the model's highest (xhigh for Hydrogen, the one model the CLI names an
/// `-xhigh` id for; high for every other), and the levels below its lowest
/// (`none`, `minimal`) to low. Staffing offers only levels that need no translation.
#[logged]
pub fn antigravity_effort<'a>(tier: &str, effort: &'a str) -> &'a str {
    match effort {
        "low" | "high" => effort,
        "none" | "minimal" => "low",
        "medium" if matches!(tier, "flash" | "argon" | "carbon" | "hydrogen") || antigravity_claude(tier) => effort,
        "xhigh" | "max" if tier == "hydrogen" => "xhigh",
        _ => "high",
    }
}

#[nolog]
pub fn antigravity_claude(tier: &str) -> bool {
    matches!(tier, "agy-sonnet" | "agy-opus")
}

/// These independent tiers have no model versions; effort selects a verified CLI id.
#[logged]
pub fn antigravity_model(tier: &str, model: &str, effort: &str) -> String {
    if antigravity_claude(tier) {
        format!("{}-{}", model.trim_end_matches("-high"), antigravity_effort(tier, effort))
    } else {
        model.to_string()
    }
}

/// A tier whose turn cost is an ESTIMATE: its provider has not published a price, so its turns are priced from
/// a guess and marked estimated (the spend badge's "est."). Hydrogen only (user 2026-11-13 md16909f83245:
/// $1.50 input as given, output guessed from Flash's ratio); drop it here when the real price is known.
#[nolog]
pub fn cost_is_estimate(tier: &str) -> bool {
    tier == "hydrogen"
}

#[nolog]
pub fn antigravity_pool(tier: &str) -> &'static str {
    if antigravity_claude(tier) { "3p" } else { "gemini" }
}

/// A conditional Gemini tier's own quota bucket, beside its pool's windows:
/// /usage reports Argon's "Gemini 4 Argon Weekly Limit" as group
/// `gemini-argon-wtu-weekly` (measured 2026-10-27). The token is the tier
/// name, matched as one part of a group id; only that tier spends it.
pub fn antigravity_own_bucket(tier: &str) -> Option<&'static str> {
    TIERS.iter().find(|t| t.tier == tier && t.provider == GOOGLE && t.conditional).map(|t| t.tier)
}

pub fn tier(name: &str) -> Option<&'static Tier> {
    TIERS.iter().find(|t| t.tier == name)
}

/// The version a NEW hire of the tier gets written into its scope when it names none: the latest offered version
/// when it differs from the tier's legacy default (`model`, what "no version saved" has always meant for a seat
/// that exists). Fable 5.2 (USER 2026-11-09 21:52Z): `None` for every tier whose latest IS its default.
#[nolog]
pub fn new_hire_version(t: &Tier) -> Option<&'static str> {
    t.versions.first().filter(|(_, model)| *model != t.model).map(|(version, _)| *version)
}

/// The model a new hire of the tier runs: its default model, or the one `new_hire_version` names.
#[nolog]
pub fn new_hire_model(t: &Tier) -> &'static str {
    t.versions.first().filter(|(_, model)| *model != t.model).map_or(t.model, |(_, model)| *model)
}

/// The version a seat that EXISTS with no saved version still means, when that differs from what a new hire gets
/// (Fable: "5.1"); `None` when blank and the latest are the same.
#[nolog]
pub fn legacy_version(t: &Tier) -> Option<&'static str> {
    new_hire_version(t)?;
    t.versions.iter().find(|(_, model)| *model == t.model).map(|(version, _)| *version)
}

/// The user-facing name of what a new hire of the tier gets.
#[logged]
pub fn new_hire_display_name(t: &Tier) -> Option<String> {
    display_name(t, new_hire_version(t))
}

/// Product and family names shown beside an agent's selected model. Keep
/// these with the model catalog so every renderer uses the same vendor names.
fn display_family(t: &Tier) -> Option<&'static str> {
    Some(match (t.provider, t.tier) {
        (CLAUDE, "fable") => "Claude Fable",
        (CLAUDE, "opus") => "Claude Opus",
        (GOOGLE, "agy-opus") => "Opus",
        (CLAUDE, "sonnet") => "Claude Sonnet",
        (GOOGLE, "agy-sonnet") => "Sonnet",
        (CLAUDE, "haiku") => "Claude Haiku",
        (OPENAI, "astra") => "ChatGPT Astra",
        (OPENAI, "sol") => "ChatGPT Sol",
        (OPENAI, "terra") => "ChatGPT Terra",
        (OPENAI, "luna") => "ChatGPT Luna",
        (OPENAI, "gpt-reserve") => "ChatGPT Reserve",
        (GOOGLE, "flash") => "Gemini Flash",
        (GOOGLE, "pro") => "Gemini Pro",
        (GOOGLE, "argon") => "Gemini Argon",
        (GOOGLE, "krypton") => "Gemini Krypton",
        (GOOGLE, "carbon") => "Gemini Carbon",
        (GOOGLE, "hydrogen") => "Gemini Hydrogen",
        (MUSE, "wonder") => "Muse Wonder",
        (MUSE, "wonder-full") => "Muse Wonder Full",
        (MUSE, "spark") => "Muse Spark",
        _ => return None,
    })
}

/// The catalog's user-facing model name for a tier and optional pinned version.
#[logged]
pub fn display_name(t: &Tier, requested_version: Option<&str>) -> Option<String> {
    let family = display_family(t)?;
    let version = requested_version
        .and_then(|wanted| t.versions.iter().find(|(v, _)| *v == wanted).map(|(v, _)| *v))
        .or_else(|| t.versions.iter().find(|(_, model)| *model == t.model).map(|(v, _)| *v))
        .or_else(|| t.versions.first().map(|(v, _)| *v));
    Some(version.map_or_else(|| family.to_owned(), |v| format!("{family} {v}")))
}

/// The catalog in the order tiers are LISTED together (user 2026-10-13):
/// providers in the order the catalog first names them, and within a
/// provider the dearest seat first. The sort is stable, so equal seats keep
/// their catalog order. Every picker, menu and list reads this, so a tier
/// added to `TIERS` orders itself; `TIERS` itself stays the order a default
/// is taken from (the first offered) and is never shown as is.
#[nolog]
pub fn listed() -> &'static [&'static Tier] {
    static LISTED: std::sync::OnceLock<Vec<&'static Tier>> = std::sync::OnceLock::new();
    LISTED.get_or_init(|| {
        let rank = |provider: &str| TIERS.iter().position(|t| t.provider == provider).unwrap_or(usize::MAX);
        let mut out: Vec<&'static Tier> = TIERS.iter().collect();
        out.sort_by(|a, b| rank(a.provider).cmp(&rank(b.provider)).then(b.seat.total_cmp(&a.seat)));
        out
    })
}

/// Where a catalog tier stands in `listed()`; tiers outside the catalog
/// (OpenRouter, language model servers) come after it.
#[nolog]
pub fn listed_rank(name: &str) -> usize {
    listed().iter().position(|t| t.tier == name).unwrap_or(usize::MAX)
}

/// The letter on a runtime tier's chip: the first letter of the first word
/// of its model's label (`claude-sonnet-5` → C, `qwen3.6-35b-a3b:latest` →
/// Q), the rule OpenRouter favorites have used since they were added; `?`
/// for a label without one. The lane's colour marks the lane, not the letter.
#[logged]
pub fn monogram(label: &str) -> String {
    let first = label.split([':', '-', '_', '.', '/', ' ']).find(|t| !t.is_empty()).unwrap_or("?");
    first.chars().next().map(|c| c.to_ascii_uppercase().to_string()).unwrap_or_else(|| "?".into())
}

pub fn is_openrouter(tier: &str) -> bool {
    tier.starts_with("or-")
}

/// A model on one of the user's language model servers (`ls-<server>-<model>`).
#[nolog]
pub fn is_langserver(tier: &str) -> bool {
    tier.starts_with(crate::langserver::TIER_PREFIX)
}

/// Which provider a tier runs on. Unknown tiers answer "claude" (the safe
/// same-lane default: a wrong cross-provider verdict would reset a session).
pub fn provider_of(tier: &str) -> &'static str {
    if is_openrouter(tier) {
        return OPENROUTER;
    }
    if is_langserver(tier) {
        return LANGSERVER;
    }
    self::tier(tier).map(|t| t.provider).unwrap_or(CLAUDE)
}

/// The provider one agent runs on, as messages about that agent name it
/// ("the Language model server process exited…"), so it stays singular. The
/// provider class and collection are "Language model servers" (user 2026-10-12
/// 21:22Z): see the Providers payload and `turned_off`.
pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        OPENAI => "Codex",
        GOOGLE => "Antigravity",
        OPENROUTER => "OpenRouter",
        LANGSERVER => "Language model server",
        MUSE => "Muse",
        _ => "Claude",
    }
}

/// Why a provider switched off in App settings › Providers can't be used.
/// That switch belongs to the whole class, so Language model servers take a
/// plural verb (as `langserver::route` says it).
#[nolog]
pub fn turned_off(provider: &str) -> String {
    match provider {
        LANGSERVER => "Language model servers are turned off in App settings".to_string(),
        _ => format!("{} is turned off in App settings", provider_label(provider)),
    }
}

/// A Muse Code tier (`wonder`, `wonder-full`, `spark`).
#[nolog]
pub fn is_muse(tier: &str) -> bool {
    self::tier(tier).is_some_and(|t| t.provider == MUSE)
}

/// The account-mark pool a Muse tier's limit is recorded under (`muse:<tier>`).
#[nolog]
pub fn muse_pool(tier: &str) -> String {
    format!("muse:{tier}")
}

/// Whether `tier` runs `model`: its own model or one of its versions'.
#[nolog]
pub fn runs_model(tier: &str, model: &str) -> bool {
    self::tier(tier).is_some_and(|t| t.model == model || t.versions.iter().any(|(_, m)| *m == model))
}

/// The model id a node on `tier` (optionally pinned to `version`) runs.
pub fn model_for(tier: &str, version: Option<&str>) -> String {
    if let Some(t) = self::tier(tier) {
        if let Some(v) = version {
            if let Some((_, m)) = t.versions.iter().find(|(k, _)| *k == v) {
                return m.to_string();
            }
        }
        return t.model.to_string();
    }
    tier.to_string()
}

pub fn seat_price(tier: &str) -> f64 {
    self::tier(tier).map(|t| t.seat).unwrap_or(1.0)
}

#[cfg(test)]
mod effort_tests {
    use super::*;

    fn v(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    /// A level offered under its own name goes as it is; any other maps to the
    /// highest offered at or below it, else the lowest offered (the bar's clamp).
    #[test]
    fn launch_effort_keeps_native_names_and_clamps_the_rest() {
        let claude = v(EFFORTS);
        assert_eq!(launch_effort("xhigh", &claude), ("xhigh".into(), false));
        assert_eq!(launch_effort("minimal", &claude), ("low".into(), true));
        assert_eq!(launch_effort("none", &claude), ("low".into(), true));
        let codex = v(&["minimal", "low", "medium", "high", "xhigh"]);
        assert_eq!(launch_effort("max", &codex), ("xhigh".into(), true));
        assert_eq!(launch_effort("minimal", &codex), ("minimal".into(), false));
        let full = v(&["minimal", "low", "medium", "high", "xhigh"]);
        assert_eq!(launch_effort("max", &full), ("xhigh".into(), true));
        // A known model with no effort setting receives no launch argument.
        assert_eq!(launch_effort("max", &[]), (String::new(), false));
        // an unknown saved name takes the lowest offered, never an invented one
        assert_eq!(launch_effort("ultra", &codex), ("minimal".into(), true));
    }

    #[test]
    fn muse_effort_uses_the_rows_names() {
        let wonder = v(MUSE_EFFORTS);
        assert_eq!(muse_effort("max", Some(&wonder), Some("high")), ("max".into(), false));
        let full = v(&["minimal", "low", "medium", "high", "xhigh"]);
        assert_eq!(muse_effort("max", Some(&full), Some("high")), ("xhigh".into(), true));
        assert_eq!(muse_effort("high", Some(&[]), Some("high")), (String::new(), false));
        assert_eq!(muse_effort("minimal", None, None), ("minimal".into(), false));
        assert_eq!(muse_effort("none", None, Some("high")), ("high".into(), true));
    }

    /// Older saved levels keep reading as themselves; a name no harness has
    /// reads as the default, as before.
    #[test]
    fn saved_levels_from_every_harness_stay_effective() {
        let s = serde_json::json!({});
        for l in EFFORT_ORDER {
            assert_eq!(effective_effort(&serde_json::json!({ "effort": l }), &s), *l);
        }
        assert_eq!(effective_effort(&serde_json::json!({ "effort": "ultra" }), &s), DEFAULT_EFFORT);
        assert_eq!(effective_effort(&serde_json::json!({}), &serde_json::json!({ "default_effort": "minimal" })), "minimal");
    }

    #[test]
    fn antigravity_maps_the_lowest_names_down() {
        assert_eq!(antigravity_effort("flash", "minimal"), "low");
        assert_eq!(antigravity_effort("flash", "none"), "low");
        assert_eq!(antigravity_effort("argon", "max"), "high");
    }

    #[test]
    fn argon_effort_medium_reaches_the_launch_mapping() {
        assert_eq!(antigravity_effort("argon", "medium"), "medium");
        assert_eq!(antigravity_model("argon", "gemini-4-argon", "medium"), "gemini-4-argon");
        for (saved, expected) in [("low", "low"), ("high", "high"), ("max", "high"), ("minimal", "low")] {
            assert_eq!(antigravity_effort("argon", saved), expected);
        }
    }

    #[test]
    fn argon_effort_picker_offers_medium_without_widening_other_tiers() {
        let state = crate::providers::State::default();
        assert_eq!(crate::providers::effort_names(&state, "argon"), Some(v(&["low", "medium", "high"])));
        // Carbon (user 2026-11-11 "missing the medium effort level"): the installed agy 1.5.6 carries the explicit
        // `gemini-4-carbon-medium` id and the "Gemini 4 Carbon (Medium)" label (static inspection, see argon-effort.md)
        assert_eq!(crate::providers::effort_names(&state, "carbon"), Some(v(&["low", "medium", "high"])));
        assert_eq!(antigravity_effort("carbon", "medium"), "medium");
        for tier in ["pro", "krypton"] {
            assert_eq!(crate::providers::effort_names(&state, tier), Some(v(&["low", "high"])), "{tier}");
        }
        for tier in ["flash", "agy-sonnet", "agy-opus"] {
            assert_eq!(crate::providers::effort_names(&state, tier), Some(v(&["low", "medium", "high"])), "{tier}");
        }
    }

    /// Barium was replaced by Krypton (user 2026-11-11): a stale stored "barium" is an unknown tier
    /// (no alias), so `seat_of` refuses it with "unknown tier" and it is never offered.
    #[test]
    fn a_stale_barium_is_an_unknown_tier_and_krypton_takes_its_place() {
        assert!(tier("barium").is_none());
        let k = tier("krypton").expect("krypton");
        assert!(k.conditional && k.provider == GOOGLE && k.seat == 2.0 && k.letter == "K" && k.model == "gemini-4-krypton");
    }

    /// Carbon costs 4 credits (user 2026-11-12 m18bc0505e597 "change carbon's credit cost to 4"): the price of
    /// Opus, Wonder and agy-opus, no longer the placeholder 2 it copied from Pro. Krypton and Argon keep 2.
    #[test]
    fn carbon_costs_four_credits_like_opus() {
        assert_eq!(seat_price("carbon"), 4.0);
        for same in ["opus", "wonder", "agy-opus"] {
            assert_eq!(seat_price(same), seat_price("carbon"), "{same}");
        }
        for unchanged in ["argon", "krypton", "pro"] {
            assert_eq!(seat_price(unchanged), 2.0, "{unchanged}");
        }
    }

    /// Gemini 4 Hydrogen (user 2026-11-12 m6b3dbb2cfa71, unreleased: every figure here is a placeholder until a
    /// real turn): a Gemini tier in the $1.5 input band, so seat 1 like Flash, which it replaces. It is offered
    /// unconditionally (user 2026-11-13 m6258781910ea), not on agy's model list like Argon, Krypton and Carbon.
    /// user 2026-11-13 m39ddd2612ce5: "also make sure hydrogen has an xhigh effort level that's selectable".
    /// How agy takes it, by static inspection of the installed CLI (244,091,032 bytes, SHA256 064e6519...aa2f;
    /// nothing was run): it carries the id `gemini-4-hydrogen-xhigh` and the label "Gemini 4 Hydrogen (XHigh)",
    /// the only `-xhigh` model id in it, and its `--effort` help reads "(low|medium|high|xhigh|max)". So xhigh is
    /// asked for as every Gemini effort is: `--model gemini-4-hydrogen --effort xhigh`.
    /// Medium (user m293bedc7db68 "add medium, and add it for carbon"): the same CLI names
    /// `gemini-4-hydrogen-medium` and "Gemini 4 Hydrogen (Medium)". Carbon's medium is pinned in
    /// `argon_effort_picker_offers_medium_without_widening_other_tiers`.
    #[test]
    fn hydrogen_offers_xhigh_and_the_launch_asks_for_it_by_name() {
        let state = crate::providers::State::default();
        assert_eq!(crate::providers::effort_names(&state, "hydrogen"), Some(v(&["low", "medium", "high", "xhigh"])));
        assert_eq!(crate::providers::effort_names(&state, "carbon"), Some(v(&["low", "medium", "high"])));
        assert_eq!(antigravity_effort("hydrogen", "medium"), "medium");
        assert_eq!(antigravity_model("hydrogen", "gemini-4-hydrogen", "medium"), "gemini-4-hydrogen");
        assert_eq!(antigravity_effort("hydrogen", "xhigh"), "xhigh");
        assert_eq!(antigravity_model("hydrogen", "gemini-4-hydrogen", "xhigh"), "gemini-4-hydrogen", "the effort is a flag, not an id suffix");
        // a level above its highest becomes its highest, which is xhigh here and high everywhere else
        assert_eq!(antigravity_effort("hydrogen", "max"), "xhigh");
        for (saved, sent) in [("low", "low"), ("high", "high"), ("none", "low"), ("minimal", "low")] {
            assert_eq!(antigravity_effort("hydrogen", saved), sent, "{saved}");
        }
        // medium stays off the two models the CLI names no -medium id for
        for tier in ["pro", "krypton"] { assert_eq!(antigravity_effort(tier, "medium"), "high", "{tier}"); }
        // no other Antigravity model gains it: the CLI names no other -xhigh id
        for tier in ["flash", "argon", "carbon", "krypton", "pro", "agy-opus", "agy-sonnet"] {
            assert_eq!(antigravity_effort(tier, "xhigh"), "high", "{tier}");
            assert_eq!(antigravity_effort(tier, "max"), "high", "{tier}");
            assert!(!crate::providers::effort_names(&state, tier).unwrap().iter().any(|e| e == "xhigh"), "{tier}");
        }
    }

    /// Flash (user 2026-11-13 md16909f83245 "Now") is legacy: known, placed by name, offered by no list.
    #[test]
    fn hydrogen_is_an_always_offered_gemini_tier_and_flash_is_legacy() {
        let h = tier("hydrogen").expect("hydrogen");
        assert_eq!((h.provider, h.model, h.letter, h.seat, h.conditional, h.legacy), (GOOGLE, "gemini-4-hydrogen", "H", 1.0, false, false));
        assert_eq!(h.seat, crate::openrouter::seat_for(1.5), "the standing input-price seat rule");
        assert_eq!(display_name(h, None).as_deref(), Some("Gemini Hydrogen 4"));
        assert_eq!((antigravity_pool("hydrogen"), antigravity_own_bucket("hydrogen")), ("gemini", None));
        let f = tier("flash").expect("flash stays a known tier: seats on it keep their letter, colour and price");
        assert!(f.legacy && !f.conditional);
        assert_eq!((f.seat, f.model), (1.0, "gemini-3.8-flash"));
        assert!(cost_is_estimate("hydrogen"));
        for measured in ["flash", "argon", "carbon", "krypton", "pro", "opus", "sol"] {
            assert!(!cost_is_estimate(measured), "{measured}");
        }
    }

    #[test]
    fn muse_tiers_and_pools() {
        for (name, seat) in [("wonder", 4.0), ("wonder-full", 10.0), ("spark", 2.0)] {
            let t = tier(name).unwrap();
            assert_eq!((t.provider, t.seat, t.conditional), (MUSE, seat, true));
            assert!(is_muse(name));
        }
        assert!(runs_model("spark", "muse-spark-1.2") && !runs_model("wonder", "muse-wonder-full-1.0"));
        assert_eq!(muse_pool("wonder-full"), "muse:wonder-full");
        assert_eq!(provider_label(MUSE), "Muse");
    }

    fn names(provider: &str) -> Vec<&'static str> {
        listed().iter().filter(|t| t.provider == provider).map(|t| t.tier).collect()
    }

    /// Fable 5.2 (USER 2026-11-09 21:52Z "throw that into the next release"): the latest offered Fable version, the
    /// default for NEW hires; a seat with no saved version keeps meaning 5.1 (coordinator 2026-11-09 22:05Z).
    #[test]
    fn fable_5_2_is_the_new_hire_default_and_unpinned_seats_stay_on_5_1() {
        let t = tier("fable").unwrap();
        assert_eq!(t.versions.iter().map(|(k, _)| *k).collect::<Vec<_>>(), ["5.2", "5.1", "5"]);
        assert_eq!(t.model, "claude-fable-5-1", "no saved version still means 5.1");
        assert_eq!(model_for("fable", None), "claude-fable-5-1");
        assert_eq!(model_for("fable", Some("5.2")), "claude-fable-5-2");
        assert_eq!(model_for("fable", Some("5.1")), "claude-fable-5-1");
        assert_eq!(model_for("fable", Some("5")), "claude-fable-5");
        assert_eq!(new_hire_version(t), Some("5.2"));
        assert_eq!(new_hire_model(t), "claude-fable-5-2");
        assert_eq!(display_name(t, None).as_deref(), Some("Claude Fable 5.1"), "the seat-less legacy read");
        assert_eq!(new_hire_display_name(t).as_deref(), Some("Claude Fable 5.2"));
        assert_eq!(t.context, Some(1_000_000));
    }

    /// The picker's blank option on an EXISTING seat names the legacy default (Fable: 5.1), only where it differs.
    #[test]
    fn the_legacy_version_is_named_only_where_blank_differs_from_the_latest() {
        assert_eq!(legacy_version(tier("fable").unwrap()), Some("5.1"));
        for t in TIERS.iter().filter(|t| t.tier != "fable") {
            assert_eq!(legacy_version(t), None, "{}", t.tier);
        }
    }

    /// Only a tier whose latest version is not its default gets an explicit version for a new hire.
    #[test]
    fn no_other_tier_writes_a_version_for_a_new_hire() {
        for t in TIERS.iter().filter(|t| t.tier != "fable") {
            assert_eq!(new_hire_version(t), None, "{}", t.tier);
            assert_eq!(new_hire_model(t), t.model, "{}", t.tier);
        }
    }

    /// The user's rule (2026-10-13): every provider lists its tiers dearest
    /// seat first; equal seats keep catalog order; providers keep their order.
    #[test]
    fn tiers_are_listed_dearest_first_within_each_provider() {
        assert_eq!(listed().len(), TIERS.len());
        assert_eq!(names(CLAUDE), ["fable", "opus", "sonnet", "haiku"]);
        assert_eq!(names(OPENAI), ["astra", "sol", "terra", "gpt-reserve", "luna"]);
        // Carbon seats at 4 (user 2026-11-12), level with agy-opus: equal seats keep catalog order, so it leads
        assert_eq!(names(GOOGLE), ["carbon", "agy-opus", "pro", "argon", "krypton", "agy-sonnet", "flash", "hydrogen"]);
        assert_eq!(names(MUSE), ["wonder-full", "wonder", "spark"]);
        // what a person sees: legacy and not-yet-listed models are hidden
        let seen = |p: &str, conditional: &[&str]| -> Vec<&'static str> {
            listed().iter().filter(|t| t.provider == p && !t.legacy && (!t.conditional || conditional.contains(&t.tier)))
                .map(|t| t.tier).collect()
        };
        // Flash is legacy since Hydrogen (user 2026-11-13): Hydrogen is the Gemini model every account is offered
        assert_eq!(seen(GOOGLE, &["agy-sonnet", "agy-opus"]), ["agy-opus", "agy-sonnet", "hydrogen"]);
        assert_eq!(seen(OPENAI, &[]), ["astra", "sol", "terra", "luna"]);
        // the rule itself, so a tier added later orders itself
        for p in [CLAUDE, OPENAI, GOOGLE, MUSE] {
            let seats: Vec<f64> = listed().iter().filter(|t| t.provider == p).map(|t| t.seat).collect();
            assert!(seats.windows(2).all(|w| w[0] >= w[1]), "{p}: {seats:?}");
            let catalog: Vec<&str> = TIERS.iter().filter(|t| t.provider == p).map(|t| t.tier).collect();
            for pair in listed().iter().filter(|t| t.provider == p).collect::<Vec<_>>().windows(2) {
                if pair[0].seat == pair[1].seat {
                    let at = |t: &Tier| catalog.iter().position(|c| *c == t.tier).unwrap();
                    assert!(at(pair[0]) < at(pair[1]), "{p}: equal seats must keep catalog order");
                }
            }
        }
    }

    /// GPT-6.1 Terra (user 2026-10-26 18:19Z "get 4.4.6 out with this";
    /// "make sure to take terra out of the legacy models checkbox"): Terra is
    /// a current Codex tier again. New seats run gpt-6.1-terra; a seat pinned
    /// to 5.6 keeps gpt-5.6-terra.
    #[test]
    fn terra_is_current_on_gpt_6_1_and_keeps_its_5_6_pin() {
        let t = tier("terra").unwrap();
        assert_eq!((t.provider, t.model, t.legacy, t.conditional), (OPENAI, "gpt-6.1-terra", false, false));
        assert_eq!(t.versions, &[("6.1", "gpt-6.1-terra"), ("5.6", "gpt-5.6-terra")]);
        assert_eq!(model_for("terra", None), "gpt-6.1-terra");
        assert_eq!(model_for("terra", Some("5.6")), "gpt-5.6-terra");
        assert!(runs_model("terra", "gpt-6.1-terra") && runs_model("terra", "gpt-5.6-terra"));
        // OpenAI's GPT-6.1 Terra API rates per million tokens
        assert_eq!(t.prices, Some((1.0, 0.05, 5.0)));
    }

    /// The standing seat rule, the one OpenRouter seats use: dollars per
    /// million input tokens. Every priced OpenAI tier follows it, and seat
    /// prices follow the latest model, so GPT-6.1 Terra's $1 seats at 1.
    #[test]
    fn openai_seats_follow_the_input_price_rule() {
        for t in TIERS.iter().filter(|t| t.provider == OPENAI) {
            let (input, _, _) = t.prices.unwrap_or_else(|| panic!("{} has no price", t.tier));
            assert_eq!(t.seat, crate::openrouter::seat_for(input), "{}", t.tier);
        }
        assert_eq!(seat_price("terra"), 1.0);
    }

    #[test]
    fn provider_groups_keep_the_catalog_order() {
        let mut groups: Vec<&str> = Vec::new();
        for t in listed() {
            if groups.last() != Some(&t.provider) {
                assert!(!groups.contains(&t.provider), "{} is split", t.provider);
                groups.push(t.provider);
            }
        }
        let mut old: Vec<&str> = Vec::new();
        for t in TIERS {
            if !old.contains(&t.provider) {
                old.push(t.provider);
            }
        }
        assert_eq!(groups, old);
        assert_eq!((listed_rank("fable"), listed_rank("nope")), (0, usize::MAX));
        assert!(listed_rank("wonder-full") < listed_rank("wonder") && listed_rank("wonder") < listed_rank("spark"));
    }
}
