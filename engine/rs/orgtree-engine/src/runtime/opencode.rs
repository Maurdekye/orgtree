//! OpenCode 2.x configuration for the generic ACP client. There is no hosted
//! OpenCode account here: the selected Orgtree provider supplies every model call.
//! Config is process environment only; the persistent lane root contains resume
//! data, while each launch gets fresh config/home/cache directories.

use std::path::PathBuf;
use anyhow::{anyhow, ensure, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use super::{acp, acp_scope};

pub const KEY_ENV: &str = "ORGTREE_ACP_PROVIDER_KEY";

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

/// Recognize a native entrypoint, never execute an npm .cmd file directly.
#[logged]
pub fn locate() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("APPDATA").map(PathBuf::from)
        .map(|p| p.join("npm/node_modules/@opencode/cli/bin/opencode.exe")).filter(|p| p.is_file()) { return Some(path); }
    std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(if cfg!(windows) { "opencode.exe" } else { "opencode" })).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
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
