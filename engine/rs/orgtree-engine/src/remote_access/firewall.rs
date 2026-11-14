//! The door's Windows Firewall rules, read back
//! (docs/rust-engine/remote-org.md, "Where the door listens").
//!
//! The engine never adds or removes a rule: that needs administrator rights
//! and a prompt, which only the desktop can show
//! (apps/desktop/main/remotefirewall.ts). Here the rules are only read, so the
//! owner's windows can say "Windows Firewall is blocking this" when the door
//! stands where no rule lets another computer reach it.
//!
//! A reading starts a PowerShell, so there is one when the owner looks or
//! changes something and never on a timer. A unit test reads nothing of the
//! computer, and a rig run reads a file the run wrote
//! (`rig-home\rig-firewall\remote-access.txt`) instead of the firewall.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::lifecycle::Listen;
use crate::engine::Engine;

/// The rule that lets Tailscale's addresses reach the door. The desktop adds it under this
/// name (`REMOTE_RULE` in apps/desktop/main/remotefirewall.ts; tests/remote-access-firewall.test.mjs
/// holds the two together).
pub const RULE: &str = "Orgtree remote access";
/// The rule that lets this private network reach it, when the owner chose that.
pub const RULE_LAN: &str = "Orgtree remote access (private network)";
/// How long a reading is taken to be true while the owner looks.
const FRESH: Duration = Duration::from_secs(30);
/// How long a reading may take.
#[cfg(not(test))]
const PATIENCE: Duration = Duration::from_secs(15);

/// One rule as Windows has it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    /// The private network's rule (`RULE_LAN`), not Tailscale's (`RULE`).
    pub lan: bool,
    /// Enabled, inbound and allowing.
    pub lets_in: bool,
    /// The local port, as Windows writes it.
    pub port: String,
    /// The rule is for this engine's own program.
    pub mine: bool,
}

/// What PowerShell is asked: the two rules, one line each, and `read` when it got to the end.
/// It changes nothing (every command in it is a `Get-`). A program's path is sent as base64, so
/// no code page can spoil it.
#[nolog]
pub fn script() -> String {
    [
        "$ErrorActionPreference = 'Stop'".to_string(),
        format!("foreach ($pair in @(@('tailscale', '{RULE}'), @('lan', '{RULE_LAN}'))) {{"),
        "  foreach ($r in @(Get-NetFirewallRule -DisplayName $pair[1] -ErrorAction SilentlyContinue)) {".to_string(),
        "    $port = @(($r | Get-NetFirewallPortFilter).LocalPort) -join ','".to_string(),
        "    $program = [string]($r | Get-NetFirewallApplicationFilter).Program".to_string(),
        "    $coded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($program))".to_string(),
        "    \"rule`t$($pair[0])`t$($r.Enabled)`t$($r.Direction)`t$($r.Action)`t$port`t$coded\"".to_string(),
        "  }".to_string(),
        "}".to_string(),
        "'read'".to_string(),
    ]
    .join("\n")
}

/// What the read printed. `None`: it did not get to its end, so nothing is known. `mine` says
/// whether a program's path is this engine's.
#[nolog]
pub fn parse(text: &str, mine: &dyn Fn(&str) -> bool) -> Option<Vec<Rule>> {
    use base64::Engine as _;
    let mut rules = Vec::new();
    let mut ended = false;
    for line in text.lines().map(|line| line.trim_end_matches(['\r', ' '])) {
        if line == "read" {
            ended = true;
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let [tag, kind, enabled, direction, action, port, program] = fields.as_slice() else { continue };
        let lan = match (*tag, *kind) {
            ("rule", "tailscale") => false,
            ("rule", "lan") => true,
            _ => continue,
        };
        let program = base64::engine::general_purpose::STANDARD.decode(program).ok().and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default();
        rules.push(Rule {
            lan,
            lets_in: *enabled == "True" && *direction == "Inbound" && *action == "Allow",
            port: port.to_string(),
            mine: !program.is_empty() && mine(&program),
        });
    }
    ended.then_some(rules)
}

/// Do the rules let the door in, as the owner chose it? Tailscale's rule when Tailscale was
/// chosen, the private network's when that was: each enabled, inbound, allowing, for the door's
/// own port and for this engine's own program. A rule for another port or another program lets
/// nobody reach this door. This computer itself (127.0.0.1) needs no rule: Windows Firewall
/// does not filter it.
#[nolog]
pub fn lets_in(rules: &[Rule], port: u16, listen: Listen) -> bool {
    let port = port.to_string();
    let fits = |wanted: bool| rules.iter().any(|rule| rule.lan == wanted && rule.lets_in && rule.mine && rule.port == port);
    (!listen.tailscale || fits(false)) && (!listen.lan || fits(true))
}

/// Is this the engine's own program? Two ways of writing one file's path are one program
/// (another case, a shortened name, a drive letter that is a folder elsewhere).
#[nolog]
pub fn mine(program: &str) -> bool {
    let Ok(own) = std::env::current_exe() else { return false };
    let same = |a: &std::path::Path, b: &std::path::Path| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy());
    if same(std::path::Path::new(program), &own) {
        return true;
    }
    match (std::fs::canonicalize(program), std::fs::canonicalize(&own)) {
        (Ok(theirs), Ok(own)) => same(&theirs, &own),
        _ => false,
    }
}

