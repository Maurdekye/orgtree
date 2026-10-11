//! The Language Server lane's pass-through. A harness on the lane is pointed
//! at `http://127.0.0.1:<engine port>/ls/<server id>` and sends this boot's
//! pass-through secret as its key; the engine hands each request on to the
//! server (its own key, or the lane's placeholder, replaces the secret, so
//! the CLI never holds the server's key) with the conversation in the shape
//! a strict chat template accepts: ONE system message, first, then user and
//! assistant turns that alternate. The answer streams back unchanged.
//!
//! Why (live bug 2026-10-10, 4.2.0-alpha.5, llama.cpp + Qwen 3.8): Claude
//! Code 2.1.x sends `role: "system"` messages inside `messages` (its
//! environment block, the token budget after each tool result), and the
//! model's template raises "System message must be at the beginning". Codex
//! sends its developer instructions as a second leading message, and its
//! environment context and the prompt as two user messages in a row.
//!
//! A template that still refuses a request answers 400 here, with the
//! server's own words: a template refuses the same conversation on every
//! retry, so neither the CLI nor the engine should retry it.
//!
//! Compaction (live bug 2026-10-11, alpha.7, the same server with a 64K
//! window): a CLI asks the model for a summary of the conversation when its
//! context fills, and a local model answered without text (it called one of
//! the offered tools, or thought until the window ran out), which both CLIs
//! count as a failed compaction. A summary request goes on without tools,
//! without earlier thinking, with reasoning off where the server is known to
//! honour that, and with long tool outputs shortened when it would take more
//! than 3/5 of the window. A server's refusal of a request longer than its
//! window is answered in the words each CLI compacts on (Anthropic's "prompt
//! is too long: N tokens > M maximum", OpenAI's context_length_exceeded).

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};

use crate::engine::Engine;

const PREFIX: &str = "/ls/";
/// the largest request body the pass-through holds (images ride in base64)
const MAX_BODY: usize = 256 << 20;
/// an error answer is read whole (up to this) to recognise a template error
const MAX_ERROR: usize = 1 << 20;

/// This boot's pass-through secret: the key every harness on the lane sends.
#[nolog]
pub fn secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| format!("orgtree-ls-{}", uuid::Uuid::new_v4().simple()))
}

/// The base URL a harness on `server` is pointed at: the CLI appends its
/// own path (`/v1/messages`, `/responses`), which is handed on after the
/// server's own base URL.
#[logged]
pub fn base(engine: &Engine, server: &str) -> String {
    format!("http://127.0.0.1:{}{PREFIX}{server}", engine.boot.port)
}

#[nolog]
pub fn route(path: &str) -> bool {
    path.starts_with(PREFIX)
}

/// The whole route bypasses the API's token and its body tracing: its
/// requests carry prompts and keys. One log line per request instead.
#[nolog]
pub async fn dispatch(State(engine): State<Arc<Engine>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let rest = &path[PREFIX.len()..];
    let (server_id, tail) = rest.find('/').map_or((rest, ""), |i| (&rest[..i], &rest[i..]));
    if !authorized(&parts.headers) {
        return error(StatusCode::UNAUTHORIZED, tail,
            "this address is Orgtree's language-server pass-through: it takes requests only from the agents Orgtree launches");
    }
    let Some(server) = crate::langserver::server(&engine, server_id) else {
        return error(StatusCode::NOT_FOUND, tail, &format!("no language server {server_id} in App settings › Providers"));
    };
    let label = server["label"].as_str().unwrap_or(server_id).to_string();
    let query = parts.uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}{tail}{query}", crate::langserver::base_url(&server));
    let bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(e) => return error(StatusCode::PAYLOAD_TOO_LARGE, tail, &format!("the request could not be read: {e}")),
    };
    let (bytes, normalized, assist) = if parts.method == Method::POST {
        prepare(tail, bytes, &server)
    } else {
        (bytes, false, None)
    };
    if let Some(a) = &assist {
        tracing::info!(server = %server_id, path = %tail, tools = a.tools, thinking = a.thinking, shortened = a.shortened,
            chars_before = a.chars.0, chars_after = a.chars.1, thinking_off = a.thinking_off,
            "language-server pass-through: a summary request (compaction), reshaped for a local model");
    }
    let key = crate::langserver::key(&engine, server_id).await.unwrap_or_else(|| crate::langserver::NO_KEY.to_string());
    let mut headers = HeaderMap::new();
    for (name, value) in parts.headers.iter().filter(|(n, _)| forwardable(n)) {
        headers.append(name.clone(), value.clone());
    }
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {key}")) {
        headers.insert(header::AUTHORIZATION, v);
    }
    let sent = client().request(parts.method.clone(), &target).headers(headers).body(bytes).send().await;
    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(server = %server_id, path = %tail, error = %e, "language-server pass-through: no answer");
            return error(StatusCode::BAD_GATEWAY, tail, &format!("the language server {label} did not answer: {e}"));
        }
    };
    let status = resp.status();
    tracing::info!(server = %server_id, method = %parts.method, path = %tail, status = status.as_u16(), normalized,
        "language-server pass-through");
    let mut back = HeaderMap::new();
    for (name, value) in resp.headers().iter().filter(|(n, _)| forwardable(n)) {
        back.append(name.clone(), value.clone());
    }
    if status.is_client_error() || status.is_server_error() {
        let body = read_capped(resp, MAX_ERROR).await;
        let text = String::from_utf8_lossy(&body);
        if status.is_server_error() && is_template_error(&text) {
            tracing::warn!(server = %server_id, status = status.as_u16(),
                "language-server pass-through: the chat template refused the request; answered 400 (not retried)");
            return error(StatusCode::BAD_REQUEST, tail, &format!(
                "the chat template of {label} refused this conversation ({status}; it would refuse it on every retry): {}",
                server_words(&text)));
        }
        if let Some(counts) = context_overflow(&text) {
            tracing::warn!(server = %server_id, status = status.as_u16(), prompt = ?counts.0, window = ?counts.1,
                "language-server pass-through: the request is longer than the server's window; answered as prompt-too-long");
            return overflow_error(tail, &label, counts, &server_words(&text));
        }
        let mut r = Response::new(Body::from(body));
        *r.status_mut() = status;
        *r.headers_mut() = back;
        return r;
    }
    let mut r = Response::new(Body::from_stream(resp.bytes_stream()));
    *r.status_mut() = status;
    *r.headers_mut() = back;
    r
}

