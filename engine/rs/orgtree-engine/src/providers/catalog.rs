//! The model-tier catalog: a tier is a price band (one chip on the canvas);
//! a model version is a subcategory inside a tier.

pub const CLAUDE: &str = "claude";
pub const OPENAI: &str = "openai";
pub const GOOGLE: &str = "google";
pub const OPENROUTER: &str = "openrouter";
/// Models on the user's own (local or self-hosted) language servers, driven
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
    Tier { tier: "fable", provider: CLAUDE, seat: 10.0, model: "claude-fable-5-1",
        versions: &[("5.1", "claude-fable-5-1"), ("5", "claude-fable-5")], letter: "F",
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
        versions: &[], letter: "A",
        context: Some(1_050_000), live_effort: false, legacy: false, conditional: false, prices: Some((10.0, 1.0, 50.0)) },
    Tier { tier: "sol", provider: OPENAI, seat: 2.0, model: "gpt-6.1-sol",
        versions: &[("6.1", "gpt-6.1-sol"), ("6", "gpt-6-sol"), ("5.6", "gpt-5.6-sol")], letter: "S",
        context: Some(1_050_000), live_effort: false, legacy: false, conditional: false, prices: Some((2.0, 0.10, 10.0)) },
    Tier { tier: "terra", provider: OPENAI, seat: 2.0, model: "gpt-5.6-terra",
        versions: &[], letter: "T",
        context: Some(1_050_000), live_effort: false, legacy: true, conditional: false, prices: Some((2.0, 0.20, 12.0)) },
    Tier { tier: "luna", provider: OPENAI, seat: 0.1, model: "gpt-6-luna",
        versions: &[("6", "gpt-6-luna"), ("5.6", "gpt-5.6-luna")], letter: "L",
        context: None, live_effort: false, legacy: false, conditional: false, prices: Some((0.10, 0.01, 0.60)) },
    Tier { tier: "gpt-reserve", provider: OPENAI, seat: 0.2, model: "gpt-reserve",
        versions: &[], letter: "R",
        context: None, live_effort: false, legacy: true, conditional: false, prices: Some((0.20, 0.02, 1.20)) },
    Tier { tier: "flash", provider: GOOGLE, seat: 1.0, model: "gemini-3.8-flash",
        versions: &[("3.8", "gemini-3.8-flash"), ("3.7", "gemini-3.7-flash"), ("3.6", "gemini-3.6-flash")], letter: "F",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: false, prices: None },
    Tier { tier: "pro", provider: GOOGLE, seat: 2.0, model: "gemini-3.1-pro",
        versions: &[], letter: "P",
        context: Some(1_000_000), live_effort: false, legacy: true, conditional: false, prices: None },
    Tier { tier: "argon", provider: GOOGLE, seat: 2.0, model: "gemini-4-argon",
        versions: &[("4", "gemini-4-argon")], letter: "A",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
    Tier { tier: "barium", provider: GOOGLE, seat: 2.0, model: "gemini-4-barium",
        versions: &[("4", "gemini-4-barium")], letter: "B",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
    // speculative Gemini 4 Carbon (user 2026-10-10): a copy of Barium, offered
    // only while the account's `agy models` lists it
    Tier { tier: "carbon", provider: GOOGLE, seat: 2.0, model: "gemini-4-carbon",
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
/// to high, and the levels below its lowest (`none`, `minimal`) to low.
/// Staffing offers only levels that need no translation.
#[logged]
pub fn antigravity_effort<'a>(tier: &str, effort: &'a str) -> &'a str {
    match effort {
        "low" | "high" => effort,
        "none" | "minimal" => "low",
        "medium" if matches!(tier, "flash" | "argon") || antigravity_claude(tier) => effort,
        _ => "high",
    }
}

#[logged]
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

#[logged]
pub fn antigravity_pool(tier: &str) -> &'static str {
    if antigravity_claude(tier) { "3p" } else { "gemini" }
}

pub fn tier(name: &str) -> Option<&'static Tier> {
    TIERS.iter().find(|t| t.tier == name)
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
        (GOOGLE, "barium") => "Gemini Barium",
        (GOOGLE, "carbon") => "Gemini Carbon",
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
/// (OpenRouter, language servers) come after it.
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

/// A model on one of the user's language servers (`ls-<server>-<model>`).
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
/// ("the Language Server process exited…"), so it stays singular. The
/// provider class and collection are "Language servers" (user 2026-10-12
/// 21:22Z): see the Providers payload and `turned_off`.
pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        OPENAI => "Codex",
        GOOGLE => "Antigravity",
        OPENROUTER => "OpenRouter",
        LANGSERVER => "Language Server",
        MUSE => "Muse",
        _ => "Claude",
    }
}

/// Why a provider switched off in App settings › Providers can't be used.
/// That switch belongs to the whole class, so Language servers take a
/// plural verb (as `langserver::route` says it).
#[nolog]
pub fn turned_off(provider: &str) -> String {
    match provider {
        LANGSERVER => "Language servers are turned off in App settings".to_string(),
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
        for tier in ["pro", "barium", "carbon"] {
            assert_eq!(crate::providers::effort_names(&state, tier), Some(v(&["low", "high"])), "{tier}");
        }
        for tier in ["flash", "agy-sonnet", "agy-opus"] {
            assert_eq!(crate::providers::effort_names(&state, tier), Some(v(&["low", "medium", "high"])), "{tier}");
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

    /// The user's rule (2026-10-13): every provider lists its tiers dearest
    /// seat first; equal seats keep catalog order; providers keep their order.
    #[test]
    fn tiers_are_listed_dearest_first_within_each_provider() {
        assert_eq!(listed().len(), TIERS.len());
        assert_eq!(names(CLAUDE), ["fable", "opus", "sonnet", "haiku"]);
        assert_eq!(names(OPENAI), ["astra", "sol", "terra", "gpt-reserve", "luna"]);
        assert_eq!(names(GOOGLE), ["agy-opus", "pro", "argon", "barium", "carbon", "agy-sonnet", "flash"]);
        assert_eq!(names(MUSE), ["wonder-full", "wonder", "spark"]);
        // what a person sees: legacy and not-yet-listed models are hidden
        let seen = |p: &str, conditional: &[&str]| -> Vec<&'static str> {
            listed().iter().filter(|t| t.provider == p && !t.legacy && (!t.conditional || conditional.contains(&t.tier)))
                .map(|t| t.tier).collect()
        };
        assert_eq!(seen(GOOGLE, &["agy-sonnet", "agy-opus"]), ["agy-opus", "agy-sonnet", "flash"]);
        assert_eq!(seen(OPENAI, &[]), ["astra", "sol", "luna"]);
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
