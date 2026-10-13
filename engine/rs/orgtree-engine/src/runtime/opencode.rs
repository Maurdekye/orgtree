//! OpenCode 2.x configuration for the generic ACP client. There is no hosted
//! OpenCode account here: the selected Orgtree provider supplies every model call.
//! Config is process environment only; the persistent lane root contains resume
//! data, while each launch gets fresh config/home/cache directories.

use std::path::PathBuf;
use anyhow::{anyhow, ensure, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use super::{acp, acp_scope};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

pub const KEY_ENV: &str = "ORGTREE_ACP_PROVIDER_KEY";

/// The adapter owns launch policy, bridge lifetime and the session driver;
/// the ACP transport remains unaware of OpenCode or Orgtree's actor.
pub enum SessionEvent {
    Update { turn: Option<String>, value: Value },
    Finished { turn: String, result: Result<Value> },
    Ended(String),
}

pub struct OpenCodeProc {
    pub process: uuid::Uuid,
    pub pid: u32,
    pub session_id: String,
    pub model: String,
    pub mcp_observed: bool,
    inner: acp::Process,
    launch: Option<Launch>,
    pipe: CancellationToken,
    active: Arc<AtomicBool>,
    commands: mpsc::Sender<(String, String)>,
    worker: Option<tokio::task::JoinHandle<()>>,
}

#[nolog]
impl OpenCodeProc {
    pub async fn spawn(mut spec: Spec, engine: Arc<crate::engine::Engine>, caller: super::Caller,
                       resume: Option<String>, emit: Arc<dyn Fn(uuid::Uuid, SessionEvent) + Send + Sync>) -> Result<Self> {
        let pipe = CancellationToken::new();
        // Every startup error (including config conversion) must close the
        // listener. Successful construction transfers that duty to the process.
        let startup_pipe = pipe.clone().drop_guard();
        let (ready_tx, ready_rx) = watch::channel(false);
        let name = crate::bridge::serve_observed(engine, caller, pipe.clone(), Some(ready_tx))?;
        spec.servers = servers(&name, &spec.servers)?;
        let cwd = spec.cwd.to_string_lossy().to_string();
        let prepared = Launch::prepare(spec);
        let mut launch = match prepared { Ok(v) => v, Err(e) => { pipe.cancel(); return Err(e); } };
        let spawned = acp::Process::spawn(launch.take_spec()?).await;
        let (mut inner, mut events) = match spawned { Ok(v) => v, Err(e) => { pipe.cancel(); return Err(e); } };
        let opened: Result<String> = async {
            let init = inner.client.request("initialize", json!({"protocolVersion":1,
                "clientCapabilities":{},"clientInfo":{"name":"Orgtree","version":env!("CARGO_PKG_VERSION")}}), Duration::from_secs(30)).await?;
            compatible(&init)?;
            let session = if let Some(session) = resume {
                // Failure is explicit, not a silently fresh session. The actor
                // can retain mail and offer a deliberate fresh-session action.
                inner.client.request("session/load", json!({"sessionId":session,"cwd":cwd,"mcpServers":[]}), Duration::from_secs(30)).await?;
                session
            } else {
                let opened = inner.client.request("session/new", json!({"cwd":cwd,"mcpServers":[]}), Duration::from_secs(30)).await?;
                opened["sessionId"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("OpenCode returned no session id"))?.to_string()
            };
            inner.client.request("session/set_config_option", json!({"sessionId":session,
                "configId":"model","value":launch.model}), Duration::from_secs(15)).await?;
            Ok(session)
        }.await;
        let session_id = match opened {
            Ok(id) => id,
            Err(e) => { inner.close().await; pipe.cancel(); return Err(e); }
        };
        // This is a bridge handshake observation, not proof of the model's
        // catalog. OpenCode registers it asynchronously after tools/list.
        let mcp_observed = wait_for_tools(ready_rx, Duration::from_secs(5), Duration::from_millis(250)).await;
        if !mcp_observed { tracing::info!("OpenCode MCP readiness not observed; tools may appear late"); }
        let active = Arc::new(AtomicBool::new(false));
        let active_worker = active.clone();
        let (commands, mut receive) = mpsc::channel::<(String, String)>(1);
        let client = inner.client.clone();
        let sid = session_id.clone();
        let process = inner.process;
        let worker = tokio::spawn(async move {
            // One request future and one event consumer preserve ordering:
            // pump enqueues updates before resolving the prompt response;
            // the biased branch drains those updates before Finished.
            let mut current: Option<String> = None;
            let mut pending: std::pin::Pin<Box<dyn std::future::Future<Output=Result<Value>> + Send>> = Box::pin(std::future::pending());
            loop {
                tokio::select! {
                    biased;
                    event = events.recv() => match event {
                        Some(acp::Event::Notification(value)) => emit(process, SessionEvent::Update { turn:current.clone(), value }),
                        Some(acp::Event::Ended(reason)) => { emit(process, SessionEvent::Ended(reason)); break; },
                        None => { emit(process, SessionEvent::Ended("ACP event stream closed".into())); break; },
                    },
                    result = &mut pending, if current.is_some() => {
                        let turn = current.take().unwrap();
                        pending = Box::pin(std::future::pending());
                        active_worker.store(false, Ordering::Release);
                        emit(process, SessionEvent::Finished {turn,result});
                    },
                    command = receive.recv(), if current.is_none() => match command {
                        None => break,
                        Some((turn, text)) => {
                            current = Some(turn);
                            let client = client.clone(); let session = sid.clone();
                            pending = Box::pin(async move { client.request("session/prompt",
                                json!({"sessionId":session,"prompt":[{"type":"text","text":text}]}), Duration::from_secs(24*60*60)).await });
                        },
                    },
                }
            }
            active_worker.store(false, Ordering::Release);
        });
        startup_pipe.disarm();
        Ok(Self { process:inner.process,pid:inner.pid,session_id,model:launch.model.clone(),mcp_observed,
            inner,launch:Some(launch),pipe,active,commands,worker:Some(worker) })
    }

    pub fn start_turn(&self, text: &str) -> Result<String> {
        ensure!(self.active.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_ok(), "OpenCode already has a prompt in flight");
        let turn = uuid::Uuid::new_v4().to_string();
        let text = if self.mcp_observed { text.to_string() } else {
            format!("[Orgtree: MCP readiness was not observed at startup; your Orgtree tools may appear late.]\n{text}")
        };
        if self.commands.try_send((turn.clone(),text)).is_err() {
            self.active.store(false,Ordering::Release);
            return Err(anyhow!("OpenCode session worker is unavailable"));
        }
        Ok(turn)
    }
    pub fn interrupt(&self) -> bool {
        self.inner.client.notify("session/cancel",json!({"sessionId":self.session_id})).is_ok()
    }
    pub fn alive(&mut self) -> bool { self.inner.alive() && self.worker.as_ref().is_some_and(|w| !w.is_finished()) }
    pub async fn exit_status(&mut self, reason: &str) -> String { self.inner.exit_status(reason).await }
    pub async fn close(&mut self) {
        if self.active.load(Ordering::Acquire) { self.interrupt(); }
        self.inner.close().await;
        if let Some(worker) = self.worker.take() { let _ = worker.await; }
        self.pipe.cancel();
        self.launch.take();
    }
}

impl Drop for OpenCodeProc {
    fn drop(&mut self) { self.pipe.cancel(); }
}

#[nolog]
async fn wait_for_tools(mut ready: watch::Receiver<bool>, timeout: Duration, settle: Duration) -> bool {
    let observed = tokio::time::timeout(timeout, async {
        loop {
            if *ready.borrow_and_update() { return true; }
            if ready.changed().await.is_err() { return false; }
        }
    }).await.unwrap_or(false);
    if observed { tokio::time::sleep(settle).await; }
    observed
}

/// Sensitive by construction: do not add Debug/Serialize or logged arguments.
pub struct Spec {
    pub exe: PathBuf,
    pub cwd: PathBuf,
    pub profile: PathBuf,
    pub base_url: String,
    pub key: String,
    pub model: String,
    pub context: u64,
    pub output: u64,
    pub identity: String,
    pub policy: acp_scope::Policy,
    /// OpenCode-format MCP entries, generated only from granted engine servers.
    pub servers: Map<String, Value>,
    pub who: String,
}

pub struct Launch {
    spec: Option<acp::Spec>,
    pub model: String,
    /// Only this UUID directory is disposable; never erase persistent sessions.
    root: PathBuf,
}

#[nolog]
impl Launch {
    pub fn prepare(spec: Spec) -> Result<Self> {
        ensure!(!spec.model.trim().is_empty(), "OpenCode requires a model id");
        let url = reqwest::Url::parse(&spec.base_url).map_err(|_| anyhow!("invalid ACP provider URL"))?;
        ensure!(matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none(),
            "ACP provider URL must be HTTP(S), with credentials supplied separately");
        let profile = &spec.profile;
        std::fs::create_dir_all(profile)?;
        let root = profile.join(format!("launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let prepared = (|| {
            // An allowlist prevents ambient provider keys, NODE_OPTIONS, plugin
            // configuration, user profile roots and proxy credentials leaking in.
            let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| matches!(k.to_ascii_uppercase().as_str(),
                "PATH" | "PATHEXT" | "SYSTEMROOT" | "WINDIR" | "COMSPEC" | "PROGRAMFILES" | "PROGRAMFILES(X86)" |
                "LANG" | "LC_ALL" | "SHELL" | "TERM")).collect();
            for (key, dir, persistent) in [
                ("XDG_DATA_HOME", "data", true), ("XDG_STATE_HOME", "state", true),
                ("XDG_CONFIG_HOME", "config", false), ("XDG_CACHE_HOME", "cache", false),
                ("HOME", "home", false), ("USERPROFILE", "home", false), ("OPENCODE_TEST_HOME", "home", false),
                ("APPDATA", "appdata", false), ("LOCALAPPDATA", "local", false),
                ("ProgramData", "system", false), ("TEMP", "tmp", false), ("TMP", "tmp", false),
            ] {
                let path = if persistent { profile.join(dir) } else { root.join(dir) };
                std::fs::create_dir_all(&path)?;
                env.push((key.into(), path.to_string_lossy().into_owned()));
            }
            let models = root.join("models.json");
            std::fs::write(&models, b"{}")?;
            env.extend([
                ("OPENCODE_MODELS_PATH".into(), models.to_string_lossy().into_owned()),
                ("OPENCODE_DISABLE_MODELS_FETCH".into(), "true".into()),
                ("OPENCODE_CONFIG_PROJECT_DISABLE".into(), "true".into()),
                ("OPENCODE_FILEWATCHER_DISABLE".into(), "true".into()),
                ("OPENCODE_DISABLE_FFF".into(), "true".into()),
                (KEY_ENV.into(), spec.key.clone()),
                ("OPENCODE_CONFIG_CONTENT".into(), configuration(&spec).to_string()),
            ]);
            let policy = spec.policy.clone();
            Ok(acp::Spec { exe: spec.exe.clone(), args: vec!["acp".into(), "--log-level".into(), "none".into()],
                cwd: spec.cwd.clone(), env, who: spec.who.clone(),
                approval: std::sync::Arc::new(move |method, params| policy.answer(method, params)) })
        })();
        match prepared {
            Ok(launch) => Ok(Self { spec: Some(launch), model: format!("orgtree/{}", spec.model), root }),
            Err(e) => { let _ = std::fs::remove_dir_all(&root); Err(e) }
        }
    }

    pub fn take_spec(&mut self) -> Result<acp::Spec> {
        self.spec.take().ok_or_else(|| anyhow!("ACP launch was already consumed"))
    }
}

