//! Capabilities belong to a node kind; placement does not require a runtime.
use anyhow::Result;

/// Refuse at admission, before a turn control can start or wait for an actor.
#[logged]
pub fn require_turn_runtime(kind: &str, name: &str) -> Result<()> {
    if kind != "agent" {
        crate::refuse!(BadRequest, "{name} is a {kind} node with no runtime, turn or session; apply turn controls to its agent members instead");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn turn_controls_require_a_runtime_capability() {
        assert!(require_turn_runtime("agent", "worker").is_ok());
        for kind in ["project", "future-container"] {
            let error = require_turn_runtime(kind, "work").unwrap_err();
            assert!(matches!(error.downcast_ref::<crate::domain::UserError>(), Some(crate::domain::UserError::BadRequest(_))));
            assert!(error.to_string().contains("no runtime, turn or session"));
        }
    }
}
