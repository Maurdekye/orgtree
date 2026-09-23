//! Check the Python-oracle vectors against this crate.
//!
//! Every section of `vectors/funding-vectors.json` is re-evaluated here and
//! every field the oracle recorded is compared exactly: numbers by Python
//! kind and float bits, strings byte for byte, read and write sets as sets.
//! A failure names its section, row and field.

use crate::fmt::py_g;
use crate::ledger::{Fail, GrantEvent, Rules, StrandCall};
use crate::pynum::{py_sum, PyNum};
use crate::snapshot::{parse_spec, Snapshot};
use crate::Outcome;
use orgtree_backend_codec::json::{parse, Limits, Number, Profile, Value};
use orgtree_backend_codec::presence::Presence;
use std::collections::BTreeSet;

/// The committed vectors, embedded so the driver and tests need no file
/// system access to find them.
pub const COMMITTED: &str = include_str!("../vectors/funding-vectors.json");

pub const SCHEMA: &str = "orgtree.funding-core-vectors/v1";

/// Every section the oracle writes. A vectors file missing one fails.
pub const SECTIONS: &[&str] = &[
    "fmt_g",
    "sum",
    "value",
    "acquire",
    "reallocate",
    "hire",
    "rehire",
    "outside",
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

    /// Sections with at least one failure.
    pub fn failing_sections(&self) -> BTreeSet<String> {
        self.failures
            .iter()
            .filter_map(|f| f.split(['[', ':']).next())
            .map(str::to_owned)
            .collect()
    }
}

type Check = Result<(), String>;

fn member<'a>(o: &'a Value, k: &str) -> Option<&'a Value> {
    match o {
        Value::Object(obj) => match obj.get(k) {
            Presence::Present(v) => Some(v),
            Presence::Null => Some(&Value::Null),
            Presence::Absent => None,
        },
        _ => None,
    }
}

fn need<'a>(o: &'a Value, k: &str) -> Result<&'a Value, String> {
    member(o, k).ok_or_else(|| format!("missing field {k}"))
}

fn text(v: &Value) -> Result<&str, String> {
    match v {
        Value::String(s) => Ok(s),
        _ => Err("expected a string".to_owned()),
    }
}

fn items(v: &Value) -> Result<&[Value], String> {
    match v {
        Value::Array(a) => Ok(a),
        _ => Err("expected an array".to_owned()),
    }
}

/// A number exactly as Python's `json.loads` returns it, non-finite floats
/// included.
fn pynum(v: &Value) -> Result<PyNum, String> {
    match v {
        Value::Number(n) => match n {
            Number::Finite(s) if n.is_integer_lexeme() => s
                .parse::<i128>()
                .map(PyNum::Int)
                .map_err(|_| format!("int {s} wider than i128")),
            _ => Ok(PyNum::Float(n.to_f64())),
        },
        _ => Err("expected a number".to_owned()),
    }
}

fn show(x: PyNum) -> String {
    match x {
        PyNum::Int(i) => format!("int {i}"),
        PyNum::Float(f) => format!("float {f:?}"),
    }
}

fn same_num(what: &str, want: &Value, got: PyNum) -> Check {
    let w = pynum(want)?;
    if w.identical(got) {
        Ok(())
    } else {
        Err(format!("{what}: want {}, got {}", show(w), show(got)))
    }
}

fn strings(v: &Value) -> Result<Vec<String>, String> {
    items(v)?
        .iter()
        .map(|x| text(x).map(str::to_owned))
        .collect()
}

fn same_strings(what: &str, want: &Value, got: &[String]) -> Check {
    let w = strings(want)?;
    if w == got {
        Ok(())
    } else {
        Err(format!("{what}: want {w:?}, got {got:?}"))
    }
}

fn same_set(what: &str, want: &Value, got: &BTreeSet<String>) -> Check {
    let w: BTreeSet<String> = strings(want)?.into_iter().collect();
    if &w == got {
        return Ok(());
    }
    let missing: Vec<&String> = w.difference(got).collect();
    let extra: Vec<&String> = got.difference(&w).collect();
    Err(format!("{what}: missing {missing:?}, extra {extra:?}"))
}

fn opt_str(v: &Value) -> Result<Option<String>, String> {
    match v {
        Value::Null => Ok(None),
        other => Ok(Some(text(other)?.to_owned())),
    }
}

