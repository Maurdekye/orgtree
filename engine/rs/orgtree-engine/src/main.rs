//! Orgtree engine.
//!
//! `orgtree-engine [serve]`  — the engine (started by the desktop or by `host`)
//! `orgtree-engine standalone` — the engine with no desktop: mandatory token
//!   (`ORGTREE_STANDALONE_TOKEN` or `<data>/standalone-token`), optional
//!   `ORGTREE_BIND`/`ORGTREE_PORT`; see docs/rust-engine/STANDALONE-ENGINE.md
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
mod codex_kills;
mod config;
mod core_policy;
mod core_process;
mod core_state;
mod core_monitor;
mod core_startup;
mod core_diagnostics;
mod core_recovery;
mod credential_context;
mod credential_bridge;
mod domain;
mod engine;
mod events;
mod feed;
mod host;
#[cfg(windows)]
mod hosted_pipes;
mod http;
mod harnesses;
mod import2x;
mod import30;
mod import_dogmemo;
mod import_failures;
mod importer;
mod install_stop;
mod langserver;
mod lsproxy;
mod launch;
mod mailhub;
mod migrate;
mod net;
mod openrouter;
mod org_accounts;
mod orgs;
mod pg;
mod phone;
mod profile_pictures;
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

use crate::config::Config;
use crate::engine::{Boot, Engine};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if std::env::current_exe().ok().and_then(|p|p.file_name().map(|n|n.to_string_lossy().to_lowercase())) == Some("gh.exe".into()) {
        return credential_bridge::cli("gh", &args[1..]);
    }
    if std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase())) == Some("orgtree-git-askpass.exe".into()) {
        return credential_bridge::askpass::cli(&args[1..]);
    }
    match args.get(1).map(String::as_str) {
        None | Some("serve") => serve(false),
        Some("standalone") => serve(true),
        Some("host") => host::run(),
        Some("core-control") => core_monitor::cli(&args[2..]),
        Some("core-recovery") => core_recovery::cli(&args[2..]),
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

fn serve(standalone: bool) -> ExitCode {
    let cfg = match Config::from_env(standalone) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("orgtree-engine: {e:#}");
            return ExitCode::from(1);
        }
    };
    if standalone {
        // stderr only (stdout stays the launcher protocol), never the log.
        eprintln!("orgtree-engine standalone: data root {}, listening on {} (port in the ready line)",
                  cfg.data_root.display(), cfg.bind);
        if cfg.standalone_generated_token {
            eprintln!("orgtree-engine standalone: first-run token, saved to {}: {}",
                      cfg.data_root.join(crate::config::STANDALONE_TOKEN_FILE).display(), cfg.desktop_token);
        }
    }
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
    let descriptor_root = cfg.data_root.clone();
    let code = match rt.block_on(tracing::Instrument::instrument(run(cfg), trace::request("engine"))) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "engine stopped with an error");
            ExitCode::from(1)
        }
    };
    rt.shutdown_timeout(std::time::Duration::from_secs(5));
    // Managed engines publish their own descriptor. Remove only that owner's
    // file while the root lock still excludes any replacement publisher.
    host::remove_descriptor(&descriptor_root);
    drop(lock);
    code
}

