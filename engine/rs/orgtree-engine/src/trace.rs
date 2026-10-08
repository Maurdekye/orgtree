//! The engine log (decision 34): every engine method's calls and returns,
//! each line under its Tokio task id, request id, client and invocation id, in the
//! galaxy-star style:
//!
//! ```text
//! INFO     [2026-10-06 17:36:53.394512] T42 RQ1a2b3c4d user EX5e6f7a8b http.nodes.message@EX0a1b2c3d domain.mail.send(org_id=3, out=…)
//! INFO     [2026-10-06 17:36:53.406871] T42 RQ1a2b3c4d user EX5e6f7a8b domain.mail.send(...) [12.359 ms] -> Ok(Sent { … })
//! ```
//!
//! One file per engine start, named with the start time; rolled over (gzip)
//! daily or at a size limit; files older than 30 days are removed.

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// A line longer than this is brought under it (see `fit`; decision 36).
pub const LINE_CAP: usize = 8 * 1024;
/// Room kept for the line's prefix (level, time, task, request, client, frame, caller).
const PREFIX_ROOM: usize = 256;
/// What the message part of a line may use.
const BUDGET: usize = LINE_CAP - PREFIX_ROOM;
/// How much of a shortened argument stays visible.
pub const ARG_PREVIEW: usize = 160;
/// How much of a shortened return value (or body member) stays visible.
pub const RET_PREVIEW: usize = 240;
/// Console mirror: lines cut to this (the file keeps them whole).
pub const CONSOLE_CAP: usize = 500;
pub const RETENTION_DAYS: u64 = 30;
/// Roll the file over (gzip) past this size, or daily.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Packaged builds are compiled with `ORGTREE_RELEASE_BUILD` set; every
/// other build is a local development build.
pub const RELEASE_BUILD: bool = option_env!("ORGTREE_RELEASE_BUILD").is_some();

/// Verbose logging (galaxy-star's `LOG_VERBOSE`): the call and return line
/// of every logged method, every request's HEADERS line and the settings at
/// startup. Off, a logged method costs one atomic load; REQUEST/RESPONSE
/// lines, warnings and errors are written either way. Off by default in a
/// packaged build, on in a development build; set live from App settings ›
/// Developer (decision 35).
static VERBOSE: AtomicBool = AtomicBool::new(!RELEASE_BUILD);

/// Turn verbose logging on or off; answers the previous state.
pub fn set_verbose(on: bool) -> bool {
    VERBOSE.swap(on, Ordering::Relaxed)
}

pub fn verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// `ORGTREE_LOG_VERBOSE=0|1` fixes verbose logging for this run (the
/// setting is then ignored).
pub fn pinned() -> Option<bool> {
    match std::env::var("ORGTREE_LOG_VERBOSE").as_deref() {
        Ok("0") | Ok("false") | Ok("off") => Some(false),
        Ok("1") | Ok("true") | Ok("on") => Some(true),
        _ => None,
    }
}

/// Apply the stored setting unless the environment pins it.
pub fn apply_verbose(setting: bool) {
    let on = pinned().unwrap_or(setting);
    if set_verbose(on) != on {
        tracing::info!("verbose logging {}", if on { "on" } else { "off" });
    }
}

/// `orgtree_engine::domain::mail::send` → `domain.mail.send`
pub fn dotted(path: &str) -> String {
    path.strip_prefix("orgtree_engine::").unwrap_or(path).replace("::", ".")
}

fn id32() -> u32 {
    rand::random()
}

pub fn kb(n: usize) -> String {
    format!("{:.1} kb", n as f64 / 1024.0)
}

/// The longest prefix of `s` that is at most `n` bytes, on a char boundary.
pub fn cut(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut i = n;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    &s[..i]
}

// ------------------------------------------------------------ requests

/// A new request: the root of everything done for it (HTTP request, agent
/// tool call, actor message, background job). `client` is `user`,
/// `desktop`, `agent:<id>/<name>` or `engine`.
pub fn request(client: &str) -> tracing::Span {
    tracing::span!(target: "call", parent: None, Level::INFO, "request", rq = id32(), client = client)
}

/// The same, recording what caused it (the request that sent an agent a message).
pub fn request_from(client: &str, cause: Option<&str>) -> tracing::Span {
    match cause {
        Some(c) => tracing::span!(target: "call", parent: None, Level::INFO, "request", rq = id32(), client = client, cause = c),
        None => request(client),
    }
}

