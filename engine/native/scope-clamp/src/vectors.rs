//! Runs a vectors file (the committed one by default) against this crate.
//! Every section must be present and every row must match exactly: values
//! by Python type and content, refusals by exact text, and a Python
//! exception other than `LedgerError` only by the crate reporting the input
//! as outside its domain.

use crate::clamp::{
    apply_ceiling, check_tier_ceiling, clamp_dirs, clamp_tools, clamp_vis, expand_mcp, norm_dirs,
    norm_tools, DirGrant, Fail, Rules,
};
use crate::ntpath::{normcase, normpath};
use crate::pystr::{py_repr, PyStr};
use crate::val::{str_json, Val};
use orgtree_backend_codec::json::{parse, Limits, Profile, Value};
use std::collections::BTreeSet;

pub const COMMITTED: &str = include_str!("../vectors/scope-clamp-vectors.json");

pub const SECTIONS: [&str; 12] = [
    "normpath",
    "normcase",
    "repr",
    "strip",
    "norm_tools",
    "norm_dirs",
    "expand_mcp",
    "clamp_tools",
    "clamp_dirs",
    "clamp_vis",
    "apply_ceiling",
    "tier_ceiling",
];

#[derive(Debug, Default)]
pub struct Report {
    pub checked: Vec<(String, usize)>,
    pub failures: Vec<String>,
}

impl Report {
    pub fn total(&self) -> usize {
        self.checked.iter().map(|(_, n)| n).sum()
    }

    pub fn failing_sections(&self) -> BTreeSet<String> {
        self.failures
            .iter()
            .filter_map(|f| f.split('[').next().map(str::to_owned))
            .collect()
    }
}

type Check = Result<(), String>;

fn val(v: &Value) -> Result<Val, String> {
    Val::from_json(v).map_err(|o| format!("unreadable row: {}", o.0))
}

fn pystr(v: &Value) -> Result<PyStr, String> {
    match val(v)? {
        Val::Str(s) => Ok(s),
        other => Err(format!("expected a string, got {other:?}")),
    }
}

fn items(v: &Value) -> Result<&[Value], String> {
    match v {
        Value::Array(a) => Ok(a),
        _ => Err("expected an array".to_owned()),
    }
}

fn member<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    match v {
        Value::Object(o) => o.members().iter().find(|(x, _)| x == k).map(|(_, y)| y),
        _ => None,
    }
}

fn opt_list(v: &Value) -> Result<Option<Vec<PyStr>>, String> {
    match v {
        Value::Null => Ok(None),
        _ => items(v)?
            .iter()
            .map(pystr)
            .collect::<Result<_, _>>()
            .map(Some),
    }
}

fn dirs_of(v: &Val) -> Result<Vec<DirGrant>, String> {
    let Val::List(l) = v else {
        return Err("expected a folder list".to_owned());
    };
    l.iter()
        .map(|d| match (d.get("path"), d.get("mode")) {
            (Some(Val::Str(p)), Some(m)) => Ok(DirGrant {
                path: p.clone(),
                mode: m.clone(),
            }),
            _ => Err("malformed folder grant".to_owned()),
        })
        .collect()
}

fn dirs_val(ds: &[DirGrant]) -> Val {
    Val::List(ds.iter().map(DirGrant::to_val).collect())
}

fn strs_val(v: &[PyStr]) -> Val {
    Val::List(v.iter().cloned().map(Val::Str).collect())
}

/// Compare an outcome with the row's `ok` / `refused` / `raises`.
fn outcome(row: &Value, got: Result<Val, Fail>) -> Check {
    if let Some(ok) = member(row, "ok") {
        let want = val(ok)?;
        return match got {
            Ok(v) if v == want => Ok(()),
            Ok(v) => Err(format!("want {}, got {}", want.to_json(), v.to_json())),
            Err(f) => Err(format!("want {}, got {f:?}", want.to_json())),
        };
    }
    if let Some(msg) = member(row, "refused") {
        let want = pystr(msg)?;
        return match got {
            Err(Fail::Refused(m)) if m == want => Ok(()),
            other => Err(format!("want refusal {}, got {other:?}", str_json(&want))),
        };
    }
    if let Some(name) = member(row, "raises") {
        return match got {
            Err(Fail::Outside(_)) => Ok(()),
            other => Err(format!(
                "Python raised {name:?}; want Outside, got {other:?}"
            )),
        };
    }
    Err("row has no outcome".to_owned())
}

