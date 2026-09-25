//! `orgtree-store-service --root <prototype root> [--exit-on-stdin-eof] [--db-url-env NAME]`
//!
//! The host bracket (lead ruling on WS1's item; call shape agreed with WS1):
//! 1. validate the root (shared prototype guard);
//! 2. read the runtime role's connection facts from the custodian's
//!    `pg/cluster/pg-attach.json` + `secrets/credentials.json` (no password in
//!    the environment or command line; `--db-url-env` is a DEV-ONLY override);
//! 3. refuse if a live store service already serves this root;
//! 4. connect, check the server's `orgtree.instance_token` against the
//!    descriptor, read `store_incarnation`, register liveness;
//! 5. bind, write the owner-only service descriptor, THEN print one
//!    `{"type":"ready",...}` line on stdout (logs go to stderr only);
//! 6. stop on the authenticated `service.shutdown` verb, on Ctrl-C, or — with
//!    `--exit-on-stdin-eof` — when the host closes our stdin: the liveness row
//!    is marked stopped and the descriptor removed.
//!
//! Before Ready, any failure exits 2 with one stderr line and no stdout.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::Hooks;
use orgtree_store::lookup::{traced_exec, Liveness, INCARNATION_SQL};
use orgtree_store::{Connector, ExecConfig, Executor, Val};
use orgtree_store_service::descriptor::{self, Descriptor, DESCRIPTOR_SCHEMA};
use orgtree_store_service::handler::StoreHandler;
use orgtree_store_service::proto::{read_frame, write_frame};
use orgtree_store_service::{boot, guard, server};
use tokio::io::AsyncReadExt;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("orgtree-store-service: {msg}");
    std::process::exit(2);
}

/// Is a store service already answering on this root's descriptor?
async fn live_service_on(root: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(descriptor::path_in(root)) else { return false };
    let Ok(d) = serde_json::from_str::<Descriptor>(&text) else { return false };
    let probe = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", d.port)).await.ok()?;
        write_frame(&mut s, &serde_json::json!({"hello": d.token})).await.ok()?;
        read_frame(&mut s).await.ok()?.filter(|f| f.get("handshake").is_some())
    };
    matches!(tokio::time::timeout(Duration::from_secs(3), probe).await, Ok(Some(_)))
}