fn same_grants(want: &Value, got: &[(String, PyNum)]) -> Check {
    let w = items(want)?;
    if w.len() != got.len() {
        return Err(format!(
            "grants_changed: want {} rows, got {got:?}",
            w.len()
        ));
    }
    for (row, (id, g)) in w.iter().zip(got) {
        let pair = items(row)?;
        if pair.len() != 2 || text(&pair[0])? != id {
            return Err(format!(
                "grants_changed: want node {:?}, got {id}",
                pair.first()
            ));
        }
        same_num(&format!("grants_changed[{id}]"), &pair[1], *g)?;
    }
    Ok(())
}

fn same_notices(want: &Value, got: &[(Vec<String>, String)]) -> Check {
    let w = items(want)?;
    if w.len() != got.len() {
        return Err(format!("notices: want {} rows, got {got:?}", w.len()));
    }
    for (row, (to, body)) in w.iter().zip(got) {
        let pair = items(row)?;
        if pair.len() != 2 {
            return Err("notices: malformed row".to_owned());
        }
        same_strings("notices.to", &pair[0], to)?;
        if text(&pair[1])? != body {
            return Err(format!(
                "notices.text: want {:?}, got {body:?}",
                text(&pair[1])?
            ));
        }
    }
    Ok(())
}

fn same_strand(want: &Value, got: &[StrandCall]) -> Check {
    let w = items(want)?;
    if w.len() != got.len() {
        return Err(format!("strand: want {} calls, got {}", w.len(), got.len()));
    }
    for (k, (row, call)) in w.iter().zip(got).enumerate() {
        let r = items(row)?;
        if r.len() != 4 || text(&r[0])? != call.payer {
            return Err(format!("strand[{k}]: payer differs (got {})", call.payer));
        }
        same_num(&format!("strand[{k}].before"), &r[1], call.before)?;
        same_num(&format!("strand[{k}].after"), &r[2], call.after)?;
        same_strings(&format!("strand[{k}].warnings"), &r[3], &call.warnings)?;
    }
    Ok(())
}

fn same_events(want: &Value, got: &[GrantEvent]) -> Check {
    let w = items(want)?;
    if w.len() != got.len() {
        return Err(format!("events: want {} rows, got {}", w.len(), got.len()));
    }
    for (k, (row, e)) in w.iter().zip(got).enumerate() {
        let r = items(row)?;
        if r.len() != 3 {
            return Err(format!("events[{k}]: malformed"));
        }
        let to: Vec<Option<String>> = items(&r[0])?
            .iter()
            .map(opt_str)
            .collect::<Result<_, _>>()?;
        if to != e.to || text(&r[1])? != "access.grant_changed" {
            return Err(format!("events[{k}]: recipients {to:?} vs {:?}", e.to));
        }
        let p = &r[2];
        if text(need(p, "relation")?)? != e.relation
            || text(need(p, "node")?)? != e.node
            || text(need(p, "by")?)? != e.by
        {
            return Err(format!("events[{k}]: relation/node/by differ"));
        }
        same_num(
            &format!("events[{k}].delta"),
            need(p, "delta")?,
            PyNum::Float(e.delta),
        )?;
        same_num(
            &format!("events[{k}].now"),
            need(p, "now")?,
            PyNum::Float(e.now),
        )?;
        same_num(
            &format!("events[{k}].free"),
            need(p, "free")?,
            PyNum::Float(e.free),
        )?;
    }
    Ok(())
}

fn same_logs(want: &Value, got: &[(String, Vec<String>)]) -> Check {
    let w = items(want)?;
    if w.len() != got.len() {
        return Err(format!("logs: want {} rows, got {}", w.len(), got.len()));
    }
    for (row, (op, ws)) in w.iter().zip(got) {
        let r = items(row)?;
        if r.len() != 2 || text(&r[0])? != op {
            return Err("logs: op differs".to_owned());
        }
        same_strings("logs.warnings", &r[1], ws)?;
    }
    Ok(())
}

/// The outcome's refusal against the row's `raises`/`message`, or the
/// absence of both. `Ok(true)` means the step succeeded on both sides.
fn same_result<T>(row: &Value, out: &Outcome<T>) -> Result<bool, String> {
    match (member(row, "raises"), &out.result) {
        (None, Ok(_)) => Ok(true),
        (Some(exc), Err(Fail::Refused(r))) => {
            let msg = text(need(row, "message")?)?;
            if text(exc)? != r.exc.as_str() || msg != r.message {
                return Err(format!(
                    "refusal: want {} {msg:?}, got {} {:?}",
                    text(exc)?,
                    r.exc.as_str(),
                    r.message
                ));
            }
            Ok(false)
        }
        (_, Err(Fail::Outside(o))) => Err(format!("outside the parity domain: {}", o.0)),
        (Some(exc), Ok(_)) => Err(format!(
            "want {} {:?}, got success",
            text(exc)?,
            member(row, "message")
        )),
        (None, Err(Fail::Refused(r))) => Err(format!("want success, got {:?}", r.message)),
    }
}

