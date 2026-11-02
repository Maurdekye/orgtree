//! Batch queue submission for orgtree_message: many jobs to one project's
//! mail queue in one call (user 2026-10-28 m2af169f65d89, authorized
//! 2026-11-01 m81708aedacc4). Each job goes out as its own ordinary project
//! mail through `mailtools::send_one`, so reach, dispatch and ACK are
//! exactly a single send's; this module parses the batch sources, renders
//! the rows and reports every row's outcome. The full contract is the
//! orgtree-tool-message glossary leaf.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::mailtools::{send_one, Letter};
use super::{Done, Me};
use crate::domain::UserError;
use crate::engine::Engine;

/// The metadata fields that turn an orgtree_message into a batch.
pub(super) const BATCH_KEYS: &[&str] = &["jobs", "rows", "jobs_file", "batch_key"];

const MAX_JOBS: usize = 1000;
const MAX_JOB_BODY: usize = 256 * 1024;
const MAX_TOTAL_BODY: usize = 8 * 1024 * 1024;
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_ROW_KEYS: usize = 64;
const MAX_KEY_CHARS: usize = 64;
const MAX_BATCH_KEY_CHARS: usize = 128;
/// Rejected rows spelled out in the answer text; the card lists them all.
const TEXT_REJECTS: usize = 20;

/// Does this (flattened) orgtree_message ask for a batch?
#[logged]
pub(super) fn is_batch(args: &Value) -> bool {
    BATCH_KEYS.iter().any(|k| args.get(k).is_some_and(|v| !v.is_null()))
}

#[derive(Debug)]
enum Source {
    Jobs(Vec<Value>),
    Rows(Vec<Value>),
    File(String),
}

#[derive(Debug)]
struct Spec {
    source: Source,
    batch_key: Option<String>,
}

/// The batch fields' own shape, checked before any file or database work.
/// Content problems inside one job or row are not refusals: `render`
/// reports those per row.
#[logged]
fn spec(args: &Value) -> Result<Spec> {
    if args["attachments"].as_array().is_some_and(|a| !a.is_empty()) {
        crate::refuse!(BadRequest, "a batch does not take attachments: each job is one plain queue mail; name file paths in the job body instead");
    }
    if args.get("reply_to").is_some_and(|v| !v.is_null()) || args.get("replies").is_some_and(|v| !v.is_null()) {
        crate::refuse!(BadRequest, "a batch does not take reply_to or replies: jobs are new queue mail (a reply to mail a project handed you is its ack; send that as an ordinary message)");
    }
    if args.get("options").is_some_and(|v| !v.is_null()) || args["multiple"].as_bool() == Some(true) {
        crate::refuse!(BadRequest, "options are for Hubchat questions; a batch goes to a project queue");
    }
    if args["urgent"].as_bool() == Some(true) {
        crate::refuse!(BadRequest, "urgent needs an agent currently in Do Not Disturb; a batch goes to a project queue");
    }
    let given = |k: &str| args.get(k).filter(|v| !v.is_null());
    let sources = ["jobs", "rows", "jobs_file"].iter().filter(|k| given(k).is_some()).count();
    if sources == 0 {
        crate::refuse!(BadRequest, "batch_key names a batch but queues nothing by itself: give jobs, rows or jobs_file");
    }
    if sources > 1 {
        crate::refuse!(BadRequest, "give exactly one batch source: jobs, rows or jobs_file");
    }
    let listed = |k: &str, what: &str| -> Result<Vec<Value>> {
        let Some(a) = given(k).and_then(Value::as_array) else {
            crate::refuse!(BadRequest, "{k} must be an array of {what}");
        };
        if a.is_empty() {
            crate::refuse!(BadRequest, "{k} needs at least one entry");
        }
        if a.len() > MAX_JOBS {
            crate::refuse!(BadRequest, "at most {MAX_JOBS} jobs per batch ({} given); split the batch", a.len());
        }
        Ok(a.clone())
    };
    let source = if given("jobs").is_some() {
        Source::Jobs(listed("jobs", "job-body strings")?)
    } else if given("rows").is_some() {
        Source::Rows(listed("rows", "row objects")?)
    } else {
        let Some(path) = given("jobs_file").and_then(Value::as_str) else {
            crate::refuse!(BadRequest, "jobs_file must be a manifest path string");
        };
        if path.trim().is_empty() {
            crate::refuse!(BadRequest, "jobs_file needs a manifest path");
        }
        Source::File(path.to_string())
    };
    let batch_key = match given("batch_key") {
        None => None,
        Some(v) => {
            let Some(key) = v.as_str() else { crate::refuse!(BadRequest, "batch_key must be a string") };
            if key.is_empty() {
                crate::refuse!(BadRequest, "batch_key cannot be empty; omit it, or name this batch");
            }
            if key.chars().count() > MAX_BATCH_KEY_CHARS {
                crate::refuse!(BadRequest, "batch_key is at most {MAX_BATCH_KEY_CHARS} characters");
            }
            if key.chars().any(char::is_control) {
                crate::refuse!(BadRequest, "batch_key cannot contain control characters");
            }
            Some(key.to_string())
        }
    };
    Ok(Spec { source, batch_key })
}

