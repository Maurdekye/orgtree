//! Native Git askpass: no shell, no credential persistence, no tracing.
use super::{lookup, safe_field, valid_host, Duration, MAX};
use std::process::{ExitCode, Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Target {
    field: &'static str,
    host: String,
    path: String,
    username: String,
}

#[nolog]
fn decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() || !bytes[i+1].is_ascii_hexdigit() || !bytes[i+2].is_ascii_hexdigit() { return None; }
            i += 3;
        } else { i += 1; }
    }
    let text = percent_encoding::percent_decode_str(s).decode_utf8().ok()?.into_owned();
    safe_field(&text).then_some(text)
}

/// credential.sanitizePrompt=true makes Git percent-encode data before formatting.
/// Split encoded delimiters first; decoding a username/path must not change hosts.
#[nolog]
fn target(prompt: &str) -> Option<Target> {
    if prompt.len() > MAX || prompt.chars().any(char::is_control) { return None; }
    let (field, url) = if let Some(u) = prompt.strip_prefix("Username for '") { ("username", u) }
        else { ("password", prompt.strip_prefix("Password for '")?) };
    let url = url.strip_suffix("': ")?.strip_prefix("https://")?;
    let (authority, path) = url.split_once('/').unwrap_or((url, ""));
    let (username, host) = authority.rsplit_once('@').unwrap_or(("", authority));
    // Literal delimiters cannot occur inside encoded username data.
    if username.contains('@') || username.contains(':') { return None; }
    let host = decode(host)?;
    if !valid_host(&host) || host.matches(':').count() > 1 { return None; }
    Some(Target { field, host, path: decode(path)?, username: decode(username)? })
}

#[nolog]
pub fn cli(args: &[String]) -> ExitCode {
    if args.len() != 1 || std::env::var_os("ORGTREE_ASKPASS_ACTIVE").is_some() { return ExitCode::FAILURE; }
    let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return ExitCode::FAILURE; };
    match rt.block_on(run(&args[0])) { Ok(code) => ExitCode::from(code), Err(()) => ExitCode::FAILURE }
}

#[nolog]
async fn run(prompt: &str) -> Result<u8, ()> {
    if let Some(t) = target(prompt) {
        let mut answer = lookup("git", &t.host, &t.path, &t.username).await;
        let value = std::str::from_utf8(&answer).ok().and_then(|s| s.lines().filter_map(|l|l.split_once('=')).find(|(k,_)| *k == t.field).map(|(_,v)|v));
        let result = if let Some(value) = value.filter(|v| !v.is_empty() && safe_field(v)) {
            let mut stdout = tokio::io::stdout();
            Some(async { stdout.write_all(value.as_bytes()).await.map_err(|_| ())?; stdout.write_all(b"\n").await.map_err(|_| ())?; Ok(0) }.await)
        } else { None };
        answer.fill(0);
        if let Some(result) = result { return result; }
    }
    fallback(prompt).await
}

/// Preserve Git's GIT_ASKPASS > core.askPass > SSH_ASKPASS precedence, including
/// an explicit empty value. Unknown prompts take this path without a bridge call.
#[nolog]
async fn original() -> Option<String> {
    if let Ok(value) = std::env::var("ORGTREE_ORIGINAL_GIT_ASKPASS") { return Some(value); }
    let mut git = tokio::process::Command::new("git");
    git.args(["config", "--get", "core.askPass"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    git.creation_flags(crate::winproc::CREATE_NO_WINDOW);
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(3), git.output()).await {
        if out.status.success() && out.stdout.len() <= MAX {
            return String::from_utf8(out.stdout).ok().map(|v|v.trim_end_matches(['\r','\n']).to_string());
        }
    }
    std::env::var("SSH_ASKPASS").ok()
}

#[nolog]
async fn fallback(prompt: &str) -> Result<u8, ()> {
    let original = original().await.filter(|s| !s.is_empty()).ok_or(())?;
    let mut cmd = tokio::process::Command::new(&original);
    cmd.arg(prompt).env("GIT_ASKPASS", &original).env("ORGTREE_ASKPASS_ACTIVE", "1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::winproc::CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?;
    let mut answer = Vec::new();
    let work = async {
        (&mut stdout).take((MAX + 1) as u64).read_to_end(&mut answer).await.map_err(|_| ())?;
        if answer.len() > MAX { return Err(()); }
        let status = child.wait().await.map_err(|_| ())?;
        if !status.success() { return Err(()); }
        tokio::io::stdout().write_all(&answer).await.map_err(|_| ())?;
        Ok(0)
    };
    let result = tokio::time::timeout(Duration::from_secs(15), work).await.map_err(|_| ()).and_then(|r|r);
    answer.fill(0);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[nolog]
    fn encoded_targets_round_trip_without_host_confusion() {
        let t = target("Password for 'https://a%40b%3Ac@github.com:443/org/a%252Fb%20c': ").unwrap();
        assert_eq!(t.field, "password"); assert_eq!(t.username, "a@b:c");
        assert_eq!(t.host, "github.com:443"); assert_eq!(t.path, "org/a%2Fb c");
        let t = target("Username for 'https://github.com': ").unwrap();
        assert_eq!(t.username, ""); assert_eq!(t.path, "");
        for prompt in ["Other prompt", "Password: ", "Password for 'http://github.com': ",
            "Password for 'https://github.com%0aevil': ", "Password for 'https://a@b@github.com': ",
            "Password for 'https://github.com/bad%': "] { assert!(target(prompt).is_none()); }
    }
}
