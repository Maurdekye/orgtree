//! Desktop-owned interactive host launch. Elevation is requested by the desktop,
//! never here. Prepare/commit keeps UAC cancellation ahead of engine shutdown.
use std::{io::Read, path::{Path, PathBuf}, process::ExitCode, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use crate::core_process::{Identity, Life};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Context {
    pub session: Option<u32>,
    pub console: Option<u32>,
    pub owns_console: bool,
    pub known: bool,
    pub operator_sid: Option<String>,
    pub elevated: bool,
}

#[nolog]
pub(crate) fn context() -> Context {
    let (operator_sid, elevated) = crate::host::launch_identity();
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
        let mut id = 0;
        let session = (unsafe { ProcessIdToSessionId(std::process::id(), &mut id) } != 0).then_some(id);
        let console = unsafe { WTSGetActiveConsoleSessionId() };
        let console = (console != u32::MAX && console != 0).then_some(console);
        let sessions = crate::core_process::Sessions::new().and_then(|mut s| s.read());
        let owns_console = console.is_some_and(|c| sessions.as_ref().is_some_and(|rows| rows.iter().any(|s| s.id == c)));
        let known = session.is_some() && sessions.is_some() && operator_sid.is_some();
        Context { session, console, owns_console, known, operator_sid, elevated }
    }
    #[cfg(not(windows))]
    Context { session: None, console: None, owns_console: false, known: false, operator_sid, elevated }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    nonce: String,
    session: u32,
    operator_sid: String,
    parent: Identity,
    data_root: PathBuf,
    ui_directory: PathBuf,
    admin: bool,
}

#[nolog]
fn validate(request: &Request, here: &Context, parent: Life) -> Result<(), &'static str> {
    if request.nonce.len() != 64 || !request.nonce.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid request nonce"); }
    if !here.known || request.session == 0 || here.session != Some(request.session) || here.console != Some(request.session) || !here.owns_console {
        return Err("the requesting operator is not in this signed-in console session");
    }
    if here.operator_sid.as_deref() != Some(request.operator_sid.as_str()) { return Err("the elevated launcher belongs to a different operator"); }
    if request.admin && !here.elevated { return Err("administrator launch was not elevated"); }
    if parent != Life::Alive { return Err("the requesting desktop identity is no longer live"); }
    if !request.data_root.is_absolute() || !request.ui_directory.is_absolute() || !request.ui_directory.join("index.html").is_file() {
        return Err("invalid launch paths");
    }
    Ok(())
}

#[nolog]
fn read_request(file: &Path) -> Result<Request, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(file).map_err(|_| "cannot read launch request")?.take(16385)
        .read_to_end(&mut bytes).map_err(|_| "cannot read launch request")?;
    if bytes.len() > 16384 { return Err("launch request is too large".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "invalid launch request".into())
}

#[nolog]
fn write_receipt(dir: &Path, name: &str, value: &serde_json::Value) -> Result<(), String> {
    let temp = dir.join(format!("{name}.tmp"));
    std::fs::write(&temp, value.to_string()).map_err(|_| "cannot write launcher receipt")?;
    std::fs::rename(temp, dir.join(name)).map_err(|_| "cannot publish launcher receipt".into())
}

#[nolog]
fn prepared(file: &Path) -> Result<ExitCode, String> {
    let request = read_request(file)?;
    let dir = file.parent().ok_or("request has no parent directory")?;
    let here = context();
    validate(&request, &here, crate::core_process::life(&request.parent))?;
    let own = crate::core_process::identity(std::process::id()).ok_or("cannot stamp launcher identity")?;
    write_receipt(dir, "ready.json", &serde_json::json!({"nonce":request.nonce,"identity":own,"session":request.session,"admin":request.admin}))?;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if dir.join("cancel").exists() || Instant::now() >= deadline || crate::core_process::life(&request.parent) != Life::Alive {
            write_receipt(dir, "done.json", &serde_json::json!({"cancelled":true}))?;
            return Ok(ExitCode::from(2));
        }
        if std::fs::read_to_string(dir.join("commit")).ok().as_deref() == Some(request.nonce.as_str()) { break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Nothing before commit stops or starts an engine. Recheck the operator after
    // the prompt/wait; a sign-out or fast-user switch cannot become a boot launch.
    validate(&request, &context(), crate::core_process::life(&request.parent))?;
    std::env::set_var("ORGTREE_V2_DATA", &request.data_root);
    std::env::set_var("ORGTREE_V2_UI_DIR", &request.ui_directory);
    // The desktop must prove graceful release before committing. The host still
    // owns the native root lock/refusal checks, so a competing owner is preserved.
    write_receipt(dir, "done.json", &serde_json::json!({"committed":true}))?;
    Ok(crate::host::run_in_session(request.admin))
}

#[nolog]
pub fn cli(args: &[String]) -> ExitCode {
    if args.first().map(String::as_str) == Some("inspect") && args.len() <= 2 {
        let mut value = serde_json::to_value(context()).unwrap();
        if let Some(pid) = args.get(1).and_then(|v| v.parse::<u32>().ok()) {
            value["parent"] = serde_json::json!(crate::core_process::identity(pid));
        }
        println!("{value}");
        return ExitCode::SUCCESS;
    }
    if args.first().map(String::as_str) == Some("prepare") && args.len() == 2 {
        let file = Path::new(&args[1]);
        match prepared(file) {
            Ok(code) => return code,
            Err(error) => {
                if let Some(dir) = file.parent() { let _ = write_receipt(dir, "error.json", &serde_json::json!({"error":error})); }
                eprintln!("session launch refused: {error}");
                return ExitCode::from(1);
            }
        }
    }
    eprintln!("usage: session-launch inspect | prepare <request.json>");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Request, Context) {
        (Request { nonce:"a".repeat(64), session:7, operator_sid:"operator".into(), parent:Identity {pid:42,created:"123".into()},
            data_root:PathBuf::from("relative"), ui_directory:PathBuf::from("relative"), admin:true },
         Context {session:Some(7),console:Some(7),owns_console:true,known:true,operator_sid:Some("operator".into()),elevated:true})
    }
    #[test] fn no_console_refuses() { let (r,mut c)=fixture();c.console=None;assert!(validate(&r,&c,Life::Alive).unwrap_err().contains("console")); }
    #[test] fn unknown_session_probe_refuses() { let (r,mut c)=fixture();c.known=false;assert!(validate(&r,&c,Life::Alive).unwrap_err().contains("console")); }
    #[test] fn other_operator_refuses() { let (r,mut c)=fixture();c.operator_sid=Some("other".into());assert!(validate(&r,&c,Life::Alive).unwrap_err().contains("different operator")); }
    #[test] fn absent_elevation_refuses() { let (r,mut c)=fixture();c.elevated=false;assert!(validate(&r,&c,Life::Alive).unwrap_err().contains("not elevated")); }
    #[test] fn reused_or_unknown_parent_refuses() { let (r,c)=fixture();for life in [Life::Gone,Life::Unknown] {assert!(validate(&r,&c,life).unwrap_err().contains("desktop identity"));} }
    #[test] fn malformed_nonce_refuses() { let (mut r,c)=fixture();r.nonce="x".repeat(64);assert!(validate(&r,&c,Life::Alive).unwrap_err().contains("nonce")); }
    #[test] fn no_path_or_ui_validation_bypass() { let (r,c)=fixture();assert_eq!(validate(&r,&c,Life::Alive),Err("invalid launch paths")); }
}