/// The harness's key is this boot's secret (`Authorization: Bearer`, the way
/// both CLIs send a key; `x-api-key` too).
#[nolog]
fn authorized(h: &HeaderMap) -> bool {
    let given = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| h.get("x-api-key").and_then(|v| v.to_str().ok()));
    let want = secret().as_bytes();
    given.is_some_and(|g| {
        let g = g.trim().as_bytes();
        g.len() == want.len() && g.iter().zip(want).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    })
}

/// Hop-by-hop headers, the length (the body is re-made or streamed) and the
/// harness's key stay behind.
#[nolog]
fn forwardable(name: &HeaderName) -> bool {
    !matches!(name.as_str(), "host" | "content-length" | "connection" | "keep-alive" | "proxy-connection"
        | "proxy-authenticate" | "proxy-authorization" | "te" | "trailer" | "transfer-encoding" | "upgrade"
        | "authorization" | "x-api-key")
}

#[nolog]
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).build().unwrap_or_default())
}

#[nolog]
async fn read_capped(mut resp: reqwest::Response, cap: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        let room = cap.saturating_sub(out.len());
        out.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if out.len() >= cap {
            break;
        }
    }
    out
}

/// An error in the API the harness speaks: Anthropic's for `/messages`,
/// OpenAI's otherwise.
#[nolog]
fn error(status: StatusCode, tail: &str, message: &str) -> Response {
    let kind = match status {
        StatusCode::BAD_REQUEST => "invalid_request_error",
        StatusCode::UNAUTHORIZED => "authentication_error",
        StatusCode::NOT_FOUND => "not_found_error",
        _ => "api_error",
    };
    let body = if tail.contains("/messages") {
        json!({ "type": "error", "error": { "type": kind, "message": message } })
    } else {
        json!({ "error": { "message": message, "type": kind, "code": status.as_u16() } })
    };
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

/// The server's message out of its error answer, else the answer itself.
#[logged]
fn server_words(text: &str) -> String {
    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let m = v.pointer("/error/message").or_else(|| v.get("error")).or_else(|| v.get("message"))
        .and_then(Value::as_str).unwrap_or(text).trim();
    m.chars().take(2000).collect()
}

/// A server's words for a chat template that refused the conversation:
/// llama.cpp and LM Studio name Jinja, Qwen's templates `raise_exception`,
/// vLLM's (Hugging Face) templates say the roles "must alternate".
#[logged]
pub fn is_template_error(text: &str) -> bool {
    let t = text.to_lowercase();
    ["jinja", "raise_exception", "chat template", "chat_template", "roles must alternate", "must be at the beginning"]
        .iter()
        .any(|w| t.contains(w))
}

/// A request body in the shape the server needs: strict-template turns, and
/// a summary request reshaped (see the module notes). Returns the body,
/// whether it changed, and what was done to a summary request.
#[nolog]
fn prepare(tail: &str, bytes: Bytes, server: &Value) -> (Bytes, bool, Option<Assist>) {
    let messages = tail.ends_with("/messages") || tail.ends_with("/messages/count_tokens");
    if !messages && !tail.ends_with("/responses") {
        return (bytes, false, None);
    }
    let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) else { return (bytes, false, None) };
    let mut changed = if messages { normalize_messages(&mut v) } else { normalize_responses(&mut v) };
    let assist = (!tail.ends_with("/count_tokens") && is_summary_ask(&v, messages)).then(|| {
        let window = window_of(server, v["model"].as_str());
        assist_summary(&mut v, messages, server["preset"].as_str().unwrap_or(""), window)
    });
    changed |= assist.is_some();
    match changed.then(|| serde_json::to_vec(&v)) {
        Some(Ok(b)) => (Bytes::from(b), true, assist),
        _ => (bytes, false, None),
    }
}

