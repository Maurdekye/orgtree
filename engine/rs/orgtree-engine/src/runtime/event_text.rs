//! The agent-facing text of a typed event (`ev`), one renderer per leaf: a byte-for-byte port of events_render.py on origin/v3/3.0.0-alpha.0.

use serde_json::Value;

const USER: &str = "@user";
/// workfields.DESC_EXCERPT: how much of a description a notification carries inline.
const DESC_EXCERPT: usize = 600;
/// workfields.NOTE_EXCERPT: and how much of a review or acceptance note.
const NOTE_EXCERPT: usize = 800;
/// Appended to a one-shot dog's fire mail (D-200).
const WATCHDOG_ONCE_NOTE: &str = "\n\n— This was a ONE-SHOT dog: it fired once and has REMOVED ITSELF. \
It is gone from your list and will not fire again. Nothing is wrong \
and you need not remove it. If you want to watch for this again, \
arm a new one.";
const CHECKUP: &str = "[AUTOMATIC 20-MINUTE WORKING-STATUS CHECK]\n\
You previously reported that you were working, but Orgtree has not woken \
you for 20 minutes. Check the actual work, files, processes, and messages. \
If useful work remains, make concrete progress now. Then report honestly \
with orgtree_status: use working only if work is still in progress, done \
if it is complete, or blocked if you truly cannot proceed. Do not claim \
that work is continuing without verifying it.";

static NULL: Value = Value::Null;

// ======================================================================= python semantics

/// `v["k"]`: a missing key (or a non-dict) is Python's KeyError/TypeError.
#[nolog]
fn req<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object()?.get(k)
}

/// `v.get("k")`: missing reads as None.
#[nolog]
fn opt<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.as_object().and_then(|m| m.get(k)).unwrap_or(&NULL)
}

/// `str(v["k"])`.
#[nolog]
fn f(v: &Value, k: &str) -> Option<String> {
    req(v, k).map(py_str)
}

/// `_obj(ev)`: the event's object when it is a dict, else an empty one.
#[nolog]
fn obj(ev: &Value) -> &Value {
    match ev.get("object") {
        Some(o) if o.is_object() => o,
        _ => &NULL,
    }
}

/// Python truthiness of a JSON value.
#[nolog]
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|x| x != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `str(v or default)`.
#[nolog]
fn or_str(v: &Value, default: &str) -> String {
    if truthy(v) {
        py_str(v)
    } else {
        default.to_string()
    }
}

/// `v == "lit"`.
#[nolog]
fn is(v: &Value, lit: &str) -> bool {
    v.as_str() == Some(lit)
}

/// A number (or bool) as Python sees it in arithmetic and comparison.
#[nolog]
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// Python `==` between two decoded JSON values (1 == 1.0 == True).
#[nolog]
fn py_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64()) {
            (Some(i), Some(j)) => i == j,
            _ => match (x.as_u64(), y.as_u64()) {
                (Some(i), Some(j)) => i == j,
                _ => x.as_f64() == y.as_f64(),
            },
        },
        (Value::Bool(_) | Value::Number(_), Value::Bool(_) | Value::Number(_)) => num(a) == num(b),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| py_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).map(|q| py_eq(p, q)).unwrap_or(false))
        }
        _ => a == b,
    }
}

/// `repr(float)`: shortest round-trip digits, exponent form outside [1e-4, 1e16).
#[nolog]
fn py_float_repr(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let e = format!("{:e}", x.abs());
    let (mant, exp) = match e.split_once('e') {
        Some(p) => p,
        None => return format!("{x}"),
    };
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let sign = if x < 0.0 { "-" } else { "" };
    if (-4..16).contains(&exp) {
        if exp >= 0 {
            let int_len = exp as usize + 1;
            if digits.len() <= int_len {
                format!("{sign}{digits}{}.0", "0".repeat(int_len - digits.len()))
            } else {
                format!("{sign}{}.{}", &digits[..int_len], &digits[int_len..])
            }
        } else {
            format!("{sign}0.{}{digits}", "0".repeat((-exp - 1) as usize))
        }
    } else {
        let m = if digits.len() > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits };
        format!("{sign}{m}e{}{:02}", if exp < 0 { "-" } else { "+" }, exp.abs())
    }
}

/// Is `c` printable for Python's `repr` (approximately `str.isprintable`)?
#[nolog]
fn printable(c: char) -> bool {
    let u = c as u32;
    !(u < 0x20
        || (0x7f..=0xa0).contains(&u)
        || u == 0xad
        || u == 0x061c
        || u == 0x1680
        || u == 0x180e
        || (0x2000..=0x200f).contains(&u)
        || (0x2028..=0x202f).contains(&u)
        || (0x205f..=0x206f).contains(&u)
        || u == 0x3000
        || (0xd800..=0xf8ff).contains(&u)
        || u == 0xfeff
        || (0xfff9..=0xfffb).contains(&u)
        || u >= 0xf0000)
}

/// `repr(str)`.
#[nolog]
fn py_repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if printable(c) => out.push(c),
            c if (c as u32) <= 0xff => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (c as u32) <= 0xffff => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push_str(&format!("\\U{:08x}", c as u32)),
        }
    }
    out.push(q);
    out
}

/// `repr(v)` of a decoded JSON value.
#[nolog]
fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => py_repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter().map(|(k, x)| format!("{}: {}", py_repr_str(k), py_repr(x))).collect::<Vec<_>>().join(", ")
        ),
        other => py_str(other),
    }
}

/// `str(v)` of a decoded JSON value (`None`, `True`, `1.0`, `['a']`).
#[nolog]
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                py_float_repr(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => s.clone(),
        other => py_repr(other),
    }
}

/// Python's `str.isspace` set (Rust's plus the four ASCII separators).
#[nolog]
fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// `str.strip()`.
#[nolog]
fn py_strip(s: &str) -> &str {
    s.trim_matches(py_space)
}

/// `s[:n]` by characters.
#[nolog]
fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `v[:n]` on a str (or a list, then printed).
#[nolog]
fn py_slice(v: &Value, n: usize) -> Option<String> {
    match v {
        Value::String(s) => Some(take(s, n)),
        Value::Array(a) => Some(py_repr(&Value::Array(a.iter().take(n).cloned().collect()))),
        _ => None,
    }
}

/// `int(v)`.
#[nolog]
fn py_int(v: &Value) -> Option<i128> {
    match v {
        Value::Bool(b) => Some(*b as i128),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i as i128)
            } else if let Some(u) = n.as_u64() {
                Some(u as i128)
            } else {
                let x = n.as_f64()?.trunc();
                (x.is_finite() && x.abs() < 1e38).then_some(x as i128)
            }
        }
        Value::String(s) => {
            let t = py_strip(s);
            let (neg, d) = match t.strip_prefix('-') {
                Some(r) => (true, r),
                None => (false, t.strip_prefix('+').unwrap_or(t)),
            };
            if d.is_empty() || d.starts_with('_') || d.ends_with('_') || d.contains("__") {
                return None;
            }
            if !d.chars().all(|c| c.is_ascii_digit() || c == '_') {
                return None;
            }
            let n: i128 = d.replace('_', "").parse().ok()?;
            Some(if neg { -n } else { n })
        }
        _ => None,
    }
}

/// `float(v)`.
#[nolog]
fn py_float(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(_) | Value::Number(_) => num(v),
        Value::String(s) => py_strip(s).parse::<f64>().ok(),
        _ => None,
    }
}

/// Python's `format(x, "g")` / `format(x, "+g")`: 6 significant digits, trailing zeros stripped.
#[nolog]
fn fmt_g(x: f64, plus: bool) -> String {
    let body = if x.is_nan() {
        "nan".to_string()
    } else if x.is_infinite() {
        if x > 0.0 { "inf".into() } else { "-inf".into() }
    } else {
        let e = format!("{:.5e}", x);
        let (mant, exp) = e.split_once('e').unwrap_or((e.as_str(), "0"));
        let exp: i32 = exp.parse().unwrap_or(0);
        if !(-4..6).contains(&exp) {
            let m = if mant.contains('.') { mant.trim_end_matches('0').trim_end_matches('.') } else { mant };
            format!("{m}e{}{:02}", if exp < 0 { "-" } else { "+" }, exp.abs())
        } else {
            let s = format!("{:.*}", (5 - exp) as usize, x);
            if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
        }
    };
    if plus && !body.starts_with('-') {
        format!("+{body}")
    } else {
        body
    }
}

/// `_g(x)`: `f"{float(x):g}"`, as the ledger prints credits.
#[nolog]
fn g(v: &Value) -> Option<String> {
    py_float(v).map(|x| fmt_g(x, false))
}

/// What `for x in v` yields when each `x` is then subscripted (a str or
/// dict only iterates cleanly when empty).
#[nolog]
fn items(v: &Value) -> Option<Vec<&Value>> {
    match v {
        Value::Array(a) => Some(a.iter().collect()),
        Value::String(s) if s.is_empty() => Some(Vec::new()),
        Value::Object(o) if o.is_empty() => Some(Vec::new()),
        _ => None,
    }
}

/// The strings `sep.join(v)` would join (a str iterates its characters, a dict its keys).
#[nolog]
fn strs(v: &Value) -> Option<Vec<String>> {
    match v {
        Value::Array(a) => a.iter().map(|x| x.as_str().map(str::to_string)).collect(),
        Value::String(s) => Some(s.chars().map(String::from).collect()),
        Value::Object(o) => Some(o.keys().cloned().collect()),
        _ => None,
    }
}

/// `sep.join(v)`.
#[nolog]
fn join(v: &Value, sep: &str) -> Option<String> {
    strs(v).map(|x| x.join(sep))
}

/// `sep.join(v) or default`.
#[nolog]
fn join_or(v: &Value, sep: &str, default: &str) -> Option<String> {
    let s = join(v, sep)?;
    Some(if s.is_empty() { default.to_string() } else { s })
}

/// workfields.prose: trimmed, otherwise whole.
#[nolog]
fn prose(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        py_strip(&py_str(v)).to_string()
    }
}

/// workfields.excerpt: a preview of a lossless field that says it is one.
#[nolog]
fn excerpt(v: &Value, limit: usize, what: &str, how: &str) -> String {
    let s = if v.is_null() { String::new() } else { py_str(v) };
    let n = s.chars().count();
    if n <= limit {
        return s;
    }
    format!(
        "{}… [EXCERPT — {n} characters in full; this shows the first {limit}. Read the whole {what} with {how}]",
        take(&s, limit)
    )
}

// ============================================================================= idioms

/// `the user` for the root, `"name"` for an agent.
#[nolog]
fn who(by: &str) -> String {
    if by == USER {
        "the user".into()
    } else {
        format!("\"{by}\"")
    }
}

#[nolog]
fn who_cap(by: &str) -> String {
    if by == USER {
        "The user".into()
    } else {
        who(by)
    }
}

