//! First-start import of the 3.x data (per-org databases) into the new
//! schema. The old databases are only read; nothing in them changes.

use anyhow::Result;
use deadpool_postgres::Pool;

use crate::config::Config;
use crate::pg::Cluster;

pub async fn run_if_needed(_cfg: &Config, _cluster: &Cluster, _pool: &Pool, _progress: &dyn Fn(&str)) -> Result<()> {
    Ok(())
}