#[derive(Default)]
struct Held {
    /// The rules as they were last read. `None`: not read yet, or the reading failed.
    rules: Option<Vec<Rule>>,
    read_at: Option<Instant>,
    /// Tests only: what a reading finds (the read's output), instead of asking the computer.
    #[cfg(test)]
    fixed: Option<String>,
}

/// What is known of the door's firewall rules.
#[derive(Default)]
pub struct Firewall {
    held: Mutex<Held>,
    /// One reading at a time.
    one: tokio::sync::Mutex<()>,
}

/// Has this computer a Windows Firewall to read? (A unit test plays one on any system.)
#[nolog]
fn applies() -> bool {
    cfg!(any(windows, test))
}

#[nolog]
impl Firewall {
    /// What the owner's app is shown. `state`: `none` (this computer has no Windows Firewall),
    /// `unknown` (not read yet, or it could not be read), `ok`, or `missing` (the door, as the
    /// owner chose it, is not let in: "Windows Firewall is blocking this"). `present`: a rule
    /// of the door's is there at all, so it can be offered for removal once nothing is shared.
    pub fn shown(&self, port: u16, listen: Listen) -> Value {
        if !applies() {
            return json!({ "state": "none", "present": false });
        }
        match self.held.lock().ok().and_then(|held| held.rules.clone()) {
            None => json!({ "state": "unknown", "present": false }),
            Some(rules) => json!({ "state": if lets_in(&rules, port, listen) { "ok" } else { "missing" }, "present": !rules.is_empty() }),
        }
    }

    /// Tests only: what the next readings find (the read's output); `None`, that it cannot be read.
    #[cfg(test)]
    pub fn fix(&self, text: Option<&str>) {
        if let Ok(mut held) = self.held.lock() {
            held.fixed = text.map(str::to_string);
        }
    }

    fn fresh(&self) -> bool {
        self.held.lock().map(|held| held.read_at.is_some_and(|at| at.elapsed() < FRESH)).unwrap_or(true)
    }

    /// Keep a reading. True when what is known changed.
    fn keep(&self, rules: Option<Vec<Rule>>) -> bool {
        let Ok(mut held) = self.held.lock() else { return false };
        let changed = held.rules != rules;
        held.rules = rules;
        held.read_at = Some(Instant::now());
        changed
    }
}

/// The read's output, or `None` when the firewall could not be read.
#[cfg(test)]
#[nolog]
async fn read(engine: &Engine) -> Option<String> {
    engine.access.firewall.held.lock().ok().and_then(|held| held.fixed.clone())
}

/// The read's output, or `None` when the firewall could not be read.
#[cfg(not(test))]
#[nolog]
async fn read(_engine: &Engine) -> Option<String> {
    if crate::rig::active() {
        // a rig run never reads this computer's firewall: its rules are a file the run writes
        let file = crate::rig::home_dir()?.join("rig-firewall").join("remote-access.txt");
        return Some(std::fs::read_to_string(file).unwrap_or_else(|_| "read".to_string()));
    }
    let powershell = format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string()));
    let mut cmd = tokio::process::Command::new(powershell);
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &crate::phone::encode_ps(&script())]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    let out = tokio::time::timeout(PATIENCE, cmd.output()).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Read the rules now, and wait for it: the owner is about to turn a switch on, or has just
/// let the door in. True when what is known changed.
#[nolog]
pub async fn read_now(engine: &Engine) -> bool {
    if !applies() {
        return false;
    }
    let firewall = &engine.access.firewall;
    let _one = firewall.one.lock().await;
    let rules = read(engine).await.and_then(|text| parse(&text, &mine));
    firewall.keep(rules)
}

