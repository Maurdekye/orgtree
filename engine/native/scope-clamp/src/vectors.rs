//! Runs a vectors file (the committed one by default) against this crate.
//! Every section must be present and every row must match exactly: values
//! by Python type and content, refusals by exact text, and a Python
//! exception other than `LedgerError` only by the crate reporting the input
//! as outside its domain.

use crate::clamp::{
    clamp_dirs, clamp_tools, clamp_vis, expand_mcp, norm_dirs, norm_tools, DirGrant, Fail, Rules,
};
use crate::ntpath::{normcase, normpath};
use crate::pystr::{py_repr, PyStr};
use crate::val::{str_json, Val};
use orgtree_backend_codec::json::{parse, Limits, Profile, Value};
use std::collections::BTreeSet;

pub const COMMITTED: &str = include_str!("../vectors/scope-clamp-vectors.json");

pub const SECTIONS: [&str; 10] = [
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
            let (g, reg) = (opt_list(&a[0])?, opt_list(&a[1])?);
            let got = expand_mcp(g.as_deref(), reg.as_deref());
            outcome(&a[2], Ok(strs_val(&got)))
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
        _ => Err(format!("unknown section {section}")),
    }
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