fn common<T>(row: &Value, out: &Outcome<T>) -> Check {
    same_grants(need(row, "grants_changed")?, &out.grants_changed)?;
    same_notices(need(row, "notices")?, &out.notices)?;
    same_strand(need(row, "strand")?, &out.strand_calls)?;
    same_set("reads", need(row, "reads")?, &out.reads)?;
    same_set("writes", need(row, "writes")?, &out.writes)
}

fn spec(row: &Value) -> Result<Snapshot, String> {
    parse_spec(need(row, "spec")?).map_err(|o| format!("spec: {}", o.0))
}

fn acquire_calls<T>(row: &Value, out: &Outcome<T>) -> Check {
    let w = items(need(row, "acquire_calls")?)?;
    if w.len() != out.acquisitions.len() {
        return Err(format!(
            "acquire_calls: want {}, got {}",
            w.len(),
            out.acquisitions.len()
        ));
    }
    for (k, (c, a)) in w.iter().zip(&out.acquisitions).enumerate() {
        let r = items(c)?;
        let cascade = matches!(r.get(3), Some(Value::Bool(true)));
        if r.len() != 4
            || text(&r[0])? != a.actor
            || text(&r[1])? != a.payer
            || cascade != a.cascade
        {
            return Err(format!("acquire_calls[{k}]: differs"));
        }
        same_num(&format!("acquire_calls[{k}].need"), &r[2], a.need)?;
    }
    Ok(())
}

fn check_value(row: &Value, rules: &Rules) -> Check {
    let snap = spec(row)?;
    let nid = text(need(row, "node")?)?;
    let out = match text(need(row, "op")?)? {
        "committed" => crate::committed(&snap, nid, rules),
        "free" => crate::free(&snap, nid, rules),
        op => return Err(format!("unknown value op {op}")),
    };
    if same_result(row, &out)? {
        if let Ok(v) = out.result {
            same_num("value", need(row, "value")?, v)?;
        }
    }
    same_set("reads", need(row, "reads")?, &out.reads)
}

fn check_acquire(row: &Value, rules: &Rules) -> Check {
    let snap = spec(row)?;
    let out = crate::chain_acquire(
        &snap,
        text(need(row, "actor")?)?,
        text(need(row, "payer")?)?,
        pynum(need(row, "need")?)?,
        matches!(need(row, "cascade")?, Value::Bool(true)),
        rules,
    );
    same_result(row, &out)?;
    same_strings("warnings", need(row, "warnings")?, &out.acquire_warnings)?;
    common(row, &out)
}

fn check_reallocate(row: &Value, rules: &Rules) -> Check {
    let snap = spec(row)?;
    let out = crate::reallocate(
        &snap,
        text(need(row, "actor")?)?,
        text(need(row, "node")?)?,
        pynum(need(row, "delta")?)?,
        rules,
    );
    if same_result(row, &out)? {
        if let Ok((g, ws)) = &out.result {
            same_num("grant", need(row, "grant")?, *g)?;
            same_strings("warnings", need(row, "warnings")?, ws)?;
        }
    }
    same_events(need(row, "events")?, &out.events)?;
    same_logs(need(row, "logs")?, &out.logs)?;
    common(row, &out)
}

fn check_hire(row: &Value, rules: &Rules) -> Check {
    let snap = spec(row)?;
    let parent = opt_str(need(row, "parent")?)?;
    let out = crate::hire(
        &snap,
        text(need(row, "actor")?)?,
        parent.as_deref(),
        text(need(row, "tier")?)?,
        pynum(need(row, "grant")?)?,
        rules,
    );
    if same_result(row, &out)? {
        if let Ok(g) = out.result {
            same_num("new_grant", need(row, "new_grant")?, g)?;
        }
    }
    acquire_calls(row, &out)?;
    same_strings("warnings", need(row, "warnings")?, &out.acquire_warnings)?;
    common(row, &out)
}

