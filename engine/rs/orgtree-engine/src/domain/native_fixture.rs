//! Test-only admission for disposable native proof inputs. Never log credentials.
use anyhow::{ensure, Context, Result};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use tokio_postgres::{Config, NoTls, config::Host};

#[derive(Clone)]
struct Inputs { owner: String, home: String, root: String, output: String, url: String, org: String }

#[nolog]
impl Inputs {
    fn from_env() -> Result<Self> {
        let read = |key| std::env::var(key).with_context(|| format!("missing synthetic input {key}"));
        Ok(Self { owner: read("ORGTREE_AGENT")?, home: read("ORGTREE_RIG_HOME")?,
            root: read("ORGTREE_CLAIM_TEST_ROOT")?, output: read("ORGTREE_CLAIM_TEST_OUTPUT")?,
            url: read("ORGTREE_CLAIM_TEST_URL")?, org: read("ORGTREE_CLAIM_TEST_ORG")? })
    }
}

pub(crate) struct Fixture { pub cfg: Config, pub org: i64, root: PathBuf, output: PathBuf }

#[nolog]
fn owned_path(path: &Path, base: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "synthetic path must be absolute");
    ensure!(!path.components().any(|c| matches!(c, Component::ParentDir)), "synthetic path traversal");
    // Reject junctions as well as symlinks before canonicalization or writes.
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).context("missing synthetic path")?;
        ensure!(!metadata.file_type().is_symlink(), "synthetic symlink refused");
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            ensure!(metadata.file_attributes() & 0x400 == 0, "synthetic reparse point refused");
        }
    }
    let canonical = path.canonicalize().context("canonical synthetic path")?;
    ensure!(canonical.starts_with(base.canonicalize().context("missing owned synthetic base")?), "outside owned synthetic base");
    Ok(canonical)
}

#[nolog]
fn json_file(path: &Path, base: &Path) -> Result<Value> {
    let file = owned_path(path, base)?;
    Ok(serde_json::from_slice(&std::fs::read(file).context("read synthetic metadata")?).context("invalid synthetic metadata")?)
}

#[nolog]
fn require_loopback(cfg: &Config) -> Result<()> {
    ensure!(matches!(cfg.get_hosts(), [Host::Tcp(host)] if host == "127.0.0.1"), "database must use explicit loopback only");
    Ok(())
}

#[nolog]
impl Fixture {
    fn validate(input: &Inputs) -> Result<Self> {
        ensure!(!input.owner.is_empty() && input.owner.len() <= 64 && input.owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "invalid synthetic owner");
        let owned_rig = Path::new("D:/orgtree-work/rig").join(&input.owner);
        let owned_build = Path::new("C:/orgtree-build").join(&input.owner);
        let home = owned_path(Path::new(&input.home), &owned_rig)?;
        let root = owned_path(Path::new(&input.root), &owned_rig)?;
        ensure!(root.parent() == Some(home.join("runs").as_path()), "root must be a direct run in the owned rig home");
        let output = owned_path(Path::new(&input.output), &owned_build)?;
        ensure!(output != owned_build.canonicalize()?, "output must be a private phase below the owned build scope");
        let run = json_file(&root.join("run.json"), &root)?;
        ensure!(run["by"].as_str() == Some(input.owner.as_str()) && run["status"] == "ready", "run owner/state mismatch");
        ensure!(run["realCli"] != true && run["realMuse"] != true && run["realOpenCode"] != true, "real provider run refused");
        let id = root.file_name().and_then(|s| s.to_str()).context("run identity")?;
        ensure!(run["id"].as_str() == Some(id), "run identity mismatch");
        let data = owned_path(&root.join("data"), &root)?;
        ensure!(owned_path(Path::new(run["data"].as_str().context("missing run data")?), &root)? == data, "run data mismatch");
        let marker = json_file(&data.join(".orgtree-rig-root"), &root)?;
        ensure!(marker["rig"] == 1 && marker["run"].as_str() == Some(id), "missing disposable rig marker");
        let cfg: Config = input.url.parse().map_err(|_| anyhow::anyhow!("invalid synthetic database config"))?;
        ensure!(cfg.get_dbname() == Some("orgtree_engine") && cfg.get_user() == Some("orgtree_admin"), "non-disposable database/user refused");
        require_loopback(&cfg)?;
        ensure!(cfg.get_options().is_none(), "database options refused");
        let cluster = data.join("pg/cluster");
        let attach = json_file(&cluster.join("pg-attach.json"), &root)?;
        let port = attach["port"].as_u64().filter(|p| *p > 0 && *p <= u16::MAX as u64).context("invalid scratch port")? as u16;
        ensure!(cfg.get_ports() == [port], "database port is not the owned rig port");
        let credentials = json_file(&cluster.join("secrets/credentials.json"), &root)?;
        let password = credentials["orgtree_admin"].as_str().filter(|s| !s.is_empty()).context("missing scratch credentials")?;
        ensure!(cfg.get_password() == Some(password.as_bytes()), "database credentials are not the owned rig credentials");
        let org = input.org.parse::<i64>().context("invalid synthetic org")?;
        ensure!(org > 0, "invalid synthetic org");
        Ok(Self { cfg, org, root, output })
    }

