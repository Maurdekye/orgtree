//! Read-only user MCP discovery. Definitions are secret-bearing: never derive
//! Debug/Serialize for the registry or log parser inputs/errors.
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

const MAX_CONFIG: u64 = 4 * 1024 * 1024;
const SOURCES: [&str; 5] = [
    "claude-code",
    "codex-cli",
    "antigravity",
    "muse",
    "opencode",
];

#[derive(Default)]
pub struct McpRegistry {
    dependencies: Vec<PathBuf>,
    stamps: Vec<(PathBuf, Option<(SystemTime, u64)>)>,
    pub servers: Vec<(String, Value)>,
    sources: BTreeMap<String, Vec<&'static str>>,
}

impl McpRegistry {
    /// Deliberate allowlist; no definition, URL, header, env or command escapes.
    #[nolog]
    pub fn public(&self) -> Value {
        let details: Vec<Value> = self.servers.iter().map(|(name, cfg)| json!({
            "name": name, "sources": self.sources.get(name),
            "transport": if cfg.get("command").is_some() { "stdio" } else { cfg["type"].as_str().unwrap_or("http") },
        })).collect();
        json!({"servers": self.servers.iter().map(|(n, _)| n).collect::<Vec<_>>(), "details": details})
    }
}

#[derive(Clone)]
struct SourceFile {
    source: &'static str,
    path: PathBuf,
}

#[nolog]
fn env_path(name: &str) -> Option<PathBuf> {
    if crate::rig::active() {
        return None;
    }
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[nolog]
fn source_files(
    home: &Path,
    installed: [bool; 5],
    codex: Option<PathBuf>,
    xdg: Option<PathBuf>,
) -> Vec<SourceFile> {
    let config = xdg.unwrap_or_else(|| home.join(".config"));
    let paths = [
        vec![home.join(".claude.json")],
        vec![codex
            .unwrap_or_else(|| home.join(".codex"))
            .join("config.toml")],
        vec![
            home.join(".gemini/config/mcp_config.json"),
            home.join(".gemini/antigravity/mcp_config.json"),
            home.join(".gemini/antigravity-cli/mcp_config.json"),
            home.join(".antigravity/mcp_config.json"),
        ],
        vec![config.join("muse/settings.json")],
        vec![
            config.join("opencode/opencode.json"),
            config.join("opencode/opencode.jsonc"),
        ],
    ];
    paths
        .into_iter()
        .enumerate()
        .filter(|(i, _)| installed[*i])
        .flat_map(|(i, paths)| {
            paths
                .into_iter()
                .filter(|p| !generated(p))
                .map(move |path| SourceFile {
                    source: SOURCES[i],
                    path,
                })
        })
        .collect()
}

#[nolog]
fn generated(path: &Path) -> bool {
    let p = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    p.contains("/scratch/orgtree/")
        || p.contains("/.agents/plugins/orgtree/")
        || p.ends_with("/.orgtree-mcp.json")
}

#[nolog]
pub(super) fn discover(providers: &super::Providers, refresh: bool) -> Arc<McpRegistry> {
    // Installation lookup only: no authentication or harness process is started.
    let installed = [
        super::locate_claude().is_some(),
        super::locate_codex().is_some(),
        super::locate_agy().is_some(),
        super::locate_muse().is_some(),
        crate::runtime::opencode::locate().is_some(),
    ];
    let mut files = source_files(
        &super::home(),
        installed,
        env_path("CODEX_HOME"),
        env_path("XDG_CONFIG_HOME"),
    );
    if installed[4] {
        if let Some(dir) = env_path("OPENCODE_CONFIG_DIR") {
            for name in ["opencode.json", "opencode.jsonc"] {
                let path = dir.join(name);
                if !generated(&path) {
                    files.push(SourceFile {
                        source: "opencode",
                        path,
                    });
                }
            }
        }
        if let Some(path) = env_path("OPENCODE_CONFIG").filter(|p| !generated(p)) {
            files.push(SourceFile {
                source: "opencode",
                path,
            });
        }
    }
    read_cached(&providers.mcp, &files, refresh)
}

#[nolog]
fn read_cached(
    cache: &arc_swap::ArcSwap<McpRegistry>,
    files: &[SourceFile],
    refresh: bool,
) -> Arc<McpRegistry> {
    let cur = cache.load_full();
    let mut paths = files.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
    paths.extend(cur.dependencies.iter().cloned());
    if !refresh && cur.stamps == fingerprint(&paths) {
        return cur;
    }
    let mut dependencies = Vec::new();
    let mut entries = Vec::new();
    for file in files {
        let read = || -> Result<Vec<(String, Value)>, &'static str> {
            let meta = std::fs::metadata(&file.path).map_err(|_| "missing or unreadable config")?;
            if meta.len() > MAX_CONFIG {
                return Err("config exceeds size limit");
            }
            let text = std::fs::read_to_string(&file.path).map_err(|_| "unreadable config")?;
            parse(file.source, &text)
        };
        match read() {
            Ok(defs) => {
                for (name, mut value) in defs {
                    if file.source == "opencode" {
                        if let Err(reason) = file_references(
                            &mut value,
                            &file.path,
                            &super::home(),
                            &mut dependencies,
                        ) {
                            tracing::warn!(source = file.source, reason, "MCP entry skipped");
                            continue;
                        }
                    }
                    match normalize(file.source, &name, &value, &|key| std::env::var(key).ok()) {
                        Ok(Some(cfg)) => entries.push((file.source, name, cfg)),
                        Ok(None) => {}
                        Err(reason) => {
                            tracing::warn!(source = file.source, reason, "MCP entry skipped")
                        }
                    }
                }
            }
            Err(reason) => tracing::debug!(source = file.source, reason, "MCP source skipped"),
        }
    }
    let mut registry = merge(entries);
    dependencies.sort();
    dependencies.dedup();
    let mut paths = files.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
    paths.extend(dependencies.iter().cloned());
    registry.stamps = fingerprint(&paths);
    registry.dependencies = dependencies;
    let next = Arc::new(registry);
    cache.store(next.clone());
    next
}