fn last(row: &Value) -> Result<&Value, String> {
    items(row)?.last().ok_or_else(|| "empty row".to_owned())
}

fn check_row(section: &str, row: &Value, r: &Rules) -> Check {
    match section {
        "normpath" | "normcase" | "repr" | "strip" => {
            let a = items(row)?;
            let (input, want) = (pystr(&a[0])?, pystr(&a[1])?);
            let got = match section {
                "normpath" => normpath(&input, r.path),
                "normcase" => normcase(&input, r.path),
                "repr" => py_repr(&input),
                _ => input.strip(),
            };
            if got == want {
                Ok(())
            } else {
                Err(format!(
                    "{} -> want {}, got {}",
                    str_json(&input),
                    str_json(&want),
                    str_json(&got)
                ))
            }
        }
        "norm_tools" => {
            let a = items(row)?;
            let t = val(&a[0])?;
            let got = norm_tools(Some(&t), r)
                .map(|g| g.to_val())
                .map_err(Fail::Outside);
            outcome(&a[1], got)
        }
        "norm_dirs" => {
            let a = items(row)?;
            let d = val(&a[0])?;
            let got = norm_dirs(Some(&d), r)
                .map(|g| dirs_val(&g))
                .map_err(Fail::Outside);
            outcome(&a[1], got)
        }
        "expand_mcp" => {
            let a = items(row)?;
            let (g, c, reg) = (opt_list(&a[0])?, opt_list(&a[1])?, opt_list(&a[2])?);
            let got = expand_mcp(g.as_deref(), c.as_deref(), reg.as_deref());
            outcome(&a[3], Ok(strs_val(&got)))
        }
        "clamp_tools" => {
            let a = items(row)?;
            let (req, par) = (val(&a[0])?, val(&a[1])?);
            let strict = matches!(a[2], Value::Bool(true));
            let who = pystr(&a[3])?;
            let par = if par == Val::Null { None } else { Some(&par) };
            let got = clamp_tools(Some(&req), par, strict, &who, r)
                .map(|(g, lost)| Val::List(vec![g.to_val(), strs_val(&lost)]));
            outcome(last(row)?, got)
        }
        "clamp_dirs" => {
            let a = items(row)?;
            let reqd = dirs_of(&val(&a[0])?)?;
            let pmap = match &a[1] {
                Value::Null => None,
                v => Some(
                    items(v)?
                        .iter()
                        .map(|p| {
                            let p = items(p)?;
                            Ok((pystr(&p[0])?, val(&p[1])?))
                        })
                        .collect::<Result<Vec<_>, String>>()?,
                ),
            };
            let strict = matches!(a[2], Value::Bool(true));
            let who = pystr(&a[3])?;
            let got = clamp_dirs(&reqd, pmap.as_deref(), strict, &who, r)
                .map(|(k, lost)| Val::List(vec![dirs_val(&k), strs_val(&lost)]));
            outcome(last(row)?, got)
        }
        "clamp_vis" => {
            let a = items(row)?;
            let req = val(&a[0])?;
            let pv = val(&a[1])?;
            let strict = matches!(a[2], Value::Bool(true));
            let parent = match pv.as_str().and_then(PyStr::to_rust) {
                Some(m) if m == "no-parent" => None,
                Some(m) if m == "absent" => Some(None),
                _ => Some(Some(&pv)),
            };
            let got =
                clamp_vis(&req, parent, strict, r).map(|(v, c)| Val::List(vec![v, Val::Bool(c)]));
            outcome(last(row)?, got)
        }
        "apply_ceiling" => {
            let get = |k: &str| member(row, k).ok_or_else(|| format!("row without {k}"));
            let ms = val(get("max_scope")?)?;
            let ms = match ms.as_str().and_then(PyStr::to_rust) {
                Some(m) if m == "absent" => None,
                _ => Some(ms),
            };
            let tools = val(get("tools")?)?;
            let dirs = match val(get("dirs")?)? {
                Val::Null => None,
                d => Some(dirs_of(&d)?),
            };
            let vis = val(get("vis")?)?;
            let pm = val(get("pm")?)?;
            let raise = matches!(get("raise")?, Value::Bool(true));
            let opt = |v: &Val| {
                if *v == Val::Null {
                    None
                } else {
                    Some(v.clone())
                }
            };
            let (tools, vis, pm) = (opt(&tools), opt(&vis), opt(&pm));
            let got = apply_ceiling(
                ms.as_ref(),
                tools.as_ref(),
                dirs.as_deref(),
                vis.as_ref(),
                pm.as_ref(),
                raise,
                r,
            )
            .map(|c| {
                let o = |v: Option<Val>| v.unwrap_or(Val::Null);
                let (raised, logged) = match c.raised {
                    Some((ms, logged)) => (ms, logged),
                    None => (Val::Null, false),
                };
                let s = PyStr::from;
                Val::Obj(vec![
                    (s("tools"), o(c.tools)),
                    (s("dirs"), c.dirs.map_or(Val::Null, |d| dirs_val(&d))),
                    (s("vis"), o(c.vis)),
                    (s("pm"), o(c.pm)),
                    (s("bridged"), Val::Bool(c.bridged)),
                    (s("warnings"), strs_val(&c.warnings)),
                    (s("raised"), raised),
                    (
                        s("logged"),
                        Val::List(if logged {
                            vec![Val::Str(s("ceiling_raise"))]
                        } else {
                            vec![]
                        }),
                    ),
                ])
            });
            outcome(row, got)
        }
        "tier_ceiling" => {
            let a = items(row)?;
            let mt = val(&a[0])?;
            let tier = pystr(&a[1])?;
            let mt = match mt.as_str().and_then(PyStr::to_rust) {
                Some(m) if m == "absent" => None,
                _ => Some(mt),
            };
            let doc = doc_tiers();
            let mt = match &mt {
                None | Some(Val::Null) => None,
                Some(v) => Some(v),
            };
            let got = check_tier_ceiling(mt, &tier, &doc, r).map(|()| Val::Null);
            outcome(last(row)?, got)
        }
        _ => Err(format!("unknown section {section}")),
    }
}

