//! The permission-scope clamps of `orgtree.ledger`, line by line, over
//! explicit inputs. Every function returns Python's value, Python's
//! `LedgerError` text, or [`Outside`] for an input the model does not cover.

use crate::ntpath::{normcase, normpath, PathRules};
use crate::pystr::{py_repr, PyStr};
use crate::val::{Outside, Val};

pub const TOOL_KEYS: [&str; 4] = ["bash", "web", "edit", "subagents"];
pub const VIS_LEVELS: [&str; 4] = ["self", "team", "subtree", "full"];
pub const PM_LEVELS: [&str; 4] = ["plan", "default", "acceptEdits", "bypassPermissions"];

/// Which rules to apply. [`Rules::LEGACY`] is the Python ledger; every other
/// setting is a deliberate mistake used only as a negative control.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub path: PathRules,
    /// Held-folder lookup by exact key instead of by held ancestor tree.
    pub exact_key_only: bool,
    /// A read-only held tree wins over a read/write one.
    pub ro_over_rw: bool,
    /// `norm_dirs` keeps the request order instead of sorting.
    pub keep_request_order: bool,
    /// `norm_dirs` keeps the last of two exact duplicates, not the first.
    pub last_duplicate_wins: bool,
    /// `"*"` among MCP names is not collapsed to `["*"]`.
    pub no_star_collapse: bool,
    /// Strict clamps clamp instead of refusing.
    pub strict_demoted: bool,
}

impl Rules {
    pub const LEGACY: Rules = Rules {
        path: PathRules::WINDOWS,
        exact_key_only: false,
        ro_over_rw: false,
        keep_request_order: false,
        last_duplicate_wins: false,
        no_star_collapse: false,
        strict_demoted: false,
    };
}

/// A clamp refused (Python `LedgerError` with this text), or the input is
/// outside the parity domain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fail {
    Refused(PyStr),
    Outside(Outside),
}

impl From<Outside> for Fail {
    fn from(o: Outside) -> Fail {
        Fail::Outside(o)
    }
}

pub type F<T> = Result<T, Fail>;

fn refuse<T>(parts: &[&PyStr]) -> F<T> {
    let mut v = Vec::new();
    for p in parts {
        v.extend_from_slice(&p.0);
    }
    Err(Fail::Refused(PyStr(v)))
}

fn s(t: &str) -> PyStr {
    PyStr::from(t)
}

/// `norm_tools(t)`: four switches plus a sorted MCP name list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolGrant {
    pub flags: [bool; 4],
    pub mcp: Vec<PyStr>,
}

impl ToolGrant {
    pub fn to_val(&self) -> Val {
        let mut m: Vec<(PyStr, Val)> = TOOL_KEYS
            .iter()
            .zip(self.flags)
            .map(|(k, f)| (s(k), Val::Bool(f)))
            .collect();
        m.push((
            s("mcp"),
            Val::List(self.mcp.iter().cloned().map(Val::Str).collect()),
        ));
        Val::Obj(m)
    }
}

/// Iterating a Python value (`for x in v`): a list's items, a string's
/// characters, a dict's keys. Anything else is a `TypeError`.
fn py_iter(v: &Val) -> Result<Vec<Val>, Outside> {
    match v {
        Val::List(l) => Ok(l.clone()),
        Val::Str(st) => Ok(st.0.iter().map(|&c| Val::Str(PyStr(vec![c]))).collect()),
        Val::Obj(m) => Ok(m.iter().map(|(k, _)| Val::Str(k.clone())).collect()),
        _ => Err(Outside("iteration over a non-iterable")),
    }
}

/// `x in v` where `x` is a `str`.
fn py_contains_str(v: &Val, x: &PyStr) -> Result<bool, Outside> {
    match v {
        Val::List(l) => Ok(l.iter().any(|e| e.eq_str(x))),
        Val::Str(st) => Ok(x.is_empty() || st.0.windows(x.0.len()).any(|w| w == x.0.as_slice())),
        Val::Obj(m) => Ok(m.iter().any(|(k, _)| k == x)),
        _ => Err(Outside("membership test on a non-container")),
    }
}