impl Drop for Launch {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
}

#[nolog]
fn configuration(spec: &Spec) -> Value {
    let mut rules = vec![json!({"action":"*","resource":"*","effect":"ask"})];
    if !spec.policy.bypass {
        rules.push(json!({"action":"execute","resource":"*","effect":"deny"}));
    }
    let model = json!({"name":spec.model, "capabilities":{"tools":true,"input":["text"],"output":["text"]},
        "limit":{"context":spec.context.max(1024),"output":spec.output.max(1)},
        "body":{"max_tokens":spec.output.max(1)}});
    json!({
        "update":"disable","share":"disabled","warming":false,"snapshots":false,"lsp":false,"formatter":false,
        "skills":[],"instructions":[],"plugins":[],
        "default_agent":"orgtree","model":format!("orgtree/{}",spec.model),"permissions":rules,
        "agents":{"orgtree":{"mode":"primary","system":spec.identity},"build":{"disabled":true},"plan":{"disabled":true}},
        "providers":{"orgtree":{"name":"Orgtree provider","package":"aisdk:@ai-sdk/openai-compatible",
            "settings":{"apiKey":format!("{{env:{KEY_ENV}}}"),"baseURL":spec.base_url},
            "models":{spec.model.clone():model}}},
        "mcp":{"servers":spec.servers}
    })
}

