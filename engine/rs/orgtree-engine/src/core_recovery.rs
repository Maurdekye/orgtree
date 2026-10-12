//! Independent Windows recovery. No provider state, raw stderr or network I/O.
//! The desktop owns engine launch/attach; a detached native watcher replaces a
//! dead desktop. Native handles, not HTTP failures or reused PIDs, prove death.
use std::process::ExitCode;
#[cfg(windows)] use std::path::Path;

#[nolog]
pub fn cli(args: &[String]) -> ExitCode {
    #[cfg(windows)] { return win::cli(args); }
    #[cfg(not(windows))] { let _ = args; ExitCode::from(2) }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::{core_process::{self, Identity, Life}, core_state::{self, Snapshot}, core_diagnostics};
    use std::{fs, io::{Read, Write}, path::PathBuf, process::{Command, Stdio}, time::{Duration, Instant}};
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::{Foundation::*, System::{Threading::*, SystemInformation::*}};

    struct Handle(HANDLE);
    #[nolog]
    impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

    #[nolog]
    fn opened(who: &Identity) -> Option<Handle> {
        unsafe {
            let h = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, who.pid));
            if h.0.is_null() { return None; }
            let mut c: FILETIME = std::mem::zeroed(); let mut e = c; let mut k = c; let mut u = c;
            if GetProcessTimes(h.0, &mut c, &mut e, &mut k, &mut u) == 0 { return None; }
            let stamp = (((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64).to_string();
            (stamp == who.created).then_some(h)
        }
    }
    #[nolog]
    fn exit_code(h: &Handle) -> Option<u32> {
        unsafe {
            if WaitForSingleObject(h.0, 0) != WAIT_OBJECT_0 { return None; }
            let mut code = 0;
            (GetExitCodeProcess(h.0, &mut code) != 0).then_some(code)
        }
    }
    #[nolog]
    fn image(h: &Handle) -> Option<PathBuf> {
        let mut buf = vec![0u16; 32768]; let mut n = buf.len() as u32;
        if unsafe { QueryFullProcessImageNameW(h.0, 0, buf.as_mut_ptr(), &mut n) } == 0 { return None; }
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..n as usize])))
    }
    #[nolog]
    fn singleton(root: &Path, role: &str) -> Option<Handle> {
        use sha2::{Digest, Sha256};
        let key = hex::encode(Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes()));
        let name: Vec<u16> = format!("Local\\OrgtreeRecovery-{role}-{key}").encode_utf16().chain(Some(0)).collect();
        let h = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if h.is_null() { return None; }
        let out = Handle(h);
        (!exists).then_some(out)
    }
    #[nolog]
    fn resources() -> bool {
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (unsafe { GlobalMemoryStatusEx(&mut m) != 0 })
            && m.ullAvailPhys >= 3 * 1024 * 1024 * 1024 && m.ullAvailPageFile >= 4 * 1024 * 1024 * 1024
    }
    #[nolog]
    fn read_json(path: &Path) -> Option<serde_json::Value> {
        let mut b = Vec::new(); fs::File::open(path).ok()?.take(8193).read_to_end(&mut b).ok()?;
        if b.len() > 8192 { return None; }
        serde_json::from_slice(&b).ok()
    }
    #[nolog]
    fn current(root: &Path, who: &Identity) -> Option<Snapshot> {
        let s = core_state::read(root)?;
        if s.desktop.as_ref().is_some_and(|d| d != who) || core_state::stopped(root, &s) { return None; }
        // Failed WTS inspection suspends launch admission, not observation.
        // Retain native handles until a known logoff/replacement/Quit.
        if signed_in(root, &s) == Some(false) { None } else { Some(s) }
    }
    #[nolog]
    fn signed_in(root: &Path, s: &Snapshot) -> Option<bool> {
        core_state::sessions(root, &mut core_process::Sessions::new())
            .map(|active| s.sessions.iter().any(|a| active.contains(a)))
    }
    #[nolog]
    fn record(root: &Path, event: &str, s: &Snapshot, code: Option<u32>) {
        let pid = if event.contains("desktop") { s.desktop.as_ref().map_or(0, |d| d.pid) } else { s.engine.pid };
        core_diagnostics::record(root, event, Some(&s.generation), pid, code);
    }
    // One durable attempt per failed identity, capped across successive crashes.
    // The short native owner serializes admission, including concurrent callers.
    #[nolog]
    fn claim(root: &Path, role: &str, key: &str) -> bool {
        let Some(_owner) = singleton(root, "admission") else { return false; };
        let now = core_state::now();
        let file = root.join(format!("core-recovery-{role}-budget.json"));
        let mut times: Vec<i64> = match read_json(&file) {
            Some(v) => match serde_json::from_value(v) { Ok(t) => t, Err(_) => return false },
            None if file.exists() => return false,
            None => vec![],
        };
        times.retain(|t| now.saturating_sub(*t) < 600_000);
        if times.len() >= 3 || times.last().is_some_and(|t| now.saturating_sub(*t) < [5000, 15000, 45000][times.len().min(2)]) { return false; }
        // One fixed claim per role is sufficient: current() binds admission to
        // the current failed identity. Late observers cannot claim an old one.
        let marker = root.join(format!("core-recovery-{role}-claim"));
        if fs::read_to_string(&marker).ok().as_deref() == Some(key) { return false; }
        let Ok(mut f) = fs::OpenOptions::new().write(true).create(true).truncate(true).open(marker) else { return false; };
        if f.write_all(key.as_bytes()).and_then(|_| f.sync_all()).is_err() { return false; }
        times.push(now);
        let Ok(bytes) = serde_json::to_vec(&times) else { return false; };
        let Ok(mut f) = fs::OpenOptions::new().write(true).create(true).truncate(true).open(file) else { return false; };
        f.write_all(&bytes).and_then(|_| f.sync_all()).is_ok()
    }

    #[nolog]
    pub fn cli(args: &[String]) -> ExitCode {
        if args.len() < 3 || !Path::new(&args[1]).is_absolute() { return ExitCode::from(2); }
        let Ok(root) = Path::new(&args[1]).canonicalize() else { return ExitCode::from(2); };
        let Ok(pid) = args[2].parse::<u32>() else { return ExitCode::from(2); };
        let Some(s) = core_state::read(&root) else {
            if args[0] == "quit" {
                if core_process::identity(pid).is_none() { return ExitCode::from(1); }
                let Some(active) = core_state::sessions(&root, &mut core_process::Sessions::new()) else { return ExitCode::from(1); };
                if core_state::manual_quit_sessions(&root, &active).is_err() { return ExitCode::from(1); }
                println!("{{\"cancelled\":true}}");
            } else { println!("{{}}"); }
            return ExitCode::SUCCESS;
        };
        let who = if args[0] == "quit" {
            // Before registration the new desktop may be waiting for a boot
            // engine. A known live different desktop still owns that session.
            if s.desktop.as_ref().is_some_and(|d| d.pid != pid && core_process::life(d) != Life::Gone) { return ExitCode::from(1); }
            core_process::identity(pid)
        } else if s.desktop.is_none() { core_process::identity(pid) }
          else { s.desktop.as_ref().filter(|w| w.pid == pid).cloned() };
        let Some(who) = who else { println!("{{}}"); return ExitCode::SUCCESS; };
        match args[0].as_str() {
            "quit" if core_process::identity(pid).as_ref() == Some(&who) => {
                // Serialize Quit with the final native desktop launch. A
                // launch that won immediately before Quit is included in the
                // new desktop's journal stop check, never a fresh user launch.
                let until = Instant::now();
                let _publication = loop {
                    if let Some(lock) = singleton(&root, "publication") { break lock; }
                    if until.elapsed() >= Duration::from_secs(4) { return ExitCode::from(1); }
                    std::thread::sleep(Duration::from_millis(20));
                };
                if core_state::manual_quit(&root, &s).is_err() { return ExitCode::from(1); }
                record(&root, "manual-quit", &s, None);
                println!("{{\"cancelled\":true}}");
            }
            "engine" if core_process::identity(pid).as_ref() == Some(&who) => {
                let valid = current(&root, &who).filter(|v| v.generation == s.generation)
                    .is_some_and(|v| !core_state::recovery_deferred(&v) && signed_in(&root, &v) == Some(true) && core_process::life(&v.engine) == Life::Gone);
                let ready = valid && resources() && claim(&root, "engine", &s.generation);
                if ready { record(&root, "engine-recovery-admitted", &s, None); }
                println!("{}", serde_json::json!({"admitted":ready}));
            }
            "arm" if core_process::identity(pid).as_ref() == Some(&who) => {
                let running = read_json(&root.join("core-recovery-watcher.json"))
                    .and_then(|v| serde_json::from_value::<(Identity, Identity)>(v).ok())
                    .is_some_and(|(d, w)| d == who && core_process::life(&w) == Life::Alive);
                if !running && !core_state::stopped(&root, &s) {
                    let Ok(exe) = std::env::current_exe() else { return ExitCode::from(1); };
                    let child = Command::new(exe).args(["core-recovery", "watch"])
                        .arg(&root).arg(pid.to_string()).arg(&who.created)
                        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB).spawn();
                    if child.is_err() { record(&root, "watcher-start-refused", &s, None); }
                }
                println!("{}", serde_json::json!({"armed":running}));
            }
            "watch" if args.get(3) == Some(&who.created) => { watch(&root, who); }
            _ => return ExitCode::from(2),
        }
        ExitCode::SUCCESS
    }

    #[nolog]
    fn watch(root: &Path, desktop: Identity) {
        let Some(_owner) = singleton(root, "desktop-watch") else { return; };
        let Some(d) = opened(&desktop) else { return; };
        let Some(exe) = image(&d) else { return; };
        let Some(me) = core_process::identity(std::process::id()) else { return; };
        let Some(mut s) = current(root, &desktop) else { return; };
        let Some(mut e) = opened(&s.engine) else { return; };
        let Ok(bytes) = serde_json::to_vec(&(desktop.clone(), me)) else { return; };
        if fs::write(root.join("core-recovery-watcher.json"), bytes).is_err() { return; }
        let mut noted_exit = false;
        loop {
            let Some(next) = current(root, &desktop) else { return; };
            if next.engine != s.engine {
                let Some(handle) = opened(&next.engine) else { return; };
                e = handle; noted_exit = false;
            }
            s = next;
            if !noted_exit {
                if let Some(code) = exit_code(&e) { record(root, "native-engine-exit", &s, Some(code)); noted_exit = true; }
            }
            if let Some(code) = exit_code(&d) {
                core_diagnostics::record(root, "native-desktop-exit", Some(&s.generation), desktop.pid, Some(code));
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(300) {
            let Some(fresh) = current(root, &desktop) else { return; };
            // Give an intentional installer/relaunch its original allowance;
            // never reset it on retries, and never launch during unknown WTS.
            if !core_state::recovery_deferred(&fresh) && signed_in(root, &fresh) == Some(true)
                && began.elapsed() >= Duration::from_secs(5) && resources() {
                let key = format!("{}-{}", desktop.pid, desktop.created);
                if claim(root, "desktop", &key) {
                    let Some(_publication) = singleton(root, "publication") else { return; };
                    // Re-read after admission. A user's launch or Quit wins.
                    if !current(root, &desktop).is_some_and(|s| !core_state::recovery_deferred(&s) && signed_in(root, &s) == Some(true)) { return; }
                    let child = Command::new(&exe).arg("--core-recovered")
                        .env_remove("ELECTRON_RUN_AS_NODE").env("ORGTREE_V2_DATA", root)
                        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                        // The observer is already independent of the desktop
                        // and owns no kill-on-close job. Do not break out of
                        // an unrelated enclosing job (e.g. test containment).
                        .creation_flags(CREATE_NEW_PROCESS_GROUP).spawn();
                    record(root, if child.is_ok() { "desktop-recovery-launched" } else { "desktop-recovery-launch-failed" }, &fresh, None);
                    return;
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        record(root, "desktop-recovery-budget-or-resources-exhausted", &s, None);
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn admission_is_single_owner_and_bounded_across_crashes() {
            let dir = std::env::temp_dir().join(format!("orgtree-recovery-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let owner = singleton(&dir, "admission").unwrap();
            assert!(!claim(&dir, "engine", "first"));
            drop(owner);
            assert!(claim(&dir, "engine", "first"));
            assert!(!claim(&dir, "engine", "first"));
            assert!(!claim(&dir, "engine", "too-soon"));
            let budget = dir.join("core-recovery-engine-budget.json");
            fs::write(&budget, serde_json::to_vec(&vec![core_state::now()-60_000]).unwrap()).unwrap();
            assert!(claim(&dir, "engine", "second"));
            fs::write(&budget, serde_json::to_vec(&vec![core_state::now()-60_000;2]).unwrap()).unwrap();
            assert!(claim(&dir, "engine", "third"));
            fs::write(&budget, serde_json::to_vec(&vec![core_state::now()-60_000;3]).unwrap()).unwrap();
            assert!(!claim(&dir, "engine", "fourth"));
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "fixed-size journal, no per-crash file growth");
            fs::remove_dir_all(dir).unwrap();
        }
        #[test]
        fn retained_handle_reports_exit_only_for_exact_identity() {
            let who = core_process::identity(std::process::id()).unwrap();
            let h = opened(&who).unwrap();
            assert!(exit_code(&h).is_none());
            assert!(image(&h).is_some());
            let mut stale = who; stale.created = "0".into();
            assert!(opened(&stale).is_none());
        }
    }

}