/// The members of `set(v)` when every member is a `str` (sorted, deduped).
fn str_set(v: &Val) -> Result<Vec<PyStr>, Outside> {
    let mut out = Vec::new();
    for e in py_iter(v)? {
        match e {
            Val::Str(x) => out.push(x),
            _ => return Err(Outside("set of non-str MCP names")),
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

pub fn norm_tools(t: Option<&Val>, r: &Rules) -> Result<ToolGrant, Outside> {
    let t = match t {
        Some(v) if v.truthy() => v,
        _ => &Val::Obj(Vec::new()),
    };
    if !matches!(t, Val::Obj(_)) {
        return Err(Outside("tool grant is not a dict"));
    }
    let mut flags = [true; 4];
    for (i, k) in TOOL_KEYS.iter().enumerate() {
        flags[i] = t.get(k).is_none_or(Val::truthy);
    }
    let mut mcp: Vec<PyStr> = Vec::new();
    if let Some(m) = t.get("mcp") {
        for e in py_iter(m)? {
            if e.truthy() {
                mcp.push(e.py_str()?);
            }
        }
    }
    mcp.sort();
    mcp.dedup();
    if !r.no_star_collapse && mcp.contains(&s("*")) {
        mcp = vec![s("*")];
    }
    Ok(ToolGrant { flags, mcp })
}

/// One folder grant: `{"path": ..., "mode": ...}`.
#[derive(Clone, Debug, PartialEq)]
pub struct DirGrant {
    pub path: PyStr,
    pub mode: Val,
}

impl DirGrant {
    pub fn to_val(&self) -> Val {
        Val::Obj(vec![
            (s("path"), Val::Str(self.path.clone())),
            (s("mode"), self.mode.clone()),
        ])
    }
}

pub fn norm_dirs(dirs: Option<&Val>, r: &Rules) -> Result<Vec<DirGrant>, Outside> {
    let items = match dirs {
        Some(v) if v.truthy() => py_iter(v)?,
        _ => Vec::new(),
    };
    let mut out: Vec<DirGrant> = Vec::new();
    for d in items {
        let (path, mode) = match &d {
            Val::Str(p) => (p.strip(), Val::Str(s("rw"))),
            Val::Obj(_) => {
                let p = match d.get("path") {
                    None => PyStr::default(),
                    Some(Val::Str(p)) => p.clone(),
                    Some(_) => return Err(Outside("non-str folder path")),
                };
                (
                    p.strip(),
                    d.get("mode").cloned().unwrap_or(Val::Str(s("rw"))),
                )
            }
            _ => return Err(Outside("folder grant is neither str nor dict")),
        };
        let mode_ok = mode.eq_str(&s("rw")) || mode.eq_str(&s("ro"));
        if path.is_empty() || !mode_ok {
            continue;
        }
        if let Some(i) = out.iter().position(|g| g.path == path) {
            if r.last_duplicate_wins {
                out[i] = DirGrant { path, mode };
            }
            continue;
        }
        out.push(DirGrant { path, mode });
    }
    if !r.keep_request_order {
        let key = |g: &DirGrant| {
            let m = g.mode.as_str().cloned().unwrap_or_default();
            (
                normcase(&normpath(&g.path, r.path), r.path),
                m,
                g.path.clone(),
            )
        };
        let mut keyed: Vec<_> = out.into_iter().map(|g| (key(&g), g)).collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        out = keyed.into_iter().map(|(_, g)| g).collect();
    }
    Ok(out)
}

/// `expand_mcp(granted, registry)`; `None` is Python `None`.
pub fn expand_mcp(granted: Option<&[PyStr]>, registry: Option<&[PyStr]>) -> Vec<PyStr> {
    let star = s("*");
    let reg: Vec<PyStr> = registry.unwrap_or(&[]).to_vec();
    let g_in = granted.unwrap_or(&[]);
    let mut g: Vec<PyStr> = if g_in.contains(&star) {
        reg.clone()
    } else {
        g_in.iter().filter(|x| reg.contains(x)).cloned().collect()
    };
    g.sort();
    g.dedup();
    g
}

fn list_repr(items: &[PyStr]) -> PyStr {
    let mut v = vec![u32::from(b'[')];
    for (i, x) in items.iter().enumerate() {
        if i > 0 {
            v.extend(", ".chars().map(u32::from));
        }
        v.extend(py_repr(x).0);
    }
    v.push(u32::from(b']'));
    PyStr(v)
}

/// `Org._clamp_tools(requested, parent_tools, strict, who)`.
pub fn clamp_tools(
    requested: Option<&Val>,
    parent: Option<&Val>,
    strict: bool,
    who: &PyStr,
    r: &Rules,
) -> F<(ToolGrant, Vec<PyStr>)> {
    let strict = strict && !r.strict_demoted;
    let mut req = norm_tools(requested, r)?;
    let Some(parent) = parent else {
        return Ok((req, Vec::new()));
    };
    if !matches!(parent, Val::Obj(_)) {
        return Err(Outside("parent tools is not a dict").into());
    }
    let mut lost = Vec::new();
    for (i, k) in TOOL_KEYS.iter().enumerate() {
        if req.flags[i] && !parent.get(k).is_none_or(Val::truthy) {
            if strict {
                return refuse(&[
                    who,
                    &s(" does not hold "),
                    &py_repr(&s(k)),
                    &s("; cannot grant it"),
                ]);
            }
            req.flags[i] = false;
            lost.push(s(k));
        }
    }
    let empty = Val::List(Vec::new());
    let phold = parent.get("mcp").unwrap_or(&empty);
    let star = s("*");
    let parent_star = py_contains_str(phold, &star)?;
    if req.mcp.contains(&star) {
        req.mcp = if parent_star {
            vec![star]
        } else {
            str_set(phold)?
        };
    } else if !parent_star {
        let held = py_iter(phold)?;
        let extra: Vec<PyStr> = req
            .mcp
            .iter()
            .filter(|x| !held.iter().any(|h| h.eq_str(x)))
            .cloned()
            .collect();
        if held.iter().any(|h| matches!(h, Val::List(_) | Val::Obj(_))) {
            return Err(Outside("unhashable MCP name").into());
        }
        if !extra.is_empty() {
            if strict {
                return refuse(&[
                    who,
                    &s(" does not hold MCP server(s) "),
                    &list_repr(&extra),
                    &s("; cannot grant"),
                ]);
            }
            req.mcp.retain(|x| held.iter().any(|h| h.eq_str(x)));
            for x in extra {
                lost.push(s("mcp:").concat(&x));
            }
        }
    }
    Ok((req, lost))
}

/// The mode a holder's set confers on `path` (`_held_mode`).
fn held_mode(path: &PyStr, parent_map: &[(PyStr, Val)], r: &Rules) -> Option<&'static str> {
    if r.exact_key_only {
        return parent_map
            .iter()
            .rev()
            .find(|(hp, _)| hp == path)
            .map(|(_, hm)| if hm.eq_str(&s("rw")) { "rw" } else { "ro" });
    }
    let p = r.path;
    let sep = if p.posix {
        u32::from(b'/')
    } else {
        u32::from(b'\\')
    };
    let want = normcase(&normpath(path, p), p);
    let mut best: Option<&'static str> = None;
    for (hp, hm) in parent_map {
        let base = normcase(&normpath(hp, p), p).rstrip_any(&[u32::from(b'\\'), u32::from(b'/')]);
        if want == base || want.starts_with(&base.concat(&PyStr(vec![sep]))) {
            let rw = hm.eq_str(&s("rw"));
            if r.ro_over_rw {
                if !rw {
                    return Some("ro");
                }
                best = Some("rw");
            } else {
                if rw {
                    return Some("rw");
                }
                best = Some("ro");
            }
        }
    }
    best
}

/// `Org._clamp_dirs(requested, parent_map, strict, who)`. `parent_map` is
/// the holder's `{path: mode}` in insertion order; `None` is the user.
pub fn clamp_dirs(
    requested: &[DirGrant],
    parent_map: Option<&[(PyStr, Val)]>,
    strict: bool,
    who: &PyStr,
    r: &Rules,
) -> F<(Vec<DirGrant>, Vec<PyStr>)> {
    let strict = strict && !r.strict_demoted;
    let Some(pm) = parent_map else {
        return Ok((requested.to_vec(), Vec::new()));
    };
    let mut kept = Vec::new();
    let mut lost = Vec::new();
    for d in requested {
        match held_mode(&d.path, pm, r) {
            None => {
                if strict {
                    return refuse(&[
                        &s("cannot grant dirs "),
                        who,
                        &s(" does not hold (\u{2116}30): ["),
                        &py_repr(&d.path),
                        &s("]"),
                    ]);
                }
                lost.push(d.path.clone());
            }
            Some("ro") if d.mode.eq_str(&s("rw")) => {
                if strict {
                    return refuse(&[
                        who,
                        &s(" holds "),
                        &py_repr(&d.path),
                        &s(" read-only; cannot grant read/write (\u{2116}30)"),
                    ]);
                }
                kept.push(DirGrant {
                    path: d.path.clone(),
                    mode: Val::Str(s("ro")),
                });
                lost.push(d.path.concat(&s(" (downgraded to ro)")));
            }
            Some(_) => kept.push(d.clone()),
        }
    }
    Ok((kept, lost))
}

fn level(levels: &[&str; 4], v: &Val) -> Option<usize> {
    levels.iter().position(|l| v.eq_str(&s(l)))
}

/// `Org._clamp_vis(requested, parent, strict)`. `parent` is `None` for no
/// parent, else the parent's stored `org_visibility` (`None` when absent).
pub fn clamp_vis(
    requested: &Val,
    parent: Option<Option<&Val>>,
    strict: bool,
    r: &Rules,
) -> F<(Val, bool)> {
    let strict = strict && !r.strict_demoted;
    let Some(pv) = parent else {
        return Ok((requested.clone(), false));
    };
    let Some(ri) = level(&VIS_LEVELS, requested) else {
        return Ok((requested.clone(), false));
    };
    let full = Val::Str(s("full"));
    let pv = pv.unwrap_or(&full);
    if let Some(pi) = level(&VIS_LEVELS, pv) {
        if ri > pi {
            if strict {
                return refuse(&[
                    &s("org_visibility "),
                    &py_repr(&s(VIS_LEVELS[ri])),
                    &s(" exceeds the parent's own "),
                    &py_repr(&s(VIS_LEVELS[pi])),
                    &s(" \u{2014} visibility is a capability and only shrinks downward"),
                ]);
            }
            return Ok((pv.clone(), true));
        }
    }
    Ok((requested.clone(), false))
}
