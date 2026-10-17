//! Per-model speed support, separate from reasoning effort and process identity.
use serde_json::Value;
use super::{catalog, State};

/// Only exact first-party Opus families verified in installed Claude Code 2.1.292.
#[nolog]
pub fn claude_model(model: &str) -> bool {
    model.starts_with("claude-opus-5") || model.starts_with("claude-opus-4-8")
}

#[nolog]
pub fn supported(st: &State, tier: &str, version: Option<&str>) -> bool {
    let Some(t) = catalog::tier(tier) else { return false };
    let model = catalog::model_for(tier, version);
    match t.provider {
        catalog::CLAUDE => claude_model(&model),
        catalog::OPENAI => st.codex_fast_modes.contains_key(&model),
        _ => false,
    }
}

#[logged]
pub fn validate(st: &State, tier: &str, version: Option<&str>, value: &Value) -> anyhow::Result<bool> {
    let Some(enabled) = value.as_bool() else { crate::refuse!(BadRequest, "fast_mode must be a boolean") };
    if enabled && !supported(st,tier,version) { crate::refuse!(BadRequest, "this model does not offer fast mode") }
    Ok(enabled)
}

/// Explicit default prevents an inherited global fast tier from sticking.
#[nolog]
pub fn codex_tier(st: &State, model: &str, enabled: bool) -> Option<String> {
    st.codex_fast_modes.get(model).map(|tier| if enabled { tier.clone() } else { "default".into() })
}

/// Never infer priority access from a name or from another model's capabilities.
#[nolog]
pub fn advertised_tier(row: &Value) -> Option<String> {
    let tiers: Vec<&str> = match row.get("serviceTiers").and_then(Value::as_array) {
        Some(rows) => rows.iter().filter_map(|r| r["id"].as_str()).collect(),
        None => row["additionalSpeedTiers"].as_array().map(|rows| rows.iter().filter_map(Value::as_str).collect()).unwrap_or_default(),
    };
    tiers.into_iter().find(|id| matches!(*id, "fast" | "priority")).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn fast_mode_uses_only_advertised_speed_tiers() {
        assert_eq!(advertised_tier(&json!({"serviceTiers":[{"id":"default"},{"id":"priority"}]})).as_deref(),Some("priority"));
        assert_eq!(advertised_tier(&json!({"additionalSpeedTiers":["fast"]})).as_deref(),Some("fast"));
        assert_eq!(advertised_tier(&json!({"serviceTiers":[],"additionalSpeedTiers":["fast"]})),None);
        assert_eq!(advertised_tier(&json!({"serviceTiers":[{"id":"flex","name":"Fast"}]})),None);
    }
    #[test]
    fn fast_mode_is_model_specific_and_off_is_explicit() {
        let mut st=State::default();
        st.codex_fast_modes.insert("gpt-6.1-sol".into(),"priority".into());
        assert!(supported(&st,"sol",None));
        assert!(!supported(&st,"sol",Some("6")));
        assert!(supported(&st,"opus",None));
        for tier in ["sonnet","haiku","agy-opus","or-opus","ls-opus","wonder"] { assert!(!supported(&st,tier,None)); }
        assert_eq!(codex_tier(&st,"gpt-6.1-sol",false).as_deref(),Some("default"));
        assert_eq!(codex_tier(&st,"gpt-6.1-sol",true).as_deref(),Some("priority"));
        assert_eq!(codex_tier(&st,"unknown",true),None);
    }
    #[test]
    fn fast_mode_validates_boolean_and_is_not_inherited() {
        let st=State::default();
        assert!(validate(&st,"opus",None,&json!(true)).unwrap());
        assert!(!validate(&st,"haiku",None,&json!(false)).unwrap());
        assert!(validate(&st,"haiku",None,&json!(true)).is_err());
        for value in [json!("true"),json!(null),json!(1)] { assert!(validate(&st,"opus",None,&value).is_err()); }
        let child=crate::domain::scope::clamp(&json!({}),&json!({"fast_mode":true}));
        assert_eq!(child["fast_mode"],Value::Null);
        let child=crate::domain::scope::clamp(&json!({"fast_mode":false}),&json!({"fast_mode":true}));
        assert_eq!(child["fast_mode"],json!(false));
    }
}