#[nolog]
fn fingerprint(paths: &[PathBuf]) -> Vec<(PathBuf, Option<(SystemTime, u64)>)> {
    paths
        .iter()
        .map(|p| {
            (
                p.clone(),
                std::fs::metadata(p)
                    .ok()
                    .and_then(|m| Some((m.modified().ok()?, m.len()))),
            )
        })
        .collect()
}

/// OpenCode file references are resolved relative to the source config, never
/// recursively scanned. Their metadata participates in automatic invalidation.
#[nolog]
fn file_references(
    value: &mut Value,
    config: &Path,
    home: &Path,
    deps: &mut Vec<PathBuf>,
) -> Result<(), &'static str> {
    match value {
        Value::String(s) => {
            let mut rest = s.as_str();
            let mut out = String::new();
            while let Some(start) = rest.find("{file:") {
                out.push_str(&rest[..start]);
                let tail = &rest[start + 6..];
                let end = tail.find('}').ok_or("invalid file reference")?;
                let name = &tail[..end];
                let path = if let Some(relative) = name.strip_prefix("~/") {
                    home.join(relative)
                } else {
                    config.parent().unwrap_or(home).join(name)
                };
                deps.push(path.clone());
                if std::fs::metadata(&path)
                    .map_err(|_| "unreadable file reference")?
                    .len()
                    > MAX_CONFIG
                {
                    return Err("file reference exceeds size limit");
                }
                let content =
                    std::fs::read_to_string(path).map_err(|_| "unreadable file reference")?;
                out.push_str(content.trim());
                rest = &tail[end + 1..];
            }
            out.push_str(rest);
            *s = out;
        }
        Value::Array(a) => {
            for v in a {
                file_references(v, config, home, deps)?;
            }
        }
        Value::Object(m) => {
            for v in m.values_mut() {
                file_references(v, config, home, deps)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[nolog]
fn parse(source: &str, text: &str) -> Result<Vec<(String, Value)>, &'static str> {
    let text = text.trim_start_matches('\u{feff}');
    let doc: Value = if source == "codex-cli" {
        let t = toml::from_str::<toml::Value>(text).map_err(|_| "invalid TOML")?;
        serde_json::to_value(t).map_err(|_| "invalid TOML value")?
    } else {
        let text = if source == "opencode" {
            jsonc(text)?
        } else {
            text.to_string()
        };
        serde_json::from_str(&text).map_err(|_| "invalid JSON")?
    };
    let key = match source {
        "codex-cli" | "muse" => "mcp_servers",
        "opencode" => "mcp",
        _ => "mcpServers",
    };
    match doc.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Object(m)) => Ok(m.iter().map(|(n, v)| (n.clone(), v.clone())).collect()),
        _ => Err("invalid MCP section"),
    }
}