/// One piece of a parsed job template.
#[derive(Debug, PartialEq)]
enum Seg {
    Lit(String),
    /// A placeholder key and its optional zero-pad width (`{index:03}`).
    Key(String, Option<usize>),
}

/// Parse the body template once, before any row renders: a malformed
/// template refuses the whole call, never half a batch.
#[logged]
fn template(body: &str) -> Result<Vec<Seg>, String> {
    if body.trim().is_empty() {
        return Err("rows need the job template in body, with {key} placeholders for the row values".into());
    }
    let mut segs = Vec::new();
    let mut lit = String::new();
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                lit.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                lit.push('}');
            }
            '{' => {
                let mut inner = String::new();
                let mut closed = false;
                for c2 in chars.by_ref() {
                    if c2 == '}' {
                        closed = true;
                        break;
                    }
                    if c2 == '{' {
                        return Err("the body template has a '{' inside a placeholder".into());
                    }
                    inner.push(c2);
                    if inner.len() > 80 {
                        return Err("a template placeholder is too long".into());
                    }
                }
                if !closed {
                    return Err("the body template has an unclosed '{' placeholder; write {{ for a literal brace".into());
                }
                let (key, pad) = placeholder(&inner)?;
                if !lit.is_empty() {
                    segs.push(Seg::Lit(std::mem::take(&mut lit)));
                }
                segs.push(Seg::Key(key, pad));
            }
            '}' => return Err("the body template has a lone '}'; write }} for a literal brace".into()),
            c => lit.push(c),
        }
    }
    if !lit.is_empty() {
        segs.push(Seg::Lit(lit));
    }
    if !segs.iter().any(|s| matches!(s, Seg::Key(..))) {
        return Err("the body template has no {key} placeholder; every row would queue the same job".into());
    }
    Ok(segs)
}

#[logged]
fn placeholder(inner: &str) -> Result<(String, Option<usize>), String> {
    let (key, pad) = match inner.split_once(':') {
        Some((k, fmt)) => {
            let digits = fmt.strip_prefix('0').filter(|d| d.len() == 1);
            let width = digits.and_then(|d| d.parse::<usize>().ok()).filter(|w| *w > 0)
                .ok_or_else(|| format!("placeholder {{{inner}}}: the only format is :0W zero-padding with W one digit, 1-9 (for example {{index:03}})"))?;
            (k, Some(width))
        }
        None => (inner, None),
    };
    if key.is_empty() || key.chars().count() > MAX_KEY_CHARS
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(format!("placeholder {{{inner}}}: a key is 1-{MAX_KEY_CHARS} letters, digits, '_', '-' or '.'"));
    }
    Ok((key.to_string(), pad))
}

/// A row value as template text; nested values have no text form.
#[logged]
fn stringify(key: &str, v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        _ => Err(format!("value for {{{key}}} must be a string, number or boolean")),
    }
}

/// Render one row. The row's own `index`/`total` win over the batch's.
#[logged]
fn fill(segs: &[Seg], row: &Map<String, Value>, index: usize, total: usize) -> Result<String, String> {
    let mut out = String::new();
    for seg in segs {
        match seg {
            Seg::Lit(l) => out.push_str(l),
            Seg::Key(k, pad) => {
                let v = match row.get(k) {
                    Some(v) => stringify(k, v)?,
                    None if k == "index" => index.to_string(),
                    None if k == "total" => total.to_string(),
                    None => return Err(format!("missing value for {{{k}}}")),
                };
                if let Some(w) = pad {
                    let short = w.saturating_sub(v.chars().count());
                    if short > 0 {
                        out.push_str(&"0".repeat(short));
                    }
                }
                out.push_str(&v);
            }
        }
    }
    Ok(out)
}

