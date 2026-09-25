//! The new seat's scope (S3 §4.8 hire read set "scope"; legacy `Org.hire`
//! lines for `add_dirs`, `tools`, `org_visibility`, the kiosk ceiling and the
//! permission mode). The decisions are the reviewed `orgtree-scope-clamp`
//! crate's (r7 C6: decide over facts read under the island's locks); this
//! module only adapts rows to its Python-shaped values and back.

use orgtree_scope_clamp::clamp::{self, DirGrant, Fail, Rules, PM_LEVELS, VIS_LEVELS};
use orgtree_scope_clamp::pystr::PyStr;
use orgtree_scope_clamp::val::Val as PyVal;
use serde_json::{Map, Number, Value};

use crate::exec::{CmdError, Refusal};

/// serde JSON → the clamp crate's Python value (ints stay ints).
pub fn py(v: &Value) -> PyVal {
    match v {
        Value::Null => PyVal::Null,
        Value::Bool(b) => PyVal::Bool(*b),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => PyVal::Int(i128::from(i)),
            (None, Some(u)) => PyVal::Int(i128::from(u)),
            _ => PyVal::Float(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => PyVal::Str(PyStr::from(s.as_str())),
        Value::Array(a) => PyVal::List(a.iter().map(py).collect()),
        Value::Object(o) => PyVal::Obj(o.iter().map(|(k, v)| (PyStr::from(k.as_str()), py(v))).collect()),
    }
}

/// The clamp crate's value → serde JSON (dict order kept).
pub fn js(v: &PyVal) -> Value {
    match v {
        PyVal::Null => Value::Null,
        PyVal::Bool(b) => Value::Bool(*b),
        PyVal::Int(i) => i64::try_from(*i).map(Value::from).unwrap_or(Value::Null),
        PyVal::Float(f) => Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
        PyVal::Str(s) => Value::String(s.to_text()),
        PyVal::List(l) => Value::Array(l.iter().map(js).collect()),
        PyVal::Obj(m) => {
            let mut o = Map::new();
            for (k, x) in m {
                o.insert(k.to_text(), js(x));
            }
            Value::Object(o)
        }
    }
}

fn fail(f: Fail) -> Result<Refusal, CmdError> {
    match f {
        Fail::Refused(t) => Ok(Refusal::new("invalid", t.to_text())),
        Fail::Outside(o) => Err(CmdError::Defect(format!("scope clamp outside its parity domain: {}", o.0))),
    }
}

/// The parent's stored scope, as the clamps read it (`None` = top level: the
/// user holds everything).
pub struct ParentScope {
    pub tools: Value,
    pub folders: Value,
    pub visibility: String,
    pub permission_mode: String,
}

/// What the seat is born with, plus the warnings legacy returns.
pub struct Derived {
    pub tools: Value,
    pub folders: Value,
    pub visibility: String,
    pub permission_mode: String,
    pub warnings: Vec<String>,
    /// The raise-ceiling bridge offer (legacy `res["bridge"]`).
    pub bridged: bool,
}

/// The inputs of the derivation (legacy `Org.hire` arguments and the org
/// defaults it reads).
pub struct Request<'a> {
    pub user_actor: bool,
    pub add_dirs: Option<&'a Value>,
    pub tools: Option<&'a Value>,
    /// Already defaulted (`org_visibility` or the org default) and checked
    /// against `VIS_LEVELS`.
    pub vis: &'a str,
    /// Whether the caller stated `org_visibility` (strictness of the clamp).
    pub vis_explicit: bool,
    pub org_dirs: Option<&'a Value>,
    pub default_tools: Option<&'a Value>,
    pub org_permission_mode: &'a str,
    /// The kiosk ceiling (`kiosk.max_scope`), `None` when there is none.
    pub ceiling: Option<&'a Value>,
    pub raise_ceiling: bool,
}

/// Legacy order: dirs (strict for an explicit list), tools (strict for an
/// agent's explicit grant), visibility (strict for an agent's explicit
/// grant), then — after the funding step, which cannot be refused by this —
/// the kiosk ceiling over tools/dirs/visibility, the permission mode
/// (org default capped at the parent, then the ceiling). The two halves are
/// split so the caller can run the funding step between them exactly where
/// legacy does (every refusal before `_chain_acquire`).
/// Folders, tools, visibility and warnings, before the funding step.
pub type Clamped = (Vec<DirGrant>, Value, String, Vec<String>);