/// The current request's id (`RQxxxxxxxx`), if any.
pub fn current_rq() -> Option<String> {
    let span = tracing::Span::current();
    span.with_subscriber(|(id, dispatch)| {
        let reg = dispatch.downcast_ref::<tracing_subscriber::Registry>()?;
        let s = reg.span(id)?;
        for s in s.scope() {
            if let Some(r) = s.extensions().get::<ReqInfo>() {
                return Some(format!("RQ{:08x}", r.rq));
            }
        }
        None
    })
    .flatten()
}

/// `agent:<id>/<name>`
pub fn agent_client(id: i64, name: &str) -> String {
    format!("agent:{id}/{name}")
}

// ------------------------------------------------------------ frames

/// One invocation of a logged method (one stack frame): its span carries
/// the invocation id both its call and return lines print.
pub struct Frame {
    span: tracing::Span,
    path: &'static str,
    start: Option<Instant>,
    on: bool,
}

impl Frame {
    pub fn new(path: &'static str) -> Frame {
        if !VERBOSE.load(Ordering::Relaxed) {
            return Frame { span: tracing::Span::none(), path, start: None, on: false };
        }
        let span = tracing::span!(target: "call", Level::INFO, "frame", ex = id32(), m = path);
        let on = !span.is_disabled();
        Frame { span, path, start: Some(Instant::now()), on }
    }
    pub fn on(&self) -> bool {
        self.on
    }
    pub fn span(&self) -> tracing::Span {
        self.span.clone()
    }
    pub fn enter(&self) -> tracing::span::Entered<'_> {
        self.span.enter()
    }
    pub fn call(&self, args: Args) {
        let line = args.line(self.path);
        let _g = self.span.enter();
        tracing::event!(target: "call", Level::INFO, phase = "call", "{}", line);
    }
    pub fn ret(&self, v: Shown) {
        let ms = self.start.map(|s| s.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0);
        let lead = format!("{}(...) [{ms:.3} ms] ", self.path);
        let _g = self.span.enter();
        match v.fail {
            None => {
                let line = v.fit(&format!("{lead}-> "));
                tracing::event!(target: "call", Level::INFO, phase = "ret", "{}", line);
            }
            Some(Fail::Refusal) => {
                let line = v.fit(&format!("{lead}!! "));
                tracing::event!(target: "call", Level::WARN, phase = "ret", "{}", line);
            }
            Some(Fail::Error) => {
                let line = v.fit(&format!("{lead}!! "));
                tracing::event!(target: "call", Level::ERROR, phase = "ret", "{}", line);
            }
        }
    }
}

/// The arguments of one call, rendered.
#[derive(Default)]
pub struct Args {
    items: Vec<(&'static str, Shown)>,
}

impl Args {
    pub fn new() -> Args {
        Args::default()
    }
    pub fn push(&mut self, label: &'static str, v: Shown) {
        self.items.push((label, v.flat()));
    }
    fn line(self, path: &str) -> String {
        let mut slots: Vec<Slot> = self
            .items
            .into_iter()
            .map(|(label, v)| Slot { lead: format!("{label}="), text: v.text, orig: v.orig })
            .collect();
        let fixed = path.len() + 2 + slots.len().saturating_sub(1) * 2;
        fit_slots(&mut slots, fixed, ARG_PREVIEW);
        let mut out = String::with_capacity(LINE_CAP);
        out.push_str(path);
        out.push('(');
        for (i, s) in slots.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            out.push_str(&s.lead);
            out.push_str(&s.text);
        }
        out.push(')');
        finish(out)
    }
}

// ------------------------------------------------------------ fitting a line

struct Slot {
    lead: String,
    text: String,
    /// the value's full size (the text may hold only its start)
    orig: usize,
}

fn line_len(fixed: usize, slots: &[Slot]) -> usize {
    fixed + slots.iter().map(|s| s.lead.len() + s.text.len()).sum::<usize>()
}

