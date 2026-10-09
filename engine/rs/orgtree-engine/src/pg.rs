//! The bundled PostgreSQL cluster: start it as our own child, create it on a
//! fresh data root, stop it cleanly, and hand out a connection pool.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio_postgres::NoTls;

use crate::config::Config;
use crate::winproc;

pub const ENGINE_DB: &str = "orgtree_engine";
pub const ADMIN_ROLE: &str = "orgtree_admin";

pub struct Cluster {
    pub data_dir: PathBuf,
    pub cluster_dir: PathBuf,
    pub bin: PathBuf,
    pub port: u16,
    pub password: String,
    child: Option<Child>,
}

#[logged]
impl Cluster {
    fn tool(&self, name: &str) -> PathBuf {
        self.bin.join(crate::util::exe_name(name))
    }

    #[nolog]
    pub fn connect_config(&self, db: &str) -> tokio_postgres::Config {
        let mut c = tokio_postgres::Config::new();
        c.host("127.0.0.1")
            .port(self.port)
            .user(ADMIN_ROLE)
            .password(self.password.clone())
            .dbname(db)
            .application_name("orgtree-engine")
            .connect_timeout(Duration::from_secs(10))
            .keepalives(true);
        c
    }

    /// Locate (or, on a fresh root that allows it, create) the cluster and
    /// start postgres.exe as a child of this process.
    pub async fn start(cfg: &Config, progress: &dyn Fn(&str)) -> Result<Cluster> {
        let bin = cfg
            .pg_bin
            .clone()
            .ok_or_else(|| anyhow!("PostgreSQL binaries not found (set ORGTREE_P03_PG_BIN)"))?;
        if !bin.join(crate::util::exe_name("postgres")).is_file() {
            bail!("{} not found in {}", crate::util::exe_name("postgres"), bin.display());
        }
        let cluster_dir = cfg.data_root.join("pg").join("cluster");
        let data_dir = cluster_dir.join("data");
        let creds_file = cluster_dir.join("secrets").join("credentials.json");
        if !data_dir.join("PG_VERSION").is_file() {
            if !cfg.pg_bootstrap && std::env::var("ORGTREE_ENGINE_ALLOW_INITDB").as_deref() != Ok("1") {
                bail!(
                    "no PostgreSQL cluster at {} and this launch may not create one",
                    data_dir.display()
                );
            }
            progress("database-init");
            initdb(&bin, &cluster_dir, &data_dir, &creds_file).await?;
        }
        let password = read_password(&creds_file)?;
        let port = pick_pg_port(&cluster_dir);
        clear_stale_postmaster_pid(&data_dir)?;
        let log_dir = cluster_dir.join("log");
        std::fs::create_dir_all(&log_dir).ok();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("postgres.log"))
            .context("could not open the PostgreSQL log")?;
        let log2 = log.try_clone()?;
        let mut cmd = Command::new(bin.join(crate::util::exe_name("postgres")));
        cmd.arg("-D")
            .arg(&data_dir)
            .arg("-p")
            .arg(port.to_string())
            .args(["-c", "listen_addresses=127.0.0.1"])
            .args(["-c", "max_connections=200"])
            .args(["-c", "shared_buffers=512MB"])
            .args(["-c", "jit=off"])
            .args(["-c", "max_wal_size=2GB"])
            .args(["-c", "checkpoint_timeout=15min"])
            .args(["-c", "logging_collector=off"])
            .args(["-c", "log_min_duration_statement=2000"]);
        // Unix: TCP only. No socket file, so nothing clashes with a system
        // PostgreSQL's socket directory (or needs /var/run/postgresql).
        #[cfg(unix)]
        cmd.args(["-c", "unix_socket_directories="]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2))
            .kill_on_drop(false);
        winproc::no_window(&mut cmd);
        // start() runs inside run(), the future main() drives with block_on on
        // the main thread, so the death signal is tied to the process.
        winproc::die_with_engine(&mut cmd);
        progress("database-start");
        let child = cmd.spawn().context("could not start postgres")?;
        let mut cluster = Cluster { data_dir, cluster_dir, bin, port, password, child: Some(child) };
        cluster.wait_ready(progress).await?;
        cluster.write_attach();
        Ok(cluster)
    }

    async fn wait_ready(&mut self, progress: &dyn Fn(&str)) -> Result<()> {
        let started = Instant::now();
        let mut last_progress = Instant::now();
        loop {
            match self.connect_config("postgres").connect(NoTls).await {
                Ok((client, conn)) => {
                    let task = tokio::spawn(conn);
                    let ok = client.simple_query("SELECT 1").await.is_ok();
                    drop(client);
                    task.abort();
                    if ok {
                        return Ok(());
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    // "the database system is starting up" / recovery: keep waiting
                    if started.elapsed() > Duration::from_secs(3600) {
                        bail!("PostgreSQL did not become ready: {msg}");
                    }
                }
            }
            if let Some(child) = self.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    bail!(
                        "postgres.exe exited during startup ({status}); see {}",
                        self.cluster_dir.join("log").join("postgres.log").display()
                    );
                }
            }
            if last_progress.elapsed() > Duration::from_secs(10) {
                progress("database-recovery");
                last_progress = Instant::now();
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    fn write_attach(&self) {
        let pid = self.child.as_ref().and_then(|c| c.id()).unwrap_or(0);
        let doc = json!({
            "schema": "orgtree.engine-pg/v1",
            "host": "127.0.0.1",
            "port": self.port,
            "postmaster_pid": pid,
            "admin_role": ADMIN_ROLE,
            "pgpass_file": self.cluster_dir.join("secrets").join("pgpass.conf"),
            "started_by": "orgtree-engine",
            "started_at_unix": chrono::Utc::now().timestamp(),
        });
        let _ = std::fs::write(
            self.cluster_dir.join("pg-attach.json"),
            serde_json::to_vec_pretty(&doc).unwrap_or_default(),
        );
    }

    /// Fast shutdown: active transactions roll back, the cluster checkpoints.
    pub async fn stop(&mut self) {
        let mut cmd = Command::new(self.tool("pg_ctl"));
        cmd.arg("-D").arg(&self.data_dir).args(["stop", "-m", "fast", "-w", "-t", "30"]);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        winproc::no_window(&mut cmd);
        let stopped = match cmd.status().await {
            Ok(s) => s.success(),
            Err(_) => false,
        };
        if let Some(mut child) = self.child.take() {
            if !stopped {
                let _ = child.start_kill();
            }
            let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
        }
    }

    pub async fn ensure_database(&self, db: &str) -> Result<()> {
        let (client, conn) = self.connect_config("postgres").connect(NoTls).await?;
        let task = tokio::spawn(conn);
        let exists = client
            .query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&db])
            .await?
            .is_some();
        if !exists {
            client
                .batch_execute(&format!(
                    "CREATE DATABASE {db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
                ))
                .await
                .context("could not create the engine database")?;
        }
        drop(client);
        task.abort();
        Ok(())
    }

    pub fn pool(&self, db: &str, max: usize) -> Result<Pool> {
        let mgr = Manager::from_config(
            self.connect_config(db),
            NoTls,
            ManagerConfig { recycling_method: RecyclingMethod::Fast },
        );
        Pool::builder(mgr)
            .max_size(max)
            .wait_timeout(Some(Duration::from_secs(30)))
            .create_timeout(Some(Duration::from_secs(10)))
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .build()
            .map_err(|e| anyhow!("pool: {e}"))
    }
}