#[tokio::main]
async fn main() {
    let mut root: Option<PathBuf> = None;
    let mut url_env: Option<String> = None;
    let mut stdin_eof = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--root" => root = args.next().map(PathBuf::from),
            "--db-url-env" => url_env = Some(args.next().unwrap_or_else(|| fail("--db-url-env needs a name"))),
            "--exit-on-stdin-eof" => stdin_eof = true,
            other => fail(format!("unknown argument {other}")),
        }
    }
    let root = root.unwrap_or_else(|| fail("--root <prototype root> is required"));
    let env: guard::Env = std::env::vars().collect();
    let root = guard::validate(&root, &env).unwrap_or_else(|e| fail(e));

    let (cfg, attach): (PgConfig, Option<boot::Attach>) = match url_env {
        Some(name) => {
            let url = std::env::var(&name).unwrap_or_else(|_| fail(format!("environment variable {name} is not set")));
            (PgConfig::from_url(&url).unwrap_or_else(|e| fail(e)), None)
        }
        None => {
            let (cfg, a) = boot::config_from_root(&root.path, &root.root_id).unwrap_or_else(|e| fail(e));
            (cfg, Some(a))
        }
    };
    if live_service_on(&root.path).await {
        fail("a store service is already serving this root (its descriptor answers); attach to it instead");
    }

    #[allow(unused_mut)]
    let mut hooks = Hooks::default();
    #[cfg(feature = "qualification")]
    let harness_state = {
        let s = orgtree_store_service::harness::HarnessState::new();
        hooks.pause = Some(s.clone());
        hooks.controls = Some(s.clone());
        s
    };
    let main_pool = Factory::new(cfg.clone(), "executor", hooks.clone());
    let reserved = Factory::new(cfg.clone(), "lookup", hooks.clone());
    let liveness_factory = Factory::new(cfg, "liveness", hooks.clone());

    // Identity, then the store incarnation the custodian wrote.
    let db_incarnation = {
        let mut s = liveness_factory.connect().await.unwrap_or_else(|e| fail(format!("connect: {e:?}")));
        if let Some(a) = &attach {
            let rows = traced_exec(&mut s, &hooks, "exec.service.identity", boot::IDENTITY_SQL, &[]).await.unwrap_or_else(|e| fail(format!("{e:?}")));
            let col = |i: usize| rows.first().and_then(|r| r.get(i)).and_then(Val::as_text).unwrap_or("").to_string();
            let server = boot::ServerIdentity { instance_token: col(0), root_id: col(1), system_identifier: col(2) };
            boot::check_identity(&server, a).unwrap_or_else(|e| fail(e));
        }
        let rows = traced_exec(&mut s, &hooks, "exec.service.incarnation", INCARNATION_SQL, &[]).await.unwrap_or_else(|e| fail(format!("{e:?}")));
        rows.first().and_then(|r| r.first()).and_then(Val::as_uuid).unwrap_or_else(|| fail("store_incarnation is empty: run the custodian's migrations first"))
    };
    let live = Liveness::register(&liveness_factory, &hooks, "store-service", db_incarnation).await.unwrap_or_else(|e| fail(format!("register: {e:?}")));
    let service_incarnation = live.incarnation;

    let shutdown = Arc::new(tokio::sync::Notify::new());
    let exec = Executor::new(main_pool, 8, reserved, 2, ExecConfig::default(), hooks);
    let handler = Arc::new(StoreHandler {
        exec,
        build_sha: option_env!("ORGTREE_BUILD_SHA").unwrap_or("unknown").to_string(),
        service_incarnation,
        shutdown: shutdown.clone(),
    });
    let listener = server::bind_loopback().await.unwrap_or_else(|e| fail(format!("bind: {e}")));
    let port = listener.local_addr().unwrap_or_else(|e| fail(e)).port();
    let token = Arc::new(server::new_token());
    #[cfg(feature = "qualification")]
    let (harness_listener, harness_token) = (
        server::bind_loopback().await.unwrap_or_else(|e| fail(format!("bind harness: {e}"))),
        Arc::new(server::new_token()),
    );
    #[cfg(feature = "qualification")]
    let (harness_port, harness_token_field) =
        (Some(harness_listener.local_addr().unwrap_or_else(|e| fail(e)).port()), Some((*harness_token).clone()));
    #[cfg(not(feature = "qualification"))]
    let (harness_port, harness_token_field): (Option<u16>, Option<String>) = (None, None);
    let descriptor_path = descriptor::write(
        &root.path,
        &Descriptor {
            schema: DESCRIPTOR_SCHEMA.into(),
            root_id: root.root_id.clone(),
            port,
            token: (*token).clone(),
            pid: std::process::id(),
            service_incarnation: service_incarnation.to_string(),
            qualification: orgtree_store::hooks::QUALIFICATION,
            harness_port,
            harness_token: harness_token_field,
        },
    )
    .unwrap_or_else(|e| fail(e));

    #[cfg(feature = "qualification")]
    {
        use orgtree_store_service::handler;
        let hs = serde_json::json!({
            "type": "handshake", "protocol": orgtree_store_service::harness::PROTOCOL, "qualification": true,
            "build_sha": option_env!("ORGTREE_BUILD_SHA").unwrap_or("unknown"),
            "points": handler::points(), "controls": handler::CONTROLS, "declared": handler::declared(),
        });
        tokio::spawn(orgtree_store_service::harness::serve(harness_listener, harness_token, harness_state, hs));
    }

    // READY: exactly one stdout line, after the descriptor exists.
    {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", boot::ready_line(std::process::id(), port, &service_incarnation.to_string(), &descriptor_path));
        let _ = out.flush();
    }
    eprintln!("orgtree-store-service: serving on 127.0.0.1:{port}, incarnation {service_incarnation}");

    let stdin_closed = async {
        if !stdin_eof {
            return std::future::pending::<()>().await;
        }
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; 256];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    };
    tokio::select! {
        r = server::serve(listener, token, handler) => { if let Err(e) = r { eprintln!("orgtree-store-service: listener failed: {e}"); } }
        _ = tokio::signal::ctrl_c() => eprintln!("orgtree-store-service: interrupted"),
        _ = shutdown.notified() => eprintln!("orgtree-store-service: shutdown requested"),
        _ = stdin_closed => eprintln!("orgtree-store-service: stdin closed by the host"),
    }
    descriptor::remove(&root.path);
    let _ = live.stop().await;
}
