//! `orgtree-store-service --root <prototype root> [--db-url-env NAME]`
//!
//! Runs only on a WS1-marked disposable prototype root. Reads the runtime
//! role's connection URL from the environment variable NAME (default
//! `P03_PG_RUNTIME_URL`, as `pg-custodian dev up` prints it), registers its
//! liveness row, serves the channel, and publishes the descriptor. Ctrl-C
//! stops it: the liveness row is marked stopped and the descriptor removed.

use std::path::PathBuf;
use std::sync::Arc;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::Hooks;
use orgtree_store::lookup::{Liveness, INCARNATION_SQL};
use orgtree_store::{Connector, ExecConfig, Executor, Val};
use orgtree_store_service::descriptor::{self, Descriptor, DESCRIPTOR_SCHEMA};
use orgtree_store_service::handler::StoreHandler;
use orgtree_store_service::{guard, server};

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("orgtree-store-service: {msg}");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let mut root: Option<PathBuf> = None;
    let mut url_env = "P03_PG_RUNTIME_URL".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--root" => root = args.next().map(PathBuf::from),
            "--db-url-env" => url_env = args.next().unwrap_or_else(|| fail("--db-url-env needs a name")),
            other => fail(format!("unknown argument {other}")),
        }
    }
    let root = root.unwrap_or_else(|| fail("--root <prototype root> is required"));
    let env: guard::Env = std::env::vars().collect();
    let root = guard::validate(&root, &env).unwrap_or_else(|e| fail(e));
    let url = std::env::var(&url_env).unwrap_or_else(|_| fail(format!("environment variable {url_env} is not set")));
    let cfg = PgConfig::from_url(&url).unwrap_or_else(|e| fail(e));

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

    // The store incarnation the custodian wrote.
    let db_incarnation = {
        let mut s = liveness_factory.connect().await.unwrap_or_else(|e| fail(format!("connect: {e:?}")));
        let rows = orgtree_store::lookup::traced_exec(&mut s, &hooks, "exec.service.incarnation", INCARNATION_SQL, &[]).await.unwrap_or_else(|e| fail(format!("{e:?}")));
        rows.first().and_then(|r| r.first()).and_then(Val::as_uuid).unwrap_or_else(|| fail("store_incarnation is empty: run the custodian's migrations first"))
    };
    let live = Liveness::register(&liveness_factory, &hooks, "store-service", db_incarnation).await.unwrap_or_else(|e| fail(format!("register: {e:?}")));
    let service_incarnation = live.incarnation;

    let exec = Executor::new(main_pool, 8, reserved, 2, ExecConfig::default(), hooks);
    let handler = Arc::new(StoreHandler { exec, build_sha: option_env!("ORGTREE_BUILD_SHA").unwrap_or("unknown").to_string(), service_incarnation });
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
    descriptor::write(
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
    eprintln!("orgtree-store-service: serving on 127.0.0.1:{port}, incarnation {service_incarnation}");

    #[cfg(feature = "qualification")]
    {
        use orgtree_store_service::handler;
        let hs = serde_json::json!({
            "type": "handshake", "protocol": orgtree_store_service::harness::PROTOCOL, "qualification": true,
            "build_sha": option_env!("ORGTREE_BUILD_SHA").unwrap_or("unknown"),
            "points": handler::points(), "controls": handler::controls(), "declared": handler::declared(),
        });
        tokio::spawn(orgtree_store_service::harness::serve(harness_listener, harness_token, harness_state, hs));
    }
    tokio::select! {
        r = server::serve(listener, token, handler) => { if let Err(e) = r { eprintln!("orgtree-store-service: listener failed: {e}"); } }
        _ = tokio::signal::ctrl_c() => {}
    }
    descriptor::remove(&root.path);
    let _ = live.stop().await;
}