/// Bring a line under `LINE_CAP`: first shorten values largest-first to a
/// `preview` with `[rest omitted: x.y kb]`; if that is not enough, replace
/// values largest-first by `[omitted: x.y kb]` (decisions 34 and 36).
fn fit_slots(slots: &mut [Slot], fixed: usize, preview: usize) {
    let mut total = line_len(fixed, slots);
    if total <= BUDGET && slots.iter().all(|s| s.orig == s.text.len()) {
        return;
    }
    let mut order: Vec<usize> = (0..slots.len()).collect();
    order.sort_by(|a, b| slots[*b].orig.cmp(&slots[*a].orig));
    for &i in &order {
        let s = &mut slots[i];
        // a value we hold only the start of is always shortened
        let partial = s.orig > s.text.len();
        if total <= BUDGET && !partial {
            continue;
        }
        let head = cut(&s.text, preview).to_string();
        if head.len() >= s.orig {
            continue;
        }
        let new = format!("{head}[rest omitted: {}]", kb(s.orig - head.len()));
        if new.len() >= s.text.len() && !partial {
            continue;
        }
        total = total - s.text.len() + new.len();
        s.text = new;
    }
    if total <= BUDGET {
        return;
    }
    for &i in &order {
        if total <= BUDGET {
            return;
        }
        let s = &mut slots[i];
        let new = format!("[omitted: {}]", kb(s.orig));
        if new.len() >= s.text.len() {
            continue;
        }
        total = total - s.text.len() + new.len();
        s.text = new;
    }
}

/// `lead` followed by `v`, fitted under the line cap (REQUEST/RESPONSE lines).
pub fn fit_value(lead: &str, v: Shown) -> String {
    v.fit(lead)
}

/// The last resort: a line still over the cap is cut.
fn finish(line: String) -> String {
    if line.len() <= BUDGET {
        return line;
    }
    let total = line.len();
    let head = cut(&line, BUDGET - 40).to_string();
    format!("{head}…[line cut: {} more]", kb(total - head.len()))
}

// ------------------------------------------------------------ values

pub enum Fail {
    /// a refusal the caller sees (4xx, `UserError`)
    Refusal,
    Error,
}

/// One value as the log shows it.
pub struct Shown {
    /// the rendering (at most about one line's worth; `orig` is the full size)
    pub text: String,
    pub orig: usize,
    /// a JSON object or array: its members, shortened one by one if needed
    pub parts: Option<Parts>,
    pub fail: Option<Fail>,
}

pub struct Parts {
    pub open: String,
    pub close: String,
    /// (lead such as `"key":`, rendered value, full size)
    pub items: Vec<(String, String, usize)>,
}

impl Shown {
    pub fn text(s: String) -> Shown {
        let orig = s.len();
        Shown { text: s, orig, parts: None, fail: None }
    }

    fn captured(c: Capture) -> Shown {
        Shown { orig: c.total, text: c.buf, parts: None, fail: None }
    }

    pub fn debug<T: std::fmt::Debug + ?Sized>(v: &T) -> Shown {
        let mut c = Capture::new();
        let _ = write!(c, "{v:?}");
        Shown::captured(c)
    }

    pub fn json(v: &Value) -> Shown {
        Shown::json_wrapped(v, "", "")
    }

    /// `v` inside `pre`/`post` (e.g. `Ok(` … `)`), members kept apart.
    pub fn json_wrapped(v: &Value, pre: &str, post: &str) -> Shown {
        let (open, close, items): (String, String, Vec<(String, String, usize)>) = match v {
            Value::Object(m) if !m.is_empty() => (
                format!("{pre}{{"),
                format!("}}{post}"),
                m.iter()
                    .map(|(k, val)| {
                        let lead = format!("{}:", Value::String(k.clone()));
                        let mut c = Capture::new();
                        if masked(k) {
                            c.push_str("\"*****\"");
                        } else {
                            render(val, &mut c);
                        }
                        (lead, c.buf, c.total)
                    })
                    .collect(),
            ),
            Value::Array(a) if !a.is_empty() => (
                format!("{pre}["),
                format!("]{post}"),
                a.iter()
                    .map(|val| {
                        let mut c = Capture::new();
                        render(val, &mut c);
                        (String::new(), c.buf, c.total)
                    })
                    .collect(),
            ),
            other => {
                let mut c = Capture::new();
                c.push_str(pre);
                render(other, &mut c);
                c.push_str(post);
                return Shown::captured(c);
            }
        };
        let orig = open.len()
            + close.len()
            + items.iter().map(|(l, _, n)| l.len() + n).sum::<usize>()
            + items.len().saturating_sub(1);
        Shown { text: String::new(), orig, parts: Some(Parts { open, close, items }), fail: None }
    }

