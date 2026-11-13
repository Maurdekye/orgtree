//! The door's Windows Firewall rules, read back
//! (docs/rust-engine/remote-org.md, "Where the door listens").
//!
//! Not built yet: this is the shape the tests are written against.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::engine::Engine;

pub const RULE: &str = "";
pub const RULE_LAN: &str = "";

/// One rule as Windows has it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub lan: bool,
    pub lets_in: bool,
    pub port: String,
    pub mine: bool,
}

#[nolog]
pub fn script() -> String {
    String::new()
}

#[nolog]
pub fn parse(_text: &str, _mine: &dyn Fn(&str) -> bool) -> Option<Vec<Rule>> {
    None
}

#[nolog]
pub fn lets_in(_rules: &[Rule], _port: u16, _lan: bool) -> bool {
    false
}

#[nolog]
pub fn mine(_program: &str) -> bool {
    false
}

/// What is known of the door's firewall rules.
#[derive(Default)]
pub struct Firewall;

#[nolog]
impl Firewall {
    pub fn shown(&self, _port: u16, _lan: bool) -> Value {
        json!({ "state": "none", "present": false })
    }

    #[cfg(test)]
    pub fn fix(&self, _text: Option<&str>) {}
}

#[nolog]
pub async fn read_now(_engine: &Engine) -> bool {
    false
}

#[nolog]
pub fn look(_engine: &Arc<Engine>) {}

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
        let rule = |lan: bool, port: &str| Rule { lan, lets_in: true, port: port.into(), mine: true };
        // no rule: blocked
        assert!(!lets_in(&[], 7431, false));
        // Tailscale's rule is enough for "Tailscale only"
        assert!(lets_in(&[rule(false, "7431")], 7431, false));
        // "and this private network" needs that network's rule as well
        assert!(!lets_in(&[rule(false, "7431")], 7431, true));
        assert!(lets_in(&[rule(false, "7431"), rule(true, "7431")], 7431, true));
        // the private network's rule alone is never enough: Tailscale's is always wanted
        assert!(!lets_in(&[rule(true, "7431")], 7431, true));
        assert!(!lets_in(&[rule(true, "7431")], 7431, false));
        // a private-network rule that was left behind does no harm to "Tailscale only"
        assert!(lets_in(&[rule(false, "7431"), rule(true, "7431")], 7431, false));
        // the port was changed: the old rules let nobody reach the new one
        assert!(!lets_in(&[rule(false, "7431"), rule(true, "7431")], 7440, false));
        assert!(!lets_in(&[rule(false, "7440"), rule(true, "7431")], 7440, true));
        // a list or a range of ports is not what the desktop adds, and is not taken for it
        assert!(!lets_in(&[rule(false, "7431,7440")], 7431, false));
        assert!(!lets_in(&[rule(false, "7000-8000")], 7431, false));
        assert!(!lets_in(&[rule(false, "Any")], 7431, false));
        // off, outbound or blocking; or another program's
        assert!(!lets_in(&[Rule { lets_in: false, ..rule(false, "7431") }], 7431, false));
        assert!(!lets_in(&[Rule { mine: false, ..rule(false, "7431") }], 7431, false));
        // two rules of one name: one that fits is enough
        assert!(lets_in(&[Rule { lets_in: false, ..rule(false, "7431") }, rule(false, "7431")], 7431, false));
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