#[logged]
fn row_map(v: &Value) -> Result<&Map<String, Value>, String> {
    let Some(m) = v.as_object() else {
        return Err("rows entries must be objects of template values".into());
    };
    if m.len() > MAX_ROW_KEYS {
        return Err(format!("a row has {} keys; at most {MAX_ROW_KEYS}", m.len()));
    }
    if let Some(k) = m.keys().find(|k| k.chars().count() > MAX_KEY_CHARS) {
        return Err(format!("row key '{k}' is over {MAX_KEY_CHARS} characters"));
    }
    Ok(m)
}

/// One manifest entry before the batch's one kind (jobs or rows) is settled.
#[derive(Debug)]
enum Entry {
    Job(String),
    Row(Value),
}

/// Settle a mixed entry list into job candidates: the first usable entry
/// picks the kind, later entries of the other kind are rejected rows.
#[logged]
fn resolve(entries: Vec<(usize, Result<Entry, String>)>, body: &str) -> Result<Vec<(usize, Result<String, String>)>, String> {
    let total = entries.len();
    let rows_mode = entries.iter().find_map(|(_, e)| e.as_ref().ok().map(|en| matches!(en, Entry::Row(_))));
    let Some(rows_mode) = rows_mode else {
        return Ok(entries.into_iter().map(|(r, e)| (r, Err(e.err().unwrap_or_else(|| "unusable entry".into())))).collect());
    };
    let segs = if rows_mode {
        Some(template(body)?)
    } else {
        if !body.trim().is_empty() {
            return Err("with jobs (or a jobs manifest) body must be empty: each job is its own message body; use rows to fill body as a template".into());
        }
        None
    };
    Ok(entries
        .into_iter()
        .map(|(r, e)| {
            let rendered = match (e, &segs) {
                (Err(why), _) => Err(why),
                (Ok(Entry::Job(s)), None) => Ok(s),
                (Ok(Entry::Row(v)), Some(segs)) => row_map(&v).and_then(|m| fill(segs, m, r, total)),
                (Ok(_), _) => Err("the batch mixes job strings and row objects; give one kind".into()),
            };
            (r, rendered)
        })
        .collect())
}

/// The records of a CSV manifest: quoted fields, doubled quotes, commas,
/// CRLF or LF endings; a quote only opens at a field's start.
#[logged]
fn csv_records(text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut records = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        started = true;
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                c => field.push(c),
            }
        } else {
            match c {
                '"' if field.is_empty() => quoted = true,
                ',' => record.push(std::mem::take(&mut field)),
                '\n' => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                    started = false;
                }
                // a CR before LF is the ending; a lone CR ends the record too
                '\r' if chars.peek() != Some(&'\n') => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                    started = false;
                }
                '\r' => {}
                c => field.push(c),
            }
        }
    }
    if quoted {
        return Err("jobs_file ends inside a quoted CSV field".into());
    }
    if started || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    Ok(records)
}

/// A CSV manifest's rows against the body template. The first record names
/// the keys; blank lines between records are skipped, not queued.
#[logged]
fn csv_candidates(text: &str, body: &str) -> Result<Vec<(usize, Result<String, String>)>, String> {
    let segs = template(body)?;
    let mut records = csv_records(text)?.into_iter();
    let Some(headers) = records.next() else {
        return Err("jobs_file is empty".into());
    };
    for (i, h) in headers.iter().enumerate() {
        if h.trim().is_empty() {
            return Err(format!("CSV header {} is empty; every column needs a template key name", i + 1));
        }
        if h.chars().count() > MAX_KEY_CHARS {
            return Err(format!("CSV header '{h}' is over {MAX_KEY_CHARS} characters"));
        }
        if headers[..i].contains(h) {
            return Err(format!("CSV header '{h}' appears twice"));
        }
    }
    let rows: Vec<Vec<String>> = records.filter(|r| !(r.len() == 1 && r[0].is_empty())).collect();
    let total = rows.len();
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(i, fields)| {
            let r = i + 1;
            let rendered = if fields.len() != headers.len() {
                Err(format!("{} fields for {} headers", fields.len(), headers.len()))
            } else {
                let row: Map<String, Value> = headers.iter().cloned().zip(fields.into_iter().map(Value::String)).collect();
                fill(&segs, &row, r, total)
            };
            (r, rendered)
        })
        .collect())
}

