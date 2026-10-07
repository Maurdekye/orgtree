//! The engine context every task shares. Everything in here is either
//! immutable after start, lock-free (atomics, `ArcSwap`, lock-free maps), or
//! a handle to a task that owns its own state behind a channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use tokio_util::sync::CancellationToken;

use crate::config::Config;

pub struct Boot {
    /// Fresh per process: the renderer's restart detector and the feeds' epoch.
    pub id: String,
    pub pid: u32,
    pub started_at: DateTime<Utc>,
    pub port: u16,
}

pub struct Engine {
    pub cfg: Config,
    pub db: Pool,
    pub boot: Boot,
    pub credentials: crate::credential_context::CredentialContext,
    pub shutdown: CancellationToken,
    pub stopping: AtomicBool,
    pub orgs: crate::orgs::OrgDirectory,
    pub agents: crate::runtime::AgentRegistry,
    pub app: crate::appfeed::AppFeed,
    pub sched: crate::runtime::sched::Scheduler,
    pub settings: crate::settings::AppSettings,
    pub accounts: crate::accounts::Accounts,
    pub providers: crate::providers::Providers,
    pub hub: crate::mailhub::MailHub,
    pub dogs: crate::runtime::watchdogs::Registry,
    pub usage: crate::usage::Usage,
    pub net: crate::net::Net,
}

pub type EngineRef = Arc<Engine>;

#[logged]
impl Engine {
    #[nolog]
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub fn request_shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.shutdown.cancel();
    }

    pub async fn conn(&self) -> anyhow::Result<deadpool_postgres::Object> {
        Ok(self.db.get().await?)
    }
}
