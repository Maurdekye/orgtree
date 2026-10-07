//! The model-tier catalog: a tier is a price band (one chip on the canvas);
//! a model version is a subcategory inside a tier.

pub const CLAUDE: &str = "claude";
pub const OPENAI: &str = "openai";
pub const GOOGLE: &str = "google";
pub const OPENROUTER: &str = "openrouter";

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
        versions: &[], letter: "A",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
    Tier { tier: "barium", provider: GOOGLE, seat: 2.0, model: "gemini-4-barium",
        versions: &[], letter: "B",
        context: Some(1_000_000), live_effort: false, legacy: false, conditional: true, prices: None },
];

pub const SEAT_FLOOR: f64 = 0.10;
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
pub const DEFAULT_EFFORT: &str = "high";

/// Match the 3.x Antigravity CLI vocabulary; larger inherited levels clamp
/// to high. Staffing offers only levels that need no translation.
#[logged]
pub fn antigravity_effort<'a>(tier: &str, effort: &'a str) -> &'a str {
    match effort {
        "low" | "high" => effort,
        "medium" if tier == "flash" => effort,
        _ => "high",
    }
}

pub fn tier(name: &str) -> Option<&'static Tier> {
    TIERS.iter().find(|t| t.tier == name)
}

pub fn is_openrouter(tier: &str) -> bool {
    tier.starts_with("or-")
}

/// Which provider a tier runs on. Unknown tiers answer "claude" (the safe
/// same-lane default: a wrong cross-provider verdict would reset a session).
pub fn provider_of(tier: &str) -> &'static str {
    if is_openrouter(tier) {
        return OPENROUTER;
    }
    self::tier(tier).map(|t| t.provider).unwrap_or(CLAUDE)
}

pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        OPENAI => "Codex",
        GOOGLE => "Antigravity",
        OPENROUTER => "OpenRouter",
        _ => "Claude",
    }
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