/// Every source as (row, body-or-reason) candidates, in submission order.
/// `manifest` is the jobs_file text and its lowercase extension.
#[logged]
fn candidates(spec: &Spec, body: &str, manifest: Option<&(String, String)>) -> Result<Vec<(usize, Result<String, String>)>, String> {
    match &spec.source {
        Source::Jobs(entries) => resolve(
            entries
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    (i + 1, match v {
                        Value::String(s) => Ok(Entry::Job(s.clone())),
                        _ => Err("jobs entries must be strings".into()),
                    })
                })
                .collect(),
            body,
        ),
        Source::Rows(entries) => {
            // a broken template refuses even when every row is broken too
            template(body)?;
            resolve(
                entries
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        (i + 1, if v.is_object() {
                            Ok(Entry::Row(v.clone()))
                        } else {
                            Err("rows entries must be objects of template values".into())
                        })
                    })
                    .collect(),
                body,
            )
        }
        Source::File(_) => {
            let (text, ext) = manifest.ok_or("the manifest was not read")?;
            match ext.as_str() {
                "json" => {
                    let v: Value = serde_json::from_str(text).map_err(|e| format!("jobs_file is not valid JSON: {e}"))?;
                    let Some(a) = v.as_array() else {
                        return Err("a .json manifest must be an array of job strings or row objects".into());
                    };
                    resolve(
                        a.iter()
                            .enumerate()
                            .map(|(i, v)| {
                                (i + 1, match v {
                                    Value::String(s) => Ok(Entry::Job(s.clone())),
                                    Value::Object(_) => Ok(Entry::Row(v.clone())),
                                    _ => Err("manifest entries must be job strings or row objects".into()),
                                })
                            })
                            .collect(),
                        body,
                    )
                }
                "jsonl" | "ndjson" => {
                    let mut entries = Vec::new();
                    for (line_no, line) in text.lines().enumerate() {
                        if line.trim().is_empty() {
                            continue;
                        }
                        let r = entries.len() + 1;
                        let entry = match serde_json::from_str::<Value>(line) {
                            Ok(Value::String(s)) => Ok(Entry::Job(s)),
                            Ok(v @ Value::Object(_)) => Ok(Entry::Row(v)),
                            Ok(_) => Err(format!("line {}: a manifest line must be a job string or a row object", line_no + 1)),
                            Err(e) => Err(format!("line {}: not valid JSON ({e})", line_no + 1)),
                        };
                        entries.push((r, entry));
                    }
                    resolve(entries, body)
                }
                "csv" => csv_candidates(text, body),
                _ => {
                    if !body.trim().is_empty() {
                        return Err("a lines manifest queues each line as its own job and takes no template; use a .json, .jsonl or .csv manifest for rows".into());
                    }
                    Ok(text
                        .lines()
                        .enumerate()
                        .filter(|(_, l)| !l.is_empty())
                        .map(|(i, l)| (i + 1, Ok(l.to_string())))
                        .collect())
                }
            }
        }
    }
}

/// What a rendered batch holds: jobs to send and rows already rejected.
#[derive(Debug, Default)]
struct Rendered {
    jobs: Vec<(usize, String)>,
    rejected: Vec<(usize, String)>,
}