    pub fn failed(mut self, f: Fail) -> Shown {
        self.fail = Some(f);
        self
    }

    /// One text (an argument is shortened as a whole, not by member).
    fn flat(self) -> Shown {
        let Some(p) = self.parts else { return self };
        let mut c = Capture::new();
        c.push_str(&p.open);
        for (i, (lead, text, orig)) in p.items.iter().enumerate() {
            if i > 0 {
                c.push_str(",");
            }
            c.push_str(lead);
            c.push_str(text);
            // the member may have been held only in part: count the rest
            c.total += orig.saturating_sub(text.len());
        }
        c.push_str(&p.close);
        Shown { text: c.buf, orig: c.total, parts: None, fail: self.fail }
    }

    /// The whole line: `lead` then this value, under the cap.
    fn fit(self, lead: &str) -> String {
        match self.parts {
            None => {
                let mut slots = [Slot { lead: String::new(), text: self.text, orig: self.orig }];
                fit_slots(&mut slots, lead.len(), RET_PREVIEW);
                finish(format!("{lead}{}", slots[0].text))
            }
            Some(p) => {
                let mut slots: Vec<Slot> =
                    p.items.into_iter().map(|(l, t, n)| Slot { lead: l, text: t, orig: n }).collect();
                let fixed = lead.len() + p.open.len() + p.close.len() + slots.len().saturating_sub(1);
                fit_slots(&mut slots, fixed, RET_PREVIEW);
                let mut out = String::with_capacity(LINE_CAP);
                out.push_str(lead);
                out.push_str(&p.open);
                for (i, s) in slots.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&s.lead);
                    out.push_str(&s.text);
                }
                out.push_str(&p.close);
                finish(out)
            }
        }
    }
}

/// Keeps the first ~line's worth of a rendering and counts the rest.
struct Capture {
    buf: String,
    total: usize,
}

impl Capture {
    const KEEP: usize = LINE_CAP + 64;
    fn new() -> Capture {
        Capture { buf: String::new(), total: 0 }
    }
    fn push_str(&mut self, s: &str) {
        self.total += s.len();
        if self.buf.len() < Self::KEEP {
            let room = Self::KEEP - self.buf.len();
            self.buf.push_str(cut(s, room));
        }
    }
}

impl std::fmt::Write for Capture {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.push_str(s);
        // keep counting (the full size goes into the omission tag) but stop
        // formatting enormous values early
        if self.total > 64 * 1024 * 1024 {
            return Err(std::fmt::Error);
        }
        Ok(())
    }
}

/// Field names whose values never reach the log (galaxy-star's list and ours).
fn masked(key: &str) -> bool {
    const KEYS: &[&str] = &[
        "secret", "secret_hash", "password", "passwordhash", "password_hash", "newpassword", "new_password",
        "oldpassword", "old_password", "token", "apikey", "api_key", "kiosktoken", "admintoken", "desktop_token",
        "access_token", "refresh_token", "id_token", "auth_token", "oauth_token", "authorization", "cookie",
        "set-cookie", "x-orgtree-desktop-token", "key", "secret_key", "client_secret", "private_key", "credentials",
        "anthropic_api_key", "openai_api_key", "openrouter_key",
    ];
    let k = key.to_ascii_lowercase();
    KEYS.contains(&k.as_str())
}

/// Compact JSON with sensitive fields masked.
fn render(v: &Value, out: &mut Capture) {
    match v {
        Value::Object(m) => {
            out.push_str("{");
            for (i, (k, val)) in m.iter().enumerate() {
                if i > 0 {
                    out.push_str(",");
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push_str(":");
                if masked(k) {
                    out.push_str("\"*****\"");
                } else {
                    render(val, out);
                }
                if out.total > 64 * 1024 * 1024 {
                    return;
                }
            }
            out.push_str("}");
        }
        Value::Array(a) => {
            out.push_str("[");
            for (i, val) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",");
                }
                render(val, out);
                if out.total > 64 * 1024 * 1024 {
                    return;
                }
            }
            out.push_str("]");
        }
        other => out.push_str(&other.to_string()),
    }
}

