//! Durable fair rotation for bounded held-resource checkups. A page boundary
//! is not a holding limit; timeout-disabled records must not pin the head.
use anyhow::Result;
use tokio_postgres::{GenericClient, Row};

pub(crate) const JOBS: &str = "checkup_jobs_after";
pub(crate) const SLOTS: &str = "checkup_slots_after";

#[logged]
pub(crate) async fn read(client: &impl GenericClient, sql: &str, boundary_sql: &str, agent: i64, key: &str) -> Result<Vec<Row>> {
    let upper_key = format!("{key}_upper");
    let cursor = client.query_one(
        "SELECT coalesce((extra->>$2::text)::bigint,0),coalesce((extra->>$3::text)::bigint,0) FROM ot.agents WHERE id=$1",
        &[&agent,&key,&upper_key],
    ).await?;
    let mut after: i64 = cursor.get(0);
    let mut upper: i64 = cursor.get(1);
    if upper == 0 || after >= upper {
        upper = begin(client,agent,key,&upper_key,boundary_sql).await?;
        after = 0;
    }
    let mut rows = client.query(sql, &[&agent,&after,&upper]).await?;
    if rows.is_empty() && upper != 0 {
        // Rows can have been acknowledged/released after the boundary was
        // captured. Finish that rotation without waiting for those IDs.
        upper = begin(client,agent,key,&upper_key,boundary_sql).await?;
        rows = client.query(sql, &[&agent,&0i64,&upper]).await?;
    }
    Ok(rows)
}

#[logged]
async fn begin(client: &impl GenericClient, agent: i64, key: &str, upper_key: &str, sql: &str) -> Result<i64> {
    let upper: i64 = client.query_one(sql,&[&agent]).await?.get(0);
    client.execute(
        "UPDATE ot.agents SET extra=extra||jsonb_build_object($2::text,0,$3::text,$4::bigint) WHERE id=$1",
        &[&agent,&key,&upper_key,&upper],
    ).await?;
    Ok(upper)
}

// Only metadata is needed by the caller; do not log a page of native rows.
#[nolog]
pub(crate) async fn advance(client: &impl GenericClient, agent: i64, key: &str, rows: &[Row]) -> Result<()> {
    let after: i64 = rows.last().map(|r| r.get(0)).unwrap_or(0);
    client.execute(
        "UPDATE ot.agents SET extra=jsonb_set(extra,ARRAY[$2::text],to_jsonb($3::bigint)) WHERE id=$1",
        &[&agent,&key,&after],
    ).await?;
    Ok(())
}
