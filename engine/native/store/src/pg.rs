//! The real [`Session`] over tokio-postgres, opened only through the
//! connection [`Factory`](crate::conn::Factory).
//!
//! Parameters are bound by the server-inferred type of each placeholder, so a
//! `Val::Null` is a NULL of whatever type the statement expects. Result
//! columns decode by type; families cast anything else (e.g. `pg_lsn`) to
//! text in SQL.

use std::error::Error as _;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::BytesMut;
use tokio::task::JoinHandle;
use tokio_postgres::types::{to_sql_checked, IsNull, ToSql, Type};
use tokio_postgres::{Client, NoTls, Row};

use crate::conn::Factory;
use crate::exec::Isolation;
use crate::session::{Connector, DbError, Session};
use crate::value::{Rows, Val};

fn map_err(e: tokio_postgres::Error) -> DbError {
    if let Some(db) = e.as_db_error() {
        return DbError::Sql { code: db.code().code().to_string(), constraint: db.constraint().map(str::to_string), message: db.message().to_string() };
    }
    // Everything else (closed socket, I/O, protocol) is a lost connection.
    // The message is the driver's own and never contains the password.
    DbError::ConnectionLost { message: e.source().map(|s| s.to_string()).unwrap_or_else(|| e.to_string()) }
}

fn ts_to_system(us: i64) -> SystemTime {
    if us >= 0 {
        UNIX_EPOCH + Duration::from_micros(us as u64)
    } else {
        UNIX_EPOCH - Duration::from_micros(us.unsigned_abs())
    }
}

fn system_to_ts(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_micros() as i64,
        Err(e) => -(e.duration().as_micros() as i64),
    }
}

#[derive(Debug)]
struct P<'a>(&'a Val);

impl ToSql for P<'_> {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self.0 {
            Val::Null => Ok(IsNull::Yes),
            Val::Bool(b) => b.to_sql(ty, out),
            Val::Int(i) => match *ty {
                Type::INT2 => i16::try_from(*i)?.to_sql(ty, out),
                Type::INT4 => i32::try_from(*i)?.to_sql(ty, out),
                Type::FLOAT8 => (*i as f64).to_sql(ty, out),
                Type::FLOAT4 => (*i as f32).to_sql(ty, out),
                _ => i.to_sql(ty, out),
            },
            Val::Text(s) => s.as_str().to_sql(ty, out),
            Val::Uuid(u) => u.to_sql(ty, out),
            Val::Json(j) => j.to_sql(ty, out),
            Val::Ts(us) => ts_to_system(*us).to_sql(ty, out),
        }
    }
    fn accepts(_ty: &Type) -> bool {
        true
    }
    to_sql_checked!();
}

fn decode(row: &Row) -> Result<Vec<Val>, DbError> {
    let mut out = Vec::with_capacity(row.len());
    for (i, col) in row.columns().iter().enumerate() {
        let bad = |e: tokio_postgres::Error| DbError::Sql { code: "XX000".into(), constraint: None, message: format!("decode column {}: {e}", col.name()) };
        let v = match *col.type_() {
            Type::BOOL => row.try_get::<_, Option<bool>>(i).map_err(bad)?.map(Val::Bool),
            Type::INT2 => row.try_get::<_, Option<i16>>(i).map_err(bad)?.map(|x| Val::Int(x as i64)),
            Type::INT4 => row.try_get::<_, Option<i32>>(i).map_err(bad)?.map(|x| Val::Int(x as i64)),
            Type::INT8 => row.try_get::<_, Option<i64>>(i).map_err(bad)?.map(Val::Int),
            Type::TEXT | Type::VARCHAR | Type::NAME | Type::BPCHAR => row.try_get::<_, Option<String>>(i).map_err(bad)?.map(Val::Text),
            Type::UUID => row.try_get::<_, Option<uuid::Uuid>>(i).map_err(bad)?.map(Val::Uuid),
            Type::JSON | Type::JSONB => row.try_get::<_, Option<serde_json::Value>>(i).map_err(bad)?.map(Val::Json),
            Type::TIMESTAMPTZ | Type::TIMESTAMP => row.try_get::<_, Option<SystemTime>>(i).map_err(bad)?.map(|t| Val::Ts(system_to_ts(t))),
            ref other => {
                return Err(DbError::Sql {
                    code: "XX000".into(),
                    constraint: None,
                    message: format!("column {} has unsupported type {other}; cast it in SQL", col.name()),
                })
            }
        };
        out.push(v.unwrap_or(Val::Null));
    }
    Ok(out)
}