/// `alloc::sync::Arc<orgtree_engine::engine::Engine>` → `Arc<Engine>`
pub fn short_type(full: &str) -> String {
    let mut out = String::new();
    let mut seg = String::new();
    for ch in full.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == ':' {
            seg.push(ch);
        } else {
            out.push_str(seg.rsplit("::").next().unwrap_or(""));
            seg.clear();
            out.push(ch);
        }
    }
    out.push_str(seg.rsplit("::").next().unwrap_or(""));
    out
}

/// Rendering by the most specific means a type has (autoref specialization:
/// the macro calls `(&&&&&&&&&Show(&x)).show()`; the impl on the type with
/// the most references wins).
pub mod show {
    use super::{Fail, Shown};
    use serde::Serialize;

    pub struct Show<'a, T: ?Sized>(pub &'a T);

    pub mod prelude {
        pub use super::{L0 as _, L1 as _, L2 as _, L3 as _, L4 as _, L5 as _, L6 as _, L7 as _, L8 as _};
    }

    fn json<T: Serialize + ?Sized>(v: &T, pre: &str, post: &str) -> Shown {
        match serde_json::to_value(v) {
            Ok(j) => Shown::json_wrapped(&j, pre, post),
            Err(e) => Shown::text(format!("<unserializable: {e}>")),
        }
    }

    fn api_fail(e: &crate::http::error::ApiError) -> Fail {
        if e.status.is_server_error() { Fail::Error } else { Fail::Refusal }
    }

    fn api_err(e: &crate::http::error::ApiError) -> Shown {
        Shown::text(format!("{} {}", e.status.as_u16(), e.detail)).failed(api_fail(e))
    }

    fn anyhow_err(e: &anyhow::Error) -> Shown {
        let fail = if e.downcast_ref::<crate::domain::UserError>().is_some() { Fail::Refusal } else { Fail::Error };
        Shown::text(format!("{e:#}")).failed(fail)
    }

    // L8: an HTTP request is its method and URI (never its headers); unit is ()
    pub trait L8 {
        fn show(&self) -> Shown;
    }
    impl<'a> L8 for &&&&&&&&Show<'a, ()> {
        fn show(&self) -> Shown {
            Shown::text("()".into())
        }
    }
    impl<'a> L8 for &&&&&&&&Show<'a, anyhow::Result<()>> {
        fn show(&self) -> Shown {
            match self.0 {
                Ok(()) => Shown::text("Ok(())".into()),
                Err(e) => anyhow_err(e),
            }
        }
    }
    impl<'a, B> L8 for &&&&&&&&Show<'a, http::Request<B>> {
        fn show(&self) -> Shown {
            Shown::text(format!("{} {}", self.0.method(), self.0.uri()))
        }
    }

    // L7: JSON bodies and extractors as JSON
    pub trait L7 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: Serialize> L7 for &&&&&&&Show<'a, Result<axum::Json<T>, crate::http::error::ApiError>> {
        fn show(&self) -> Shown {
            match self.0 {
                Ok(j) => json(&j.0, "Ok(", ")"),
                Err(e) => api_err(e),
            }
        }
    }
    impl<'a, T: Serialize> L7 for &&&&&&&Show<'a, axum::Json<T>> {
        fn show(&self) -> Shown {
            json(&self.0 .0, "", "")
        }
    }
    impl<'a, T: Serialize> L7 for &&&&&&&Show<'a, axum::extract::Path<T>> {
        fn show(&self) -> Shown {
            json(&self.0 .0, "", "")
        }
    }
    impl<'a, T: Serialize> L7 for &&&&&&&Show<'a, axum::extract::Query<T>> {
        fn show(&self) -> Shown {
            json(&self.0 .0, "", "")
        }
    }

    // L6: other API results
    pub trait L6 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: std::fmt::Debug> L6 for &&&&&&Show<'a, Result<T, crate::http::error::ApiError>> {
        fn show(&self) -> Shown {
            match self.0 {
                Ok(v) => Shown::debug(&Ok::<&T, ()>(v)),
                Err(e) => api_err(e),
            }
        }
    }

    // L5/L4: engine results
    pub trait L5 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: Serialize> L5 for &&&&&Show<'a, anyhow::Result<T>> {
        fn show(&self) -> Shown {
            match self.0 {
                Ok(v) => json(v, "Ok(", ")"),
                Err(e) => anyhow_err(e),
            }
        }
    }
    pub trait L4 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: std::fmt::Debug> L4 for &&&&Show<'a, anyhow::Result<T>> {
        fn show(&self) -> Shown {
            match self.0 {
                Ok(v) => Shown::debug(&Ok::<&T, ()>(v)),
                Err(e) => anyhow_err(e),
            }
        }
    }

    // L3: any other result
    pub trait L3 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: std::fmt::Debug, E: std::fmt::Debug> L3 for &&&Show<'a, Result<T, E>> {
        fn show(&self) -> Shown {
            match self.0 {
                Ok(v) => Shown::debug(&Ok::<&T, ()>(v)),
                Err(e) => Shown::debug(e).failed(Fail::Error),
            }
        }
    }

    // L2: anything serializable, as JSON (members shortened one by one)
    pub trait L2 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: Serialize + ?Sized> L2 for &&Show<'a, T> {
        fn show(&self) -> Shown {
            json(self.0, "", "")
        }
    }

    // L1: Debug
    pub trait L1 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: std::fmt::Debug + ?Sized> L1 for &Show<'a, T> {
        fn show(&self) -> Shown {
            Shown::debug(self.0)
        }
    }

    // L0: its type
    pub trait L0 {
        fn show(&self) -> Shown;
    }
    impl<'a, T: ?Sized> L0 for Show<'a, T> {
        fn show(&self) -> Shown {
            Shown::text(format!("<{}>", super::short_type(std::any::type_name::<T>())))
        }
    }
}

