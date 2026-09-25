//! `pg-custodian` CLI. Every command prints one JSON object on stdout:
//! `{"ok":true,...}` or `{"ok":false,"code":...,"message":...}` (exit 1).
//! The one exception is `dev env`, which prints shell assignments.

use orgtree_pg_custodian::cluster::{self, ClusterState, InitOptions, PgBin};
use orgtree_pg_custodian::backup;
use orgtree_pg_custodian::dev;
use orgtree_pg_custodian::migrate;
use orgtree_pg_custodian::guard::{self, process_env, Env};
use orgtree_pg_custodian::{CustodianError, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

const USAGE: &str = "usage:
  pg-custodian dev <up|down|status|env|destroy> --agent <name> [--shell ps|sh|plain]
                   [--qual-logging on|off]   (up only; applies at start, off by default)
  pg-custodian dev status --all
  pg-custodian <command> --root <dir> [options]
  pg-custodian <status|init|start|attach|identify|urls|stop> --root <dir> --product
  pg-custodian bind-product --root <dir>

dev commands (one cluster per agent under <repo>/artifacts/p03-db/<agent>):
  up        mark + init if new, start on the agent's port if stopped, identify,
            print URLs (P03_PG_ADMIN_URL, P03_PG_RUNTIME_URL, P03_PG_REPL_URL)
  down      stop it and wait for its whole process family to exit
  status    state without connecting; --all lists every P03 cluster
  env       identify, then print the URLs as shell assignments (default ps)
  destroy   delete a STOPPED agent cluster entirely
  migrate   apply engine/native/store-schema/migrations (see root `migrate`)
  check-writer  (see root `check-writer`)

root commands:
  migrate     --schema-dir <dir> [--writer-version N]
              apply every pending NNNN_*.sql listed in <dir>/SHA256SUMS in order,
              each in one transaction with its bookkeeping row; refuses unlisted
              or missing files, gaps, checksum or history mismatches, a newer
              database, or a migration needing a newer writer; writes
              store_incarnation once
  check-writer --writer-version N   refuse if N is below the schema's min_writer
  init-root   mark a NEW or EMPTY folder as a disposable prototype root
  init        initdb a cluster under the root (quarantine, then commit by rename)
  start       start it on 127.0.0.1 [--port N] (default: a free port)
  identify    connect with SCRAM and check it is the instance this root owns
  attach      strict reuse of a running instance: owner-only descriptor, pid +
              creation time, SCRAM identity, readiness; never port/pid alone
  status      report the cluster state without connecting
  urls        identify, then print the three role URLs
  psql        run --sql <text> as the admin role [--db name] and print the rows
  stop        pg_ctl stop -m fast (or --immediate), then wait for the owned
              process family to exit [--timeout SECS, default 600]
              [--force: terminate surviving postgres.exe]
  destroy     delete a STOPPED prototype root entirely
  backup      --out <new folder>: pg_dump of one exported snapshot + a content
              manifest (row count and digest per table) from the SAME snapshot
  restore     --from <backup folder>: into this root's running, EMPTY cluster,
              one transaction, content verified, then a NEW store incarnation
  bind-product  bind the engine's OWN data root (= ORGTREE_DATA, never an
              agent's environment, never the installed app) for --product;
              an operator step before the PostgreSQL import (PYPG PG-2)
  --product   run a lifecycle command on that bound root instead of a
              prototype root; destroy, restore and every other command refuse
  qual-logging --qual-logging on|off   set the qualification-logging switch
              on a STOPPED cluster (jsonlog, log_statement=all, bind values
              never logged, files under <root>/qual-logs)

options:
  --pg-bin <dir>   PostgreSQL bin (default: env ORGTREE_P03_PG_BIN, else
                   <repo>/artifacts/p03-postgresql/18.6-4/bin)";

#[derive(Default)]
struct Args {
    command: String,
    sub: Option<String>,
    root: Option<PathBuf>,
    agent: Option<String>,
    pg_bin: Option<PathBuf>,
    port: Option<u16>,
    sql: Option<String>,
    db: Option<String>,
    shell: Option<String>,
    all: bool,
    qual_logging: Option<bool>,
    schema_dir: Option<PathBuf>,
    writer_version: Option<u32>,
    immediate: bool,
    force: bool,
    timeout: Option<u64>,
    out: Option<PathBuf>,
    from: Option<PathBuf>,
    product: bool,
}

fn parse() -> Result<Args> {
    let mut it = std::env::args().skip(1).peekable();
    let command = it.next().ok_or_else(|| CustodianError::new("cli.usage", USAGE))?;
    let mut a = Args { command, ..Default::default() };
    if a.command == "dev" {
        a.sub = Some(it.next().ok_or_else(|| CustodianError::new("cli.usage", USAGE))?);
    }
    while let Some(flag) = it.next() {
        let mut val = |name: &str| it.next().ok_or_else(|| CustodianError::new("cli.usage", format!("{name} needs a value")));
        match flag.as_str() {
            "--root" => a.root = Some(PathBuf::from(val("--root")?)),
            "--agent" => a.agent = Some(val("--agent")?),
            "--pg-bin" => a.pg_bin = Some(PathBuf::from(val("--pg-bin")?)),
            "--port" => {
                a.port = Some(val("--port")?.parse().map_err(|_| CustodianError::new("cli.usage", "--port must be 1-65535"))?)
            }
            "--sql" => a.sql = Some(val("--sql")?),
            "--db" => a.db = Some(val("--db")?),
            "--shell" => a.shell = Some(val("--shell")?),
            "--qual-logging" => {
                a.qual_logging = Some(match val("--qual-logging")?.as_str() {
                    "on" => true,
                    "off" => false,
                    _ => return Err(CustodianError::new("cli.usage", "--qual-logging takes on or off")),
                })
            }
            "--all" => a.all = true,
            "--schema-dir" => a.schema_dir = Some(PathBuf::from(val("--schema-dir")?)),
            "--writer-version" => {
                a.writer_version =
                    Some(val("--writer-version")?.parse().map_err(|_| CustodianError::new("cli.usage", "--writer-version must be a positive integer"))?)
            }
            "--immediate" => a.immediate = true,
            "--force" => a.force = true,
            "--product" => a.product = true,
            "--out" => a.out = Some(PathBuf::from(val("--out")?)),
            "--from" => a.from = Some(PathBuf::from(val("--from")?)),
            "--timeout" => {
                a.timeout = Some(val("--timeout")?.parse().map_err(|_| CustodianError::new("cli.usage", "--timeout takes seconds"))?)
            }
            "-h" | "--help" => return Err(CustodianError::new("cli.usage", USAGE)),
            other => return Err(CustodianError::new("cli.usage", format!("unknown argument {other:?}\n{USAGE}"))),
        }
    }
    Ok(a)
}

/// The only commands `--product` runs: the engine bracket's lifecycle.
const PRODUCT_COMMANDS: [&str; 7] = ["status", "init", "start", "attach", "identify", "urls", "stop"];

fn bin(a: &Args, env: &Env) -> Result<PgBin> {
    let dir = match a.pg_bin.clone().or_else(|| env.get("ORGTREE_P03_PG_BIN").map(PathBuf::from)) {
        Some(d) => d,
        None => dev::default_bin(&dev::repo_home(env)?),
    };
    PgBin::locate(&dir)
}

fn identified(r: &guard::PrototypeRoot, b: &PgBin) -> Result<(cluster::RuntimeRecord, cluster::Identification)> {
    let (rt, id) = cluster::identify(r, b)?;
    if !id.identity_ok() {
        return Err(CustodianError::new("identity.mismatch", format!("{:?}", id.mismatches)));
    }
    Ok((rt, id))
}

fn run_migrate(a: &Args, r: &guard::PrototypeRoot, b: &PgBin) -> Result<Value> {
    let dir = a.schema_dir.clone().ok_or_else(|| CustodianError::new("cli.usage", "migrate needs --schema-dir <store-schema/migrations>"))?;
    let (rt, _) = identified(r, b)?;
    let report = migrate::migrate(b, &rt, &dir, a.writer_version.unwrap_or(1))?;
    Ok(json!({"migrate": report}))
}

fn run_check_writer(a: &Args, r: &guard::PrototypeRoot, b: &PgBin) -> Result<Value> {
    let w = a.writer_version.ok_or_else(|| CustodianError::new("cli.usage", "check-writer needs --writer-version N"))?;
    let (rt, _) = identified(r, b)?;
    let applied = migrate::read_applied(b, &rt)?;
    Ok(json!({"writer_version": w, "schema_min_writer": migrate::check_writer(&applied, w)?}))
}

fn stop_timeout(a: &Args) -> std::time::Duration {
    std::time::Duration::from_secs(a.timeout.unwrap_or(cluster::STOP_TIMEOUT_SECS))
}

enum Out {
    Json(Value),
    Text(String),
}

fn run_dev(a: &Args, env: &Env) -> Result<Out> {
    let home = dev::repo_home(env)?;
    let b = bin(a, env)?;
    let sub = a.sub.as_deref().unwrap_or("");
    if sub == "status" && a.all {
        return Ok(Out::Json(json!({"all": dev::status_all(env, &home, &b)?})));
    }
    let agent = a.agent.clone().ok_or_else(|| CustodianError::new("cli.usage", format!("dev {sub} needs --agent\n{USAGE}")))?;
    match sub {
        "up" => Ok(Out::Json(json!({"dev": dev::up(env, &home, &b, &agent, a.qual_logging)?}))),
        "down" => {
            let r = dev::root_for(env, &home, &agent)?;
            Ok(Out::Json(json!({"agent": agent, "stop": cluster::stop_with(&r, &b, a.immediate, a.force, stop_timeout(a))?})))
        }
        "status" => {
            let r = dev::root_for(env, &home, &agent)?;
            Ok(Out::Json(json!({
                "agent": agent,
                "root": r.path(),
                "port": dev::port_for(&agent),
                "qual_logging_configured": cluster::qual_logging_configured(&r),
                "cluster": cluster::state(&r, &b)?,
            })))
        }
        "env" => {
            let r = dev::root_for(env, &home, &agent)?;
            let (rt, _) = identified(&r, &b)?;
            Ok(Out::Text(dev::render_env(&cluster::urls(&r, &rt)?, a.shell.as_deref().unwrap_or("ps"))?))
        }
        "destroy" => {
            let r = dev::root_for(env, &home, &agent)?;
            cluster::destroy(&r, &b)?;
            Ok(Out::Json(json!({"destroyed": r.path()})))
        }
        "attach" => {
            let (rt, id) = cluster::attach(&dev::root_for(env, &home, &agent)?, &b)?;
            Ok(Out::Json(json!({"attached": true, "identification": id, "runtime": rt})))
        }
        "migrate" => Ok(Out::Json(run_migrate(a, &dev::root_for(env, &home, &agent)?, &b)?)),
        "check-writer" => Ok(Out::Json(run_check_writer(a, &dev::root_for(env, &home, &agent)?, &b)?)),
        other => Err(CustodianError::new("cli.usage", format!("unknown dev command {other:?}\n{USAGE}"))),
    }
}

fn run(a: Args) -> Result<Out> {
    let env = process_env();
    if a.command == "dev" {
        return run_dev(&a, &env);
    }
    let root_path = a.root.clone().ok_or_else(|| CustodianError::new("cli.usage", format!("--root is required\n{USAGE}")))?;
    if a.command == "init-root" {
        let r = guard::init_root(&root_path, &env)?;
        return Ok(Out::Json(json!({"root": r.path(), "root_id": r.root_id()})));
    }
    if a.command == "bind-product" {
        let r = guard::bind_product_root(&root_path, &env)?;
        return Ok(Out::Json(json!({"root": r.path(), "root_id": r.root_id(), "product": true})));
    }
    let r = if a.product {
        if !PRODUCT_COMMANDS.contains(&a.command.as_str()) {
            return Err(CustodianError::new("product.refused", format!("{:?} is not run with --product", a.command)));
        }
        guard::validate_product_root(&root_path, &env)?
    } else {
        guard::validate_root(&root_path, &env)?
    };
    let b = bin(&a, &env)?;
    let v = match a.command.as_str() {
        "init" => json!({"root": r.path(), "instance": cluster::init(&r, &b, &InitOptions::default())?}),
        "start" => {
            let rt = cluster::start(&r, &b, a.port)?;
            json!({"runtime": rt, "conninfo": rt.conninfo("postgres")})
        }
        "identify" => {
            let (rt, id) = identified(&r, &b)?;
            json!({"identity_ok": id.identity_ok(), "ready": id.ready(), "identification": id, "runtime": rt})
        }
        "status" => json!({
            "root": r.path(),
            "root_id": r.root_id(),
            "qual_logging_configured": cluster::qual_logging_configured(&r),
            "cluster": cluster::state(&r, &b)?,
        }),
        "attach" => {
            let (rt, id) = cluster::attach(&r, &b)?;
            json!({"attached": true, "identification": id, "runtime": rt})
        }
        "backup" => {
            let out = a.out.clone().ok_or_else(|| CustodianError::new("cli.usage", "backup needs --out <new folder>"))?;
            json!({"backup": backup::backup(&r, &b, &out, &env)?})
        }
        "restore" => {
            let from = a.from.clone().ok_or_else(|| CustodianError::new("cli.usage", "restore needs --from <backup folder>"))?;
            json!({"restore": backup::restore(&r, &b, &from)?})
        }
        "migrate" => run_migrate(&a, &r, &b)?,
        "check-writer" => run_check_writer(&a, &r, &b)?,
        "qual-logging" => {
            let on = a.qual_logging.ok_or_else(|| CustodianError::new("cli.usage", "qual-logging needs --qual-logging on|off"))?;
            json!({"changed": cluster::set_qual_logging(&r, &b, on)?, "qual_logging_configured": on})
        }
        "urls" => {
            let (rt, _) = identified(&r, &b)?;
            json!({"urls": cluster::urls(&r, &rt)?})
        }
        "psql" => {
            let sql = a.sql.clone().ok_or_else(|| CustodianError::new("cli.usage", "psql needs --sql"))?;
            let (rt, _) = identified(&r, &b)?;
            json!({"rows": cluster::psql(&b, &rt, a.db.as_deref().unwrap_or("postgres"), &sql)?})
        }
        "stop" => json!({"stop": cluster::stop_with(&r, &b, a.immediate, a.force, stop_timeout(&a))?}),
        "destroy" => {
            if let ClusterState::Running { .. } = cluster::state(&r, &b)? {
                return Err(CustodianError::new("destroy.running", "stop first"));
            }
            cluster::destroy(&r, &b)?;
            json!({"destroyed": r.path()})
        }
        other => return Err(CustodianError::new("cli.usage", format!("unknown command {other:?}\n{USAGE}"))),
    };
    Ok(Out::Json(v))
}

fn main() {
    match parse().and_then(run) {
        Ok(Out::Json(mut v)) => {
            v["ok"] = json!(true);
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
        }
        Ok(Out::Text(t)) => print!("{t}"),
        Err(e) => {
            println!("{}", serde_json::to_string_pretty(&json!({"ok": false, "code": e.code, "message": e.message})).unwrap());
            std::process::exit(1);
        }
    }
}