#[logged]
async fn run(cfg: Config) -> Result<()> {
    let mut startup = core_startup::Startup::begin(&cfg)?;
    let root_id = cfg.data_root_id.clone();
    let progress = move |phase: &str| launch::progress(phase, &root_id);
    let listener = launch::bind_port(&cfg.data_root, cfg.bind, cfg.port).context("could not bind the engine port")?;
    let port = listener.local_addr()?.port();

    let mut cluster = pg::Cluster::start_observed(&cfg, &progress, &startup.cancelled).await?;
    let result = run_with_cluster(cfg, &cluster, listener, port, &progress, &mut startup).await;
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
    startup: &mut core_startup::Startup,
) -> Result<()> {
    let preparation = async {
    #[cfg(debug_assertions)]
    if rig::active() {
        let delay = std::env::var("ORGTREE_RIG_CORE_STARTUP_DELAY_MS").ok()
            .and_then(|v| v.parse::<u64>().ok()).unwrap_or(0).min(180_000);
        if delay != 0 {
            progress("database-convert-rig-delay");
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
    }
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
    Ok::<_, anyhow::Error>((pool, settings_doc))
    };
    let (pool, settings_doc) = tokio::select! {
        biased;
        _ = startup.cancelled.cancelled() => anyhow::bail!("core process exited before readiness"),
        result = preparation => result?,
    };
    let boot = Boot {
        id: startup.generation.clone(),
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
    let (core, core_inbox) = core_monitor::Core::channel();
    let engine = Arc::new(Engine {
        cfg: cfg.clone(),
        db: pool,
        boot,
        credentials: credential_context::CredentialContext::new(),
        credential_bridge: crate::credential_bridge::Bridge::new(),
        core,
        shutdown: startup.cancelled.clone(),
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
    // before anything with a child of its own (the hosted hub) starts
    #[cfg(unix)]
    stop_on_signals(&engine);
    credential_context::start(&engine);
    // tool-bridge sockets a killed earlier run left (Windows pipes go with their process)
    #[cfg(unix)]
    bridge::clear_stale(&engine.cfg.data_root);
    orgs::load_all(&engine).await?;
    appfeed::start(&engine, app_inbox);
    // orgs a first-start import could not copy: one line each in the org list
    import_failures::publish(&engine).await;
    if let Err(e) = org_accounts::load(&engine).await {
        tracing::warn!(error = %format!("{e:#}"), "the orgs' account lists could not be read; every account is allowed until they are");
    }
    accounts::start(&engine).await;
    if let Err(error) = usage::muse_cache::restore(&engine).await {
        tracing::warn!(error = %error, "could not restore Muse usage readings");
    }
    openrouter::import_legacy(&engine).await;
    // every key carries its own harness, seeded from the old global setting
    openrouter::migrate_harnesses(&engine).await;
    // the stored OpenRouter favorites are hireable tiers from the first
    // request, every start: discovery (a CLI probe) fills the rest later
    providers::refresh_openrouter(&engine);
    providers::start(&engine);
    // the built-in organization templates, as files in the templates folder
    tokio::task::spawn_blocking(|| {
        if let Err(e) = domain::templates::seed() {
            tracing::warn!(error = %e, "the templates folder could not be seeded");
        }
    });
    usage::start(&engine);
    runtime::sched::start(&engine, sched_inbox);
    mailhub::prepare_database(&engine, cluster).await;
    mailhub::start(&engine).await;
    phone::start(&engine);
    net::start(&engine);
    runtime::recover(&engine).await;
    // language-server seats follow their server's price (the flat 0.10 of
    // 4.2.0-alpha.1 becomes the default 1 on the first start after it)
    tokio::spawn({
        let engine = engine.clone();
        async move {
            let out = langserver::reprice_everywhere(&engine).await;
            if !out.is_empty() {
                tracing::info!(changes = %serde_json::Value::Array(out), "language-server seats repriced");
            }
        }
    });
    runtime::warm_all(&engine);
    runtime::watchdogs::start(&engine).await;
    // a safe start holds the automatic wakes back unless a rig run asked for them
    if std::env::var("ORGTREE_ENGINE_SAFE_START").as_deref() != Ok("1") || rig::reminder_sweep_s().is_some() {
        runtime::reminders::start(&engine);
    }

    if let Some(pid) = cfg.parent_pid.filter(|_| !engine.core.enabled) {
        let eng = engine.clone();
        winproc::watch_parent(pid, move || {
            tracing::warn!(pid, "parent process exited; shutting down");
            eng.request_shutdown();
        });
    }
    // Windows has no SIGINT path into stop_on_signals: give a standalone
    // terminal run the same clean Ctrl+C shutdown Unix gets.
    #[cfg(windows)]
    if engine.cfg.standalone {
        let eng = engine.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                tracing::warn!("Ctrl+C received; shutting down");
                eng.request_shutdown();
            }
        });
    }

    let app = http::router(engine.clone());
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let shutdown = engine.shutdown.clone();
    runtime::convo::close_open_compactions(&engine).await;
    tokio::spawn(runtime::convo::repair_old_args(engine.clone()));
    // Missing members cannot register until control is available. Keep the
    // stamped-identity startup watcher until this point, then hand off once.
    startup.finish();
    core_monitor::start(&engine, core_inbox);
    runtime::session_watch::start(&engine);
    // an installer that cannot ask through the descriptor asks through its record
    install_stop::start(&engine);
    progress("engine-ready");
    #[cfg(windows)]
    if engine.core.enabled && std::env::var("ORGTREE_CORE_MODE").as_deref() == Ok("managed") {
        // The descriptor has the same owner-only, atomic publication boundary
        // as the boot host. A replacement desktop can adopt this SAME engine.
        // The reason is the failed step, never the token (write_descriptor's errors name no secret).
        host::write_descriptor(&cfg.data_root, port, std::process::id(), &cfg.desktop_token, true)
            .map_err(|e| anyhow::anyhow!("cannot publish managed engine attachment: {e}"))?;
    }
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

/// SIGTERM, SIGINT and SIGHUP stop the engine cleanly, as they stop the host
/// (launchd and systemd end a service with SIGTERM; a terminal sends the
/// others): the HTTP server drains, the agents are settled and the hosted mail
/// hub is stopped, where the default would end the process at once and leave
/// the hub holding its port.
#[cfg(unix)]
#[logged]
fn stop_on_signals(engine: &Arc<Engine>) {
    use tokio::signal::unix::{signal, SignalKind};
    for (name, kind) in [("SIGTERM", SignalKind::terminate()), ("SIGINT", SignalKind::interrupt()), ("SIGHUP", SignalKind::hangup())] {
        let mut received = match signal(kind) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(signal = name, error = %e, "cannot catch this signal: it ends the engine without stopping its hub");
                continue;
            }
        };
        let eng = engine.clone();
        tokio::spawn(async move {
            if received.recv().await.is_some() {
                tracing::warn!(signal = name, "signal received; shutting down");
                eng.request_shutdown();
            }
        });
    }
}