/// Configured MCP uses direct tools in every mode. Bypass additionally allows
/// Code Mode; keeping MCP direct there is deliberately the same config route.
#[nolog]
pub fn servers(bridge: &str, granted: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut result = Map::new();
    result.insert("orgtree".into(), json!({"type":"local","command":[std::env::current_exe()?.to_string_lossy(),
        "mcp-bridge","--pipe",bridge],"codemode":false}));
    for (name, srv) in granted {
        if name == "orgtree" { continue; }
        ensure!(!name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
            "ACP MCP server name contains unsupported characters");
        let mut entry = if let Some(command) = srv["command"].as_str() {
            let mut args = vec![json!(command)];
            if let Some(extra) = srv["args"].as_array() {
                ensure!(extra.iter().all(Value::is_string), "MCP command arguments must be strings");
                args.extend(extra.clone());
            }
            json!({"type":"local","command":args,"environment":srv.get("env").cloned().unwrap_or(json!({}))})
        } else if let Some(url) = srv["url"].as_str() {
            json!({"type":"remote","url":url,"headers":srv.get("headers").cloned().unwrap_or(json!({})),"oauth":false})
        } else { return Err(anyhow!("unsupported MCP transport for ACP")); };
        entry["codemode"] = json!(false);
        result.insert(server_alias(name), entry);
    }
    Ok(result)
}

