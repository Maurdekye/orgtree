//! The REAL Q-C5 control on a WS1 dev cluster (r7 Q-C5; lead ruling, decision 3):
//! a hidden statement on a REGISTERED POOLED executor connection, between two
//! traced operations, must be flagged against that exact session by the server
//! statement log. This test only PRODUCES the evidence; the verdict is
//! `tools/p03/probes/qc5_live_check.py`, which reconciles it with
//! `tools/p03/harness/serverlog.py`.
//!
//! Two scenarios, each bracketed in the server log by marker statements from the
//! harness's own admin session (which the checker excludes by its session id):
//! - `clean`: nothing armed; the log must reconcile with the trace (the positive
//!   control: without it a "detection" could be noise);
//! - `hidden`: `Q-C5.hidden_pooled_statement` armed (WS2: an untraced `SELECT 1`
//!   on the checked-out pooled connection before the attempt's BEGIN, recording
//!   `control_executed`), pool size 1, two operations on one pid.
//!
//! `#[ignore]`: run ONLY through the P03 run lock, with P03_PG_ADMIN_URL,
//! P03_PG_RUNTIME_URL from `devdb.cmd env` (cluster started `--qual-logging on`)
//! and P03_WS7_OUT naming an output directory. A missing variable PANICS: a
//! skipped DB test must never read as a pass. It rebuilds the `public` schema, so
//! it refuses any cluster whose data directory is not this agent's disposable one.
#![cfg(feature = "sink")]

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::{ControlPlan, Hooks};
use orgtree_store::{
    Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity,
    Principal, Refusal, Session, Tx, Uuid, Val,
};
use orgtree_store_trace::sink::Collector;

const OWN_CLUSTER: &str = "\\artifacts\\p03-db\\p02-contacts-opus55\\";
const CONTROL: &str = "Q-C5.hidden_pooled_statement";

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set: this DB test did NOT run"))
}

fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0701)
}
fn agent() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_07a1)
}
fn incarnation() -> Uuid {
    Uuid::from_u128(0x7c)
}

// ---- the command: WS2's SetStatus shape (tests/pg.rs), anchor + own-row lock + write + intent

static STATUS: Family = Family { name: "status", isolation: Isolation::ReadCommitted, retry_unique: &[] };
const ANCHOR: &str = "SELECT lifecycle, generation FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
const LOCK_OWN: &str = "SELECT version FROM runtime_state WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
const UPDATE: &str = "UPDATE runtime_state SET status = $3, version = version + 1, \
     updated_at = to_timestamp($4::double precision / 1000000) WHERE org_id = $1 AND principal_id = $2 RETURNING version";
const INTENT: &str = "INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
     VALUES ($1, gen_random_uuid(), 'notify', $2, NULL, now(), now())";