/// `the user` / bare name (the docket idiom).
#[nolog]
fn user_or(by: &str) -> String {
    if by == USER {
        "the user".into()
    } else {
        by.to_string()
    }
}

/// The description as a notification shows it: an excerpt that says so.
#[nolog]
fn desc(ev: &Value) -> String {
    let text = or_str(opt(ev, "objective"), "");
    if text.is_empty() {
        return "(none recorded)".into();
    }
    let slug = py_str(opt(obj(ev), "slug"));
    let body = excerpt(
        &Value::String(text),
        DESC_EXCERPT,
        "description",
        &format!("orgtree_work get slug={slug} before acting on it"),
    );
    let notice = opt(ev, "objective_notice");
    if truthy(notice) {
        format!("{}\n{body}", py_strip(&py_str(notice)))
    } else {
        body
    }
}

/// A review or acceptance note as a notification shows it.
#[nolog]
fn note(ev: &Value, what: &str) -> String {
    let slug = py_str(opt(obj(ev), "slug"));
    excerpt(opt(ev, "note"), NOTE_EXCERPT, &format!("{what} note"), &format!("orgtree_work get slug={slug}"))
}

#[nolog]
fn docket_head(tag: &str, ev: &Value) -> Option<String> {
    let o = obj(ev);
    let slug = f(o, "slug")?;
    let title = take(&or_str(opt(o, "title"), ""), 80);
    Some(format!("[DOCKET {tag} · {slug} \"{title}\"] "))
}

#[nolog]
fn relay_suffix(ev: &Value) -> Option<String> {
    if !truthy(opt(ev, "relayed")) {
        return Some(String::new());
    }
    let rv = f(ev, "reviewer")?;
    Some(format!(
        "\n(This notice comes from the docket itself: {rv} is the \
item's reviewer but cannot address you directly under the mail rules. \
Reply to your own superior if you need to reach them.)"
    ))
}

// ======================================================================= reply / docket

#[nolog]
fn r_reply_docket(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let how = if is(req(ev, "role")?, "participant") {
        let owner = or_str(opt(ev, "owner"), "nobody (unassigned)");
        format!(
            "(the user replied on this docket item ADDRESSED TO \
YOU AS A PARTICIPANT — the item is owned by \
{owner}, not by \
you; treat this as item-linked mail, act on it, and \
coordinate any update with the owner)"
        )
    } else {
        "(the user replied on this docket item — treat it as \
item-linked mail and update the item if it changes \
the work)"
            .to_string()
    };
    let slug = f(o, "slug")?;
    let title = take(&or_str(opt(o, "title"), ""), 80);
    let body = f(ev, "body")?;
    Some(format!("[DOCKET REPLY · {slug} \"{title}\"] {how}\n{body}"))
}

#[nolog]
fn r_assigned(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let prev = req(ev, "previous_owner")?;
    let own = req(ev, "owner")?;
    let head = docket_head("ASSIGNMENT", ev)?;
    let assigner = user_or(&f(ev, "assigner")?);
    let previously = if truthy(prev) && !py_eq(prev, own) { format!(" (previously {})", py_str(prev)) } else { String::new() };
    let desc = desc(ev);
    let done = join_or(req(ev, "done_so_far")?, "; ", "(nothing recorded)")?;
    let next = join_or(req(ev, "working_on_next")?, "; ", "(nothing recorded)")?;
    let acc = join_or(req(ev, "acceptance")?, "; ", "(none recorded)")?;
    let slug = f(o, "slug")?;
    Some(format!(
        "{head}You are now the ASSIGNMENT on this docket item — that is \
OWNERSHIP: you hold its management rights, the user's replies on \
it come to you, and you are who the docket names as responsible.\
\nAssigned by {assigner}{previously}.\
\nDescription: {desc}\
\nLatest status — done so far: {done}\
\nWorking on / next: {next}\
\nAcceptance conditions: {acc}\
\nRead it in full with orgtree_work get slug={slug}, and \
`update` it at the next meaningful boundary — your update is what \
the user reads."
    ))
}

#[nolog]
fn r_review_requested(ev: &Value) -> Option<String> {
    let head = docket_head("REVIEW REQUEST", ev)?;
    let owner = or_str(req(ev, "owner")?, "its owner");
    let by = user_or(&f(ev, "requested_by")?);
    let rev = if truthy(opt(ev, "revision")) { py_int(opt(ev, "revision"))? } else { 0 };
    let cand = or_str(opt(ev, "candidate"), "(none supplied)");
    let base = or_str(opt(ev, "base"), "(none supplied)");
    let desc = desc(ev);
    let acc = join_or(req(ev, "acceptance")?, "; ", "(none recorded)")?;
    let done = join_or(req(ev, "done_so_far")?, "; ", "(nothing recorded)")?;
    let slug = f(obj(ev), "slug")?;
    let relay = if truthy(opt(ev, "relayed")) {
        let rb = f(ev, "requested_by")?;
        format!(
            "\n(This notice comes from the docket itself: \
{rb} named you but cannot address you \
directly under the mail rules. Your review decision reaches \
them either way.)"
        )
    } else {
        String::new()
    };
    Some(format!(
        "{head}You are named as the REVIEWER of this docket item. THIS IS NOT \
OWNERSHIP: {owner} \
keeps the work and the responsibility for delivering it. You \
hold exactly three things — read it, add `evidence`, and record \
ONE decision with orgtree_work action='review': `approve` (the \
check passed — that COMPLETES the item) or `changes` (it goes \
back to the owner as in_progress, and your note is what they act \
on). Until you decide, the next action on this item is yours.\
\nRequested by {by}.\
\nIssued at item revision {rev}; candidate {cand}; base {base}.\
\nDescription: {desc}\
\nAcceptance conditions: {acc}\
\nWhat the owner says is done: {done}\
\nRead the complete standalone scope with orgtree_work get slug={slug} before reviewing it.{relay}"
    ))
}

#[nolog]
fn r_review_seat_requested(ev: &Value) -> Option<String> {
    let head = docket_head("REVIEW SEAT REQUEST", ev)?;
    let by = user_or(&f(ev, "requested_by")?);
    let rv = f(ev, "reviewer")?;
    let why = if truthy(opt(ev, "note")) { format!("\nWhy: {}", note(ev, "request")) } else { String::new() };
    let owner = or_str(req(ev, "owner")?, "its owner");
    let slug = f(obj(ev), "slug")?;
    Some(format!(
        "{head}{by} is asking you to grant \
{rv} the REVIEW SEAT on this docket item. You are \
being asked because you are the nearest agent who is both above \
{rv} and owner-level on this item — an owner may \
name only itself, its own subtree or its own superior as \
reviewer, so a peer reviewer is yours to authorize and nobody \
else's.{why}\
\nThe item belongs to {owner} and stays \
with them: granting the seat lets them NAME \
{rv} as reviewer. It hands over read, evidence, \
the one review decision and participant-level state control — \
not the item.\
\nGrant it with orgtree_work action='review_grant' \
reviewer={rv} items=['{slug}'], or \
turn it down with action='review_revoke' slug={slug} \
reviewer={rv} and a `note` saying why.\
\nRead the item first with orgtree_work get slug={slug}."
    ))
}

#[nolog]
fn r_review_seat_decided(ev: &Value) -> Option<String> {
    let who = user_or(&f(ev, "decided_by")?);
    let rid = f(ev, "reviewer")?;
    let slug = f(obj(ev), "slug")?;
    let decision = req(ev, "decision")?;
    let body = if is(decision, "granted") {
        let mid = if truthy(opt(ev, "seated")) {
            format!(
                "\nThe item was already at status review, so the seat has \
been handed over and {rid} is its reviewer now."
            )
        } else {
            format!(
                "\nYou can now put the item into review naming \
{rid} — orgtree_work action='update' slug={slug} \
status=review reviewer={rid}."
            )
        };
        format!(
            "{who} GRANTED {rid} the review seat on this item.{mid}\
\nNaming {rid} spends the grant. A `changes` verdict \
keeps permission for the same reviewer's next entry into \
review on this item."
        )
    } else if is(decision, "revoked") {
        format!(
            "{who} REVOKED {rid}'s review seat on this item. Naming \
{rid} as reviewer is refused again until somebody above you \
both grants it afresh. A review round already in flight is \
not cancelled — that verdict is still owed."
        )
    } else {
        format!(
            "{who} DECLINED the request to give {rid} the review seat on \
this item. Nothing changed; name a reviewer you may already \
name, or ask for a different one."
        )
    };
    let head = docket_head("REVIEW SEAT", ev)?;
    let rev = match opt(ev, "revision") {
        Value::Null => String::new(),
        r => format!("\nIssued at item revision {}.", py_str(r)),
    };
    let tn = if truthy(opt(ev, "note")) { format!("\nTheir note: {}", note(ev, "decision")) } else { String::new() };
    Some(format!("{head}{body}{rev}{tn}"))
}

#[nolog]
fn r_review_changes(ev: &Value) -> Option<String> {
    let head = docket_head("REVIEW", ev)?;
    let rv = user_or(&f(ev, "reviewer")?);
    let n = if truthy(opt(ev, "note")) {
        format!("\nWhat the reviewer asked for: {}", note(ev, "review"))
    } else {
        "\nThe reviewer left no note; ask them what they want changed rather \
than guessing."
            .to_string()
    };
    let relay = relay_suffix(ev)?;
    Some(format!(
        "{head}CHANGES REQUESTED by {rv} — the item is \
back with you as in_progress and the next action is yours.{n}{relay}"
    ))
}

#[nolog]
fn r_review_approved(ev: &Value) -> Option<String> {
    let head = docket_head("REVIEW", ev)?;
    let rv = user_or(&f(ev, "reviewer")?);
    let n = if truthy(opt(ev, "note")) { format!("\nReviewer's note: {}", note(ev, "approval")) } else { String::new() };
    let relay = relay_suffix(ev)?;
    Some(format!(
        "{head}REVIEW PASSED — {rv} approved this item and \
it is now DONE. Nothing further is needed on it.{n}{relay}"
    ))
}

#[nolog]
fn r_review_approved_stage(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let head = docket_head("REVIEW", ev)?;
    let rv = user_or(&f(ev, "reviewer")?);
    let cand = f(ev, "candidate")?;
    let n = if truthy(opt(ev, "note")) { format!("\nReviewer's note: {}", note(ev, "approval")) } else { String::new() };
    let slug = f(o, "slug")?;
    let relay = relay_suffix(ev)?;
    Some(format!(
        "{head}COMMIT APPROVED — {rv} approved commit \
{cand} on this item. It is NOT done: the item is \
`approved`, it is still yours, and the next action is the \
LANDING — rebase, fast-forward and push that commit.{n}\
\nWhen it is on the integration branch, record it (orgtree_work claim \
slug={slug} stage=pushed ref=<sha> note=<git ls-remote \
origin refs/heads/<branch> output>) and \
complete the item only then. Nobody completes it for you — this \
outcome exists precisely so the docket does not read Done for \
code that is not in the product.{relay}"
    ))
}