// ------------------------------------------------------------ the layer

struct FrameInfo {
    ex: u32,
    path: String,
    caller: Option<(u32, String)>,
}

struct ReqInfo {
    rq: u32,
    client: String,
}

#[derive(Default)]
struct SpanGrab {
    ex: Option<u64>,
    m: Option<String>,
    rq: Option<u64>,
    client: Option<String>,
    cause: Option<String>,
}

impl Visit for SpanGrab {
    fn record_u64(&mut self, f: &Field, v: u64) {
        match f.name() {
            "ex" => self.ex = Some(v),
            "rq" => self.rq = Some(v),
            _ => {}
        }
    }
    fn record_str(&mut self, f: &Field, v: &str) {
        match f.name() {
            "m" => self.m = Some(v.to_string()),
            "client" => self.client = Some(v.to_string()),
            "cause" => self.cause = Some(v.to_string()),
            _ => {}
        }
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        let s = format!("{v:?}").trim_matches('"').to_string();
        match f.name() {
            "m" => self.m = Some(s),
            "client" => self.client = Some(s),
            "cause" => self.cause = Some(s),
            _ => {}
        }
    }
}

#[derive(Default)]
struct EventGrab {
    message: String,
    phase: Option<String>,
    fields: String,
}

impl Visit for EventGrab {
    fn record_str(&mut self, f: &Field, v: &str) {
        match f.name() {
            "message" => self.message.push_str(v),
            "phase" => self.phase = Some(v.to_string()),
            name => {
                let _ = write!(self.fields, " {name}={v}");
            }
        }
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        match f.name() {
            "message" => {
                let _ = write!(self.message, "{v:?}");
            }
            "phase" => self.phase = Some(format!("{v:?}").trim_matches('"').to_string()),
            name => {
                let _ = write!(self.fields, " {name}={v:?}");
            }
        }
    }
}

pub struct EngineLayer {
    file: tracing_appender::non_blocking::NonBlocking,
    /// a dev-run mirror on stderr through its own writer thread (the stderr
    /// handle's mutex would be one lock for every thread)
    console: Option<tracing_appender::non_blocking::NonBlocking>,
}

fn level_name(l: &Level) -> &'static str {
    match *l {
        Level::TRACE => "TRACE",
        Level::DEBUG => "DEBUG",
        Level::INFO => "INFO",
        Level::WARN => "WARNING",
        Level::ERROR => "ERROR",
    }
}