/// Render and bound the whole batch before anything is sent.
#[logged]
fn render(spec: &Spec, body: &str, manifest: Option<&(String, String)>) -> Result<Rendered, String> {
    let cands = candidates(spec, body, manifest)?;
    if cands.is_empty() {
        return Err("the batch has no jobs".into());
    }
    if cands.len() > MAX_JOBS {
        return Err(format!("at most {MAX_JOBS} jobs per batch ({} given); split the batch", cands.len()));
    }
    let mut out = Rendered::default();
    let mut total = 0usize;
    for (r, cand) in cands {
        match cand {
            Err(why) => out.rejected.push((r, why)),
            Ok(b) if b.trim().is_empty() => out.rejected.push((r, "the job body is blank".into())),
            Ok(b) if b.len() > MAX_JOB_BODY => {
                out.rejected.push((r, format!("the job body is {} bytes, over the {} KiB per-job cap", b.len(), MAX_JOB_BODY / 1024)))
            }
            Ok(b) => {
                total += b.len();
                out.jobs.push((r, b));
            }
        }
    }
    if total > MAX_TOTAL_BODY {
        return Err(format!("the batch renders {total} bytes of job bodies, over the {} MiB per-batch cap; split the batch", MAX_TOTAL_BODY / (1024 * 1024)));
    }
    Ok(out)
}

/// The mail `client_op` stamping one batch job, so a retried batch_key
/// finds it (migration 0081 indexes the lookup). Scoped to the sender and
/// the project: the same key on another queue is another batch.
#[logged]
fn client_op(org_id: i64, sender: i64, project: i64, key: &str, row: usize) -> String {
    let digest = hex::encode(Sha256::digest(format!("orgtree-batch:{org_id}:{sender}:{project}:{key}").as_bytes()));
    format!("b1:{}:{row}", &digest[..32])
}

/// Read a jobs_file manifest under the caller's folder authority, the same
/// check an attachment path gets. Returns its text and lowercase extension.
#[logged]
async fn read_manifest(engine: &Arc<Engine>, me: &Me, raw: &str) -> Result<(String, String)> {
    let org = engine.orgs.by_id(me.org_id).ok_or_else(|| anyhow::anyhow!("organization not open"))?;
    let presenter = crate::domain::docs::presenter(engine, &org, me.id).await?;
    let path = crate::domain::docs::readable(&presenter, raw)?;
    if !path.is_file() {
        crate::refuse!(BadRequest, "jobs_file is not a file");
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        use std::io::Read;
        let mut buf = Vec::new();
        std::fs::File::open(&path)?.take(MAX_MANIFEST + 1).read_to_end(&mut buf)?;
        Ok(buf)
    })
    .await??;
    if bytes.len() as u64 > MAX_MANIFEST {
        crate::refuse!(BadRequest, "jobs_file is over the {} MiB manifest cap", MAX_MANIFEST / (1024 * 1024));
    }
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => crate::refuse!(BadRequest, "jobs_file must be UTF-8 text"),
    };
    let text = text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text);
    Ok((text, ext))
}

/// One row's final state in a submitted batch.
#[derive(Debug)]
enum Outcome {
    Queued(String),
    Already(String),
    Rejected(String),
}

