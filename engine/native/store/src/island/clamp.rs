//! Capability containment (r7 §6.4, C2a P3): the child's folders, tools,
//! visibility (and, on a move or a lowering, permission mode) kept within its
//! parent's. The DECISION is the reviewed `orgtree-scope-clamp` crate (legacy
//! `_clamp_dirs`, `_clamp_tools`, `_clamp_vis`, non-strict: the clamp that
//! removes what now exceeds), reused, never re-derived; this adapter only
//! converts the stored JSON to and from its Python value model.
//!
//! Stored shapes (`scope_rows`): `folders` = `[{"path": str, "mode": "rw"|"ro"}]`,
//! `tools` = legacy's tool dict (`bash`, `web`, `edit`, `subagents`, `mcp`),
//! `visibility` ∈ `self|team|subtree|full`, `permission_mode` ∈
//! `plan|default|acceptEdits|bypassPermissions`.

use orgtree_backend_codec::json::{parse, Limits, Profile};
use orgtree_scope_clamp::{clamp_dirs, clamp_tools, clamp_vis, norm_dirs, PyStr, Rules, Val as PyVal};
use orgtree_scope_clamp::clamp::PM_LEVELS;
use serde_json::Value;

use crate::exec::CmdError;
use crate::island::Scope;

const LIMITS: Limits = Limits { max_bytes: 1 << 20, max_depth: 64 };

fn to_py(v: &Value) -> Result<PyVal, CmdError> {
    let text = v.to_string();
    let j = parse(&text, Profile::PythonLegacy, LIMITS).map_err(|e| CmdError::Defect(format!("scope json: {e}")))?;
    PyVal::from_json(&j).map_err(|o| CmdError::Defect(format!("scope value outside the clamp model: {}", o.0)))
}

fn from_py(v: &PyVal) -> Result<Value, CmdError> {
    serde_json::from_str(&v.to_json()).map_err(|e| CmdError::Defect(format!("clamp output: {e}")))
}

/// What a clamp changed.
#[derive(Clone, Debug, PartialEq)]
pub struct Clamped {
    pub scope: Scope,
    pub changed: bool,
    pub lost: Vec<String>,
}

/// Clamp `child` into `parent`. `with_mode`: also clamp the permission mode
/// (a move does; an unrelated edit never does, D-101 / r7 Q-C11 (d)).
pub fn clamp(child: &Scope, parent: &Scope, with_mode: bool) -> Result<Clamped, CmdError> {
    let r = Rules::LEGACY;
    let who = PyStr::from("the parent");
    let out_of_model = |o: orgtree_scope_clamp::Outside| CmdError::Defect(format!("clamp input outside the model: {}", o.0));
    let refused = |f: orgtree_scope_clamp::Fail| match f {
        orgtree_scope_clamp::Fail::Refused(t) => CmdError::Defect(format!("non-strict clamp refused: {}", t.to_text())),
        orgtree_scope_clamp::Fail::Outside(o) => CmdError::Defect(format!("clamp input outside the model: {}", o.0)),
    };
    let mut lost: Vec<String> = Vec::new();

    // folders
    let child_dirs = norm_dirs(Some(&to_py(&child.folders)?), &r).map_err(out_of_model)?;
    let parent_dirs = norm_dirs(Some(&to_py(&parent.folders)?), &r).map_err(out_of_model)?;
    let pm: Vec<(PyStr, PyVal)> = parent_dirs.iter().map(|d| (d.path.clone(), d.mode.clone())).collect();
    let (kept, l) = clamp_dirs(&child_dirs, Some(&pm), false, &who, &r).map_err(refused)?;
    lost.extend(l.iter().map(PyStr::to_text));
    let folders = from_py(&PyVal::List(kept.iter().map(|d| d.to_val()).collect()))?;

    // tools
    let (tg, l) = clamp_tools(Some(&to_py(&child.tools)?), Some(&to_py(&parent.tools)?), false, &who, &r).map_err(refused)?;
    lost.extend(l.iter().map(PyStr::to_text));
    let tools = from_py(&tg.to_val())?;

    // visibility
    let pv = PyVal::Str(PyStr::from(parent.visibility.as_str()));
    let (v, vis_lost) = clamp_vis(&PyVal::Str(PyStr::from(child.visibility.as_str())), Some(Some(&pv)), false, &r).map_err(refused)?;
    let visibility = v.as_str().map(PyStr::to_text).unwrap_or_else(|| child.visibility.clone());
    if vis_lost {
        lost.push("visibility".into());
    }

    // permission mode: only when asked (a move, a lowering)
    let mut permission_mode = child.permission_mode.clone();
    if with_mode {
        let lv = |m: &str| PM_LEVELS.iter().position(|x| *x == m);
        if let (Some(c), Some(p)) = (lv(&child.permission_mode), lv(&parent.permission_mode)) {
            if c > p {
                permission_mode = parent.permission_mode.clone();
                lost.push("permission_mode".into());
            }
        }
    }

    let scope = Scope { depth: child.depth, tools, folders, visibility, permission_mode, version: child.version };
    // `changed` compares the stored values, not the lists of losses: the
    // tool dict is normalised (explicit flags) even when nothing is lost.
    let changed = scope.folders != child.folders || scope.tools != child.tools || scope.visibility != child.visibility || scope.permission_mode != child.permission_mode;
    Ok(Clamped { scope, changed, lost })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sc(folders: Value, tools: Value, vis: &str, pm: &str) -> Scope {
        Scope { depth: 1, tools, folders, visibility: vis.into(), permission_mode: pm.into(), version: 0 }
    }

    #[test]
    fn a_folder_the_parent_lacks_is_removed_and_rw_under_ro_is_downgraded() {
        let parent = sc(json!([{"path": "C:\\a", "mode": "ro"}]), json!({}), "full", "default");
        let child = sc(json!([{"path": "C:\\a\\b", "mode": "rw"}, {"path": "C:\\z", "mode": "rw"}]), json!({}), "full", "default");
        let c = clamp(&child, &parent, false).unwrap();
        assert!(c.changed);
        assert_eq!(c.scope.folders, json!([{"path": "C:\\a\\b", "mode": "ro"}]));
    }

    #[test]
    fn visibility_and_tools_shrink_to_the_parent() {
        let parent = sc(json!([]), json!({"bash": false}), "team", "default");
        let child = sc(json!([]), json!({"bash": true}), "full", "default");
        let c = clamp(&child, &parent, false).unwrap();
        assert_eq!(c.scope.visibility, "team");
        assert_eq!(c.scope.tools.get("bash"), Some(&json!(false)));
    }

    #[test]
    fn permission_mode_is_clamped_only_when_asked() {
        let parent = sc(json!([]), json!({}), "full", "default");
        let child = sc(json!([]), json!({}), "full", "bypassPermissions");
        assert_eq!(clamp(&child, &parent, false).unwrap().scope.permission_mode, "bypassPermissions");
        assert_eq!(clamp(&child, &parent, true).unwrap().scope.permission_mode, "default");
    }

    #[test]
    fn a_contained_child_is_unchanged_in_every_stored_field() {
        let parent = sc(json!([{"path": "C:\\a", "mode": "rw"}]), json!({"bash": true, "web": true, "edit": true, "subagents": true, "mcp": []}), "full", "default");
        let child = sc(json!([{"path": "C:\\a", "mode": "ro"}]), json!({"bash": true, "web": true, "edit": true, "subagents": true, "mcp": []}), "team", "plan");
        let c = clamp(&child, &parent, true).unwrap();
        assert!(!c.changed, "{c:?}");
    }
}
