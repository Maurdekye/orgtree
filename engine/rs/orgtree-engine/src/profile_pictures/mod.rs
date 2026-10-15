//! Organization-owned pictures. Bytes have a dedicated bounded meta record and
//! never enter the agent tree, net identity document or automatic trace values.
pub mod wire;
pub mod image;
use crate::engine::Engine;
use wire::PictureRecord;

#[derive(Debug,thiserror::Error)]
pub enum Error { #[error("{0}")] Invalid(String) }
pub type Result<T> = std::result::Result<T,Error>;

#[nolog]
pub fn key(org:i64)->String { format!("org.picture.{org}") }

#[nolog]
pub async fn load(engine:&Engine,org:i64)->anyhow::Result<Option<PictureRecord>> {
    let c=engine.db.get().await?;
    load_in(&**c,org).await
}

#[nolog]
pub(crate) async fn load_in<C:tokio_postgres::GenericClient+Sync>(c:&C,org:i64)->anyhow::Result<Option<PictureRecord>> {
    let row=c.query_opt("SELECT value FROM ot.meta WHERE key=$1",&[&key(org)]).await?;
    row.map(|r|serde_json::from_value(r.get(0))).transpose().map_err(Into::into)
}

/// The org row serializes local edits and incoming revision merges, including
/// the missing-first-record case. No decoding or network IO holds the row lock.
#[nolog]
pub async fn save(engine:&Engine,org:i64,mut incoming:PictureRecord,explicit:bool)->anyhow::Result<PictureRecord> {
    incoming.decoded()?;
    let mut c=engine.db.get().await?;
    let tx=c.transaction().await?;
    tx.query_one("SELECT id FROM ot.orgs WHERE id=$1 FOR UPDATE",&[&org]).await?;
    let before=load_in(&*tx,org).await?;
    incoming=save_in(&tx,org,incoming,explicit).await?;
    tx.commit().await?;
    if before.as_ref()!=Some(&incoming) { published(engine,org); }
    Ok(incoming)
}

/// Same mutation for HTTP, network merges and the atomic Logo journal.
/// Payload-bearing helpers deliberately never emit automatic trace values.
/// Callers validate before acquiring locks; journal restores use the already
/// validated normalized snapshots. No native image decode occurs here.
#[nolog]
pub(crate) async fn save_in(tx:&tokio_postgres::Transaction<'_>,org:i64,mut incoming:PictureRecord,explicit:bool)->anyhow::Result<PictureRecord> {
    if tx.query_opt("SELECT id FROM ot.orgs WHERE id=$1 AND state='active' FOR UPDATE",&[&org]).await?.is_none() {
        crate::refuse!(NotFound,"organization is no longer active");
    }
    let old:Option<PictureRecord>=tx.query_opt("SELECT value FROM ot.meta WHERE key=$1",&[&key(org)]).await?
        .map(|r|serde_json::from_value(r.get(0))).transpose()?;
    if explicit { incoming.meta.revision=wire::next_revision(old.as_ref().map(|r|&r.meta))?; }
    if let Some(old)=old {
        if old.meta.revision>=incoming.meta.revision { return Ok(old); }
    }
    tx.execute("INSERT INTO ot.meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",&[&key(org),&serde_json::to_value(&incoming)?]).await?;
    Ok(incoming)
}

#[logged]
pub(crate) fn published(engine:&Engine,org:i64) {
    if let Some(o)=engine.orgs.by_id(org) { crate::changes::notify(engine,&o,vec![crate::changes::Change::Net]); }
    crate::net::kick(engine);
}