fn read_password(creds: &Path) -> Result<String> {
    let raw = std::fs::read_to_string(creds)
        .with_context(|| format!("could not read {}", creds.display()))?;
    let v: serde_json::Value = serde_json::from_str(&raw).context("credentials.json is not JSON")?;
    v.get(ADMIN_ROLE)
        .and_then(|p| p.as_str())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("credentials.json has no {ADMIN_ROLE} entry"))
}

#[logged]
fn pick_pg_port(cluster_dir: &Path) -> u16 {
    let preferred = std::fs::read_to_string(cluster_dir.join("pg-attach.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .map(|p| p as u16);
    let free = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
    if let Some(p) = preferred {
        if p >= 1024 && free(p) {
            return p;
        }
    }
    // let the OS choose
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(55433)
}

#[logged]
fn clear_stale_postmaster_pid(data_dir: &Path) -> Result<()> {
    let pidfile = data_dir.join("postmaster.pid");
    let Ok(text) = std::fs::read_to_string(&pidfile) else { return Ok(()) };
    let pid: u32 = text.lines().next().and_then(|l| l.trim().parse().ok()).unwrap_or(0);
    if pid != 0 && winproc::process_alive(pid) && is_postgres(pid) {
        bail!("another PostgreSQL (pid {pid}) is already running on this cluster");
    }
    std::fs::remove_file(&pidfile).ok();
    Ok(())
}

#[cfg(windows)]
#[logged]
fn is_postgres(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        ok != 0 && String::from_utf16_lossy(&buf[..len as usize]).to_lowercase().ends_with("postgres.exe")
    }
}

/// Linux: the process name in /proc (`comm`) is `postgres` for the postmaster.
#[cfg(target_os = "linux")]
#[logged]
fn is_postgres(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|c| c.trim() == "postgres").unwrap_or(false)
}

/// macOS: the executable path the kernel reports for the pid ends in `/postgres`.
#[cfg(target_os = "macos")]
#[logged]
fn is_postgres(pid: u32) -> bool {
    let Ok(pid) = libc::c_int::try_from(pid) else { return false };
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    n > 0 && buf[..n as usize].ends_with(b"/postgres")
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
#[logged]
fn is_postgres(_pid: u32) -> bool {
    true
}

#[logged]
async fn initdb(bin: &Path, cluster_dir: &Path, data_dir: &Path, creds_file: &Path) -> Result<()> {
    use rand::RngCore;
    let secrets = cluster_dir.join("secrets");
    std::fs::create_dir_all(&secrets)?;
    // Unix: the secrets folder is owner-only (0700), so the password files in
    // it are unreadable to other local users whatever their own mode.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let admin_pw = hex::encode(raw);
    rand::thread_rng().fill_bytes(&mut raw);
    let runtime_pw = hex::encode(raw);
    let pwfile = secrets.join(".initdb-pw.tmp");
    std::fs::write(&pwfile, &admin_pw)?;
    let mut cmd = Command::new(bin.join(crate::util::exe_name("initdb")));
    cmd.arg("-D")
        .arg(data_dir)
        .arg("-U")
        .arg(ADMIN_ROLE)
        .arg(format!("--pwfile={}", pwfile.display()))
        .args(["-A", "scram-sha-256", "-E", "UTF8", "--locale=C", "--no-instructions"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    winproc::no_window(&mut cmd);
    let out = cmd.output().await.context("could not run initdb")?;
    std::fs::remove_file(&pwfile).ok();
    if !out.status.success() {
        bail!("initdb failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let creds = json!({ ADMIN_ROLE: admin_pw, "orgtree_runtime": runtime_pw });
    std::fs::write(creds_file, serde_json::to_vec_pretty(&creds)?)?;
    std::fs::write(
        secrets.join("pgpass.conf"),
        format!("127.0.0.1:*:*:{ADMIN_ROLE}:{admin_pw}\n127.0.0.1:*:*:orgtree_runtime:{runtime_pw}\n"),
    )?;
    Ok(())
}