    pub async fn from_env() -> Self {
        let fixture = Self::validate(&Inputs::from_env().expect("explicit synthetic inputs")).expect("owned synthetic fixture");
        let (client, connection) = fixture.cfg.connect(NoTls).await.expect("owned scratch connection");
        let task = tokio::spawn(async move { connection.await });
        let server: String = client.query_one("SHOW data_directory", &[]).await.expect("scratch server identity").get(0);
        let expected = owned_path(&fixture.root.join("data/pg/cluster/data"), &fixture.root).expect("owned scratch cluster");
        assert_eq!(owned_path(Path::new(&server), &fixture.root).expect("server must use owned disposable cluster"), expected);
        drop(client); task.await.expect("scratch connection task").expect("scratch connection closed");
        fixture
    }

    pub fn engine_root(&self, name: &str) -> PathBuf {
        assert!(!name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        let path = self.output.join(name);
        if !path.exists() { std::fs::create_dir(&path).expect("create owned engine fixture"); }
        owned_path(&path, &self.output).expect("owned engine output")
    }

    pub fn migration_file(&self) -> PathBuf {
        let path = std::env::var("ORGTREE_V433_MIGRATIONS").expect("explicit owned migration input");
        self.input_file(Path::new(&path)).expect("owned migration input")
    }

    fn input_file(&self, path: &Path) -> Result<PathBuf> {
        let path = owned_path(path, &self.output)?;
        ensure!(path.is_file(), "migration input must be a file");
        Ok(path)
    }
}

#[test]
#[nolog]
fn hostaddr_override_is_rejected_without_connecting() {
    let mut cfg: Config = "host=127.0.0.1 port=12345 user=orgtree_admin dbname=orgtree_engine".parse().unwrap();
    require_loopback(&cfg).expect("host-only loopback is admitted");
    cfg.hostaddr("192.0.2.1".parse().unwrap());
    assert!(require_loopback(&cfg).is_err(), "hostaddr overrides host before server identity can be checked");
}

#[tokio::test]
#[ignore = "requires supplied owned synthetic metadata, never connects"]
#[nolog]
async fn rejects_invalid_inputs() {
    let good = Inputs::from_env().unwrap();
    let fixture = Fixture::validate(&good).unwrap();
    let mut bad = good.clone(); bad.owner.clear(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.owner = "other-owner".into(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.root = "C:/Windows".into(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.root = std::env::var("APPDATA").unwrap_or_default(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.output = "C:/orgtree-build/other-owner".into(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.output.clear(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.url.clear(); assert!(Fixture::validate(&bad).is_err());
    let mut bad = good.clone(); bad.url.push_str(" password=wrong"); assert!(Fixture::validate(&bad).is_err());
    assert!(fixture.input_file(Path::new("C:/Windows")).is_err());
    assert!(fixture.input_file(&fixture.output).is_err());
    for url in ["host=192.0.2.1 user=orgtree_admin dbname=orgtree_engine", "host=127.0.0.1 user=postgres dbname=postgres", "host=127.0.0.1 user=orgtree_admin dbname=orgtree_engine port=1"] {
        let mut bad = good.clone(); bad.url = url.into(); assert!(Fixture::validate(&bad).is_err());
    }
}