#[nolog]
fn r_participant(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let head = docket_head("PARTICIPATION", ev)?;
    let owner = or_str(req(ev, "owner")?, "nobody (unassigned)");
    let by = user_or(&f(ev, "added_by")?);
    let desc = desc(ev);
    let slug = f(o, "slug")?;
    Some(format!(
        "{head}You are now a PARTICIPANT on this docket item — not its assignment. \
The item is owned by {owner}; you may \
read it, update it, add evidence and attach questions, and the \
user's replies addressed to you on it arrive as item-linked mail. \
Added by {by}.\
\nDescription: {desc}\
\nRead it with orgtree_work get slug={slug} when your work \
touches it; no reply is expected to this notice."
    ))
}

#[nolog]
fn r_attention(ev: &Value) -> Option<String> {
    let slug = f(obj(ev), "slug")?;
    let reason = prose(req(ev, "reason")?);
    Some(format!(
        "[DOCKET · {slug}] The user saw your attention flag \
(\"{reason}\") and chose to say nothing. \
This is not approval, rejection, or substantive feedback. Do not \
re-raise that same reason without material new information."
    ))
}

#[nolog]
fn r_status(ev: &Value) -> Option<String> {
    let state = f(ev, "state")?.to_uppercase();
    let summary = f(ev, "summary")?;
    Some(format!("[{state}] {summary}"))
}

// ================================================================ answers / decisions

#[nolog]
fn r_answer(ev: &Value) -> Option<String> {
    let qs = req(ev, "questions")?;
    let txt = opt(ev, "text");
    if truthy(req(ev, "dismissed")?) {
        let q = qs.as_array()?.first()?;
        let question = f(q, "question")?;
        return Some(format!(
            "[QUESTION DISMISSED] The user closed your question without \
answering:\nQ: {question}\
\nProceed on your best judgment, or re-ask later with a sharper \
framing."
        ));
    }
    if truthy(req(ev, "single")?) {
        let q = qs.as_array()?.first()?;
        let sel = req(q, "selected")?;
        let mut body = format!("[ANSWER to your question]\nQ: {}", f(q, "question")?);
        if truthy(sel) {
            body.push_str(&format!("\nSelected: {}", join(sel, " · ")?));
        }
        if truthy(txt) {
            body.push_str(if truthy(sel) { "\nAlso: " } else { "\nAnswer: " });
            body.push_str(&py_str(txt));
        }
        return Some(body);
    }
    let mut lines = vec!["[ANSWER to your questions]".to_string()];
    for (i, q) in items(qs)?.into_iter().enumerate() {
        q.as_object()?;
        let label = or_str(opt(q, "label"), &format!("Q{}", i + 1));
        let question = f(q, "question")?;
        let sel = join(req(q, "selected")?, " · ")?;
        lines.push(format!("{label} — {question}\n→ {sel}"));
    }
    if truthy(txt) {
        lines.push(format!("Also: {}", py_str(txt)));
    }
    Some(lines.join("\n"))
}

#[nolog]
fn r_batch(ev: &Value) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    for s in items(req(ev, "sections")?)? {
        let k = req(s, "kind")?;
        if is(k, "ask") {
            let mut lines: Vec<String> = Vec::new();
            let mut answered = 0;
            for (i, q) in items(req(s, "questions")?)?.into_iter().enumerate() {
                q.as_object()?;
                let label = or_str(opt(q, "label"), &format!("Q{}", i + 1));
                let answer = req(q, "answer")?;
                let question = f(q, "question")?;
                if answer.is_null() {
                    lines.push(format!(
                        "{label} — {question}\n→ (skipped — the user \
left this one unanswered)"
                    ));
                } else {
                    answered += 1;
                    lines.push(format!("{label} — {question}\n→ {}", py_str(answer)));
                }
            }
            let head = if answered > 0 { "[ANSWERS to your questions]\n" } else { "[your questions were SKIPPED]\n" };
            out.push(format!("{head}{}", lines.join("\n")));
        } else if is(k, "credit") {
            if is(req(s, "outcome")?, "skipped") {
                let old = g(req(s, "old")?)?;
                let asked = g(req(s, "asked")?)?;
                out.push(format!(
                    "[CREDIT REQUEST skipped] Your ask ({old} → \
{asked}) was left undecided — you may re-ask later."
                ));
            } else {
                out.push(credit_text(s)?);
            }
        } else if is(k, "scope") {
            out.push(join(req(s, "lines")?, "\n")?);
        } else if is(k, "skipped") {
            out.push(format!("[QUESTION skipped] {}", f(s, "question")?));
        }
    }
    Some(out.join("\n\n"))
}

/// A credit decision's text (also the `decision.credit` renderer).
#[nolog]
fn credit_text(s: &Value) -> Option<String> {
    let old = g(req(s, "old")?)?;
    let new = g(req(s, "asked")?)?;
    let asked = format!("you asked {old} → {new}");
    let oc = req(s, "outcome")?;
    if is(oc, "approved") {
        let now = g(req(s, "now")?)?;
        return Some(format!("The user APPROVED your credit request — your grant is now {now}."));
    }
    if is(oc, "counter") {
        let give = py_float(req(s, "granted")?)?;
        let d = fmt_g(give - py_float(req(s, "old")?)?, true);
        let gv = fmt_g(give, false);
        return Some(format!(
            "The user COUNTER-OFFERED: {asked}; granted {old} → {gv} \
({d}). You may take this as-is, request more \
later, or find another way within it."
        ));
    }
    if is(oc, "declined") {
        let now = g(req(s, "now")?)?;
        return Some(format!(
            "The user DECLINED the increase — {asked}; your grant stays \
{now}. You may re-ask with a stronger case, or work within it."
        ));
    }
    if is(oc, "reduced") {
        let give = py_float(req(s, "granted")?)?;
        let gv = fmt_g(give, false);
        let d = fmt_g(give - py_float(req(s, "old")?)?, true);
        return Some(format!(
            "The user REDUCED your grant: {asked}; your grant is now {gv} \
({d} — unused credits reclaimed). You may \
re-ask, or work within it."
        ));
    }
    Some(format!(
        "The user DENIED your credit request ({old} → {new}). Your grant stays \
{old} — work within it, re-ask with a stronger case, or escalate \
differently."
    ))
}

#[nolog]
fn r_decision_audience(ev: &Value) -> Option<String> {
    if truthy(req(ev, "granted")?) {
        let by = f(ev, "decided_by")?;
        return Some(format!(
            "Audience granted: you may message {by} directly until \
it is rescinded."
        ));
    }
    if is(req(ev, "decided_by")?, USER) {
        return Some("The user declined your audience request.".into());
    }
    let target = f(ev, "target")?;
    let by = f(ev, "decided_by")?;
    Some(format!(
        "Your audience request to reach {target} was declined at \
{by}."
    ))
}

#[nolog]
fn r_ask_routed(ev: &Value) -> Option<String> {
    let qs = items(req(ev, "questions")?)?;
    let mut parts: Vec<String> = Vec::new();
    for qd in &qs {
        let mut p = f(qd, "text")?;
        if truthy(opt(qd, "header")) {
            p = format!("[{}] {p}", py_str(opt(qd, "header")));
        }
        if truthy(opt(qd, "work_item")) {
            p = format!("(docket item {}) {p}", py_str(opt(qd, "work_item")));
        }
        let options = req(qd, "options")?;
        if truthy(options) {
            p.push_str("\nOptions: ");
            p.push_str(&join(options, " · ")?);
            if truthy(req(qd, "multi")?) {
                p.push_str(" (several may apply)");
            }
        }
        parts.push(p);
    }
    let head = if qs.len() == 1 {
        "[QUESTION — needs an answer]\n".to_string()
    } else {
        format!("[QUESTIONS — {} need answers]\n", qs.len())
    };
    Some(format!("{head}{}", parts.join("\n\n")))
}

// ================================================================ access / resources

#[nolog]
fn r_scope_requested(ev: &Value) -> Option<String> {
    let lines: Vec<String> = strs(req(ev, "items")?)?.into_iter().map(|x| format!("- {x}")).collect();
    let reason = f(ev, "reason")?;
    Some(format!(
        "[SCOPE REQUEST — needs a grant or an escalation]\n{}\
\nReason: {}\
\nIf you hold these, grant them directly with orgtree_retool; \
otherwise escalate up your chain — only the user can grant past \
your own scope.",
        lines.join("\n"),
        py_strip(&reason)
    ))
}

#[nolog]
fn r_audience_requested(ev: &Value) -> Option<String> {
    let frm = f(ev, "from_node")?;
    let target = f(ev, "target")?;
    let reason_v = req(ev, "reason")?;
    let stage = req(ev, "stage")?;
    let reason = py_str(reason_v);
    if is(stage, "initial") {
        let r = py_slice(reason_v, 300)?;
        return Some(format!(
            "AUDIENCE REQUEST: your report \"{frm}\" asks to speak directly with \
{target}. Reason: \"{r}\". You may forward it one hop up \
(orgtree_audience action=forward), deny it (action=deny), or simply \
handle the matter yourself and deny."
        ));
    }
    if is(stage, "target") {
        return Some(format!(
            "AUDIENCE REQUEST reached you: \"{frm}\" asks to speak with you \
directly. Reason: {reason}. Grant with orgtree_audience \
action=grant, or deny."
        ));
    }
    if is(stage, "user") {
        return Some(format!(
            "Audience request (forwarded up the chain): \"{frm}\" asks to speak \
with you directly. Reason: {reason}. Grant or deny it from the \
inbox panel."
        ));
    }
    Some(format!(
        "AUDIENCE REQUEST (forwarded): \"{frm}\" seeks {target}. Reason: {reason}. \
Forward, deny, or handle it."
    ))
}

#[nolog]
fn r_audience_changed(ev: &Value) -> Option<String> {
    let oc = req(ev, "outcome")?;
    let by_v = req(ev, "by")?;
    let target_v = req(ev, "target")?;
    let other = py_str(opt(ev, "other"));
    let by_user = is(by_v, USER);
    let who = if by_user { "The user".to_string() } else { format!("\"{}\"", py_str(by_v)) };
    let target = py_str(target_v);
    Some(if is(oc, "user_audience") {
        if by_user {
            "The user granted you a USER AUDIENCE — you may write to them directly \
until it is rescinded."
                .into()
        } else {
            format!(
                "{who} granted you a direct USER AUDIENCE — you may write to the \
user directly until it is rescinded."
            )
        }
    } else if is(oc, "audience_with") {
        format!(
            "{who} granted you an audience with \"{target}\" — you may message \
them directly until it is rescinded."
        )
    } else if is(oc, "audience_from") {
        format!(
            "{who} granted \"{other}\" an audience with you — it may now message \
you directly; you may revoke it at will."
        )
    } else if is(oc, "user_audience_seen") {
        format!(
            "{who} granted \"{other}\" a direct audience to you — it may now write \
to your inbox. Revoke it from the audience panel at will."
        )
    } else if is(oc, "org_inbox") {
        format!(
            "{who} granted you audience with the ORG INBOX: you now receive \
outside messages addressed to this organization (chatq sessions, \
other orgs) and may reply for it with orgtree_message to the \
sender's @org:/@net: address. Replies speak for the org as a \
whole — coordinate with the other recipients before answering."
        )
    } else if is(oc, "org_inbox_auto") {
        "Outside mail arrived and no one held the ORG-INBOX audience, so it \
was auto-granted to you (the senior top-level agent). You now receive \
outside messages addressed to this organization and reply for it. \
Extend the audience to a better-suited agent with orgtree_audience \
action=grant target=extern; revoke your own with action=revoke."
            .into()
    } else if is(oc, "org_inbox_released") {
        "You gave up your ORG-INBOX audience — outside mail addressed to the \
org no longer reaches you."
            .into()
    } else if is(oc, "declined") {
        "The user declined your audience request.".into()
    } else {
        let label = if is(target_v, USER) { "the user".to_string() } else { target };
        format!("Your audience with {label} was rescinded — fall back to the parent chain.")
    })
}