/// JSONC comments and trailing commas, without touching quoted text or URLs.
#[nolog]
fn jsonc(text: &str) -> Result<String, &'static str> {
    let mut b = text.as_bytes().to_vec();
    let mut i = 0;
    let mut quoted = false;
    while i < b.len() {
        if quoted {
            if b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                quoted = false;
            }
            i += 1;
            continue;
        }
        if b[i] == b'"' {
            quoted = true;
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"//") {
            while i < b.len() && b[i] != b'\n' {
                b[i] = b' ';
                i += 1;
            }
        } else if b[i..].starts_with(b"/*") {
            b[i] = b' ';
            b[i + 1] = b' ';
            i += 2;
            while i + 1 < b.len() && !b[i..].starts_with(b"*/") {
                b[i] = b' ';
                i += 1;
            }
            if i + 1 >= b.len() {
                return Err("unterminated JSON comment");
            }
            b[i] = b' ';
            b[i + 1] = b' ';
            i += 2;
        } else {
            i += 1;
        }
    }
    quoted = false;
    i = 0;
    while i < b.len() {
        if quoted {
            if b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                quoted = false;
            }
        } else if b[i] == b'"' {
            quoted = true;
        } else if b[i] == b',' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < b.len() && matches!(b[j], b'}' | b']') {
                b[i] = b' ';
            }
        }
        i += 1;
    }
    String::from_utf8(b).map_err(|_| "invalid UTF-8")
}