fn check_rehire(row: &Value, rules: &Rules) -> Check {
    let snap = spec(row)?;
    let grant = match need(row, "grant")? {
        Value::Null => None,
        g => Some(pynum(g)?),
    };
    let nid = text(need(row, "node")?)?;
    let out = crate::rehire(&snap, text(need(row, "actor")?)?, nid, grant, rules);
    if same_result(row, &out)? {
        match (member(row, "noop"), &out.result) {
            (Some(w), Ok(None)) => same_strings(
                "noop",
                w,
                &[format!("{nid} is already live \u{2014} nothing to do")],
            )?,
            (None, Ok(Some(_))) => {}
            _ => return Err("noop: live/archived outcome differs".to_owned()),
        }
    }
    acquire_calls(row, &out)?;
    same_strings("warnings", need(row, "warnings")?, &out.acquire_warnings)?;
    let states = items(need(row, "states_changed")?)?;
    let want: Vec<(String, String)> = states
        .iter()
        .map(|r| match items(r)? {
            [k, v] => Ok((text(k)?.to_owned(), text(v)?.to_owned())),
            _ => Err("states_changed: malformed row".to_owned()),
        })
        .collect::<Result<_, String>>()?;
    if want != out.states_changed {
        return Err(format!(
            "states_changed: want {want:?}, got {:?}",
            out.states_changed
        ));
    }
    common(row, &out)
}

fn check_outside(row: &Value, rules: &Rules) -> Check {
    let snap = spec(row)?;
    let actor = text(need(row, "actor")?)?;
    let result = match text(need(row, "op")?)? {
        "acquire" => crate::chain_acquire(
            &snap,
            actor,
            text(need(row, "payer")?)?,
            pynum(need(row, "need")?)?,
            matches!(need(row, "cascade")?, Value::Bool(true)),
            rules,
        )
        .result
        .map(|_| ()),
        "rehire" => {
            let grant = match need(row, "grant")? {
                Value::Null => None,
                g => Some(pynum(g)?),
            };
            crate::rehire(&snap, actor, text(need(row, "node")?)?, grant, rules)
                .result
                .map(|_| ())
        }
        "hire" => {
            let parent = opt_str(need(row, "parent")?)?;
            crate::hire(
                &snap,
                actor,
                parent.as_deref(),
                text(need(row, "tier")?)?,
                pynum(need(row, "grant")?)?,
                rules,
            )
            .result
            .map(|_| ())
        }
        op => return Err(format!("outside: unknown op {op}")),
    };
    match result {
        Err(Fail::Outside(_)) => Ok(()),
        _ => Err("outside: the crate answered a row outside its parity domain".to_owned()),
    }
}

fn check_fmt_g(row: &Value, rules: &Rules) -> Check {
    let r = items(row)?;
    let x = pynum(&r[0])?;
    let want = text(&r[1])?;
    let got = py_g(x, rules.fmt_half_even);
    if got == want {
        Ok(())
    } else {
        Err(format!("format({}, 'g'): want {want}, got {got}", show(x)))
    }
}

fn check_sum(row: &Value, rules: &Rules) -> Check {
    let r = items(row)?;
    let xs: Vec<PyNum> = items(&r[0])?.iter().map(pynum).collect::<Result<_, _>>()?;
    let got = py_sum(&xs, rules.sum).map_err(|o| format!("sum outside: {}", o.0))?;
    same_num("sum", &r[1], got)
}

/// Check a vectors text under `rules`.
pub fn run(text_in: &str, rules: &Rules) -> Report {
    let mut report = Report::default();
    let limits = Limits {
        max_bytes: 64 << 20,
        max_depth: 64,
    };
    let doc = match parse(text_in, Profile::PythonLegacy, limits) {
        Ok(d) => d,
        Err(e) => {
            report.failures.push(format!("parse: {e}"));
            return report;
        }
    };
    match member(&doc, "schema") {
        Some(Value::String(s)) if s == SCHEMA => {}
        _ => report.failures.push(format!("schema: expected {SCHEMA}")),
    }
    for &name in SECTIONS {
        let rows = match member(&doc, name) {
            Some(Value::Array(rows)) if !rows.is_empty() => rows,
            _ => {
                report
                    .failures
                    .push(format!("{name}: missing or empty section"));
                continue;
            }
        };
        let check: fn(&Value, &Rules) -> Check = match name {
            "fmt_g" => check_fmt_g,
            "sum" => check_sum,
            "value" => check_value,
            "acquire" => check_acquire,
            "reallocate" => check_reallocate,
            "hire" => check_hire,
            "rehire" => check_rehire,
            _ => check_outside,
        };
        for (i, row) in rows.iter().enumerate() {
            if let Err(e) = check(row, rules) {
                report.failures.push(format!("{name}[{i}]: {e}"));
            }
        }
        report.checked.push((name.to_owned(), rows.len()));
    }
    report
}