#[nolog]
fn r_grant_changed(ev: &Value) -> Option<String> {
    let who = who_cap(&f(ev, "by")?);
    if is(req(ev, "relation")?, "self") {
        let d = fmt_g(py_float(req(ev, "delta")?)?, true);
        let now = g(req(ev, "now")?)?;
        let free = g(req(ev, "free")?)?;
        return Some(format!(
            "{who} adjusted your grant by {d} \
(now {now}, free {free})."
        ));
    }
    let node = f(ev, "node")?;
    let d = fmt_g(py_float(req(ev, "delta")?)?, true);
    Some(format!("{who} adjusted \"{node}\"'s grant by {d}."))
}

#[nolog]
fn r_scope_changed(ev: &Value) -> Option<String> {
    let by = req(ev, "by")?;
    if is(by, USER) {
        return Some(
            "The user changed your configuration (folders, tools, charter, or \
org visibility). Your current scope is stated in your system prompt \
each turn."
                .into(),
        );
    }
    let by = py_str(by);
    Some(format!(
        "Your superior \"{by}\" changed your configuration (folders, tools, \
charter, or org visibility). Your current scope is stated in your \
system prompt each turn."
    ))
}

// ========================================================================= lifecycle

#[nolog]
fn r_hired(ev: &Value) -> Option<String> {
    let why = if truthy(opt(ev, "why")) { format!(" Role: {}", f(ev, "why")?) } else { String::new() };
    let who = who_cap(&f(ev, "by")?);
    let node = f(ev, "node")?;
    let tier = f(ev, "tier")?;
    if is(req(ev, "relation")?, "report") {
        let grant = py_int(req(ev, "grant")?)?;
        return Some(format!("{who} hired \"{node}\" ({tier}, grant {grant}) under you.{why}"));
    }
    let parent = or_str(opt(ev, "parent"), "the top level");
    Some(format!(
        "{who} hired \"{node}\" ({tier}) alongside you, under \
{parent}.{why}"
    ))
}

#[nolog]
fn r_retired(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let node = f(ev, "node")?;
    let who = if by == USER {
        "the user".to_string()
    } else if by == node {
        "itself (self-retirement)".to_string()
    } else {
        format!("\"{by}\"")
    };
    if is(req(ev, "relation")?, "report") {
        let freed = g(req(ev, "freed")?)?;
        return Some(format!("Your report \"{node}\" was retired by {who} (freed {freed} credits)."));
    }
    Some(format!("Your peer \"{node}\" was retired by {who}."))
}

#[nolog]
fn r_rescinded(ev: &Value) -> Option<String> {
    let node = f(ev, "node")?;
    let clawed = g(req(ev, "clawed")?)?;
    Some(format!(
        "Your report \"{node}\" was RESCINDED by the user: it is archived and \
your grant was reduced by {clawed} — rehiring it (or replacing \
the seat) needs new capacity from above, not the freed headroom."
    ))
}

#[nolog]
fn r_rehired(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let who = who(&by);
    let rel = req(ev, "relation")?;
    if is(rel, "self") {
        let wc = who_cap(&by);
        return Some(format!("{wc} rehired you. You are live again; your prior context is intact."));
    }
    let node = f(ev, "node")?;
    if is(rel, "report") {
        let grant = g(req(ev, "grant")?)?;
        return Some(format!("Your report \"{node}\" was rehired by {who} (grant {grant})."));
    }
    Some(format!("Your peer \"{node}\" was rehired by {who}."))
}

#[nolog]
fn r_dissolved(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let who = who(&by);
    let node = f(ev, "node")?;
    if is(req(ev, "relation")?, "report") {
        let wc = who_cap(&by);
        let nodes = f(ev, "nodes")?;
        let freed = g(req(ev, "freed")?)?;
        return Some(format!(
            "{wc} dissolved your report \"{node}\" and its \
whole suborganization ({nodes} node(s), freed {freed} \
credits)."
        ));
    }
    Some(format!("Your peer \"{node}\" and its suborganization were dissolved by {who}."))
}

#[nolog]
fn r_deleted(ev: &Value) -> Option<String> {
    let extra = py_int(req(ev, "extra")?)?;
    let rel = req(ev, "relation")?;
    let node = f(ev, "node")?;
    if is(rel, "report") {
        let more = if extra != 0 { format!(" and its suborganization ({extra} more node(s))") } else { String::new() };
        return Some(format!(
            "The user permanently DELETED your report \"{node}\"{more}. Its records are gone from the org."
        ));
    }
    Some(format!("Your peer \"{node}\" was permanently deleted by the user."))
}

#[nolog]
fn r_compacted(ev: &Value) -> Option<String> {
    let gen = f(ev, "generation")?;
    let pred = f(ev, "predecessor")?;
    let node = f(ev, "node")?;
    let size = or_str(opt(ev, "size_note"), "");
    if !truthy(req(ev, "auto")?) {
        if is(req(ev, "relation")?, "report") {
            return Some(format!(
                "\"{node}\" compacted (now generation {gen}). Its pre-compaction \
self is archived as \"{pred}\" — rehire it to consult the full \
detail the summary flattened."
            ));
        }
        return Some(format!(
            "You were compacted: you are now generation {gen}, and the context \
you had before it is NOT in your summary in full. Your \
pre-compaction self is archived as \"{pred}\" and is CONSULTABLE — \
orgtree_rehire on that id brings it back as your own subordinate, \
with everything you no longer remember, and you may retire it again \
when done. Reach for it when the answer you need is detail the \
summary flattened rather than something you can rederive."
        ));
    }
    if !truthy(req(ev, "lost")?) {
        if is(req(ev, "relation")?, "report") {
            return Some(format!(
                "\"{node}\" was auto-compacted BY THE CLI (now generation {gen}{size}). \
Its pre-compaction self is preserved as \"{pred}\" — rehire it to \
consult the full detail the summary flattened."
            ));
        }
        return Some(format!(
            "You were auto-compacted by the CLI: you are now generation {gen}, and \
the context you had before it is NOT in your summary in full. Your \
pre-compaction self is archived as \"{pred}\" and is CONSULTABLE — \
orgtree_rehire on that id brings it back as your own subordinate, \
with everything you no longer remember, and you may retire it again \
when done. Reach for it when the answer you need is detail the \
summary flattened rather than something you can rederive."
        ));
    }
    if is(req(ev, "relation")?, "report") {
        return Some(format!(
            "\"{node}\" was auto-compacted BY THE CLI (now generation {gen}{size}). \
Its pre-compaction session could not be preserved — \"{pred}\" is \
recorded as a LOST generation (visible, not consultable)."
        ));
    }
    Some(format!(
        "You were auto-compacted by the CLI: you are now generation {gen} and the \
context you had before it survives only as your summary. There is NO \
consultable bearer in this case — \"{pred}\" is a LOST generation and \
cannot be rehired, so anything the summary dropped is gone. Ask whoever \
gave you the work rather than hunting for a past self."
    ))
}

#[nolog]
fn r_cheap(ev: &Value) -> Option<String> {
    let pred = f(ev, "predecessor")?;
    if is(req(ev, "relation")?, "self") {
        let team = or_str(opt(ev, "team_note"), "");
        let request = or_str(opt(ev, "request_note"), "");
        return Some(format!(
            "You were CHEAP-COMPACTED: your seat, scope, team and budget are \
unchanged, but this session is FRESH — you have NO memory of your \
predecessor's work, and unlike a normal compaction there is no \
summary. Your predecessor's breadcrumbs.md — its realtime log of \
decisions and findings — is spliced into your system prompt when it \
exists (tail-truncated if long), and survives in your working folder: \
keep appending to it yourself. The full transcript is at \
transcript.jsonl beside it; Grep/Read the parts you need instead of \
reading it whole. You may also orgtree_rehire \"{pred}\" as your own \
subordinate to interrogate it directly, and retire it again when \
done.{team}{request}"
        ));
    }
    let by = f(ev, "by")?;
    let who = if by == USER {
        "the user".to_string()
    } else if by == "@system" {
        "the system (auto)".to_string()
    } else {
        by
    };
    let node = f(ev, "node")?;
    Some(format!(
        "Your report \"{node}\" was cheap-compacted by {who}: same seat and \
team, fresh session — its prior self is consultable as \"{pred}\"."
    ))
}

#[nolog]
fn r_reseeded(ev: &Value) -> Option<String> {
    if is(req(ev, "relation")?, "self") {
        let wc = who_cap(&f(ev, "by")?);
        return Some(format!(
            "{wc} re-seeded you after your previous session \
was lost. Your role, charter, credits and reports are intact, but \
your memory starts fresh — check your scratch CLAUDE.md and ask your \
chain to re-orient you."
        ));
    }
    let node = f(ev, "node")?;
    let who = who(&f(ev, "by")?);
    let pred = f(ev, "predecessor")?;
    Some(format!(
        "Your report \"{node}\" was RE-SEEDED by {who}: its \
dead session is archived as \"{pred}\" (a lost generation) \
and it starts fresh — same role, credits and reports, empty memory."
    ))
}

#[nolog]
fn r_recovered(ev: &Value) -> Option<String> {
    let pred = f(ev, "predecessor")?;
    Some(format!(
        "\"{pred}\" is RECOVERED — the generation recorded as lost was \
never actually gone, and it is now a consultable knowledge bearer. \
Rehire it to reach the context that compaction summarized away."
    ))
}

#[nolog]
fn r_phantom(ev: &Value) -> Option<String> {
    let pred = f(ev, "predecessor")?;
    let holder = f(ev, "holder")?;
    Some(format!(
        "The lineage entry \"{pred}\" has been removed: it was a \
PHANTOM. It recorded a generation that never existed — orgtree logged \
its own §8 compaction a second time, as a loss. Every record it named \
is held, in full, by \"{holder}\". Nothing was deleted but a false \
row."
    ))
}

