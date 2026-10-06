//! Orgtree engine.
//!
//! `orgtree-engine [serve]`  — the engine (started by the desktop or by `host`)
//! `orgtree-engine host`     — the boot-time supervisor run by the scheduled task
//! `orgtree-engine mcp-bridge` — stdio MCP bridge for CLIs that need one

#![allow(dead_code)]

#[macro_use]
extern crate orgtree_logged;

mod accounts;
mod appfeed;
mod bridge;
mod config;
mod domain;
mod engine;
mod feed;
mod host;
mod http;
mod importer;
mod launch;
mod mailhub;
mod migrate;
mod orgs;
mod pg;
mod providers;
mod runtime;
mod settings;
mod tools;
mod trace;
mod util;
mod winproc;

use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio_postgres::NoTls;
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::engine::{Boot, Engine};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        None | Some("serve") => serve(),
        Some("host") => host::run(),
        Some("mcp-bridge") => bridge::run(&args[2..]),
        Some("--version") | Some("version") => {
            println!("orgtree-engine {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("orgtree-engine: unknown command {other:?}");
            ExitCode::from(2)
        }
    }
}

fn serve() -> ExitCode {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("orgtree-engine: {e:#}");
            return ExitCode::from(1);
        }
    };
    let (_guards, log_file) = trace::init(&cfg);
    tracing::info!(pid = std::process::id(), root = %cfg.data_root_id, log = %log_file.display(),
                   version = env!("CARGO_PKG_VERSION"), "engine starting");
    winproc::install_root_job();
    let lock = match launch::RootLock::acquire(&cfg.data_root) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            launch::refused_root_owned("another engine owns this data root");
            tracing::warn!("data root is owned by another engine; refusing");
            return ExitCode::from(3);
        }
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "could not lock the data root");
            return ExitCode::from(1);
        }
    };
    launch::progress("engine-start", &cfg.data_root_id);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("engine")
        .build()
        .expect("tokio runtime");
    let code = match rt.block_on(tracing::Instrument::instrument(run(cfg), trace::request("engine"))) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "engine stopped with an error");
            ExitCode::from(1)
        }
    };
    rt.shutdown_timeout(std::time::Duration::from_secs(5));
    drop(lock);
    code
}

#[logged]
async fn run(cfg: Config) -> Result<()> {
    let root_id = cfg.data_root_id.clone();
    let progress = move |phase: &str| launch::progress(phase, &root_id);
    let listener = launch::bind_port(&cfg.data_root).context("could not bind the engine port")?;
    let port = listener.local_addr()?.port();

    let mut cluster = pg::Cluster::start(&cfg, &progress).await?;
    let result = run_with_cluster(cfg, &cluster, listener, port, &progress).await;
    progress("engine-stop-database");
    cluster.stop().await;
    result
}

#[logged]
async fn run_with_cluster(
    cfg: Config,
    cluster: &pg::Cluster,
    listener: std::net::TcpListener,
    port: u16,
    progress: &dyn Fn(&str),
) -> Result<()> {
    cluster.ensure_database(pg::ENGINE_DB).await?;
    {
        let (mut client, conn) = cluster.connect_config(pg::ENGINE_DB).connect(NoTls).await?;
        let task = tokio::spawn(conn);
        migrate::run(&mut client, progress).await?;
        drop(client);
        task.abort();
    }
    let pool = cluster.pool(pg::ENGINE_DB, 48)?;

    importer::run_if_needed(&cfg, cluster, &pool, progress).await?;

    let settings_doc = {
        let client = pool.get().await?;
        settings::AppSettings::load(&client).await?
    };
    let boot = Boot {
        id: uuid::Uuid::new_v4().simple().to_string(),
        pid: std::process::id(),
        started_at: chrono::Utc::now(),
        port,
    };
    let settings = settings::AppSettings::new(settings_doc);
    let max_turns = settings.max_concurrent_turns();
    let (app, app_inbox) = appfeed::AppFeed::new();
    let (sched, sched_inbox) = runtime::sched::Scheduler::new(max_turns);
    let engine = Arc::new(Engine {
        cfg: cfg.clone(),
        db: pool,
        boot,
        shutdown: CancellationToken::new(),
        stopping: AtomicBool::new(false),
        orgs: orgs::OrgDirectory::default(),
        agents: runtime::AgentRegistry::default(),
        app,
        sched,
        settings,
        accounts: accounts::Accounts::default(),
        providers: providers::Providers::default(),
        hub: mailhub::MailHub::default(),
    });

    progress("engine-load-orgs");
    orgs::load_all(&engine).await?;
    appfeed::start(&engine, app_inbox);
    accounts::start(&engine).await;
    providers::start(&engine);
    runtime::sched::start(&engine, sched_inbox);
    mailhub::start(&engine).await;
    runtime::recover(&engine).await;

    if let Some(pid) = cfg.parent_pid {
        let eng = engine.clone();
        winproc::watch_parent(pid, move || {
            tracing::warn!(pid, "parent process exited; shutting down");
            eng.request_shutdown();
        });
    }

    let app = http::router(engine.clone());
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let shutdown = engine.shutdown.clone();
    progress("engine-ready");
    launch::ready(port, &cfg.data_root_id);
    tracing::info!(port, "engine ready");
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async move { shutdown.cancelled().await })
        .await?;
    tracing::info!("engine stopping");
    runtime::shutdown(&engine).await;
    mailhub::stop(&engine).await;
    Ok(())
}