/// The owner is looking: when what is known is old, read again behind the answer, and tell
/// this desktop's windows if it changed. Nobody waits for it.
#[nolog]
pub fn look(engine: &Arc<Engine>) {
    if !applies() || engine.access.firewall.fresh() {
        return;
    }
    let engine = engine.clone();
    tokio::spawn(async move {
        let firewall = &engine.access.firewall;
        // somebody is reading already: that reading is the news
        let Ok(_one) = firewall.one.try_lock() else { return };
        if firewall.fresh() {
            return;
        }
        let rules = read(&engine).await.and_then(|text| parse(&text, &mine));
        if firewall.keep(rules) {
            super::lifecycle::publish(&engine);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coded(program: &str) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(program)
    }

    fn line(kind: &str, enabled: &str, direction: &str, action: &str, port: &str, program: &str) -> String {
        format!("rule\t{kind}\t{enabled}\t{direction}\t{action}\t{port}\t{}", coded(program))
    }

    const ENGINE: &str = "C:\\Program Files\\Orgtree\\resources\\engine\\orgtree-engine.exe";

    fn engine(program: &str) -> bool {
        program == ENGINE
    }

    #[test]
    fn the_rules_are_read_as_powershell_prints_them() {
        // nothing of the door's: known, and empty
        assert_eq!(parse("read\r\n", &engine), Some(vec![]));
        // the read did not get to its end (PowerShell failed, was stopped, printed nothing): nothing is known
        assert_eq!(parse("", &engine), None);
        assert_eq!(parse(&line("tailscale", "True", "Inbound", "Allow", "7431", ENGINE), &engine), None);
        let text = [
            line("tailscale", "True", "Inbound", "Allow", "7431", ENGINE),
            line("lan", "True", "Inbound", "Allow", "7431", ENGINE),
            "read".to_string(),
        ]
        .join("\r\n");
        assert_eq!(parse(&text, &engine), Some(vec![
            Rule { lan: false, lets_in: true, port: "7431".into(), mine: true },
            Rule { lan: true, lets_in: true, port: "7431".into(), mine: true },
        ]));
        // a path that is not plain ASCII arrives whole: it travels as base64
        let odd = "C:\\Users\\Zo\u{eb} O\u{2019}Brien\\orgtree-engine.exe";
        let got = parse(&format!("{}\nread", line("tailscale", "True", "Inbound", "Allow", "7431", odd)), &|program| program == odd);
        assert_eq!(got, Some(vec![Rule { lan: false, lets_in: true, port: "7431".into(), mine: true }]));
        // a rule that is off, outbound or blocking lets nobody in; another program's is not mine
        for (enabled, direction, action) in [("False", "Inbound", "Allow"), ("True", "Outbound", "Allow"), ("True", "Inbound", "Block")] {
            let got = parse(&format!("{}\nread", line("tailscale", enabled, direction, action, "7431", ENGINE)), &engine).unwrap();
            assert_eq!(got, vec![Rule { lan: false, lets_in: false, port: "7431".into(), mine: true }], "{enabled} {direction} {action}");
        }
        let other = parse(&format!("{}\nread", line("tailscale", "True", "Inbound", "Allow", "7431", "C:\\other\\orgtree-engine.exe")), &engine).unwrap();
        assert!(!other[0].mine);
        // a rule without a program is a rule for every program: never taken for the engine's
        let any = parse("rule\ttailscale\tTrue\tInbound\tAllow\t7431\t\nread", &|_| true).unwrap();
        assert!(!any[0].mine);
        // what is not a rule's line is not a rule: other text, another kind, too few or too many fields
        let noise = format!("WARNING: something\nrule\tphone\tTrue\tInbound\tAllow\t7431\t{c}\nrule\ttailscale\tTrue\nrule\tlan\tTrue\tInbound\tAllow\t7431\t{c}\textra\nread", c = coded(ENGINE));
        assert_eq!(parse(&noise, &engine), Some(vec![]));
    }

    #[test]
    fn the_door_is_let_in_only_by_rules_for_its_port_its_program_and_the_owners_choice() {
        // Tailscale, and this private network or not: what the one old choice was
        let ts = |lan: bool| Listen { tailscale: true, lan, local: false };
        let rule = |lan: bool, port: &str| Rule { lan, lets_in: true, port: port.into(), mine: true };
        // no rule: blocked
        assert!(!lets_in(&[], 7431, ts(false)));
        // Tailscale's rule is enough for "Tailscale only"
        assert!(lets_in(&[rule(false, "7431")], 7431, ts(false)));
        // "and this private network" needs that network's rule as well
        assert!(!lets_in(&[rule(false, "7431")], 7431, ts(true)));
        assert!(lets_in(&[rule(false, "7431"), rule(true, "7431")], 7431, ts(true)));
        // the private network's rule alone is never enough: Tailscale's is always wanted
        assert!(!lets_in(&[rule(true, "7431")], 7431, ts(true)));
        assert!(!lets_in(&[rule(true, "7431")], 7431, ts(false)));
        // a private-network rule that was left behind does no harm to "Tailscale only"
        assert!(lets_in(&[rule(false, "7431"), rule(true, "7431")], 7431, ts(false)));
        // the port was changed: the old rules let nobody reach the new one
        assert!(!lets_in(&[rule(false, "7431"), rule(true, "7431")], 7440, ts(false)));
        assert!(!lets_in(&[rule(false, "7440"), rule(true, "7431")], 7440, ts(true)));
        // a list or a range of ports is not what the desktop adds, and is not taken for it
        assert!(!lets_in(&[rule(false, "7431,7440")], 7431, ts(false)));
        assert!(!lets_in(&[rule(false, "7000-8000")], 7431, ts(false)));
        assert!(!lets_in(&[rule(false, "Any")], 7431, ts(false)));
        // off, outbound or blocking; or another program's
        assert!(!lets_in(&[Rule { lets_in: false, ..rule(false, "7431") }], 7431, ts(false)));
        assert!(!lets_in(&[Rule { mine: false, ..rule(false, "7431") }], 7431, ts(false)));
        // two rules of one name: one that fits is enough
        assert!(lets_in(&[Rule { lets_in: false, ..rule(false, "7431") }, rule(false, "7431")], 7431, ts(false)));
        // the private network by itself: Tailscale's rule is not asked for
        let lan_only = Listen { tailscale: false, lan: true, local: false };
        assert!(lets_in(&[rule(true, "7431")], 7431, lan_only));
        assert!(!lets_in(&[rule(false, "7431")], 7431, lan_only));
        // this computer itself needs no rule at all
        assert!(lets_in(&[], 7431, Listen { tailscale: false, lan: false, local: true }));
        assert!(!lets_in(&[], 7431, Listen { tailscale: true, lan: false, local: true }));
    }

    #[test]
    fn the_read_names_the_two_rules_and_changes_nothing() {
        let script = script();
        assert!(script.contains("'Orgtree remote access'") && script.contains("'Orgtree remote access (private network)'"), "{script}");
        assert!(script.trim_end().ends_with("'read'"), "the end mark is the last thing it prints");
        // every command in it only reads
        let commands: Vec<&str> = script.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).filter(|word| {
            let mut parts = word.splitn(2, '-');
            matches!((parts.next(), parts.next()), (Some(verb), Some(noun)) if !verb.is_empty() && noun.starts_with("NetFirewall"))
        }).collect();
        assert_eq!(commands, ["Get-NetFirewallRule", "Get-NetFirewallPortFilter", "Get-NetFirewallApplicationFilter"]);
        for verb in ["New-", "Set-", "Remove-", "Enable-", "Disable-", "Rename-", "Copy-", "Start-Process", "Invoke-", "iex"] {
            assert!(!script.contains(verb), "{verb}");
        }
    }

    #[test]
    fn the_engines_own_program_is_known_however_its_path_is_written() {
        let own = std::env::current_exe().unwrap();
        let text = own.to_string_lossy().to_string();
        assert!(mine(&text));
        assert!(mine(&text.to_ascii_uppercase()) || cfg!(not(windows)), "Windows paths have no case");
        assert!(mine(&std::fs::canonicalize(&own).unwrap().to_string_lossy()));
        assert!(!mine(""));
        assert!(!mine(&own.with_file_name("another-program.exe").to_string_lossy()));
        assert!(!mine(&own.parent().unwrap().to_string_lossy()));
    }
}