/// The per-org tier table every `tier_ceiling` row runs against (the oracle
/// builds the same one).
pub fn doc_tiers() -> Vec<(PyStr, Val)> {
    let s = PyStr::from;
    vec![
        (s("haiku"), Val::Int(1)),
        (s("or-a-b"), Val::Int(3)),
        (s("or-cheap"), Val::Float(0.1)),
        (s("or-bool"), Val::Bool(true)),
        (s("or-str"), Val::Str(s("3"))),
        (s("or-big"), Val::Int(10i128.pow(30))),
        (s("or-eq"), Val::Float(1.0)),
        (s("or-zero"), Val::Int(0)),
    ]
}

pub fn run(text: &str, rules: &Rules) -> Report {
    let mut report = Report::default();
    let doc = match parse(
        text,
        Profile::PythonLegacy,
        Limits {
            max_bytes: 64 << 20,
            max_depth: 64,
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            report.failures.push(format!("document: unparsable: {e:?}"));
            return report;
        }
    };
    for section in SECTIONS {
        let Some(Value::Array(rows)) = member(&doc, section) else {
            report.failures.push(format!("{section}: missing section"));
            continue;
        };
        for (i, row) in rows.iter().enumerate() {
            if let Err(e) = check_row(section, row, rules) {
                report.failures.push(format!("{section}[{i}]: {e}"));
            }
        }
        report.checked.push((section.to_owned(), rows.len()));
    }
    report
}
