//! Store-service root guard and channel. No database: the channel is served
//! by an echo handler. Every path lives under a fresh temp folder, and the
//! "live" locations come from a fake environment, so no test touches the
//! real Orgtree data.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use orgtree_store_service::guard::{self, Env, MARKER_FILE, MARKER_SCHEMA};
use orgtree_store_service::proto::{read_frame, write_frame, Handshake, Request, MAX_FRAME, PROTOCOL};
use orgtree_store_service::server::{self, Handler};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

fn scratch(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("p03-ws2-svc-{}-{}", name, uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn mark(root: &Path) {
    let real = guard::canonical(root).unwrap();
    let m = json!({"schema": MARKER_SCHEMA, "root_id": "0123456789abcdef0123456789abcdef", "root_path": real,
                   "disposable": true, "created_at_unix": 1, "created_by": "test"});
    std::fs::write(root.join(MARKER_FILE), serde_json::to_vec(&m).unwrap()).unwrap();
}

fn fake_env(base: &Path) -> Env {
    let mut e = Env::new();
    e.insert("APPDATA".into(), base.join("appdata").to_string_lossy().into());
    e.insert("USERPROFILE".into(), base.join("home").to_string_lossy().into());
    e.insert("LOCALAPPDATA".into(), base.join("local").to_string_lossy().into());
    e.insert("ProgramFiles".into(), base.join("pf").to_string_lossy().into());
    e
}

#[test]
fn a_marked_root_away_from_live_data_is_accepted() {
    let base = scratch("ok");
    let root = base.join("proto");
    std::fs::create_dir_all(&root).unwrap();
    mark(&root);
    let r = guard::validate(&root, &fake_env(&base)).unwrap();
    assert_eq!(r.root_id, "0123456789abcdef0123456789abcdef");
}

/// Live-root refusal: a root inside the (fake) live `%APPDATA%\Orgtree v2`
/// is refused WHATEVER its marker says.
#[test]
fn a_root_inside_live_data_is_refused_even_with_a_valid_marker() {
    let base = scratch("live");
    let root = base.join("appdata").join("Orgtree v2").join("data");
    std::fs::create_dir_all(&root).unwrap();
    mark(&root);
    let e = guard::validate(&root, &fake_env(&base)).unwrap_err();
    assert!(e.starts_with("[root."), "{e}");
    // and the trailing-dot spelling of the same folder
    let dotted = base.join("appdata").join("Orgtree v2.").join("data");
    assert!(guard::refuse_live(&dotted, &fake_env(&base)).is_err());
}

#[test]
fn a_root_above_live_data_is_refused() {
    let base = scratch("above");
    std::fs::create_dir_all(base.join("appdata").join("Orgtree v2")).unwrap();
    assert!(guard::refuse_live(&base.join("appdata"), &fake_env(&base)).is_err());
}

#[test]
fn markers_must_be_exact() {
    let base = scratch("marker");
    let root = base.join("proto");
    std::fs::create_dir_all(&root).unwrap();
    let env = fake_env(&base);
    assert!(guard::validate(&root, &env).is_err(), "an unmarked root must be refused");
    let real = guard::canonical(&root).unwrap();
    let full = |schema: &str, rid: &str, path: &str, disposable: bool| {
        json!({"schema": schema, "root_id": rid, "root_path": path, "disposable": disposable, "created_at_unix": 1, "created_by": "t"})
    };
    let rid = "0123456789abcdef0123456789abcdef";
    for (m, want) in [
        (full("other", rid, &real, true), "[root.bad_marker]"),
        (full(MARKER_SCHEMA, rid, &real, false), "[root.not_disposable]"),
        (full(MARKER_SCHEMA, "XYZ", &real, true), "[root.bad_marker]"),
        (full(MARKER_SCHEMA, rid, "c:\\elsewhere", true), "[root.moved_or_copied]"),
    ] {
        std::fs::write(root.join(MARKER_FILE), serde_json::to_vec(&m).unwrap()).unwrap();
        let e = guard::validate(&root, &env).unwrap_err();
        assert!(e.starts_with(want), "{want}: {e}");
    }
}

// ---- channel

struct Echo;

impl Handler for Echo {
    fn handshake(&self) -> Handshake {
        Handshake { protocol: PROTOCOL.into(), qualification: false, build_sha: "test".into(), verbs: vec!["echo".into()], points: vec![], controls: vec![] }
    }
    async fn handle(&self, req: Request) -> Value {
        json!({"verb": req.verb, "args": req.args})
    }
}

async fn start() -> (u16, String) {
    let l = server::bind_loopback().await.unwrap();
    let port = l.local_addr().unwrap().port();
    let token = server::new_token();
    tokio::spawn(server::serve(l, Arc::new(token.clone()), Arc::new(Echo)));
    (port, token)
}

fn req(verb: &str) -> Value {
    json!({"verb": verb, "org": uuid::Uuid::nil(), "binding": {"principal_kind": "agent", "principal": null, "generation": null, "acting": null, "key": null}, "args": {"x": 1}})
}

#[tokio::test]
async fn the_right_token_gets_a_handshake_and_answers_in_order() {
    let (port, token) = start().await;
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    write_frame(&mut s, &json!({"hello": token})).await.unwrap();
    let hs = read_frame(&mut s).await.unwrap().unwrap();
    assert_eq!(hs["handshake"]["protocol"], PROTOCOL);
    assert_eq!(hs["handshake"]["qualification"], false);
    for verb in ["a", "b"] {
        write_frame(&mut s, &req(verb)).await.unwrap();
        let r = read_frame(&mut s).await.unwrap().unwrap();
        assert_eq!(r["verb"], verb);
        assert_eq!(r["args"]["x"], 1);
    }
}

#[tokio::test]
async fn a_wrong_token_is_closed_without_a_word() {
    let (port, token) = start().await;
    let mut wrong = token.clone();
    wrong.replace_range(0..1, if token.starts_with('a') { "b" } else { "a" });
    for presented in [json!({"hello": wrong}), json!({"hello": ""}), json!({"nope": token})] {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        write_frame(&mut s, &presented).await.unwrap();
        assert_eq!(read_frame(&mut s).await.unwrap(), None, "{presented}");
    }
}

#[tokio::test]
async fn an_oversized_frame_is_refused() {
    let (port, token) = start().await;
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    write_frame(&mut s, &json!({"hello": token})).await.unwrap();
    read_frame(&mut s).await.unwrap().unwrap();
    s.write_all(&(MAX_FRAME + 1).to_be_bytes()).await.unwrap();
    // The server must drop the connection AT ONCE instead of waiting for (and
    // allocating) the frame. Bounded, so a server that waits fails here
    // rather than hanging the suite (mutation S3 hung before this timeout).
    let r = tokio::time::timeout(std::time::Duration::from_secs(5), read_frame(&mut s)).await;
    let r = r.expect("server kept the connection open waiting for an oversized frame");
    assert!(matches!(r, Ok(None) | Err(_)), "{r:?}");
}

#[tokio::test]
async fn a_malformed_request_gets_a_bad_request_answer() {
    let (port, token) = start().await;
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    write_frame(&mut s, &json!({"hello": token})).await.unwrap();
    read_frame(&mut s).await.unwrap().unwrap();
    write_frame(&mut s, &json!({"verb": 5})).await.unwrap();
    assert_eq!(read_frame(&mut s).await.unwrap().unwrap()["error"], "bad_request");
}

#[test]
fn token_comparison_is_exact() {
    assert!(server::token_eq("abc", "abc"));
    assert!(!server::token_eq("abc", "abd"));
    assert!(!server::token_eq("abc", "abcd"));
    assert!(!server::token_eq("", "a"));
    let t = server::new_token();
    assert_eq!(t.len(), 64);
    assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
}