pub struct PgSession {
    client: Client,
    task: JoinHandle<()>,
    pid: Option<i32>,
    start: Option<i64>,
    broken: bool,
}

impl PgSession {
    fn check(&mut self, e: DbError) -> DbError {
        if matches!(e, DbError::ConnectionLost { .. }) || self.client.is_closed() {
            self.broken = true;
        }
        e
    }
}

impl Drop for PgSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Session for PgSession {
    async fn begin(&mut self, iso: Isolation) -> Result<(), DbError> {
        let r = self.client.batch_execute(iso.begin_sql()).await.map_err(map_err);
        r.map_err(|e| self.check(e))
    }

    async fn exec(&mut self, _label: &str, sql: &str, params: &[Val]) -> Result<Rows, DbError> {
        let ps: Vec<P<'_>> = params.iter().map(P).collect();
        let refs: Vec<&(dyn ToSql + Sync)> = ps.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
        let r = self.client.query(sql, &refs).await.map_err(map_err);
        match r {
            Ok(rows) => Ok(Rows(rows.iter().map(decode).collect::<Result<_, _>>()?)),
            Err(e) => Err(self.check(e)),
        }
    }

    async fn commit(&mut self) -> Result<(), DbError> {
        let r = self.client.batch_execute("COMMIT").await.map_err(map_err);
        r.map_err(|e| self.check(e))
    }

    async fn rollback(&mut self) -> Result<(), DbError> {
        let r = self.client.batch_execute("ROLLBACK").await.map_err(map_err);
        r.map_err(|e| self.check(e))
    }

    fn drop_connection(&mut self) {
        self.task.abort();
        self.broken = true;
    }

    fn backend_pid(&self) -> Option<i32> {
        self.pid
    }

    fn backend_start(&self) -> Option<i64> {
        self.start
    }

    fn is_broken(&self) -> bool {
        self.broken || self.client.is_closed()
    }
}

const IDENTIFY_SQL: &str = "SELECT pg_backend_pid(), (extract(epoch FROM backend_start) * 1000000)::bigint \
     FROM pg_stat_activity WHERE pid = pg_backend_pid()";

impl Connector for Factory {
    type S = PgSession;

    async fn connect(&self) -> Result<PgSession, DbError> {
        let mut c = tokio_postgres::Config::new();
        c.host(&self.cfg.host)
            .port(self.cfg.port)
            .user(&self.cfg.role)
            .password(self.cfg.password.expose())
            .dbname(&self.cfg.database)
            .application_name(self.purpose)
            .connect_timeout(Duration::from_secs(10));
        let (client, connection) = c.connect(NoTls).await.map_err(map_err)?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let row = client
            .query_one(IDENTIFY_SQL, &[])
            .await
            .map_err(map_err)?;
        let pid: i32 = row.get(0);
        let start: i64 = row.get(1);
        self.register(Some(pid), Some(start));
        // The identification query is the factory's own statement on this
        // session: trace it as infrastructure so the server-log
        // reconciliation (Q-C5) can match it.
        self.traced_setup("exec.setup.identify", IDENTIFY_SQL);
        Ok(PgSession { client, task, pid: Some(pid), start: Some(start), broken: false })
    }
}