/// Submit the batch: render everything, skip what this batch_key already
/// queued, then send each remaining job in order as its own project mail.
/// A recipient-level refusal stops the batch (the rest are reported, not
/// tried one by one); a job-level refusal rejects only its row.
#[logged]
pub(super) async fn submit(
    engine: &Arc<Engine>, me: Me, to: &str, single: bool, args: &Value,
    kind: &str, notice: bool, one_time: bool, tags: Vec<String>,
) -> Result<Done> {
    if !tags.is_empty() {
        crate::refuse!(BadRequest, "a batch does not take tags: tags are only on mail to the user, and a batch goes to one project queue");
    }
    let spec = spec(args)?;
    if !single {
        crate::refuse!(BadRequest, "a batch goes to exactly one project: name one recipient in to");
    }
    let bare = to.trim().trim_start_matches('@');
    if bare == "user" || bare.starts_with("org:") || bare.starts_with("net:") {
        crate::refuse!(BadRequest, "a batch goes to one project's mail queue in this organization; {to} is not a project here");
    }
    let body = args.get("body").and_then(Value::as_str).unwrap_or("");
    let client = engine.db.get().await?;
    let target = super::target(&client, me.org_id, to).await?;
    if target.kind != crate::domain::projects::KIND {
        crate::refuse!(BadRequest, "{} is an agent, not a project: a batch queues jobs on one project's mail queue", target.name);
    }
    if target.state != "live" {
        crate::refuse!(Conflict, "project {} is retired: nothing was sent", target.name);
    }
    let manifest = match &spec.source {
        Source::File(path) => Some(read_manifest(engine, &me, path).await?),
        _ => None,
    };
    let rendered = match render(&spec, body, manifest.as_ref()) {
        Ok(r) => r,
        Err(why) => crate::refuse!(BadRequest, "{why}"),
    };
    // jobs this batch_key already queued on this project, by derived client_op:
    // only the project's own mailbox rows count, not copies handed to watchers
    let mut already: BTreeMap<usize, String> = BTreeMap::new();
    if let Some(key) = &spec.batch_key {
        if !rendered.jobs.is_empty() {
            let ops: Vec<String> = rendered.jobs.iter().map(|(r, _)| client_op(me.org_id, me.id, target.id, key, *r)).collect();
            let rows = client
                .query(
                    "SELECT uid, client_op FROM ot.mail
                      WHERE org_id = $1 AND sender_agent_id = $2 AND recipient_agent_id = $3 AND client_op = ANY($4)",
                    &[&me.org_id, &me.id, &target.id, &ops],
                )
                .await?;
            let by_op: BTreeMap<String, String> = rows.iter().map(|r| (r.get::<_, String>(1), r.get::<_, String>(0))).collect();
            for (r, _) in &rendered.jobs {
                if let Some(uid) = by_op.get(&client_op(me.org_id, me.id, target.id, key, *r)) {
                    already.insert(*r, uid.clone());
                }
            }
        }
    }
    drop(client);
    let org_id = me.org_id;
    let sender = me.id;
    let mut letter = Letter {
        tags: Vec::new(),
        me,
        body: String::new(),
        kind: kind.to_string(),
        notice,
        one_time,
        urgent_reason: None,
        attachments: Vec::new(),
        reply: None,
        replies: Vec::new(),
        client_op: None,
    };
    let mut outcomes: BTreeMap<usize, Outcome> = rendered.rejected.into_iter().map(|(r, why)| (r, Outcome::Rejected(why))).collect();
    let mut first_delivery: Option<String> = None;
    let total_rows = rendered.jobs.len() + outcomes.len();
    let mut stopped: Option<String> = None;
    for (r, job) in &rendered.jobs {
        if let Some(uid) = already.get(r) {
            outcomes.insert(*r, Outcome::Already(uid.clone()));
            continue;
        }
        if let Some(why) = &stopped {
            outcomes.insert(*r, Outcome::Rejected(format!("batch stopped: {why}")));
            continue;
        }
        letter.body = job.clone();
        letter.client_op = spec.batch_key.as_ref().map(|k| client_op(org_id, sender, target.id, k, *r));
        match send_one(engine, &letter, to, false, None).await {
            Ok(d) => {
                if first_delivery.is_none() {
                    first_delivery = Some(d.delivery.clone());
                }
                outcomes.insert(*r, Outcome::Queued(d.uid));
            }
            Err(e) => {
                let user = e.downcast_ref::<UserError>();
                let reason = match user {
                    Some(u) => u.to_string(),
                    None => format!("failed: {e}"),
                };
                // a BadRequest is about this job; anything else is about the
                // recipient or the engine, so later rows are not tried
                if !matches!(user, Some(UserError::BadRequest(_))) {
                    stopped = Some(reason.clone());
                }
                outcomes.insert(*r, Outcome::Rejected(reason));
            }
        }
    }
    let (mut queued, mut already_n, mut rejected) = (0usize, 0usize, 0usize);
    let mut mails = Vec::new();
    let mut jobs_json = Vec::new();
    let mut reject_lines = Vec::new();
    for (r, o) in &outcomes {
        match o {
            Outcome::Queued(id) => {
                queued += 1;
                mails.push(json!({ "id": id, "to": target.name, "transfer_ids": [] }));
                jobs_json.push(json!({ "row": r, "status": "queued", "id": id }));
            }
            Outcome::Already(id) => {
                already_n += 1;
                mails.push(json!({ "id": id, "to": target.name, "transfer_ids": [] }));
                jobs_json.push(json!({ "row": r, "status": "already_queued", "id": id }));
            }
            Outcome::Rejected(why) => {
                rejected += 1;
                reject_lines.push(format!("- row {r}: {why}"));
                jobs_json.push(json!({ "row": r, "status": "rejected", "reason": why }));
            }
        }
    }
    let mut text = format!("Queued {queued} of {total_rows} jobs to project {}'s mail queue", target.name);
    if already_n > 0 {
        text.push_str(&format!(" ({already_n} already queued under this batch_key, not resent)"));
    }
    text.push('.');
    if let Some(d) = &first_delivery {
        text.push_str(&format!(" First job: {d}"));
    }
    if rejected > 0 {
        text.push_str(&format!("\nRejected rows ({rejected}):\n{}", reject_lines[..reject_lines.len().min(TEXT_REJECTS)].join("\n")));
        if reject_lines.len() > TEXT_REJECTS {
            text.push_str(&format!("\n- ...and {} more; every row is in the result card.", reject_lines.len() - TEXT_REJECTS));
        }
    }
    if queued + already_n == 0 {
        crate::refuse!(Forbidden, "{text}");
    }
    let first = mails[0].clone();
    Ok(Done {
        text,
        card: Some(json!({
            "mail": first,
            "mails": mails,
            "batch": {
                "to": target.name,
                "queued": queued,
                "already_queued": already_n,
                "rejected": rejected,
                "batch_key": spec.batch_key,
                "jobs": jobs_json,
            },
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(args: Value) -> Rendered {
        let s = spec(&args).unwrap();
        render(&s, args.get("body").and_then(Value::as_str).unwrap_or(""), None).unwrap()
    }

    fn file_rendered(text: &str, ext: &str, body: &str) -> Rendered {
        let s = spec(&json!({"to": "queue-proj", "jobs_file": format!("manifest.{ext}")})).unwrap();
        render(&s, body, Some(&(text.to_string(), ext.to_string()))).unwrap()
    }

    #[test]
    fn jobs_render_in_order_and_blank_or_typed_entries_are_rejected_rows() {
        let r = rendered(json!({"to": "queue-proj", "jobs": ["first", "  ", 42, "last"], "body": ""}));
        assert_eq!(r.jobs, vec![(1, "first".to_string()), (4, "last".to_string())]);
        assert_eq!(r.rejected.len(), 2);
        assert_eq!(r.rejected[0].0, 2);
        assert!(r.rejected[0].1.contains("blank"), "{}", r.rejected[0].1);
        assert_eq!(r.rejected[1].0, 3);
        assert!(r.rejected[1].1.contains("strings"), "{}", r.rejected[1].1);
    }

    #[test]
    fn rows_fill_the_template_with_index_total_padding_and_escapes() {
        let r = rendered(json!({
            "to": "queue-proj",
            "rows": [{"sha": "abc123", "subject": "Fix it"}, {"sha": "def456", "subject": "Ship it"}],
            "body": "JOB {index:03}/{total} sha: {sha} subject: {subject} {{literal}}"
        }));
        assert_eq!(
            r.jobs,
            vec![
                (1, "JOB 001/2 sha: abc123 subject: Fix it {literal}".to_string()),
                (2, "JOB 002/2 sha: def456 subject: Ship it {literal}".to_string()),
            ]
        );
        assert!(r.rejected.is_empty());
    }

    #[test]
    fn row_missing_a_key_or_holding_a_nested_value_is_a_rejected_row() {
        let r = rendered(json!({
            "to": "queue-proj",
            "rows": [{"sha": "abc"}, {"other": 1}, {"sha": ["x"]}],
            "body": "Review {sha}"
        }));
        assert_eq!(r.jobs, vec![(1, "Review abc".to_string())]);
        assert!(r.rejected[0].1.contains("missing value for {sha}"), "{}", r.rejected[0].1);
        assert!(r.rejected[1].1.contains("must be a string, number or boolean"), "{}", r.rejected[1].1);
    }

    #[test]
    fn a_rows_own_index_wins_over_the_batchs() {
        let r = rendered(json!({"to": "queue-proj", "rows": [{"index": "custom"}], "body": "At {index} of {total}"}));
        assert_eq!(r.jobs, vec![(1, "At custom of 1".to_string())]);
    }

    #[test]
    fn malformed_templates_refuse_before_any_row() {
        for body in ["", "no placeholders", "open {sha", "lone } brace", "bad {sha:nope}", "bad {two words}"] {
            let s = spec(&json!({"to": "queue-proj", "rows": [{"sha": "x"}]})).unwrap();
            assert!(render(&s, body, None).is_err(), "template {body:?} must refuse");
        }
    }

    #[test]
    fn spec_refuses_mixed_sources_batch_only_fields_and_bad_keys() {
        for args in [
            json!({"to": "p", "batch_key": "k"}),
            json!({"to": "p", "jobs": ["a"], "rows": [{}]}),
            json!({"to": "p", "jobs": ["a"], "attachments": ["f.txt"]}),
            json!({"to": "p", "jobs": ["a"], "reply_to": "m1"}),
            json!({"to": "p", "jobs": ["a"], "urgent": true, "urgent_reason": "now"}),
            json!({"to": "p", "jobs": ["a"], "batch_key": ""}),
            json!({"to": "p", "jobs": []}),
        ] {
            assert!(spec(&args).is_err(), "{args} must refuse");
        }
        assert!(spec(&json!({"to": "p", "jobs": ["a"], "batch_key": "release-4.5.5"})).is_ok());
    }

    #[test]
    fn jobs_with_a_body_refuse_since_each_job_is_its_own_body() {
        let s = spec(&json!({"to": "p", "jobs": ["a"]})).unwrap();
        assert!(render(&s, "also this", None).unwrap_err().contains("body must be empty"));
    }

    #[test]
    fn json_and_jsonl_manifests_carry_jobs_or_rows_and_report_bad_lines() {
        let r = file_rendered("[\"one\", \"two\"]", "json", "");
        assert_eq!(r.jobs.len(), 2);
        let r = file_rendered("[{\"sha\": \"a\"}, {\"sha\": \"b\"}]", "json", "Review {sha} ({index}/{total})");
        assert_eq!(r.jobs[1], (2, "Review b (2/2)".to_string()));
        let r = file_rendered("\"one\"\nnot json\n{\"sha\": \"x\"}\n", "jsonl", "");
        assert_eq!(r.jobs, vec![(1, "one".to_string())]);
        assert_eq!(r.rejected.len(), 2);
        assert!(r.rejected[0].1.contains("line 2"), "{}", r.rejected[0].1);
        assert!(r.rejected[1].1.contains("mixes"), "{}", r.rejected[1].1);
    }

    #[test]
    fn csv_manifests_quote_and_count_fields() {
        let text = "sha,subject\r\nabc,\"Fix, carefully\"\r\ndef,\"Say \"\"hi\"\"\"\r\nonlyonefield\r\n";
        let r = file_rendered(text, "csv", "{index}: {sha} {subject}");
        assert_eq!(
            r.jobs,
            vec![(1, "1: abc Fix, carefully".to_string()), (2, "2: def Say \"hi\"".to_string())]
        );
        assert_eq!(r.rejected.len(), 1);
        assert!(r.rejected[0].1.contains("1 fields for 2 headers"), "{}", r.rejected[0].1);
    }

    #[test]
    fn a_lines_manifest_skips_blank_lines_and_keeps_line_numbers() {
        let r = file_rendered("first\n\nthird\n", "txt", "");
        assert_eq!(r.jobs, vec![(1, "first".to_string()), (3, "third".to_string())]);
    }

    #[test]
    fn count_and_size_caps_are_enforced() {
        let many: Vec<Value> = (0..1001).map(|i| json!(format!("job {i}"))).collect();
        assert!(spec(&json!({"to": "p", "jobs": many})).is_err());
        let big = "x".repeat(MAX_JOB_BODY + 1);
        let r = rendered(json!({"to": "p", "jobs": [big], "body": ""}));
        assert!(r.jobs.is_empty());
        assert!(r.rejected[0].1.contains("per-job cap"), "{}", r.rejected[0].1);
    }

    #[test]
    fn client_op_is_stable_per_batch_and_distinct_per_row_and_project() {
        let a = client_op(1, 2, 3, "release", 7);
        assert_eq!(a, client_op(1, 2, 3, "release", 7));
        assert_ne!(a, client_op(1, 2, 3, "release", 8));
        assert_ne!(a, client_op(1, 2, 4, "release", 7));
        assert_ne!(a, client_op(1, 9, 3, "release", 7));
        assert!(a.len() <= 200, "client_op keeps the desktop column's cap: {a}");
    }
}