#[nolog]
fn r_unrecoverable(ev: &Value) -> Option<String> {
    let node = f(ev, "node")?;
    let reason = f(ev, "reason")?;
    Some(format!(
        "⚠ Your report \"{node}\" is UNRECOVERABLE — its session failed to \
resume ({reason}). Its seat is still held; rehire it to RE-SEED it \
(fresh session, same identity and credits), or retire it to free the \
credits."
    ))
}

#[nolog]
fn r_bearer_lost(ev: &Value) -> Option<String> {
    let bearer = f(ev, "bearer")?;
    Some(format!(
        "Knowledge bearer \"{bearer}\" lost its transcript and is now a LOST \
generation — it can no longer be consulted; what it held survives only \
in what was already written down."
    ))
}

#[nolog]
fn r_bearer_exhausted(ev: &Value) -> Option<String> {
    let bearer = f(ev, "bearer")?;
    Some(format!(
        "Knowledge bearer \"{bearer}\" has exhausted its headroom and is now \
a PRESERVING ORACLE — it still answers, but exchanges are no longer \
retained by it."
    ))
}

#[nolog]
fn r_handoff(ev: &Value) -> Option<String> {
    let gen = f(ev, "generation")?;
    Some(format!(
        "A handoff record for this boundary is at handoff-g{gen}/\
record.md in your working folder: a citation index of instructions, \
tool calls, artifacts and mail built from files, with line refs into \
transcript.jsonl — not memory, and not evidence that any provider \
context carried over."
    ))
}

#[nolog]
fn r_switched(ev: &Value) -> Option<String> {
    let who = who_cap(&f(ev, "by")?);
    let old = f(ev, "old")?;
    let new = f(ev, "new")?;
    if is(req(ev, "relation")?, "report") {
        let node = f(ev, "node")?;
        return Some(format!("{who} switched \"{node}\" {old}→{new}."));
    }
    let qnote = if truthy(req(ev, "queued")?) {
        " — queued while you were mid-turn, applied when that turn ended"
    } else {
        ""
    };
    let so = g(req(ev, "seat_old")?)?;
    let sn = g(req(ev, "seat_new")?)?;
    let head = format!("{who} switched your model {old}→{new} (seat {so}→{sn}){qnote}. ");
    if !truthy(req(ev, "crossed")?) {
        return Some(format!(
            "{head}Same provider, so this switch keeps your session: your \
conversation resumes under the new model and nothing local was \
lost. One cost to expect: the provider prompt cache is \
namespaced per model (and per account), so your next turn opens \
a fresh cache namespace — a one-time provider-side cold open. \
That is not the same thing as a local restart: your process, \
files and history are untouched, and a local restart by itself \
never means a provider cache miss. If an ACCOUNT move rode \
along with this switch, a separate notice right after this one \
says what that did to your session."
        ));
    }
    let op = f(ev, "old_provider")?;
    let np = f(ev, "new_provider")?;
    let pred = f(ev, "predecessor")?;
    Some(format!(
        "{head}That is a different PROVIDER ({op}→{np}), so \
your conversation could NOT be carried over: this session is FRESH and you \
have no memory of your predecessor's work. Your predecessor is archived as \
\"{pred}\" — its full transcript is at transcript.jsonl beside \
your breadcrumbs.md (Grep/Read the parts you need instead of reading it \
whole), and you may orgtree_rehire \"{pred}\" as your own \
subordinate to interrogate it directly. Your warm process and prompt cache \
are gone with it, so this turn is a cold open and costs far more than a \
normal one — expect it, and do not switch back and forth. Check your scratch \
CLAUDE.md, and your breadcrumbs and mail are untouched; read them to pick up \
where you left off."
    ))
}

#[nolog]
fn r_session_rebound(ev: &Value) -> Option<String> {
    let pred = f(ev, "predecessor")?;
    Some(format!(
        "The ACCOUNT move that rode along with your model switch could not \
carry your session: on your lane a provider account change archives \
the session and starts a fresh one, so your conversation does NOT \
carry over even though the provider did not change. If your context \
shows earlier turns, that is retained REPLAY text, not turns that \
ran — verify anything it claims before building on it. Your \
predecessor is archived as \"{pred}\" — its full \
transcript is at transcript.jsonl beside your breadcrumbs.md, and \
your scratch files, breadcrumbs and mail are untouched. New account \
plus fresh session is also a fresh provider cache namespace, so \
this turn is a cold open — that cost comes from the account move, \
not from any local restart."
    ))
}

#[nolog]
fn r_switch_dropped(ev: &Value) -> Option<String> {
    let node = f(ev, "node")?;
    let target = f(ev, "target")?;
    let reason = f(ev, "reason")?;
    let kept = f(ev, "kept")?;
    Some(format!(
        "the queued switch of {node} to {target} was DROPPED at the \
end of its turn: {reason}. It stays on {kept}; ask \
again once that is resolved."
    ))
}

#[nolog]
fn r_switch_queued(ev: &Value) -> Option<String> {
    let wc = who_cap(&f(ev, "by")?);
    let node = f(ev, "node")?;
    let old = f(ev, "old")?;
    let new = f(ev, "new")?;
    Some(format!(
        "{wc} queued a model switch for \"{node}\": \
{old}→{new}, applied when its current turn ends."
    ))
}

#[nolog]
fn r_switch_cancelled(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let who = if by == USER { "The user".to_string() } else { by };
    let node = f(ev, "node")?;
    let target = f(ev, "target")?;
    Some(format!(
        "{who} cancelled the queued switch of \
\"{node}\" to {target}."
    ))
}

#[nolog]
fn r_swapped(ev: &Value) -> Option<String> {
    let a = f(ev, "a")?;
    let b = f(ev, "b")?;
    let role = req(ev, "role")?;
    let who = who_cap(&f(ev, "by")?);
    if is(role, "parent_of_a") {
        if truthy(req(ev, "nested")?) {
            return Some(format!(
                "{who} swapped the seats of your reports \"{a}\" and \"{b}\" — each \
now leads the other's former team."
            ));
        }
        return Some(format!(
            "{who} seated \"{b}\" in \"{a}\"'s place — \"{b}\" now reports to you, \
leading that seat's team."
        ));
    }
    if is(role, "peer_of_a") {
        if truthy(req(ev, "nested")?) {
            return Some(format!(
                "Your peers \"{a}\" and \"{b}\" swapped seats — each now leads the \
other's former team."
            ));
        }
        return Some(format!("\"{a}\" and \"{b}\" swapped seats — \"{b}\" now holds \"{a}\"'s seat beside you."));
    }
    if is(role, "parent_of_b") {
        return Some(format!("{who} seated \"{a}\" in \"{b}\"'s place — \"{a}\" now reports to you."));
    }
    if is(role, "peer_of_b") {
        return Some(format!("\"{a}\" and \"{b}\" swapped seats — \"{a}\" now holds \"{b}\"'s seat beside you."));
    }
    if is(role, "child_of_a") {
        return Some(format!(
            "Seat change above you: \"{b}\" took over \"{a}\"'s seat. You now report \
to \"{b}\"; your own team, grant and scope are unchanged."
        ));
    }
    if is(role, "child_of_b") {
        return Some(format!(
            "Seat change above you: \"{a}\" took over \"{b}\"'s seat. You now report \
to \"{a}\"; your own team, grant and scope are unchanged."
        ));
    }
    let disp = opt(ev, "reports_to_after");
    let disp_s = if truthy(disp) { format!("\"{}\"", py_str(disp)) } else { "the top level".to_string() };
    let aud = or_str(opt(ev, "audience_note"), "");
    let grant = f(ev, "grant_after")?;
    if is(role, "a") {
        return Some(format!(
            "{who} swapped your seat with \"{b}\": you now report to {disp_s} and \
hold that seat's team, grant ({grant}) and scope; your \
identity, charter and mailbox are unchanged.{aud}"
        ));
    }
    Some(format!(
        "{who} seated you in \"{a}\"'s place: you now report to {disp_s}, lead its \
former team, and hold the seat's grant ({grant}) and scope; \
your identity, charter and mailbox are unchanged.{aud}"
    ))
}

#[nolog]
fn r_subtree_promoted(ev: &Value) -> Option<String> {
    let t = f(ev, "promoted")?;
    let a = f(ev, "demoted")?;
    let role = req(ev, "role")?;
    let who = who_cap(&f(ev, "by")?);
    let disp = opt(ev, "reports_to_after");
    let disp_s = if truthy(disp) { format!("\"{}\"", py_str(disp)) } else { "the top level".to_string() };
    let sub = opt(ev, "subtree");
    let n = if truthy(sub) { py_int(sub)? } else { 0 };
    let team = if n != 0 {
        format!(" It brought its own team ({n} node(s)) with it.")
    } else {
        " It has no reports of its own yet.".to_string()
    };
    Some(if is(role, "new_parent") {
        format!(
            "\"{a}\" stepped down: \"{t}\" now holds its place and reports to \
you, keeping its own team.{team} \"{a}\" now reports to \"{t}\"."
        )
    } else if is(role, "peer") {
        format!(
            "\"{t}\" was promoted into \"{a}\"'s place beside you, keeping \
its own team. \"{a}\" now reports to \"{t}\"."
        )
    } else if is(role, "former_parent") {
        format!(
            "Your report \"{t}\" was promoted out of your team, up to \
{disp_s}, and took its own suborganization with it."
        )
    } else if is(role, "caller_child") {
        format!(
            "\"{t}\" was promoted above your superior \"{a}\". You still \
report to \"{a}\", with your own team, grant and scope \
unchanged — \"{a}\" now reports to \"{t}\"."
        )
    } else if is(role, "target_child") {
        format!(
            "Your superior \"{t}\" was promoted to {disp_s} and you moved \
up with it — you still report to \"{t}\", with your own team, \
grant and scope unchanged."
        )
    } else if is(role, "promoted") {
        format!(
            "{who} promoted you into \"{a}\"'s place: you now report to \
{disp_s} and KEEP YOUR OWN TEAM.{team} \"{a}\" now reports to \
you, keeping the rest of its own reports. Your identity, \
session, charter and mailbox are unchanged. YOUR TEAM \
CHARTER IS YOURS TO WRITE: a promotion does not hand you \
the one \"{a}\" was binding its team with, so if the seat you \
have taken needs a standing instruction, set it yourself \
with orgtree_retool on your own id."
        )
    } else {
        format!(
            "You stepped down: \"{t}\" now holds your former place under \
{disp_s}, with its own team, and you report to it. You keep the \
rest of your own reports, and your identity, session, charter \
and mailbox are unchanged."
        )
    })
}