/// The window of the server's model a request names (the lane's default for
/// a model the server does not list).
#[nolog]
fn window_of(server: &Value, model: Option<&str>) -> i64 {
    let m = server["models"].as_object().and_then(|ms| ms.values().find(|m| model.is_some() && m["id"].as_str() == model));
    crate::langserver::context_of(m.unwrap_or(&Value::Null))
}

/// The words that open the CLIs' own requests for a summary of the
/// conversation (their compaction): Claude Code 2.1.x's (every variant of
/// its summary prompt starts so) and Codex 0.16x's.
const SUMMARY_ASKS: &[&str] = &[
    "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
    "You are performing a CONTEXT CHECKPOINT COMPACTION",
];

/// The characters a shortened tool output keeps at each end.
const KEEP: usize = 1200;

/// What the pass-through did to one summary request, for its log line.
#[derive(Debug, Default)]
struct Assist {
    /// tools taken off the request
    tools: usize,
    /// earlier thinking blocks or reasoning items left out
    thinking: usize,
    /// tool outputs cut to their head and tail
    shortened: usize,
    /// the body's size before and after, in characters
    chars: (usize, usize),
    /// reasoning was asked off
    thinking_off: bool,
}

/// Whether the conversation's last user turn is a CLI asking for a summary.
#[nolog]
fn is_summary_ask(v: &Value, messages: bool) -> bool {
    let items = if messages { v.get("messages") } else { v.get("input") };
    let last = items
        .and_then(Value::as_array)
        .and_then(|a| a.iter().rev().find(|m| m.get("role").and_then(Value::as_str) == Some("user")));
    last.is_some_and(|m| {
        let text = text_of(&m["content"]);
        SUMMARY_ASKS.iter().any(|w| text.contains(w))
    })
}

/// A CLI's summary request in the shape that gets a summary out of a local
/// model: no tools to call (a model in the middle of a task would rather
/// call one than write the summary: an answer without text), no earlier
/// thinking, reasoning off (it can run until the window is gone before the
/// summary starts) where the server is known to honour that, and long tool
/// outputs cut to their head and tail when the request would take more
/// than 3/5 of the window, so the answer has room.
#[nolog]
fn assist_summary(v: &mut Value, messages: bool, preset: &str, window: i64) -> Assist {
    let mut a = Assist { chars: (v.to_string().len(), 0), ..Default::default() };
    if let Some(o) = v.as_object_mut() {
        a.tools = o.get("tools").and_then(Value::as_array).map_or(0, Vec::len);
        for k in ["tools", "tool_choice", "parallel_tool_calls"] {
            o.remove(k);
        }
    }
    if messages {
        for m in v["messages"].as_array_mut().into_iter().flatten() {
            if m["role"] != "assistant" {
                continue;
            }
            if let Some(parts) = m["content"].as_array_mut() {
                let n = parts.len();
                parts.retain(|p| !matches!(p["type"].as_str(), Some("thinking" | "redacted_thinking")));
                a.thinking += n - parts.len();
                if parts.is_empty() {
                    parts.push(json!({ "type": "text", "text": "…" }));
                }
            }
        }
        // Anthropic's own switch, which Ollama and vLLM map to theirs;
        // llama.cpp reads only its template's (its /v1/messages passes
        // chat_template_kwargs on). Sources 2026-10.
        v["thinking"] = json!({ "type": "disabled" });
        if preset == "llamacpp" {
            v["chat_template_kwargs"]["enable_thinking"] = json!(false);
        }
        a.thinking_off = true;
    } else {
        if let Some(items) = v["input"].as_array_mut() {
            let n = items.len();
            items.retain(|it| it["type"] != "reasoning");
            a.thinking = n - items.len();
        }
        // llama.cpp and Ollama turn reasoning off for effort "none" (their
        // sources, 2026-10); what the others make of "none" is unknown
        if matches!(preset, "llamacpp" | "ollama") {
            v["reasoning"] = json!({ "effort": "none" });
            a.thinking_off = true;
        }
    }
    let target = usize::try_from(window.max(1)).unwrap_or(usize::MAX).saturating_mul(3).saturating_mul(3) / 5;
    a.shortened = shorten_outputs(v, messages, target);
    a.chars.1 = v.to_string().len();
    a
}

