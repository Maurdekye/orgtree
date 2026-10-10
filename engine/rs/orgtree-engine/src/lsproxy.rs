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
    let (bytes, normalized) = if parts.method == Method::POST { normalize_body(tail, bytes) } else { (bytes, false) };
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

#[nolog]
fn normalize_body(tail: &str, bytes: Bytes) -> (Bytes, bool) {
    let messages = tail.ends_with("/messages") || tail.ends_with("/messages/count_tokens");
    if !messages && !tail.ends_with("/responses") {
        return (bytes, false);
    }
    let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) else { return (bytes, false) };
    let changed = if messages { normalize_messages(&mut v) } else { normalize_responses(&mut v) };
    match changed.then(|| serde_json::to_vec(&v)) {
        Some(Ok(b)) => (Bytes::from(b), true),
        _ => (bytes, false),
    }
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