#[nolog]
fn r_moved(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let who = who(&by);
    let wc = who_cap(&by);
    let tail = or_str(opt(ev, "tail"), "");
    let frm = or_str(opt(ev, "from_parent"), "the top level");
    let to = or_str(opt(ev, "to_parent"), "the top level");
    let node = f(ev, "node")?;
    let role = req(ev, "role")?;
    Some(if is(role, "old_parent") {
        format!("{wc} moved your report \"{node}\" away — it now reports to {to}.{tail}")
    } else if is(role, "old_peer") {
        format!("Your peer \"{node}\" was moved by {who} to under {to}.{tail}")
    } else if is(role, "new_parent") {
        format!("{wc} moved \"{node}\" (from {frm}) to report to you.{tail}")
    } else if is(role, "new_peer") {
        format!("\"{node}\" joined your team (moved by {who} from {frm}).{tail}")
    } else {
        format!(
            "{wc} moved you: you now report to {to} (you were \
under {frm}). Your entire suborganization moved with you."
        )
    })
}

#[nolog]
fn r_inserted(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let who = who(&by);
    let wc = who_cap(&by);
    let node = f(ev, "node")?;
    let target = f(ev, "above")?;
    let role = req(ev, "role")?;
    let p = or_str(opt(ev, "parent"), "the top level");
    if is(role, "parent") {
        return Some(format!(
            "{wc} inserted \"{node}\" above your report \
\"{target}\": \"{node}\" now holds that position and \"{target}\" reports \
to it, keeping its own team."
        ));
    }
    if is(role, "peer") {
        return Some(format!(
            "\"{node}\" joined your team (inserted by {who} above \"{target}\", which \
now reports to it)."
        ));
    }
    if is(role, "target") {
        let gt = f(ev, "grant_target")?;
        return Some(format!(
            "{wc} inserted \"{node}\" directly above you: you \
now report to \"{node}\" instead of {p}, and your entire team, scope \
and remaining grant ({gt}) came with you."
        ));
    }
    if is(role, "child") {
        return Some(format!(
            "\"{target}\" now reports to \"{node}\", inserted above it by {who}. You \
still report to \"{target}\"; your own team, grant and scope are \
unchanged."
        ));
    }
    let gn = f(ev, "grant_new")?;
    let committed = f(ev, "committed")?;
    Some(format!(
        "{wc} placed you in \"{target}\"'s position: you report \
to {p}, \"{target}\" and its whole team now report to YOU, and you hold \
that seat's scope with a grant of {gn} (of which \
{committed} is committed to \"{target}\")."
    ))
}

#[nolog]
fn r_renamed(ev: &Value) -> Option<String> {
    let by = f(ev, "by")?;
    let old = f(ev, "old")?;
    let new_v = req(ev, "new")?;
    let new = py_str(new_v);
    let who = if by == USER { "the user".to_string() } else { by };
    let new_r = py_repr(new_v);
    Some(format!(
        "You have been renamed: {old} → {new} \
(by {who}). \
Sign and refer to yourself as {new_r} from now on."
    ))
}

#[nolog]
fn r_fable_flagged(ev: &Value) -> Option<String> {
    let node = f(ev, "node")?;
    let oc = req(ev, "outcome")?;
    let aud = req(ev, "audience")?;
    let detail = take(&f(ev, "detail")?, 200);
    if is(aud, "user") {
        if is(oc, "autopsy_unavailable") {
            let model = f(ev, "autopsy_model")?;
            let reason = f(ev, "reason")?;
            return Some(format!(
                "A Fable content filter flagged a message from \"{node}\" (auto-autopsy \
configured with model \"{model}\", but that model is \
currently unavailable: {reason}; turn halted). Detail: {detail}"
            ));
        }
        if is(oc, "autopsy") {
            let autopsy = f(ev, "autopsy")?;
            let model = f(ev, "autopsy_model")?;
            let repl = f(ev, "replacement")?;
            return Some(format!(
                "A Fable content filter flagged a message from \"{node}\" (org policy \
applied: auto-autopsy — hired {autopsy} [{model}], \
replacement {repl}). Detail: {detail}"
            ));
        }
        let switched = is(oc, "switched");
        let policy = if switched { "opus" } else { "halt" };
        let retried = if switched { " — retried on opus" } else { "" };
        return Some(format!(
            "A Fable content filter flagged a message from \"{node}\" (org policy \
applied: {policy}{retried}). \
Detail: {detail}"
        ));
    }
    if is(aud, "peer") {
        return Some(format!("Your peer \"{node}\" switched fable→opus (content filter, org policy)."));
    }
    if is(oc, "switched") {
        return Some(format!(
            "Your report \"{node}\" switched fable→opus: a Fable content filter \
flagged its message (org policy). Seat cost dropped 10→5; the flagged \
turn retries on opus."
        ));
    }
    if is(oc, "autopsy_unavailable") {
        let model = f(ev, "autopsy_model")?;
        let reason = f(ev, "reason")?;
        return Some(format!(
            "Your report \"{node}\" had a message FLAGGED by Fable's content filters \
— auto-autopsy model \"{model}\" is unavailable \
({reason}); its turn HALTED (org policy)."
        ));
    }
    if is(oc, "autopsy") {
        let autopsy = f(ev, "autopsy")?;
        let model = f(ev, "autopsy_model")?;
        let repl = f(ev, "replacement")?;
        return Some(format!(
            "Your report \"{node}\" had a message FLAGGED by Fable's content filters. \
Auto-autopsy invoked: hired \"{autopsy}\" ({model}), \
replacement \"{repl}\" (fable), and retired \"{node}\"."
        ));
    }
    Some(format!(
        "Your report \"{node}\" had a message FLAGGED by Fable's content filters — \
its turn HALTED (org policy). Re-task it, or the user may switch the org \
filter policy to auto-convert to opus."
    ))
}

#[nolog]
fn r_weekly(ev: &Value) -> Option<String> {
    let node = f(ev, "node")?;
    let oc = req(ev, "outcome")?;
    let rel = req(ev, "relation")?;
    if is(rel, "user") {
        let conv = opt(ev, "converted");
        let detected = or_str(opt(ev, "detected_at"), "unknown");
        let policy = f(ev, "policy")?;
        let halted = or_str(opt(ev, "halted"), "none");
        let dissolved = or_str(opt(ev, "dissolved"), "none");
        let conv_s = or_str(conv, "none");
        let tail = if truthy(conv) { " — they stay opus until you change them." } else { "." };
        return Some(format!(
            "Weekly Fable usage limit exhausted (detected at \
{detected}; policy: {policy}). \
Halted: {halted}. Dissolved (whole subtrees): \
{dissolved}. Switched to opus: {conv_s}{tail} \
Rehiring a fable yourself, or clearing the lock in settings, \
lifts the freeze."
        ));
    }
    if is(oc, "switched") {
        if is(rel, "self") {
            return Some(
                "Weekly Fable usage limit exhausted: per org policy you now run as \
OPUS. Carry on."
                    .into(),
            );
        }
        return Some(format!(
            "Your report \"{node}\" switched fable→opus: weekly Fable usage limit \
exhausted (org policy). Its seat cost dropped 10→5; it keeps working."
        ));
    }
    if is(oc, "dissolved") {
        if is(rel, "report") {
            let nodes = f(ev, "nodes")?;
            let freed = f(ev, "freed")?;
            return Some(format!(
                "Your report \"{node}\" and its entire suborganization ({nodes} \
node(s)) were dissolved: weekly Fable usage limit exhausted (org \
policy). {freed} credits returned to you."
            ));
        }
        return Some(format!(
            "Your peer \"{node}\" and its suborganization were dissolved (weekly \
Fable limit, org policy)."
        ));
    }
    if is(rel, "self") {
        return Some(
            "Weekly Fable usage limit exhausted: you are halted. Your reports \
remain active."
                .into(),
        );
    }
    if is(rel, "peer") {
        return Some(format!("Your peer \"{node}\" has halted (weekly Fable limit)."));
    }
    Some(format!(
        "Your report \"{node}\" has HALTED: weekly Fable usage limit exhausted. It \
holds its seat and will not run until the limit resets or the user \
intervenes — decide how to cover its work."
    ))
}

#[nolog]
fn r_unlocked(ev: &Value) -> Option<String> {
    if is(req(ev, "relation")?, "self") {
        return Some("The Fable lock was cleared by the user: you are no longer halted. Carry on.".into());
    }
    let node = f(ev, "node")?;
    Some(format!(
        "\"{node}\" is RELEASED from the weekly-Fable halt (the user cleared \
it). It runs again; no need to keep covering its work."
    ))
}

#[nolog]
fn r_limit_reset(ev: &Value) -> Option<String> {
    let rel = req(ev, "relation")?;
    if is(rel, "user") {
        let released = join(req(ev, "released")?, ", ")?;
        return Some(format!(
            "Weekly Fable limit reset — halted fable agent(s) released: \
{released}. Their superiors were told to stop covering."
        ));
    }
    if is(rel, "self") {
        return Some("The weekly Fable limit has reset: you are no longer halted. Carry on.".into());
    }
    let node = f(ev, "node")?;
    Some(format!(
        "\"{node}\" is RELEASED from the weekly-Fable halt — the limit reset. \
It runs again; no need to keep covering its work."
    ))
}

// =========================================================================== monitor

/// A fire body with the one-shot note appended, capped at the mail row's 8000
/// (cut before the note, so the note always survives).
#[nolog]
fn watchdog_once_note(body: &str) -> String {
    let keep = 8000 - WATCHDOG_ONCE_NOTE.chars().count();
    let cut = take(body, keep);
    format!("{}{WATCHDOG_ONCE_NOTE}", cut.trim_end_matches(py_space))
}

#[nolog]
fn r_wd_fired(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let lines_v = req(ev, "lines")?;
    let name = f(o, "name")?;
    let prefix = f(ev, "prefix")?;
    let count_v = req(ev, "count")?;
    let count = py_str(count_v);
    let lines: Vec<String> = match lines_v {
        Value::Array(a) => a.iter().take(20).map(|x| x.as_str().map(|s| take(s, 500))).collect::<Option<_>>()?,
        Value::String(s) => s.chars().take(20).map(String::from).collect(),
        _ => return None,
    };
    let c = num(count_v)?;
    let more = if c > 20.0 {
        let rest = match count_v {
            Value::Number(n) if n.is_f64() => py_float_repr(c - 20.0),
            _ => ((c as i128) - 20).to_string(),
        };
        format!("\n… {rest} more")
    } else {
        String::new()
    };
    let body = format!("[WATCHDOG {name}]{prefix} {count} event(s):\n{}{more}", lines.join("\n"));
    Some(if truthy(req(ev, "once")?) { watchdog_once_note(&body) } else { body })
}

#[nolog]
fn r_wd_quiet(ev: &Value) -> Option<String> {
    let name = f(obj(ev), "name")?;
    let headline = f(ev, "headline")?.to_uppercase();
    let facts = join(req(ev, "facts")?, "\n")?;
    let advice = f(ev, "advice")?;
    Some(format!(
        "[WATCHDOG {name}] ⚠ {headline}\n\n{facts}\n\n{advice}\n\n\
⚠ This is about the THING BEING WATCHED, not about orgtree. Restarts \
and deploys do not produce this message: the counter above only \
advances on checks that actually ran (D-176)."
    ))
}