/// Cut the longest tool outputs to their head and tail, longest first, until
/// the request is at most `target` characters (about three a token). Returns
/// how many were cut.
#[nolog]
fn shorten_outputs(v: &mut Value, messages: bool, target: usize) -> usize {
    let mut size = v.to_string().len();
    if size <= target {
        return 0;
    }
    let mut spots: Vec<(String, usize)> = Vec::new();
    if messages {
        for (i, m) in v["messages"].as_array().into_iter().flatten().enumerate() {
            for (j, p) in m["content"].as_array().into_iter().flatten().enumerate() {
                if p["type"] != "tool_result" {
                    continue;
                }
                match &p["content"] {
                    Value::String(s) => spots.push((format!("/messages/{i}/content/{j}/content"), s.len())),
                    Value::Array(parts) => {
                        for (k, q) in parts.iter().enumerate() {
                            if let Some(s) = q["text"].as_str() {
                                spots.push((format!("/messages/{i}/content/{j}/content/{k}/text"), s.len()));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    } else {
        for (i, it) in v["input"].as_array().into_iter().flatten().enumerate() {
            if let (true, Some(s)) = (it["type"] == "function_call_output", it["output"].as_str()) {
                spots.push((format!("/input/{i}/output"), s.len()));
            }
        }
    }
    spots.sort_by(|a, b| b.1.cmp(&a.1));
    let mut cut = 0;
    for (at, len) in spots {
        if size <= target || len <= 2 * KEEP + 200 {
            break;
        }
        if let Some(Value::String(s)) = v.pointer_mut(&at) {
            let short = head_tail(s, KEEP);
            size = size.saturating_sub(s.len().saturating_sub(short.len()));
            *s = short;
            cut += 1;
        }
    }
    cut
}

/// `text`'s first and last `keep` characters around a note of what was left out.
#[nolog]
fn head_tail(text: &str, keep: usize) -> String {
    let n = text.chars().count();
    if n <= 2 * keep {
        return text.to_string();
    }
    let head: String = text.chars().take(keep).collect();
    let tail: String = text.chars().skip(n - keep).collect();
    format!("{head}\n[… {} characters of this output left out of the summary request …]\n{tail}", n - 2 * keep)
}

/// A server's refusal of a request longer than its context window, with the
/// two counts when it names them (prompt, window): llama.cpp's
/// exceed_context_size_error, vLLM's "maximum context length is …" (its
/// OpenAI layer) and "… longer than the maximum model length of …" (its
/// engine), and the usual wordings of the others.
#[logged]
pub fn context_overflow(text: &str) -> Option<(Option<i64>, Option<i64>)> {
    let t = text.to_lowercase();
    let words = [
        "exceeds the available context size", "exceed_context_size", "maximum context length", "maximum model length",
        "context length", "context window", "context_length_exceeded", "prompt is too long", "input is too long",
        "too many tokens",
    ];
    if !words.iter().any(|w| t.contains(w)) {
        return None;
    }
    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let n = |k: &str| v.pointer(&format!("/error/{k}")).and_then(Value::as_i64);
    if let (Some(p), Some(w)) = (n("n_prompt_tokens"), n("n_ctx")) {
        return Some((Some(p), Some(w)));
    }
    // vLLM: "This model's maximum context length is 32768 tokens. However, you requested 33000 tokens",
    // "The decoder prompt (length 33000) is longer than the maximum model length of 32768."
    let counts = regex::Regex::new(r"maximum context length is (\d+) tokens\D+?(\d+) (?:input )?tokens")
        .ok()
        .and_then(|r| r.captures(&t).map(|c| (c[2].parse().ok(), c[1].parse().ok())))
        .or_else(|| {
            regex::Regex::new(r"prompt \(length (\d+)\)[^.]*?maximum model length of (\d+)")
                .ok()
                .and_then(|r| r.captures(&t).map(|c| (c[1].parse().ok(), c[2].parse().ok())))
        });
    Some(counts.unwrap_or((None, None)))
}

/// A refusal for a request longer than the window, in the words the harness
/// acts on: Anthropic's "prompt is too long: N tokens > M maximum" starts
/// Claude Code's own compaction (it reads the gap from the two counts), and
/// OpenAI's context_length_exceeded is Codex's.
#[nolog]
fn overflow_error(tail: &str, label: &str, counts: (Option<i64>, Option<i64>), words: &str) -> Response {
    let said = match counts {
        (Some(p), Some(w)) => format!("prompt is too long: {p} tokens > {w} maximum"),
        _ => "prompt is too long for the model's context window".to_string(),
    };
    let message = format!("{said} (the language server {label}: {words})");
    let body = if tail.contains("/messages") {
        json!({ "type": "error", "error": { "type": "invalid_request_error", "message": message } })
    } else {
        json!({ "error": { "message": message, "type": "invalid_request_error", "param": "input", "code": "context_length_exceeded" } })
    };
    (StatusCode::BAD_REQUEST, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

/// Anthropic Messages in the shape a strict template accepts: `system` one
/// string; every other system message becomes a `<system-reminder>` block
/// of the user turn it stands in (where Claude Code puts its other
/// reminders); turns of one role in a row become one turn. Nothing earlier
/// moves, so a server's prompt cache still matches the conversation so far.
#[nolog]
pub fn normalize_messages(body: &mut Value) -> bool {
    let mut changed = false;
    if let Some(blocks) = body.get("system").and_then(Value::as_array) {
        if blocks.iter().all(|b| b.get("type").and_then(Value::as_str) == Some("text")) {
            let text: Vec<&str> = blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect();
            body["system"] = Value::String(text.join("\n\n"));
            changed = true;
        }
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else { return changed };
    let mut out: Vec<Value> = Vec::with_capacity(messages.len());
    for m in messages.drain(..) {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        let m = if role == "user" || role == "assistant" {
            m
        } else {
            changed = true;
            json!({ "role": "user", "content": [reminder(&text_of(&m["content"]), "text")] })
        };
        push_merged(&mut out, m, "text", &mut changed);
    }
    *messages = out;
    changed
}

/// OpenAI Responses (Codex) likewise: system and developer messages before
/// the conversation join `instructions` (the server's one system message);
/// later ones become reminders in the user turn they stand in; message
/// items of one role in a row become one.
#[nolog]
pub fn normalize_responses(body: &mut Value) -> bool {
    let Some(items) = body.get_mut("input").and_then(Value::as_array_mut) else { return false };
    let mut changed = false;
    let mut lead: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::with_capacity(items.len());
    for it in items.drain(..) {
        let message = it.get("type").and_then(Value::as_str).map_or(it.get("role").is_some(), |t| t == "message");
        let role = it.get("role").and_then(Value::as_str).unwrap_or("");
        if message && (role == "system" || role == "developer") {
            changed = true;
            let text = text_of(&it["content"]);
            if out.is_empty() {
                lead.push(text);
            } else {
                let m = json!({ "type": "message", "role": "user", "content": [reminder(&text, "input_text")] });
                push_merged(&mut out, m, "input_text", &mut changed);
            }
        } else if message && (role == "user" || role == "assistant") {
            let part = if role == "user" { "input_text" } else { "output_text" };
            push_merged(&mut out, it, part, &mut changed);
        } else {
            out.push(it);
        }
    }
    *items = out;
    if !lead.is_empty() {
        let first = body.get("instructions").and_then(Value::as_str).map(str::to_string);
        let text: Vec<String> = first.into_iter().chain(lead).filter(|s| !s.trim().is_empty()).collect();
        body["instructions"] = Value::String(text.join("\n\n"));
    }
    changed
}

/// Append `m`, or fold it into the last item when that is a message of the
/// same role (its parts typed `part` when it held a plain string).
#[nolog]
fn push_merged(out: &mut Vec<Value>, m: Value, part: &str, changed: &mut bool) {
    let role = m.get("role").and_then(Value::as_str).unwrap_or("").to_string();
    let same = |p: &Value| {
        p.get("role").and_then(Value::as_str) == Some(role.as_str())
            && p.get("type").and_then(Value::as_str).is_none_or(|t| t == "message")
    };
    match out.last_mut() {
        Some(prev) if same(prev) && m.get("type").and_then(Value::as_str).is_none_or(|t| t == "message") => {
            let mut parts = parts_of(&prev["content"], part);
            parts.extend(parts_of(&m["content"], part));
            prev["content"] = Value::Array(parts);
            *changed = true;
        }
        _ => out.push(m),
    }
}

#[nolog]
fn parts_of(content: &Value, part: &str) -> Vec<Value> {
    match content {
        Value::String(s) => vec![json!({ "type": part, "text": s })],
        Value::Array(a) => a.clone(),
        _ => Vec::new(),
    }
}

#[nolog]
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

#[nolog]
fn reminder(text: &str, part: &str) -> Value {
    json!({ "type": part, "text": format!("<system-reminder>\n{}\n</system-reminder>", text.trim()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles(v: &Value, key: &str) -> Vec<String> {
        v[key].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap_or("-").to_string()).collect()
    }

    /// Claude Code 2.1.292's request shape (measured on the rig 2026-10-10).
    #[test]
    fn claude_code_system_messages_become_reminders_in_their_user_turns() {
        let mut b = json!({
            "system": [{ "type": "text", "text": "You are Claude Code." }, { "type": "text", "text": "\nRules.", "cache_control": { "type": "ephemeral" } }],
            "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "hello" }] },
                { "role": "system", "content": "# Environment\nwin32" },
                { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "x", "input": {} }] },
                { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] },
                { "role": "system", "content": "<total_tokens>9 tokens left</total_tokens>" },
                { "role": "assistant", "content": [{ "type": "text", "text": "Done." }] },
                { "role": "user", "content": "next" },
                { "role": "system", "content": "<total_tokens>8 tokens left</total_tokens>" }
            ]
        });
        assert!(normalize_messages(&mut b));
        assert_eq!(b["system"], "You are Claude Code.\n\n\nRules.");
        assert_eq!(roles(&b, "messages"), ["user", "assistant", "user", "assistant", "user"]);
        let m = &b["messages"];
        assert_eq!(m[0]["content"][0]["text"], "hello");
        assert_eq!(m[0]["content"][1]["text"], "<system-reminder>\n# Environment\nwin32\n</system-reminder>");
        assert_eq!(m[2]["content"][0]["type"], "tool_result");
        assert_eq!(m[2]["content"][1]["text"], "<system-reminder>\n<total_tokens>9 tokens left</total_tokens>\n</system-reminder>");
        assert_eq!(m[4]["content"][0], json!({ "type": "text", "text": "next" }));
        assert_eq!(m[4]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_request_already_in_shape_is_left_alone() {
        let mut b = json!({ "system": "s", "messages": [{ "role": "user", "content": "a" }, { "role": "assistant", "content": "b" }] });
        let before = b.clone();
        assert!(!normalize_messages(&mut b));
        assert_eq!(b, before);
        let mut r = json!({ "instructions": "i", "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "a" }] }] });
        let before = r.clone();
        assert!(!normalize_responses(&mut r));
        assert_eq!(r, before);
    }

    #[test]
    fn a_leading_system_message_joins_the_first_user_turn() {
        let mut b = json!({ "messages": [{ "role": "system", "content": "x" }, { "role": "user", "content": "hi" }] });
        assert!(normalize_messages(&mut b));
        assert_eq!(roles(&b, "messages"), ["user"]);
        assert_eq!(b["messages"][0]["content"][1]["text"], "hi");
    }

    /// Codex's request shape (measured on the rig 2026-10-10).
    #[test]
    fn codex_developer_messages_join_instructions_and_user_turns_merge() {
        let mut r = json!({
            "instructions": "base",
            "input": [
                { "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "charter" }] },
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<environment_context/>" }] },
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "prompt" }] },
                { "type": "function_call", "call_id": "c1", "name": "x", "arguments": "{}" },
                { "type": "function_call_output", "call_id": "c1", "output": "ok" },
                { "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "late" }] },
                { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Done." }] },
                { "type": "message", "role": "user", "content": "again" }
            ]
        });
        assert!(normalize_responses(&mut r));
        assert_eq!(r["instructions"], "base\n\ncharter");
        let input = r["input"].as_array().unwrap();
        let kinds: Vec<String> = input.iter().map(|i| format!("{}:{}", i["type"].as_str().unwrap_or(""), i["role"].as_str().unwrap_or(""))).collect();
        assert_eq!(kinds, ["message:user", "function_call:", "function_call_output:", "message:user", "message:assistant", "message:user"]);
        assert_eq!(input[0]["content"].as_array().unwrap().len(), 2);
        assert_eq!(input[3]["content"][0]["text"], "<system-reminder>\nlate\n</system-reminder>");
        assert_eq!(input[5]["content"], "again"); // not merged: left as it was
    }

    #[test]
    fn template_errors_are_recognised() {
        assert!(is_template_error(r#"{"error":{"code":500,"message":"While executing CallExpression at line 106, column 32 ... Jinja Exception: System message must be at the beginning."}}"#));
        assert!(is_template_error("Conversation roles must alternate user/assistant/user/assistant/..."));
        assert!(!is_template_error(r#"{"error":{"message":"model is loading"}}"#));
        assert_eq!(server_words(r#"{"error":{"message":" bad template "}}"#), "bad template");
        assert_eq!(server_words("plain"), "plain");
    }

    #[test]
    fn a_template_refusal_is_a_real_error_not_a_freeze() {
        use crate::runtime::recovery::{classify, Class};
        let res = json!({ "api_error_status": 500 });
        let jinja = "API Error: 500 {\"error\":{\"message\":\"Jinja Exception: System message must be at the beginning.\"}}";
        assert_eq!(classify(jinja, &res, true, false), None);
        assert!(matches!(classify("API Error: 500 upstream crashed", &res, true, false), Some(Class::Net(_))));
    }

    fn server(preset: &str, window: i64) -> Value {
        json!({ "preset": preset, "models": { "m": { "id": "qwen", "context": window, "tier": "ls-x-qwen" } } })
    }

    /// Claude Code 2.1.292's summary request (rig capture 2026-10-11): its
    /// last turn is the tool result and the summary prompt, merged.
    fn claude_summary(output: &str) -> Value {
        json!({
            "model": "qwen", "stream": true, "max_tokens": 8192, "thinking": { "type": "adaptive" },
            "tools": [{ "name": "Bash", "input_schema": {} }, { "name": "mcp__orgtree__orgtree_status", "input_schema": {} }],
            "tool_choice": { "type": "auto" },
            "system": "You are Claude Code.",
            "messages": [
                { "role": "user", "content": "read the parts" },
                { "role": "assistant", "content": [{ "type": "thinking", "thinking": "let me read", "signature": "s" },
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "cat part1.txt" } }] },
                { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": output },
                    { "type": "text", "text": "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far" }] }
            ]
        })
    }

    #[test]
    fn a_claude_code_summary_request_goes_on_without_tools_or_thinking() {
        let body = Bytes::from(claude_summary("short output").to_string());
        let (out, changed, assist) = prepare("/v1/messages", body, &server("llamacpp", 65536));
        let v: Value = serde_json::from_slice(&out).unwrap();
        let a = assist.expect("a summary request");
        assert!(changed);
        assert_eq!((a.tools, a.thinking, a.shortened, a.thinking_off), (2, 1, 0, true));
        assert!(v.get("tools").is_none() && v.get("tool_choice").is_none());
        assert_eq!(v["thinking"], json!({ "type": "disabled" }));
        assert_eq!(v["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(v["messages"][1]["content"].as_array().unwrap().len(), 1);
        assert_eq!(v["messages"][1]["content"][0]["type"], "tool_use");
        // another preset: Anthropic's switch only
        let (out, _, _) = prepare("/v1/messages", Bytes::from(claude_summary("x").to_string()), &server("ollama", 65536));
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["thinking"], json!({ "type": "disabled" }));
        assert!(v.get("chat_template_kwargs").is_none());
    }

    #[test]
    fn a_summary_request_that_would_fill_the_window_gets_its_long_outputs_cut() {
        let long = "log line 0123456789\n".repeat(2000); // 40,000 characters
        let (out, _, assist) = prepare("/v1/messages", Bytes::from(claude_summary(&long).to_string()), &server("llamacpp", 16384));
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(assist.unwrap().shortened, 1);
        let kept = v["messages"][2]["content"][0]["content"].as_str().unwrap();
        assert!(kept.contains("characters of this output left out of the summary request"));
        assert!(kept.starts_with("log line 0123456789\n") && kept.ends_with("log line 0123456789\n"));
        assert!(kept.chars().count() < 2 * KEEP + 200);
        // a window with room: nothing is cut
        let (_, _, assist) = prepare("/v1/messages", Bytes::from(claude_summary(&long).to_string()), &server("llamacpp", 131072));
        assert_eq!(assist.unwrap().shortened, 0);
    }

    #[test]
    fn a_codex_compaction_request_goes_on_without_reasoning_items() {
        let r = json!({
            "model": "qwen", "instructions": "base", "reasoning": { "summary": "auto" },
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "read the parts" }] },
                { "type": "reasoning", "id": "rs1", "summary": [{ "type": "summary_text", "text": "thinking" }] },
                { "type": "function_call", "call_id": "c1", "name": "exec_command", "arguments": "{}" },
                { "type": "function_call_output", "call_id": "c1", "output": "ok" },
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary" }] }
            ]
        });
        let (out, _, assist) = prepare("/v1/responses", Bytes::from(r.to_string()), &server("llamacpp", 65536));
        let v: Value = serde_json::from_slice(&out).unwrap();
        let a = assist.unwrap();
        assert_eq!((a.thinking, a.thinking_off), (1, true));
        assert!(v["input"].as_array().unwrap().iter().all(|it| it["type"] != "reasoning"));
        assert_eq!(v["reasoning"], json!({ "effort": "none" }));
        let (out, _, _) = prepare("/v1/responses", Bytes::from(r.to_string()), &server("ollama", 65536));
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["reasoning"], json!({ "effort": "none" }));
        // vLLM: what it makes of "none" is unknown, left as Codex sent it
        let (out, _, _) = prepare("/v1/responses", Bytes::from(r.to_string()), &server("vllm", 65536));
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["reasoning"], json!({ "summary": "auto" }));
    }

    #[test]
    fn an_ordinary_request_is_not_a_summary_request() {
        let b = json!({ "model": "qwen", "tools": [{ "name": "Bash" }], "messages": [{ "role": "user", "content": "summarize the logs for me" }] });
        let (out, changed, assist) = prepare("/v1/messages", Bytes::from(b.to_string()), &server("llamacpp", 65536));
        assert!(assist.is_none() && !changed);
        assert_eq!(serde_json::from_slice::<Value>(&out).unwrap(), b);
    }

    #[test]
    fn a_servers_context_overflow_is_recognised_with_its_counts() {
        let llama = r#"{"error":{"code":400,"type":"exceed_context_size_error","n_prompt_tokens":70123,"n_ctx":65536,"message":"request (70123 tokens) exceeds the available context size (65536 tokens), try increasing it"}}"#;
        assert_eq!(context_overflow(llama), Some((Some(70123), Some(65536))));
        let vllm = r#"{"object":"error","message":"This model's maximum context length is 32768 tokens. However, you requested 33000 tokens (32000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion."}"#;
        assert_eq!(context_overflow(vllm), Some((Some(33000), Some(32768))));
        let engine = r#"{"error":{"message":"The decoder prompt (length 33000) is longer than the maximum model length of 32768. Make sure that `max_model_len` is no smaller than the number of text tokens.","type":"BadRequestError","code":400}}"#;
        assert_eq!(context_overflow(engine), Some((Some(33000), Some(32768))));
        assert_eq!(context_overflow("The number of tokens to keep from the initial prompt is greater than the context length"), Some((None, None)));
        assert_eq!(context_overflow(r#"{"error":{"message":"Loading model"}}"#), None);
        assert_eq!(context_overflow("Jinja Exception: System message must be at the beginning."), None);
    }

    #[test]
    fn an_overflow_is_answered_in_the_words_each_cli_compacts_on() {
        let r = overflow_error("/v1/messages", "llama.cpp", (Some(70123), Some(65536)), "request exceeds the available context size");
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let body = futures::executor::block_on(axum::body::to_bytes(r.into_body(), 1 << 16)).unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let m = v["error"]["message"].as_str().unwrap();
        assert_eq!(v["error"]["type"], "invalid_request_error");
        // Claude Code 2.1.292 reads the gap with this pattern
        let re = regex::Regex::new(r"(?i)prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)").unwrap();
        let c = re.captures(m).unwrap();
        assert_eq!((&c[1], &c[2]), ("70123", "65536"));
        let r = overflow_error("/v1/responses", "llama.cpp", (None, None), "context length");
        let body = futures::executor::block_on(axum::body::to_bytes(r.into_body(), 1 << 16)).unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["code"], "context_length_exceeded");
    }

    /// The CLIs' words when the context filled and compaction did not save
    /// it (Claude Code 2.1.292 live 2026-10-11; Codex 0.160.0 on the rig).
    #[test]
    fn a_full_context_is_recognised_in_each_clis_words() {
        use crate::runtime::recovery::context_full;
        assert!(context_full("Prompt is too long · automatic compaction failed: summarization produced empty response"));
        assert!(context_full("Prompt is too long"));
        assert!(context_full("API Error: The model has reached its context window limit."));
        assert!(context_full("Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."));
        assert!(context_full("stream disconnected before completion: Incomplete response returned, reason: max_output_tokens"));
        assert!(context_full(r#"API Error: 400 {"error":{"code":400,"type":"exceed_context_size_error","message":"request (70123 tokens) exceeds the available context size (65536 tokens), try increasing it"}}"#));
        assert!(!context_full("API Error: Claude's response exceeded the 8192 output token maximum."));
        assert!(!context_full("the language server llama.cpp did not answer: error sending request"));
        assert!(!context_full("Jinja Exception: System message must be at the beginning."));
    }

    #[test]
    fn only_this_boots_secret_passes() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer orgtree-local"));
        assert!(!authorized(&h));
        h.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {}", secret())).unwrap());
        assert!(authorized(&h));
    }
}
