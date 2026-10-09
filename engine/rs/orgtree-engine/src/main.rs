//! Orgtree engine.
//!
//! `orgtree-engine [serve]`  — the engine (started by the desktop or by `host`)
//! `orgtree-engine host`     — the boot-time supervisor run by the scheduled task
//! `orgtree-engine mcp-bridge` — stdio MCP bridge for CLIs that need one

#![allow(dead_code)]
#![recursion_limit = "256"]

#[macro_use]
extern crate orgtree_logged;

mod account_marks;
mod accounts;
mod appfeed;
mod bridge;
mod changes;
mod config;
mod credential_context;
mod credential_bridge;
mod domain;
mod engine;
mod events;
mod feed;
mod host;
mod http;
mod import2x;
mod import30;
mod import_dogmemo;
mod import_failures;
mod importer;
mod launch;
mod mailhub;
mod migrate;
mod net;
mod openrouter;
mod orgs;
mod pg;
mod phone;
mod providers;
mod rig;
mod runtime;
mod settings;
mod tools;
mod trace;
mod usage;
mod usage_history;
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
    if std::env::current_exe().ok().and_then(|p|p.file_name().map(|n|n.to_string_lossy().to_lowercase())) == Some("gh.exe".into()) {
        return credential_bridge::cli("gh", &args[1..]);
    }
    match args.get(1).map(String::as_str) {
        None | Some("serve") => serve(),
        Some("host") => host::run(),
        Some("credential-helper") => credential_bridge::cli("git", &args[2..]),
        Some("mcp-bridge") => bridge::run(&args[2..]),
        Some("agy-hook") => bridge::hook(&args[2..]),
        Some("agy-steer") => bridge::steer(&args[2..]),
        Some("--version") | Some("version") => {
            println!("orgtree-engine {}{}", env!("CARGO_PKG_VERSION"), if trace::RELEASE_BUILD { "" } else { " (dev)" });
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
    // before the log opens: a refused rig root gets nothing written into it
    if let Err(e) = rig::init(&cfg) {
        eprintln!("orgtree-engine: {e:#}");
        return ExitCode::from(1);
    }
    let (_guards, log_file) = trace::init(&cfg);
    tracing::info!(pid = std::process::id(), root = %cfg.data_root_id, log = %log_file.display(),
                   version = env!("CARGO_PKG_VERSION"), build = if trace::RELEASE_BUILD { "release" } else { "dev" },
                   "engine starting");
    rig::announce();
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
    // before any watchdog starts, so an imported passive dog never wakes its owner
    import_dogmemo::run_once(&cfg, cluster, &pool).await;

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
    trace::apply_verbose(settings.verbose_logging());
    if trace::verbose() {
        tracing::info!("{}", trace::fit_value("SETTINGS ", trace::Shown::json(&settings.get())));
    }
    let max_turns = settings.max_concurrent_turns();
    let (app, app_inbox) = appfeed::AppFeed::new();
    let (sched, sched_inbox) = runtime::sched::Scheduler::new(max_turns);
    let engine = Arc::new(Engine {
        cfg: cfg.clone(),
        db: pool,
        boot,
        credentials: credential_context::CredentialContext::new(),
        credential_bridge: crate::credential_bridge::Bridge::new(),
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
        phone: phone::Phone::default(),
        dogs: runtime::watchdogs::Registry::default(),
        usage: usage::Usage::default(),
        net: net::Net::default(),
    });

    progress("engine-load-orgs");
    credential_context::start(&engine);
    orgs::load_all(&engine).await?;
    appfeed::start(&engine, app_inbox);
    // orgs a first-start import could not copy: one line each in the org list
    import_failures::publish(&engine).await;
    accounts::start(&engine).await;
    openrouter::import_legacy(&engine).await;
    providers::start(&engine);
    usage::start(&engine);
    runtime::sched::start(&engine, sched_inbox);
    mailhub::prepare_database(&engine, cluster).await;
    mailhub::start(&engine).await;
    net::start(&engine);
    runtime::recover(&engine).await;
    runtime::warm_all(&engine);
    runtime::watchdogs::start(&engine).await;
    // a safe start holds the automatic wakes back unless a rig run asked for them
    if std::env::var("ORGTREE_ENGINE_SAFE_START").as_deref() != Ok("1") || rig::reminder_sweep_s().is_some() {
        runtime::reminders::start(&engine);
    }

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
    tokio::spawn(runtime::convo::repair_old_args(engine.clone()));
    progress("engine-ready");
    launch::ready(port, &cfg.data_root_id);
    runtime::watchdogs::events::machine(&engine,"engine.started",serde_json::json!({"commit":option_env!("ORGTREE_BUILD_COMMIT").unwrap_or("rust-engine"),"pid":engine.boot.pid}));
    tracing::info!(port, "engine ready");
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async move { shutdown.cancelled().await })
        .await?;
    tracing::info!("engine stopping");
    runtime::shutdown(&engine).await;
    mailhub::stop(&engine).await;
    Ok(())
}