// ================================================================= runtime / recovery

/// `str(v)[:300] or 'no output'`.
#[nolog]
fn err300(ev: &Value) -> Option<String> {
    let e = take(&f(ev, "err")?, 300);
    Some(if e.is_empty() { "no output".into() } else { e })
}

#[nolog]
fn r_terminal(ev: &Value) -> Option<String> {
    let door = f(ev, "door")?;
    let err = err300(ev)?;
    Some(take(
        &format!(
            "[TURN FAILED TERMINALLY — nothing will retry it]\n\
How it died: {door}\n\
Error: {err}\n\n\
orgtree classified this as NOT retryable and stopped. You were not driven \
for it — if the failure is in your CLI or your environment, another turn \
would die the same way — so this mail is waiting for you rather than \
waking you.\n\n\
⚠ WORK MAY BE UNFINISHED. Anything the dead turn had already done was \
NOT undone; anything it was about to do did not happen. Do not trust your \
own last message as a record of what ran — a turn can announce an edit in \
prose and die before the tool call. Check the disk."
        ),
        8000,
    ))
}

#[nolog]
fn r_repeated(ev: &Value) -> Option<String> {
    let attempts = f(ev, "attempts")?;
    let classified = f(ev, "classified")?;
    let err = err300(ev)?;
    Some(take(
        &format!(
            "[TURN FAILED REPEATEDLY — {attempts} attempts, giving up]\n\
Classified as: {classified}\n\
Last error: {err}\n\n\
orgtree retried this turn automatically and has now stopped. You are no \
longer frozen, so this message is itself a live turn — you are running \
right now.\n\n\
⚠ WORK MAY BE UNFINISHED AND UNSAVED. A turn died part-way through, \
possibly more than once. Anything it had already done — files edited, \
mail sent, commands run — DID happen and was not undone; anything it was \
about to do did not. Before redoing work, CHECK THE ACTUAL STATE: your \
working folder, `git status` if you are in a repo, and your own last \
messages. Then finish what was interrupted, or report that you cannot."
        ),
        8000,
    ))
}

#[nolog]
fn r_stalled(ev: &Value) -> Option<String> {
    let name = f(ev, "report_name")?;
    let nid = f(ev, "report")?;
    let err = err300(ev)?;
    let user = || req(ev, "audience").map(|a| is(a, "user"));
    if is(req(ev, "cause")?, "terminal") {
        let door = || f(ev, "door");
        if user()? {
            let door = door()?;
            return Some(take(
                &format!(
                    "{name} ({nid}) stopped: its turn failed in a way orgtree does not \
retry, and it has no superior to tell.\nHow it died: {door}\n\
Error: {err}\nIt is idle now and nothing will re-drive it. It may \
be holding unfinished work."
                ),
                2000,
            ));
        }
        let door = door()?;
        return Some(take(
            &format!(
                "[REPORT STALLED — {name} ({nid}) is not running]\n\
Its turn failed in a way orgtree does not retry, and nothing will \
re-drive it.\nHow it died: {door}\nError: {err}\n\n\
It has NOT been driven — if the fault is its CLI or its environment, \
waking it would just kill another turn. It is idle now and will stay \
idle until something changes. It may also be holding unfinished work \
from the turn that died.\n\n\
You are the one who can act: fix the cause, or message it once you \
have."
            ),
            8000,
        ));
    }
    let is_user = user()?;
    let attempts = f(ev, "attempts")?;
    let classified = f(ev, "classified")?;
    if is_user {
        return Some(take(
            &format!(
                "{name} ({nid}) is stuck: {attempts} turns in a row failed and \
orgtree has stopped retrying. It has no superior to tell.\n\
Classified as: {classified}\nLast error: {err}\n\
It has been told and driven, so it may recover on its own — but \
nothing will retry it again automatically."
            ),
            2000,
        ));
    }
    Some(take(
        &format!(
            "[REPORT STALLED — {name} ({nid})]\n\
Its turn failed {attempts} times in a row and orgtree has stopped \
retrying.\nClassified as: {classified}\nLast error: {err}\n\n\
It has been told and driven, so it may recover on its own — but it may \
also be holding unfinished or uncommitted work from the turn that died. \
Nothing will retry it again automatically. Check on it."
        ),
        8000,
    ))
}

#[nolog]
fn r_parked(ev: &Value) -> Option<String> {
    let name = f(ev, "report_name")?;
    let nid = f(ev, "report")?;
    let err = or_str(opt(ev, "err"), "no detail");
    let headline = f(ev, "headline")?;
    if is(req(ev, "audience")?, "user") {
        let lane = f(ev, "lane")?;
        return Some(take(
            &format!(
                "{name} ({nid}) {headline} and is stopped with no reset time — \
nothing will wake it, and it has no superior to tell.\n\
Lane: {lane}\nWhat it said: {err}"
            ),
            2000,
        ));
    }
    let detail = f(ev, "detail")?;
    let lane = f(ev, "lane")?;
    Some(take(
        &format!(
            "[REPORT STOPPED — {name} ({nid}) {headline}]\n{detail}\n\n\
Lane: {lane}\nWhat it said: {err}\n\n\
It is not frozen on a timer and orgtree will not re-drive it, so nothing \
changes until someone acts. It may also be holding unfinished work from \
the turn that stopped.\n\n\
You will not hear about it again until it has completed a turn and \
got stuck afresh."
        ),
        8000,
    ))
}

#[nolog]
fn r_limited(ev: &Value) -> Option<String> {
    let name = f(ev, "report_name")?;
    let nid = f(ev, "report")?;
    let until = or_str(opt(ev, "reset_at"), "not known");
    let err = or_str(opt(ev, "err"), "no detail");
    let lane = || f(ev, "lane");
    if is(req(ev, "audience")?, "user") {
        let lane = lane()?;
        return Some(take(
            &format!(
                "{name} ({nid}) is out of provider capacity: its provider refused the \
turn on a usage limit and it is frozen. It has no superior to tell.\n\
Lane: {lane}\nLimit lifts: {until}\nProvider said: {err}"
            ),
            2000,
        ));
    }
    let lane = lane()?;
    Some(take(
        &format!(
            "[REPORT LIMITED — {name} ({nid}) is out of provider capacity]\n\
Its provider refused the turn on a usage limit, so it stopped mid-task \
and is now FROZEN.\nLane: {lane}\nLimit lifts: {until}\n\
Provider said: {err}\n\n\
It is blocked, not broken — the work it was doing is held and will be \
replayed when it runs again. Whether it wakes by itself when the window \
lifts depends on this org's auto-resume setting; ▶ resume works either \
way.\n\n\
You will not hear about this wall again: it is one notice per episode, \
and the next one comes only after it has run a turn and been walled \
afresh. If the work cannot wait for the reset, move it to another \
agent or another lane."
        ),
        8000,
    ))
}

#[nolog]
fn r_subagent(ev: &Value) -> Option<String> {
    let orphans = items(req(ev, "orphans")?)?;
    let mut lines: Vec<String> = Vec::new();
    let mut salvage = false;
    for o in orphans.into_iter().take(20) {
        o.as_object()?;
        let outf = opt(o, "output_file");
        salvage = salvage || truthy(outf);
        let d = f(o, "description")?;
        let id = f(o, "id")?;
        let po = if truthy(outf) { format!("\n  partial output: {}", py_str(outf)) } else { String::new() };
        lines.push(format!("- \"{d}\" (task {id}){po}"));
    }
    let n = py_int(req(ev, "count")?)?;
    let reason = f(ev, "reason")?;
    let more = if n > 20 { format!("\n… and {} more", n - 20) } else { String::new() };
    let tail = if salvage {
        " The partial output files named above are real and may hold most of \
the work — READ THEM before redoing anything."
    } else {
        " Nothing usable was left on disk for these."
    };
    Some(format!(
        "[SUBAGENT DIED — {n} background subagent(s) were killed before \
finishing]\nReason: {reason}\n\n{}{more}\
\n\nNo completion record exists for these — do NOT keep waiting on \
them, and do not assume their work landed.{tail} \
To retry, relaunch — and prefer run_in_background:false, which fails \
loudly instead of silently if it happens again.",
        lines.join("\n")
    ))
}

#[nolog]
fn r_bg_task(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let d = f(o, "description")?;
    let id = f(o, "id")?;
    let summary = if truthy(opt(ev, "summary")) { format!("CLI summary: {}\n", f(ev, "summary")?) } else { String::new() };
    let outf = if truthy(opt(ev, "output_file")) {
        format!("partial output: {}\n", f(ev, "output_file")?)
    } else {
        String::new()
    };
    Some(take(
        &format!(
            "[BACKGROUND TASK STOPPED — \"{d}\" did not complete]\n\
task id: {id}\n\
{summary}{outf}\
\nThe CLI reported that this background task stopped while your \
agent process was still alive. Check the exit code, output and \
actual state before continuing."
        ),
        8000,
    ))
}

/// The `Installed version` line, which never guesses and never blanks out.
#[nolog]
fn installed_version_line(version: &Value, provenance: &Value) -> String {
    match version.as_str() {
        Some(v) if !v.is_empty() => format!("- Installed version: {v}"),
        _ if is(provenance, "source") => "- Installed version: not applicable (running from a source checkout)".into(),
        _ => "- Installed version: unavailable (no packaged build metadata)".into(),
    }
}

#[nolog]
fn build_lines(ev: &Value) -> Option<String> {
    let o = obj(ev);
    let dirty = if truthy(req(o, "dirty")?) { " [DIRTY - uncommitted changes present at boot]" } else { "" };
    let prev = opt(ev, "prev_pid");
    let pid_v = req(o, "pid")?;
    let was = if !prev.is_null() && !py_eq(prev, pid_v) { format!(" (was: {})", py_str(prev)) } else { String::new() };
    let pid = format!("{}{was}", py_str(pid_v));
    let branch = if truthy(opt(ev, "branch")) { format!(", branch: {}", f(ev, "branch")?) } else { String::new() };
    let prov_v = req(o, "provenance")?;
    let version = installed_version_line(opt(ev, "version"), prov_v);
    let commit = f(o, "commit")?;
    let short = f(o, "short")?;
    let prov = py_str(prov_v);
    let started = f(ev, "started_at")?;
    Some(format!(
        "Running build:\n{version}\n\
- Commit: {commit} (short: {short}){dirty}\n\
- Identity provenance: {prov}\n\
- Backend PID: {pid}\n- Started at: {started}{branch}"
    ))
}