#[nolog]
fn expand(
    value: &str,
    source: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, &'static str> {
    let marker = if source == "opencode" { "{env:" } else { "${" };
    if source == "codex-cli" {
        return Ok(value.to_string());
    }
    let mut rest = value;
    let mut out = String::new();
    while let Some(start) = rest.find(marker) {
        out.push_str(&rest[..start]);
        let key_rest = &rest[start + marker.len()..];
        let end = key_rest.find('}').ok_or("invalid environment reference")?;
        let key = &key_rest[..end];
        let (key, default) = key
            .split_once(":-")
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((key, None));
        let value = env(key)
            .or_else(|| default.map(str::to_string))
            .ok_or("environment reference is unset")?;
        out.push_str(&value);
        rest = &key_rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[nolog]
fn string_map(
    value: Option<&Value>,
    source: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Map<String, Value>, &'static str> {
    let Some(value) = value else {
        return Ok(Map::new());
    };
    let obj = value.as_object().ok_or("expected string map")?;
    obj.iter()
        .map(|(k, v)| {
            Ok((
                k.clone(),
                Value::String(expand(
                    v.as_str().ok_or("expected string value")?,
                    source,
                    env,
                )?),
            ))
        })
        .collect()
}

#[nolog]
fn normalize(
    source: &str,
    name: &str,
    raw: &Value,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<Value>, &'static str> {
    if name == "orgtree"
        || name.is_empty()
        || raw.get("enabled") == Some(&Value::Bool(false))
        || raw.get("disabled") == Some(&Value::Bool(true))
    {
        return Ok(None);
    }
    let obj = raw.as_object().ok_or("invalid server definition")?;
    if obj.get("args").is_some_and(|v| !v.is_array()) {
        return Err("invalid command arguments");
    }
    let mut out = Map::new();
    let command = if source == "opencode" {
        obj.get("command")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
    } else {
        obj.get("command").and_then(Value::as_str)
    };
    if let Some(cmd) = command {
        let args = if source == "opencode" {
            obj.get("command")
                .and_then(Value::as_array)
                .map(|a| a.iter().skip(1).collect::<Vec<_>>())
        } else {
            obj.get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().collect::<Vec<_>>())
        }
        .unwrap_or_default();
        if args.iter().any(|v| v.as_str() == Some("mcp-bridge")) {
            return Ok(None);
        }
        out.insert("command".into(), json!(expand(cmd, source, env)?));
        out.insert(
            "args".into(),
            Value::Array(
                args.into_iter()
                    .map(|v| {
                        expand(v.as_str().ok_or("invalid command argument")?, source, env)
                            .map(Value::String)
                    })
                    .collect::<Result<_, _>>()?,
            ),
        );
        let mut vars = string_map(
            obj.get(if source == "opencode" {
                "environment"
            } else {
                "env"
            }),
            source,
            env,
        )?;
        if let Some(Value::Array(names)) = obj.get("env_vars") {
            for name in names {
                let name = name.as_str().ok_or("invalid inherited environment name")?;
                if let Some(value) = env(name) {
                    vars.entry(name.to_string()).or_insert(json!(value));
                }
            }
        }
        if !vars.is_empty() {
            out.insert("env".into(), Value::Object(vars));
        }
    } else if let Some(url) = obj
        .get("serverUrl")
        .or_else(|| obj.get("url"))
        .and_then(Value::as_str)
    {
        out.insert(
            "type".into(),
            json!(if obj.get("type").and_then(Value::as_str) == Some("sse") {
                "sse"
            } else {
                "http"
            }),
        );
        out.insert("url".into(), json!(expand(url, source, env)?));
        let mut headers = string_map(
            obj.get("http_headers").or_else(|| obj.get("headers")),
            source,
            env,
        )?;
        if let Some(h) = obj.get("env_http_headers").and_then(Value::as_object) {
            for (key, name) in h {
                let value = env(name.as_str().ok_or("invalid header environment name")?)
                    .ok_or("header environment is unset")?;
                headers.insert(key.clone(), json!(value));
            }
        }
        if let Some(name) = obj.get("bearer_token_env_var").and_then(Value::as_str) {
            let token = env(name).ok_or("bearer token environment is unset")?;
            headers.insert("Authorization".into(), json!(format!("Bearer {token}")));
        }
        if !headers.is_empty() {
            out.insert("headers".into(), Value::Object(headers));
        }
    } else {
        return Err("missing supported transport");
    }
    Ok(Some(Value::Object(out)))
}

#[nolog]
fn merge(entries: Vec<(&'static str, String, Value)>) -> McpRegistry {
    // Reserve literal names before assigning suffixes so a real foo-codex
    // entry cannot be overwritten by a collision alias for foo.
    let reserved: BTreeSet<String> = entries.iter().map(|(_, n, _)| n.clone()).collect();
    let mut groups: BTreeMap<String, Vec<(Value, Vec<&'static str>)>> = BTreeMap::new();
    for (source, name, cfg) in entries {
        let group = groups.entry(name).or_default();
        if let Some((_, sources)) = group.iter_mut().find(|(c, _)| *c == cfg) {
            if !sources.contains(&source) {
                sources.push(source);
            }
        } else {
            group.push((cfg, vec![source]));
        }
    }
    let mut out = McpRegistry::default();
    for (name, variants) in groups {
        for (i, (cfg, sources)) in variants.into_iter().enumerate() {
            let alias = if i == 0 {
                name.clone()
            } else {
                let suffix = match sources[0] {
                    "claude-code" => "claude",
                    "codex-cli" => "codex",
                    x => x,
                };
                let base = format!("{name}-{suffix}");
                let mut candidate = base.clone();
                let mut n = 2;
                while reserved.contains(&candidate) || out.sources.contains_key(&candidate) {
                    candidate = format!("{base}-{n}");
                    n += 1;
                }
                candidate
            };
            out.sources.insert(alias.clone(), sources);
            out.servers.push((alias, cfg));
        }
    }
    out.servers.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn norm(source: &str, value: Value) -> Value {
        normalize(source, "shared", &value, &|k| {
            (k == "TOKEN").then(|| "fixture-secret".into())
        })
        .unwrap()
        .unwrap()
    }
    #[test]
    fn mcp_import_all_source_formats_and_headers() {
        for (source, text) in [
            ("claude-code", r#"{"mcpServers":{"a":{"command":"runner","args":["serve"]}}}"#),
            ("codex-cli", "[mcp_servers.a]\ncommand='runner'\nargs=['serve']"),
            ("antigravity", r#"{"mcpServers":{"a":{"command":"runner","args":["serve"]}}}"#),
            ("muse", r#"{"mcp_servers":{"a":{"transport":"stdio","command":"runner","args":["serve"]}}}"#),
            ("opencode", "{ // comment\n\"mcp\":{\"a\":{\"type\":\"local\",\"command\":[\"runner\",\"serve\",],},},}"),
        ] {
            let defs = parse(source, text).unwrap();
            assert_eq!(defs.len(), 1);
            assert_eq!(norm(source, defs[0].1.clone()), json!({"command":"runner","args":["serve"]}));
        }
        assert_eq!(
            norm(
                "antigravity",
                json!({"serverUrl":"https://invalid.test/mcp","headers":{"Authorization":"${TOKEN}"}})
            ),
            json!({"type":"http","url":"https://invalid.test/mcp","headers":{"Authorization":"fixture-secret"}})
        );
        assert_eq!(
            norm(
                "codex-cli",
                json!({"url":"https://invalid.test/mcp","bearer_token_env_var":"TOKEN","env_http_headers":{"X-Token":"TOKEN"}})
            )["headers"],
            json!({"Authorization":"Bearer fixture-secret","X-Token":"fixture-secret"})
        );
        assert_eq!(
            norm(
                "opencode",
                json!({"type":"remote","url":"https://invalid.test/{env:TOKEN}"})
            )["url"],
            "https://invalid.test/fixture-secret"
        );
    }
    #[test]
    fn mcp_import_collision_aliases_and_redaction() {
        let a = json!({"command":"private-command","args":[],"env":{"SECRET":"secret-one"}});
        let b = json!({"type":"http","url":"https://secret-url.invalid","headers":{"Authorization":"secret-two"}});
        let r = merge(vec![
            ("claude-code", "same".into(), a.clone()),
            ("codex-cli", "same".into(), b.clone()),
            ("antigravity", "same".into(), a.clone()),
            ("muse", "same-codex".into(), a),
        ]);
        assert_eq!(
            r.servers
                .iter()
                .map(|(n, _)| n.as_str())
                .collect::<Vec<_>>(),
            ["same", "same-codex", "same-codex-2"]
        );
        assert_eq!(r.sources["same"], ["claude-code", "antigravity"]);
        assert_eq!(r.servers[2].1, b);
        let public = r.public().to_string();
        for secret in [
            "secret-one",
            "secret-two",
            "private-command",
            "secret-url",
            "Authorization",
        ] {
            assert!(!public.contains(secret));
        }
        assert_eq!(r.public()["details"][2]["transport"], "http");
    }
    #[test]
    fn mcp_import_skips_generated_disabled_and_invalid() {
        for cfg in [
            json!({"enabled":false}),
            json!({"disabled":true}),
            json!({"command":"engine","args":["mcp-bridge"]}),
        ] {
            assert!(normalize("claude-code", "a", &cfg, &|_| None)
                .unwrap()
                .is_none());
        }
        assert!(normalize(
            "claude-code",
            "orgtree",
            &json!({"command":"bridge"}),
            &|_| None
        )
        .unwrap()
        .is_none());
        assert!(normalize(
            "claude-code",
            "a",
            &json!({"command":"run","args":"wrong"}),
            &|_| None
        )
        .is_err());
        assert!(parse("codex-cli", "[malformed").is_err());
        assert!(parse("opencode", "{/*no end").is_err());
        assert!(generated(Path::new(
            "C:/data/scratch/orgtree/seat/.config/opencode/opencode.json"
        )));
        assert!(generated(Path::new(
            "/seat/.agents/plugins/orgtree/mcp_config.json"
        )));
        assert!(source_files(Path::new("/home"), [false; 5], None, None).is_empty());
        let files = source_files(
            Path::new("/home"),
            [false, true, false, false, false],
            Some("/custom".into()),
            None,
        );
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, Path::new("/custom/config.toml"));
    }
    #[test]
    fn mcp_import_cache_refresh_and_file_references() {
        let root = std::env::temp_dir().join(format!(
            "orgtree-mcp-unit-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let config = root.join("opencode.jsonc");
        let token = root.join("token.txt");
        std::fs::write(&token, "first-fixture-secret\n").unwrap();
        std::fs::write(&config,r#"{"mcp":{"remote":{"url":"https://invalid.test","headers":{"Authorization":"{file:token.txt}"}}}}"#).unwrap();
        let files = [SourceFile {
            source: "opencode",
            path: config.clone(),
        }];
        let cache = arc_swap::ArcSwap::from_pointee(McpRegistry::default());
        let first = read_cached(&cache, &files, false);
        assert_eq!(
            first.servers[0].1["headers"]["Authorization"],
            "first-fixture-secret"
        );
        assert!(Arc::ptr_eq(&first, &read_cached(&cache, &files, false)));
        assert!(!Arc::ptr_eq(&first, &read_cached(&cache, &files, true)));
        std::fs::write(&token, "changed-longer-fixture-secret").unwrap();
        assert_eq!(
            read_cached(&cache, &files, false).servers[0].1["headers"]["Authorization"],
            "changed-longer-fixture-secret"
        );
        std::fs::remove_file(&config).unwrap();
        assert!(read_cached(&cache, &files, false).servers.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn mcp_import_codex_remote_headers_survive_launch_mapping() {
        let value = norm(
            "codex-cli",
            json!({"url":"https://invalid.test","http_headers":{"X-Api-Key":"fixture"}}),
        );
        let servers = Map::from_iter([("remote.dotted".into(), value)]);
        let (args, attached) = crate::runtime::codex::mcp_overrides(&servers);
        assert_eq!(attached, ["remote.dotted"]);
        let spec = crate::runtime::codex::CodexSpec {
            exe: "codex".into(),
            cwd: ".".into(),
            codex_home: None,
            api_key: None,
            model: "fixture".into(),
            effort: None,
            sandbox: crate::runtime::codex::Sandbox {
                mode: "read-only",
                approval: "on-request",
                session0: false,
            },
            instructions: String::new(),
            dynamic_tools: vec![],
            config: args.clone(),
            resume: None,
            may_write: false,
            may_shell: false,
            may_subagents: false,
            env: vec![],
            host: None,
        };
        assert!(!format!("{spec:?}").contains("X-Api-Key"));
        assert!(!format!("{spec:?}").contains("invalid.test"));

        assert!(args
            .iter()
            .any(|a| a.starts_with("mcp_servers.\"remote.dotted\".")));
        assert!(args.iter().any(|a| a.contains("http_headers=")
            && a.contains("X-Api-Key")
            && a.contains("fixture")));
    }
}