impl<S> Layer<S> for EngineLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut g = SpanGrab::default();
        attrs.record(&mut g);
        let Some(span) = ctx.span(id) else { return };
        if let (Some(ex), Some(m)) = (g.ex, g.m) {
            let caller = span
                .parent()
                .and_then(|p| p.scope().find_map(|s| s.extensions().get::<FrameInfo>().map(|f| (f.ex, f.path.clone()))));
            span.extensions_mut().insert(FrameInfo { ex: ex as u32, path: m, caller });
        }
        if let Some(rq) = g.rq {
            let client = g.client.unwrap_or_else(|| "engine".into());
            if let Some(cause) = &g.cause {
                // a request another one caused says so once, at its start
                let mut line = format!("{:<8} [{}]", "INFO", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.6f"));
                match tokio::task::try_id() {
                    Some(id) => { let _ = write!(line, " T{id}"); }
                    None => line.push_str(" T-"),
                }
                let _ = writeln!(line, " RQ{:08x} {client} begins (caused by {cause})", rq as u32);
                let mut w = self.file.clone();
                let _ = w.write_all(line.as_bytes());
            }
            span.extensions_mut().insert(ReqInfo { rq: rq as u32, client });
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut rq: Option<(u32, String)> = None;
        let mut frame: Option<(u32, Option<(u32, String)>)> = None;
        if let Some(scope) = ctx.event_scope(event) {
            for s in scope {
                let ext = s.extensions();
                if frame.is_none() {
                    if let Some(f) = ext.get::<FrameInfo>() {
                        frame = Some((f.ex, f.caller.clone()));
                    }
                }
                if rq.is_none() {
                    if let Some(r) = ext.get::<ReqInfo>() {
                        rq = Some((r.rq, r.client.clone()));
                    }
                }
                if frame.is_some() && rq.is_some() {
                    break;
                }
            }
        }
        let meta = event.metadata();
        let mut g = EventGrab::default();
        event.record(&mut g);
        let ours = meta.target() == "call";
        let bare = ours || meta.target() == "wire";
        let mut msg = String::with_capacity(g.message.len() + 64);
        if g.phase.as_deref() == Some("call") {
            if let Some((_, Some((cex, cpath)))) = &frame {
                let _ = write!(msg, "{cpath}@EX{cex:08x} ");
            }
        }
        if !bare {
            msg.push_str(&dotted(meta.target()));
            msg.push_str(": ");
        }
        msg.push_str(&g.message);
        msg.push_str(&g.fields);
        let mut prefix = format!("{:<8} [{}]", level_name(meta.level()), chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.6f"));
        // Read the emitting task, not an inherited request span or the writer
        // thread. No logging wrapper here: formatting must not log recursively.
        match tokio::task::try_id() {
            Some(id) => { let _ = write!(prefix, " T{id}"); }
            None => prefix.push_str(" T-"),
        }
        if let Some((rq, client)) = &rq {
            let _ = write!(prefix, " RQ{rq:08x} {client}");
        }
        if let Some((ex, _)) = &frame {
            let _ = write!(prefix, " EX{ex:08x}");
        }
        let mut out = String::with_capacity(prefix.len() + msg.len() + 8);
        for line in msg.split('\n') {
            out.push_str(&prefix);
            out.push(' ');
            out.push_str(line.trim_end_matches('\r'));
            out.push('\n');
        }
        let mut w = self.file.clone();
        let _ = w.write_all(out.as_bytes());
        if let Some(console) = &self.console {
            if !ours && *meta.level() <= Level::INFO {
                let mut short = String::with_capacity(out.len().min(CONSOLE_CAP * 4));
                for line in out.lines() {
                    short.push_str(cut(line, CONSOLE_CAP));
                    short.push('\n');
                }
                let mut w = console.clone();
                let _ = w.write_all(short.as_bytes());
            }
        }
    }
}

// ------------------------------------------------------------ the file

/// `YYYY-MM-DD_HH-MM-SS.log` (the start time), its legacy `.N` backups and
/// the `.log.<32 hex>.gz` archives rollover makes: the files this log owns.
fn owned(name: &str) -> bool {
    let b = name.as_bytes();
    let stamp = b.len() >= 23
        && b[..19].iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'_',
            13 | 16 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
        && &b[19..23] == b".log";
    if !stamp {
        return false;
    }
    // bytes, not str slices: a foreign file name in this folder may put a
    // multi-byte character across these offsets (slicing a str there panics,
    // and this runs at every start)
    let rest = &b[23..];
    rest.is_empty()
        || (rest.len() > 1 && rest[0] == b'.' && rest[1..].iter().all(u8::is_ascii_digit))
        || (rest.len() == 1 + 32 + 3 && rest[0] == b'.' && rest.ends_with(b".gz") && rest[1..33].iter().all(u8::is_ascii_hexdigit))
}

/// Remove owned logs last written before the retention window.
pub fn prune(dir: &Path, active: Option<&Path>) {
    let cutoff = SystemTime::now() - Duration::from_secs(RETENTION_DAYS * 24 * 3600);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if Some(p.as_path()) == active {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if !owned(&name) {
            continue;
        }
        if let Ok(md) = e.metadata() {
            if md.is_file() && md.modified().map(|m| m < cutoff).unwrap_or(false) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// The log file: rolled over daily or at `MAX_FILE_BYTES` (gzip archive
/// beside it, then a fresh file under the same name); never by count.
pub struct LogFile {
    path: PathBuf,
    file: std::fs::File,
    size: u64,
    next_roll: Instant,
}

impl LogFile {
    pub fn open(path: PathBuf) -> std::io::Result<LogFile> {
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(LogFile { path, file, size, next_roll: Instant::now() + Duration::from_secs(24 * 3600) })
    }

    fn roll(&mut self) {
        let _ = self.file.flush();
        let archive = self.path.with_file_name(format!(
            "{}.{}.gz",
            self.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            uuid::Uuid::new_v4().simple()
        ));
        let tmp = archive.with_extension("gz.tmp");
        let ok = (|| -> std::io::Result<()> {
            let mut src = std::fs::File::open(&self.path)?;
            let dst = std::fs::File::create(&tmp)?;
            let mut enc = flate2::write::GzEncoder::new(dst, flate2::Compression::fast());
            std::io::copy(&mut src, &mut enc)?;
            enc.finish()?;
            std::fs::rename(&tmp, &archive)?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&tmp);
        if ok.is_ok() {
            // a failed archive keeps the original: never destroy the log we meant to keep
            if let Ok(f) = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&self.path) {
                self.file = f;
                self.size = 0;
            }
        }
        self.next_roll = Instant::now() + Duration::from_secs(24 * 3600);
        if let Some(dir) = self.path.parent() {
            prune(dir, Some(&self.path));
        }
    }
}

impl std::io::Write for LogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.size > 0 && (self.size + buf.len() as u64 > MAX_FILE_BYTES || Instant::now() >= self.next_roll) {
            self.roll();
        }
        self.file.write_all(buf)?;
        self.size += buf.len() as u64;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

/// Start the log: `<data>\diagnostics\logs\<start time>.log`. Returns the
/// writer guard (flushes on drop) and the file's path.
pub fn init(cfg: &crate::config::Config) -> (Vec<tracing_appender::non_blocking::WorkerGuard>, PathBuf) {
    use tracing_subscriber::prelude::*;
    if let Some(on) = pinned() {
        set_verbose(on);
    }
    let dir = cfg.diagnostics_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.log", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")));
    prune(&dir, Some(&path));
    let file = LogFile::open(path.clone()).unwrap_or_else(|_| {
        LogFile::open(std::env::temp_dir().join("orgtree-engine.log")).expect("no log file can be opened")
    });
    let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(256_000)
        .lossy(true)
        .thread_name("orgtree-log")
        .finish(file);
    let filter = tracing_subscriber::EnvFilter::try_from_env("ORGTREE_LOG").unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("info,tokio_postgres=warn,hyper=warn,hyper_util=warn,h2=warn,reqwest=warn,tower_http=warn,rustls=warn")
    });
    let (console, console_guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .lossy(true)
        .thread_name("orgtree-console")
        .finish(std::io::stderr());
    let layer = EngineLayer { file: writer, console: Some(console) };
    tracing_subscriber::registry().with(layer.with_filter(filter)).init();
    // a daily sweep for long-lived processes that never roll over
    let sweep = dir.clone();
    let active = path.clone();
    std::thread::Builder::new()
        .name("orgtree-log-retention".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(24 * 3600));
            prune(&sweep, Some(&active));
        })
        .ok();
    (vec![guard, console_guard], path)
}

/// `tokio::spawn`, keeping the current request and frame (for short helper
/// tasks that work on behalf of the caller).
pub fn spawn<F>(fut: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(tracing::Instrument::in_current_span(fut))
}