#[nolog]
pub fn server_alias(name: &str) -> String {
    format!("orgtree_ext_{}", hex::encode(&Sha256::digest(name.as_bytes())[..12]))
}

#[nolog]
pub fn compatible(initialize: &Value) -> Result<()> {
    ensure!(initialize["protocolVersion"] == 1, "OpenCode did not negotiate ACP version 1");
    ensure!(initialize["agentInfo"]["name"].as_str().is_some_and(|s| s.eq_ignore_ascii_case("opencode")),
        "the installed program is not OpenCode");
    ensure!(initialize["agentInfo"]["version"].as_str().is_some_and(|s| s.starts_with("2.")),
        "this adapter requires OpenCode 2.x; install a compatible version");
    ensure!(initialize["agentCapabilities"]["loadSession"] == true, "OpenCode must support ACP session/load");
    Ok(())
}

/// Read the real ACP entrypoint during ordinary CLI discovery. No model or
/// session is opened, and the user's OpenCode roots and authentication stay out.
#[nolog]
pub async fn discover(profile: PathBuf) -> Option<(PathBuf, String)> {
    let exe = locate()?;
    let policy = acp_scope::Policy { cwd:profile.clone(),read:vec![],write:vec![],
        may_write:false,may_shell:false,may_web:false,bypass:false,mcp_tools:vec![],mcp_prefixes:vec![] };
    let mut launch = Launch::prepare(Spec { exe:exe.clone(),cwd:profile.clone(),profile,
        base_url:"http://127.0.0.1:9/v1".into(),key:"unused-discovery".into(),model:"discovery".into(),
        context:1024,output:1,identity:String::new(),policy,servers:Map::new(),who:"OpenCode ACP discovery".into() }).ok()?;
    let (mut child, _events) = acp::Process::spawn(launch.take_spec().ok()?).await.ok()?;
    let result = child.client.request("initialize",json!({"protocolVersion":1,"clientCapabilities":{},
        "clientInfo":{"name":"Orgtree discovery","version":env!("CARGO_PKG_VERSION")}}),Duration::from_secs(15)).await;
    child.close().await;
    let result = result.ok()?;
    compatible(&result).ok()?;
    Some((exe,result["agentInfo"]["version"].as_str()?.to_string()))
}

/// Recognize a native entrypoint, never execute an npm .cmd file directly.
#[logged]
pub fn locate() -> Option<PathBuf> {
    if crate::rig::active() { return crate::rig::cli_bin("ORGTREE_OPENCODE_BIN").map(|(p,_)| p); }
    if let Some(path) = std::env::var_os("APPDATA").map(PathBuf::from)
        .map(|p| p.join("npm/node_modules/@opencode/cli/bin/opencode.exe")).filter(|p| p.is_file()) { return Some(path); }
    std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(if cfg!(windows) { "opencode.exe" } else { "opencode" })).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn acp_opencode_readiness_observed_and_timeout_are_distinct() {
        let (tx, rx) = watch::channel(false);
        let pending = tokio::spawn(wait_for_tools(rx, Duration::from_secs(1), Duration::ZERO));
        tx.send(true).unwrap();
        assert!(pending.await.unwrap());
        let (_tx, rx) = watch::channel(false);
        assert!(!wait_for_tools(rx, Duration::from_millis(10), Duration::ZERO).await);
        let (tx, rx) = watch::channel(false);
        drop(tx);
        assert!(!wait_for_tools(rx, Duration::from_secs(1), Duration::ZERO).await);
    }
    #[test]
    fn acp_opencode_requires_version_and_resume_capability() {
        let mut v = json!({"protocolVersion":1,"agentInfo":{"name":"OpenCode","version":"2.0.28"},"agentCapabilities":{"loadSession":true}});
        assert!(compatible(&v).is_ok());
        v["agentInfo"]["version"] = json!("1.0"); assert!(compatible(&v).is_err());
        v["agentInfo"]["version"] = json!("2.0.28"); v["agentCapabilities"]["loadSession"] = json!(false);
        assert!(compatible(&v).is_err());
    }
    #[test]
    fn acp_opencode_mcp_is_direct_and_credentials_are_not_provider_parameters() {
        let mut granted = Map::new();
        granted.insert("files".into(), json!({"command":"fixture","args":["x"],"env":{"TOKEN":"fixture-secret"}}));
        let built = servers("fixture-pipe", &granted).unwrap();
        let alias = server_alias("files");
        assert_eq!(built[&alias]["codemode"], false);
        assert_eq!(built["orgtree"]["codemode"], false);
        assert_eq!(built[&alias]["environment"]["TOKEN"], "fixture-secret");
    }
}
