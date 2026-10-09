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
    pub credential_bridge: crate::credential_bridge::Bridge,
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
    pub phone: crate::phone::Phone,
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

#[cfg(test)]
impl Engine {
    /// An engine for tests of code that only hands it along, its data folder
    /// `data_root`: no database (the pool connects to nothing until asked)
    /// and no probes of the machine.
    pub fn for_tests(data_root: std::path::PathBuf) -> EngineRef {
        use deadpool_postgres::{Manager, ManagerConfig, RecyclingMethod, Runtime};
        let mgr = Manager::from_config(tokio_postgres::Config::new(), tokio_postgres::NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
        let db = Pool::builder(mgr).max_size(1).runtime(Runtime::Tokio1).build().expect("an unconnected pool");
        let cfg = Config { data_root, data_root_id: String::new(), desktop_token: String::new(), ui_dir: None, parent_pid: None,
            pg_bin: None, exe_dir: std::path::PathBuf::new(), pg_bootstrap: false };
        Arc::new(Engine {
            cfg,
            db,
            boot: Boot { id: "test".into(), pid: std::process::id(), started_at: Utc::now(), port: 0 },
            credentials: crate::credential_context::CredentialContext::for_tests(),
            credential_bridge: crate::credential_bridge::Bridge::new(),
            shutdown: CancellationToken::new(),
            stopping: AtomicBool::new(false),
            orgs: Default::default(),
            agents: Default::default(),
            app: crate::appfeed::AppFeed::new().0,
            sched: crate::runtime::sched::Scheduler::new(1).0,
            settings: crate::settings::AppSettings::new(serde_json::json!({})),
            accounts: Default::default(),
            providers: Default::default(),
            hub: Default::default(),
            phone: Default::default(),
            dogs: Default::default(),
            usage: Default::default(),
            net: Default::default(),
        })
    }
}