#[nolog]
fn r_restart_notice(ev: &Value) -> Option<String> {
    let commit_v = req(obj(ev), "commit")?;
    let ancestry = if is(commit_v, "unknown") {
        "- If you were waiting on or verifying a deployed fix, the running build \
identity is unknown, so no ancestry check can be made."
            .to_string()
    } else {
        format!(
            "- If you were waiting on or verifying a deployed fix, check whether the \
running commit contains your changes with:\n  \
git merge-base --is-ancestor <your-commit> {}",
            py_str(commit_v)
        )
    };
    let build = build_lines(ev)?;
    Some(format!(
        "[ORGTREE RESTART NOTICE] The backend was restarted. This is an \
informational notice delivered to live agents so you know what code \
version went live.\n\n{build}\n\n\
What you can do with this:\n\
{ancestry}\n\
- If you need to be woken immediately with a turn on the NEXT restart, \
call orgtree_restart_wake.\n\
- Otherwise, no action is needed; this notice is for your awareness."
    ))
}

#[nolog]
fn r_token(ev: &Value) -> Option<String> {
    let d = py_float(req(ev, "days")?)?;
    let d = if d > 0.0 { d } else { 0.0 };
    Some(format!(
        "⚠ The Claude subscription's refresh token expires in \
~{d:.1} days. When it lapses, re-login is \
INTERACTIVE and every turn fails until someone signs in — open Claude \
Code on this machine soon, or give the org an API key (settings → \
autonomy)."
    ))
}

#[nolog]
fn r_unread(ev: &Value) -> Option<String> {
    let nid = f(ev, "to")?;
    let b = opt(ev, "boundary_for");
    let waited = f(ev, "waited")?;
    let poll = if truthy(b) {
        format!(", and {nid} has not reported a steering poll for {}", py_str(b))
    } else {
        String::new()
    };
    Some(format!(
        "Your mid-turn message to \"{nid}\" has NOT been read yet — it has been \
waiting {waited} in its steer store. Mid-turn mail is injected when \
the recipient's current tool call returns{poll}. Nothing is lost — it is delivered at that boundary, or at {nid}'s \
next turn if the turn ends first. A safe boundary is requested; \
opaque tools may defer it until they return. The tool is not \
interrupted or repeated to deliver this mail."
    ))
}

#[nolog]
fn r_unroutable(ev: &Value) -> Option<String> {
    let peer = f(ev, "peer")?;
    let excerpt = take(&f(ev, "excerpt")?, 2000);
    Some(format!(
        "Outside party {peer} messaged this org, but no top-level agents \
are live to receive it:\n\n{excerpt}"
    ))
}

// ========================================================================= reminders

/// `_IDLE_ROLE`: what an idle-docket line says about the agent's role on the item.
#[nolog]
fn idle_role(role: &str) -> &'static str {
    match role {
        "deployer" => " — awaiting YOUR authorized deployment/publication action",
        "reviewer" => " — awaiting YOUR review",
        "unassigned_review" => " — NO REVIEWER NAMED: assign one, do not review your own work",
        "stale_reviewer" => " — its named reviewer is no longer live: name another, do not review your own work",
        _ => "",
    }
}

#[nolog]
fn r_idle_docket(ev: &Value) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    for it in items(req(ev, "items")?)? {
        let slug = f(it, "slug")?;
        let status = f(it, "status")?;
        let role = match req(it, "role")? {
            Value::String(s) => idle_role(s),
            Value::Array(_) | Value::Object(_) => return None,
            _ => "",
        };
        let title = f(it, "title")?;
        lines.push(format!("- {slug} ({status}{role}): {title}"));
    }
    let more = py_int(req(ev, "more")?)?;
    if more != 0 {
        lines.push(format!(
            "- …and {more} more item(s) waiting on you; orgtree_work list \
shows them all"
        ));
    }
    Some(format!(
        "[AUTOMATIC IDLE DOCKET REMINDER]\n\
You have been idle for 20 minutes and these docket items are waiting on \
YOU for their next action:\n{}\n\
Pick the work back up: read each one with orgtree_work get, take the \
next concrete step, and leave an honest orgtree_work update. Assert \
review only if an item is really finished; blocked (with a \
blocked_reason) if it truly cannot move; waiting (with a waiting_reason \
naming the external event and how you will hear of it) if its next step \
is not yours to take. Items that are backlogged, already waiting on an \
external event, or waiting on the user through an attention flag or an \
open question are deliberately not listed here — and nor is anything \
whose next action belongs to somebody else.",
        lines.join("\n")
    ))
}

// =================================================================== context / change

#[nolog]
fn r_deep_reach(ev: &Value) -> Option<String> {
    let nid = f(ev, "node")?;
    let gist = f(ev, "gist")?;
    if is(req(ev, "kind")?, "command") {
        return Some(format!(
            "The user ran the session command \"{gist}\" on \"{nid}\", inside your \
chain. It came from the USER directly, not through you. Re-check any \
plan of yours that assumes {nid}'s session is unchanged. You are \
being told, not asked to act."
        ));
    }
    Some(format!(
        "The user gave a direct instruction to \"{nid}\", inside your chain: \
\"{gist}\" — it carries the USER's authority and outranks anything you \
have told {nid}. Re-check any plan of yours that depends on it. You are \
being told, not asked to act."
    ))
}

#[nolog]
fn r_digest(ev: &Value) -> Option<String> {
    let groups = items(req(ev, "groups")?)?;
    let mut members: Vec<Vec<&Value>> = Vec::new();
    for g in &groups {
        members.push(items(req(g, "members")?)?);
    }
    let total: usize = members.iter().map(Vec::len).sum();
    let untyped = req(ev, "untyped")?;
    let extra = if truthy(untyped) {
        format!(", plus {} older untyped notice(s) shown verbatim after them", py_str(untyped))
    } else {
        String::new()
    };
    let mut out = vec![format!(
        "{total} notice(s) since your last turn, grouped by kind — every one is \
listed in full below{extra}:"
    )];
    for (g, ms) in groups.iter().zip(&members) {
        out.push(format!("■ {} · {} × {}", f(g, "variant")?, f(g, "object_kind")?, ms.len()));
        for m in ms {
            let at = f(m, "at")?;
            let text = render(req(m, "event")?)?;
            out.push(format!("  - {at}: {text}"));
        }
    }
    Some(out.join("\n"))
}

// ========================================================================== dispatch

#[nolog]
fn render(ev: &Value) -> Option<String> {
    ev.as_object()?;
    let variant = ev.get("variant")?.as_str()?;
    match variant {
        "ordinary.message" | "ordinary.question" | "ordinary.request" | "ordinary.decision" | "ordinary.status"
        | "ordinary.notice" | "reply.document" | "reply.mail" | "lifecycle.kickoff" => f(ev, "body"),
        "reply.docket" => r_reply_docket(ev),
        "docket.assigned" => r_assigned(ev),
        "docket.review_requested" => r_review_requested(ev),
        "docket.review_seat_requested" => r_review_seat_requested(ev),
        "docket.review_seat_decided" => r_review_seat_decided(ev),
        "docket.review_changes" => r_review_changes(ev),
        "docket.review_approved" => r_review_approved(ev),
        "docket.review_approved_stage" => r_review_approved_stage(ev),
        "docket.participant_added" => r_participant(ev),
        "decision.attention_dismissed" => r_attention(ev),
        "status.report" => r_status(ev),
        "answer.ask" => r_answer(ev),
        "answer.batch" => r_batch(ev),
        "decision.credit" => credit_text(ev),
        "decision.audience" => r_decision_audience(ev),
        "ask.routed" => r_ask_routed(ev),
        "access.scope_requested" => r_scope_requested(ev),
        "access.audience_requested" => r_audience_requested(ev),
        "access.audience_changed" => r_audience_changed(ev),
        "access.grant_changed" => r_grant_changed(ev),
        "access.scope_changed" => r_scope_changed(ev),
        "lifecycle.hired" => r_hired(ev),
        "lifecycle.retired" => r_retired(ev),
        "lifecycle.rescinded" => r_rescinded(ev),
        "lifecycle.rehired" => r_rehired(ev),
        "lifecycle.dissolved" => r_dissolved(ev),
        "lifecycle.deleted" => r_deleted(ev),
        "lifecycle.compacted" => r_compacted(ev),
        "lifecycle.cheap_compacted" => r_cheap(ev),
        "lifecycle.reseeded" => r_reseeded(ev),
        "lifecycle.recovered" => r_recovered(ev),
        "lifecycle.phantom_removed" => r_phantom(ev),
        "lifecycle.unrecoverable" => r_unrecoverable(ev),
        "lifecycle.bearer_lost" => r_bearer_lost(ev),
        "lifecycle.bearer_exhausted" => r_bearer_exhausted(ev),
        "lifecycle.handoff_record" => r_handoff(ev),
        "lifecycle.model_switched" => r_switched(ev),
        "lifecycle.session_rebound" => r_session_rebound(ev),
        "lifecycle.switch_dropped" => r_switch_dropped(ev),
        "lifecycle.switch_queued" => r_switch_queued(ev),
        "lifecycle.switch_cancelled" => r_switch_cancelled(ev),
        "lifecycle.seat_swapped" => r_swapped(ev),
        "lifecycle.subtree_promoted" => r_subtree_promoted(ev),
        "lifecycle.moved" => r_moved(ev),
        "lifecycle.inserted" => r_inserted(ev),
        "lifecycle.renamed" => r_renamed(ev),
        "policy.fable_flagged" => r_fable_flagged(ev),
        "policy.weekly_limit" => r_weekly(ev),
        "policy.unstuck" => Some(
            "The user manually UNSTUCK you (override) — any limit that held you is \
released; continue."
                .into(),
        ),
        "policy.unlocked" => r_unlocked(ev),
        "policy.limit_reset" => r_limit_reset(ev),
        "monitor.watchdog_fired" => r_wd_fired(ev),
        "monitor.watchdog_quiet" => r_wd_quiet(ev),
        "runtime.turn_failed_terminal" => r_terminal(ev),
        "runtime.turn_failed_repeated" => r_repeated(ev),
        "runtime.report_stalled" => r_stalled(ev),
        "runtime.report_parked" => r_parked(ev),
        "runtime.report_limited" => r_limited(ev),
        "runtime.subagent_died" => r_subagent(ev),
        "runtime.background_task_stopped" => r_bg_task(ev),
        "runtime.restart_notice" => r_restart_notice(ev),
        "runtime.token_expiry" => r_token(ev),
        "runtime.delivery_unread" => r_unread(ev),
        "runtime.ui_crash_report" => f(ev, "summary"),
        "runtime.external_unroutable" => r_unroutable(ev),
        "reminder.working_checkup" => Some(CHECKUP.to_string()),
        "reminder.idle_docket" => r_idle_docket(ev),
        "context.deep_reach" => r_deep_reach(ev),
        "context.notice_digest" => r_digest(ev),
        "context.org_state" | "context.provider_usage" | "context.cache_continuity" | "context.org_charter"
        | "context.command" | "context.drive_mail_pointer" | "context.drive_restart_interrupted"
        | "context.drive_restart_wake" => f(ev, "text"),
        _ => None,
    }
}

/// The agent's text for a typed event (3.x `render_agent`): `None` for an
/// unknown variant or for an event the Python renderer would raise on.
#[logged]
pub fn render_agent(ev: &serde_json::Value) -> Option<String> {
    render(ev)
}