pub fn clamp_before_funding(req: &Request<'_>, parent: Option<&ParentScope>) -> Result<Result<Clamped, Refusal>, CmdError> {
    let r = Rules::LEGACY;
    let who = PyStr::from("parent");
    // №30 dirs: default = the org's dirs at the top level, the parent's own below.
    let parent_map: Option<Vec<(PyStr, PyVal)>> = match parent {
        None => None,
        Some(p) => {
            let mut m: Vec<(PyStr, PyVal)> = Vec::new();
            if let Value::Array(a) = &p.folders {
                for d in a {
                    if let (Some(Value::String(path)), Some(mode)) = (d.get("path"), d.get("mode")) {
                        let k = PyStr::from(path.as_str());
                        match m.iter_mut().find(|(x, _)| *x == k) {
                            Some(e) => e.1 = py(mode),
                            None => m.push((k, py(mode))),
                        }
                    }
                }
            }
            Some(m)
        }
    };
    let dirs = match req.add_dirs {
        None => match parent {
            None => clamp::norm_dirs(req.org_dirs.map(py).as_ref(), &r).map_err(|o| CmdError::Defect(format!("norm_dirs: {}", o.0)))?,
            Some(p) => {
                let v = py(&p.folders);
                // the parent's stored list, copied (not re-normalised)
                match &v {
                    PyVal::List(items) => items
                        .iter()
                        .filter_map(|d| Some(DirGrant { path: d.get("path")?.as_str()?.clone(), mode: d.get("mode")?.clone() }))
                        .collect(),
                    _ => Vec::new(),
                }
            }
        },
        Some(explicit) => {
            let norm = clamp::norm_dirs(Some(&py(explicit)), &r).map_err(|o| CmdError::Defect(format!("norm_dirs: {}", o.0)))?;
            match clamp::clamp_dirs(&norm, parent_map.as_deref(), true, &who, &r) {
                Ok((kept, _)) => kept,
                Err(f) => return Ok(Err(fail(f)?)),
            }
        }
    };
    let parent_tools = parent.map(|p| py(&p.tools));
    let requested = match req.tools {
        Some(t) => Some(py(t)),
        None => req.default_tools.map(py),
    };
    let strict_tools = !req.user_actor && req.tools.is_some();
    let (tset, tlost) = match clamp::clamp_tools(requested.as_ref(), parent_tools.as_ref(), strict_tools, &who, &r) {
        Ok(x) => x,
        Err(f) => return Ok(Err(fail(f)?)),
    };
    let mut warnings = Vec::new();
    let mut vis = req.vis.to_string();
    if let Some(p) = parent {
        let strict_vis = !req.user_actor && req.vis_explicit;
        let pv = py(&Value::String(p.visibility.clone()));
        match clamp::clamp_vis(&py(&Value::String(vis.clone())), Some(Some(&pv)), strict_vis, &r) {
            Ok((v, clamped)) => {
                if let Some(s) = v.as_str() {
                    vis = s.to_text();
                }
                if clamped {
                    warnings.push(format!("org_visibility clamped to the parent's own ({vis})"));
                }
            }
            Err(f) => return Ok(Err(fail(f)?)),
        }
    }
    let mut tool_warn = Vec::new();
    if !tlost.is_empty() {
        let lost: Vec<String> = tlost.iter().map(|x| format!("'{}'", x.to_text())).collect();
        tool_warn.push(format!("tool grants clamped to the parent's own: [{}]", lost.join(", ")));
    }
    warnings.extend(tool_warn);
    Ok(Ok((dirs, js(&tset.to_val()), vis, warnings)))
}

/// Legacy `_clamp_pm(requested, parent, strict=False)`.
pub fn clamp_pm_lenient(requested: &str, parent: Option<&ParentScope>) -> String {
    let Some(p) = parent else { return requested.to_string() };
    let (Some(ri), Some(pi)) = (PM_LEVELS.iter().position(|l| *l == requested), PM_LEVELS.iter().position(|l| *l == p.permission_mode)) else {
        return requested.to_string();
    };
    if ri > pi {
        p.permission_mode.clone()
    } else {
        requested.to_string()
    }
}

/// The half after the funding step: the kiosk ceiling over tools, dirs and
/// visibility (legacy `_apply_ceiling`), then the permission mode.
pub fn after_funding(req: &Request<'_>, parent: Option<&ParentScope>, dirs: Vec<DirGrant>, tools: Value, vis: String, warnings: &mut Vec<String>) -> Result<Result<Derived, Refusal>, CmdError> {
    let r = Rules::LEGACY;
    let ceil = req.ceiling.map(py);
    let c = match clamp::apply_ceiling(ceil.as_ref(), Some(&py(&tools)), Some(&dirs), Some(&py(&Value::String(vis.clone()))), None, req.raise_ceiling, &r) {
        Ok(c) => c,
        Err(f) => return Ok(Err(fail(f)?)),
    };
    warnings.extend(c.warnings.iter().map(PyStr::to_text));
    let tools = c.tools.as_ref().map(js).unwrap_or(tools);
    let folders = Value::Array(c.dirs.as_deref().unwrap_or(&dirs).iter().map(|d| js(&d.to_val())).collect());
    let vis = c.vis.as_ref().and_then(|v| v.as_str().map(PyStr::to_text)).unwrap_or(vis);
    // D-102: the ORG default, capped at the parent's own; then the ceiling.
    let pm0 = clamp_pm_lenient(req.org_permission_mode, parent);
    let pc = match clamp::apply_ceiling(ceil.as_ref(), None, None, None, Some(&py(&Value::String(pm0.clone()))), false, &r) {
        Ok(c) => c,
        Err(f) => return Ok(Err(fail(f)?)),
    };
    warnings.extend(pc.warnings.iter().map(PyStr::to_text));
    let pm = pc.pm.as_ref().and_then(|v| v.as_str().map(PyStr::to_text)).unwrap_or(pm0);
    Ok(Ok(Derived { tools, folders, visibility: vis, permission_mode: pm, warnings: Vec::new(), bridged: c.bridged }))
}

pub fn vis_known(v: &str) -> bool {
    VIS_LEVELS.contains(&v)
}