struct SetStatus(&'static str);

impl Command for SetStatus {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &STATUS
    }
    fn verb(&self) -> &'static str {
        "set"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let Principal::Agent { id, .. } = b.principal else { return Err(CmdError::Defect("agent only".into())) };
        tx.exec("status.anchor", ANCHOR, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let Principal::Agent { id, .. } = b.principal else { return Ok(Decided::Refused(Refusal::new("x", "x"))) };
        tx.exec("status.lock_own", LOCK_OWN, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        let now = tx.now().await?;
        let rows = tx
            .exec("status.update", UPDATE, &[Val::Uuid(b.op.org), Val::Uuid(id), Val::text(self.0), Val::Int(now)])
            .await?;
        tx.exec("status.intent", INTENT, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        Ok(Decided::Applied(rows.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(-1)))
    }
}

fn binding(k: &str, tag: &str) -> Binding {
    Binding {
        principal: Principal::Agent { id: agent(), generation: 3 },
        acting: None,
        op: OpIdentity {
            org: org(),
            ns: KeyNamespace::Agent { principal: agent() },
            key: k.into(),
            fingerprint: format!("fp-{k}"),
            fingerprint_codec: "legacy-1",
            caller_keyed: true,
        },
        db_incarnation: incarnation(),
        op_tag: Some(tag.into()),
    }
}

fn key() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    format!("{ms}-{}", &Uuid::new_v4().simple().to_string()[..24])
}

struct Arm(Vec<&'static str>);
impl ControlPlan for Arm {
    fn armed(&self, id: &str, _: &OpIdentity, _: Option<&str>) -> bool {
        self.0.contains(&id)
    }
}

async fn admin() -> tokio_postgres::Client {
    let (c, conn) = tokio_postgres::connect(&var("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.expect("admin connect");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    c
}

/// Rebuild the schema from the migrations and seed one org, agent, epoch and runtime row.
async fn reset(a: &tokio_postgres::Client) {
    let dir: String = a.query_one("SHOW data_directory", &[]).await.unwrap().get(0);
    assert!(
        dir.replace('/', "\\").to_ascii_lowercase().contains(&OWN_CLUSTER.to_ascii_lowercase()),
        "refusing to rebuild a cluster that is not this agent's disposable one: {dir}"
    );
    a.batch_execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").await.unwrap();
    for m in orgtree_store_schema::MIGRATIONS {
        let sql = orgtree_store_schema::normalized(m.sql);
        a.batch_execute(&format!("BEGIN;\n{sql}\nCOMMIT;")).await.unwrap_or_else(|e| panic!("{}: {e:?}", m.file));
    }
    a.execute("INSERT INTO store_incarnation (database_id, incarnation) VALUES ($1, $2)", &[&Uuid::from_u128(0xdb), &incarnation()])
        .await
        .unwrap();
    a.batch_execute(&format!(
        "INSERT INTO organizations (org_id, slug, created_at) VALUES ('{o}', 'p03-ws7-qc5', now());
         INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{g}', 'ws7', gen_random_uuid(), 'opus', now());
         INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{g}', 'live', 3);
         INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ('{o}', '{g}', now());",
        o = org(),
        g = agent()
    ))
    .await
    .unwrap();
}

async fn session_id(a: &tokio_postgres::Client) -> String {
    a.query_one(
        "SELECT to_hex(floor(extract(epoch FROM backend_start))::bigint) || '.' || to_hex(pid) \
         FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        &[],
    )
    .await
    .unwrap()
    .get(0)
}

async fn scenario(name: &str, armed: Vec<&'static str>, known: &BTreeSet<String>, a: &tokio_postgres::Client, out: &PathBuf) {
    let nonce = Uuid::new_v4().simple().to_string();
    // literal markers: the checker takes the server-log lines between them
    a.batch_execute(&format!("SELECT 'p03-ws7-qc5-start-{name}-{nonce}'")).await.unwrap();
    let c = Arc::new(Collector::new(&format!("qc5-{name}"), 1 << 16, &format!("qc5-{name}-{nonce}"), known.clone()));
    let mut h = Hooks::with_trace(c.clone());
    h.controls = Some(Arc::new(Arm(armed)));
    let cfg = PgConfig::from_url(&var("P03_PG_RUNTIME_URL")).unwrap();
    {
        let ex = Executor::new(
            Factory::new(cfg.clone(), "executor", h.clone()),
            1, // ONE pooled connection: both operations run on the same pid
            Factory::new(cfg, "lookup", h.clone()),
            1,
            ExecConfig { max_attempts: 3, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5) },
            h,
        );
        for (i, tag) in ["A", "B"].iter().enumerate() {
            let o = ex.run(&SetStatus(if i == 0 { "one" } else { "two" }), &binding(&key(), tag)).await;
            assert!(o.is_ok(), "{name}: operation {tag} failed: {o:?}");
        }
    } // the executor and its pool close here
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.batch_execute(&format!("SELECT 'p03-ws7-qc5-end-{name}-{nonce}'")).await.unwrap();
    let mut records = c.drain();
    records.extend(c.end(true));
    let lines: Vec<String> = records.iter().map(|r| r.to_json()).collect();
    std::fs::write(out.join(format!("{name}.records.jsonl")), lines.join("\n") + "\n").unwrap();
    let meta = format!(
        "{{\"scenario\":\"{name}\",\"nonce\":\"{nonce}\",\"armed\":[{}],\"admin_session\":\"{}\",\"stream\":\"qc5-{name}\"}}",
        if name == "hidden" { format!("\"{CONTROL}\"") } else { String::new() },
        session_id(a).await
    );
    std::fs::write(out.join(format!("{name}.meta.json")), meta).unwrap();
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster with --qual-logging on; run through p03-run.ps1"]
async fn qc5_hidden_pooled_statement_evidence() {
    let out = PathBuf::from(var("P03_WS7_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let a = admin().await;
    reset(&a).await;
    let known: BTreeSet<String> = a
        .query("SELECT tablename::text FROM pg_tables WHERE schemaname = 'public'", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    assert!(known.contains("runtime_state") && known.contains("operation_receipts"), "{known:?}");
    scenario("clean", vec![], &known, &a, &out).await;
    scenario("hidden", vec![CONTROL], &known, &a, &out).await;
}
