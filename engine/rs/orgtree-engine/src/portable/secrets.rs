//! Secrets in what an export carries (docs/rust-engine/agent-export.md, "Secrets").
//!
//! USER 2026-11-23 10:43Z m3c072bcdc19a: nothing is stripped unless the app
//! setting is ticked; while it is not, a manual export warns when it detects
//! secrets the setting would have stripped. USER 20:30Z m2106530cca00 took the
//! classes as proposed: credential files by name, recognisable secrets in
//! text, and exact matches of the keys this Orgtree holds. Personal data
//! (names, addresses, paths) is not a secret here.
//!
//! One detector serves the scan and the stripping, so the warning names
//! exactly what the setting would take out. It reports kinds and counts,
//! never a value. The text patterns are the union of the two template
//! detectors (`domain/template_notes.rs`, `domain/template_links.rs`) and the
//! secret patterns of Streamer mode (`packages/contracts/streamer.ts`),
//! without Streamer mode's privacy classes.

use std::collections::BTreeMap;

use regex::bytes::{Regex, RegexSet};
use serde_json::Value;

/// What takes a stripped secret's place.
pub const REMOVED: &str = "[secret removed]";
/// A text larger than this is not scanned (the report says so).
pub const SCAN_MAX: u64 = 64 * 1024 * 1024;

pub const PRIVATE_KEY: &str = "private key";
pub const TOKEN: &str = "provider token";
pub const WEB_TOKEN: &str = "web token";
pub const AUTH_HEADER: &str = "authorization header";
pub const ASSIGNED: &str = "password or key";
pub const URL_PASSWORD: &str = "password in a URL";
pub const URL_SECRET: &str = "secret in a URL";
pub const KNOWN: &str = "key this Orgtree holds";
pub const CREDENTIAL_FILE: &str = "credential file";
pub const WATCHDOG: &str = "watchdog credentials";

/// How many secrets of each kind were found.
pub type Hits = BTreeMap<&'static str, u64>;

/// The names a setting that holds a secret ends with.
const SECRET_NAMES: &str = r"(?:api[_\-]?key|apikey|access[_\-]?key|access[_\-]?token|auth[_\-]?token|refresh[_\-]?token|client[_\-]?secret|secret[_\-]?key|private[_\-]?key|password|passwd|pwd|secret|token)";

struct Pattern {
    kind: &'static str,
    re: Regex,
    /// What of the match is the secret: one of these groups (the first that took part), or all of it.
    groups: &'static [usize],
    valid: fn(&[u8]) -> bool,
}

#[nolog]
fn any(_: &[u8]) -> bool {
    true
}

#[nolog]
fn has_digit(value: &[u8]) -> bool {
    value.iter().any(u8::is_ascii_digit)
}

/// A written-out value, not a reference to one: `${NAME}`, `<your key>`, `{{ key }}` and a
/// call are how a text names a secret it does not hold.
#[nolog]
fn literal(value: &[u8]) -> bool {
    !matches!(value.first(), Some(b'$' | b'<' | b'{' | b'%' | b'-')) && !value.contains(&b'(') && !value.windows(2).any(|w| w == b"${" || w == b"{{")
}

/// An unquoted value: letters and digits both, as a key or a password has and a name has not.
#[nolog]
fn mixed(value: &[u8]) -> bool {
    has_digit(value) && value.iter().any(u8::is_ascii_alphabetic) && literal(value)
}

#[nolog]
fn patterns() -> Vec<Pattern> {
    let p = |kind, re: &str, groups, valid| Pattern { kind, re: Regex::new(&format!("(?-u){re}")).expect("a secret pattern"), groups, valid };
    vec![
        // a whole block when its end is there, else its first line
        p(PRIVATE_KEY, r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)-----END [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", &[], any),
        p(TOKEN, r"\b(?:sk-ant-[A-Za-z0-9_\-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|glpat-[A-Za-z0-9_\-]{16,}|hf_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_\-]{30,})", &[], has_digit),
        p(TOKEN, r"\bAKIA[0-9A-Z]{16}\b", &[], any),
        p(WEB_TOKEN, r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", &[], any),
        p(AUTH_HEADER, r#"(?i)\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=\-]{8,})"#, &[1], literal),
        p(AUTH_HEADER, r"(?i)\bbearer\s+([A-Za-z0-9._~+/=\-]{20,})", &[1], has_digit),
        p(ASSIGNED, &format!(r#"(?i)[A-Za-z0-9_\-.]*{SECRET_NAMES}\b["']?\s*[:=]\s*(?:"([^"\s]{{8,}})"|'([^'\s]{{8,}})')"#), &[1, 2], literal),
        p(ASSIGNED, &format!(r#"(?i)[A-Za-z0-9_\-.]*{SECRET_NAMES}\b["']?\s*[:=]\s*([A-Za-z0-9_+/=~@!#%^*\-]{{8,}})"#), &[1], mixed),
        p(ASSIGNED, r#"(?i)--(?:token|password|secret|api-key|apikey|auth-token)(?:=|\s+)["']?([^\s"']{8,})"#, &[1], literal),
        p(URL_PASSWORD, r#"[A-Za-z][A-Za-z0-9+.\-]*://[^/\s:@"']+:([^@\s/"']{3,})@"#, &[1], literal),
        p(URL_SECRET, r#"(?i)[?&](?:access_token|api_key|apikey|auth|key|password|secret|sig|signature|token)=([^&\s"'#]{8,})"#, &[1], literal),
    ]
}

/// Finds secrets in text and in JSON, and takes them out when asked.
pub struct Detector {
    patterns: Vec<Pattern>,
    /// One pass that says which patterns can match at all.
    any: RegexSet,
    /// The keys this Orgtree holds, as one alternation of literals.
    known: Option<Regex>,
    /// A setting's name that says its value is a secret (for JSON objects).
    name: Regex,
}

#[nolog]
impl Detector {
    /// `known`: secrets this Orgtree holds, matched exactly. Shorter than eight bytes they
    /// would match ordinary words, and are left out.
    pub fn new(known: &[String]) -> Detector {
        let patterns = patterns();
        let any = RegexSet::new(patterns.iter().map(|p| p.re.as_str())).expect("the secret patterns as a set");
        let mut literals: Vec<&str> = known.iter().map(String::as_str).filter(|k| k.len() >= 8).collect();
        // the longest first: of two keys of which one begins the other, the whole one is taken
        literals.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
        literals.dedup();
        let known = (!literals.is_empty())
            .then(|| Regex::new(&format!("(?-u){}", literals.iter().map(|k| regex::escape(k)).collect::<Vec<_>>().join("|"))).expect("the held keys as a pattern"));
        let name = Regex::new(&format!(r"(?-u)(?i)^[A-Za-z0-9_\-.]*{SECRET_NAMES}$")).expect("the secret names");
        Detector { patterns, any, known, name }
    }

    /// Where the secrets of `text` lie, each with its kind, in order, none over another.
    fn find(&self, text: &[u8]) -> Vec<(usize, usize, &'static str)> {
        let mut found: Vec<(usize, usize, &'static str)> = Vec::new();
        if let Some(known) = &self.known {
            found.extend(known.find_iter(text).map(|m| (m.start(), m.end(), KNOWN)));
        }
        for at in self.any.matches(text).into_iter() {
            let pattern = &self.patterns[at];
            for caps in pattern.re.captures_iter(text) {
                let secret = if pattern.groups.is_empty() { caps.get(0) } else { pattern.groups.iter().find_map(|g| caps.get(*g)) };
                let Some(secret) = secret else { continue };
                if (pattern.valid)(secret.as_bytes()) {
                    found.push((secret.start(), secret.end(), pattern.kind));
                }
            }
        }
        // the earliest first, the longer of two that start together; what lies over an earlier one is the same secret
        found.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let mut out: Vec<(usize, usize, &'static str)> = Vec::new();
        for f in found {
            match out.last_mut() {
                Some(last) if f.0 < last.1 => last.1 = last.1.max(f.1),
                _ => out.push(f),
            }
        }
        out
    }

    /// Count the secrets of `text` into `hits`. With `strip`, the text without them, when it
    /// held any.
    pub fn scan(&self, text: &[u8], strip: bool, hits: &mut Hits) -> Option<Vec<u8>> {
        let found = self.find(text);
        if found.is_empty() {
            return None;
        }
        for (_, _, kind) in &found {
            *hits.entry(*kind).or_default() += 1;
        }
        if !strip {
            return None;
        }
        let mut out = Vec::with_capacity(text.len());
        let mut at = 0;
        for (start, end, _) in found {
            out.extend_from_slice(&text[at..start]);
            out.extend_from_slice(REMOVED.as_bytes());
            at = end;
        }
        out.extend_from_slice(&text[at..]);
        Some(out)
    }

    /// `scan` for a string.
    fn scan_string(&self, text: &mut String, strip: bool, hits: &mut Hits) -> bool {
        match self.scan(text.as_bytes(), strip, hits) {
            // a secret begins and ends at an ASCII character, so what is left is still text
            Some(clean) => {
                *text = String::from_utf8(clean).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                true
            }
            None => false,
        }
    }

    /// Count the secrets in every string of `value`, and take them out with `strip`. With
    /// `named`, a member whose NAME says it is a secret (`password`, `api_key`, ...) counts
    /// with its whole value: that is for what an agent or a person wrote (a tool's input, a
    /// watchdog's definition), not for the engine's own records, whose member names mean
    /// other things. True when something was taken out.
    pub fn scan_json(&self, value: &mut Value, strip: bool, named: bool, hits: &mut Hits) -> bool {
        // no recursion: a hand-made document can nest deeper than a thread's stack
        let mut changed = false;
        let mut todo: Vec<&mut Value> = vec![value];
        while let Some(at) = todo.pop() {
            match at {
                Value::String(text) => changed |= self.scan_string(text, strip, hits),
                Value::Array(items) => todo.extend(items.iter_mut()),
                Value::Object(members) => {
                    for (name, member) in members.iter_mut() {
                        match member {
                            Value::String(text) if named && self.name.is_match(name.as_bytes()) && text.len() >= 8 && literal(text.as_bytes()) && !text.contains(char::is_whitespace) => {
                                *hits.entry(ASSIGNED).or_default() += 1;
                                if strip {
                                    *text = REMOVED.to_string();
                                    changed = true;
                                }
                            }
                            other => todo.push(other),
                        }
                    }
                }
                _ => {}
            }
        }
        changed
    }
}

/// Whether a file is one that holds credentials, by its name. `path` is the file's path in
/// its folder, `/` between its parts.
#[nolog]
pub fn credential_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let mut parts = lower.rsplit('/');
    let name = parts.next().unwrap_or("");
    let folder = parts.next().unwrap_or("");
    if name == ".env" || (name.starts_with(".env.") && !matches!(&name[5..], "example" | "sample" | "template" | "dist" | "defaults")) {
        return true;
    }
    if [".pem", ".key", ".pfx", ".p12", ".kdbx", ".jks", ".keystore", ".ppk"].iter().any(|ext| name.ends_with(ext)) {
        return true;
    }
    if matches!(name, "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519" | ".npmrc" | ".pypirc" | ".netrc" | "_netrc" | ".git-credentials" | ".htpasswd"
        | "credentials.json" | "account_tokens.json" | "application_default_credentials.json" | "accesstokens.json" | "service-account.json") {
        return true;
    }
    matches!((folder, name), (".aws", "credentials") | (".docker", "config.json") | (".kube", "config") | ("gcloud", "credentials.db"))
}

/// Whether bytes are text a scan can read: no NUL among the first of them.
#[nolog]
pub fn looks_like_text(head: &[u8]) -> bool {
    !head[..head.len().min(8192)].contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detector() -> Detector {
        Detector::new(&["or-key-0123456789abcdef".to_string(), "short".to_string(), "hub-identity-secret-value".to_string()])
    }

    fn kinds(text: &str) -> Vec<(&'static str, u64)> {
        let mut hits = Hits::new();
        assert!(detector().scan(text.as_bytes(), false, &mut hits).is_none(), "nothing is changed without strip");
        hits.into_iter().collect()
    }

    fn stripped(text: &str) -> String {
        let mut hits = Hits::new();
        match detector().scan(text.as_bytes(), true, &mut hits) {
            Some(clean) => String::from_utf8(clean).unwrap(),
            None => text.to_string(),
        }
    }

    #[test]
    fn private_keys_whole_blocks_and_lone_first_lines() {
        let block = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----\nafter";
        assert_eq!(kinds(block), [(PRIVATE_KEY, 1)]);
        assert_eq!(stripped(block), "before\n[secret removed]\nafter");
        assert_eq!(stripped("-----BEGIN RSA PRIVATE KEY-----\nMIIE and the rest was cut"), "[secret removed]\nMIIE and the rest was cut");
        assert_eq!(kinds("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"), []);
        assert_eq!(kinds("-----BEGIN CERTIFICATE-----"), []);
    }

    #[test]
    fn provider_tokens_by_their_forms() {
        for token in [
            "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx_1234567890-zz",
            "sk-or-v1-0123456789abcdef0123456789abcdef",
            "sk-proj-AbCdEf0123456789_AbCdEf0123456789",
            "sk-AbCdEfGhIjKlMnOpQrSt1234",
            "ghp_AbCdEfGhIjKlMnOpQrSt0123456789",
            "github_pat_11AAAAAAA0abcdefghijkl_mnopqrstuvwxyz0123456789",
            "xoxb-1234567890-abcdefghij",
            concat!("glpat", "-", "AbCdEf0123456789_xyz"),
            "hf_AbCdEfGhIjKlMnOpQrSt0123456789",
            "AIzaSyA-0123456789abcdefghijklmnopqrstuvw",
            "AKIAIOSFODNN7EXAMPLE",
        ] {
            assert_eq!(kinds(&format!("the key is {token}, keep it")), [(TOKEN, 1)], "{token}");
            assert_eq!(stripped(&format!("the key is {token}, keep it")), "the key is [secret removed], keep it", "{token}");
        }
        // words that only begin like a key
        for text in ["pip install sk-learn-contrib-something-else", "the task-sk-abcdefghijklmnopqrstuvwxyz list", "ghp_short", "AKIAIOSFODNN7EXAMPLEX1", "sk-abcdefghijklmnopqrstuvwx"] {
            assert_eq!(kinds(text), [], "{text}");
        }
    }

    #[test]
    fn web_tokens_and_authorization_headers() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        assert_eq!(kinds(&format!("token: {jwt}")), [(WEB_TOKEN, 1)], "the assignment and the token are one secret");
        assert_eq!(stripped(&format!("curl -H 'Authorization: Bearer {jwt}' https://example.org")), "curl -H 'Authorization: Bearer [secret removed]' https://example.org");
        assert_eq!(stripped("Authorization: Basic dXNlcjpwYXNzd29yZA=="), "Authorization: Basic [secret removed]");
        assert_eq!(stripped(r#"headers = {"authorization": "token abcd1234efgh"}"#), r#"headers = {"authorization": "token [secret removed]"}"#);
        assert_eq!(kinds("bearer 0a1b2c3d4e5f6a7b8c9d0e1f"), [(AUTH_HEADER, 1)]);
        assert_eq!(kinds("the bearer of this letter is welcome everywhere"), []);
        assert_eq!(kinds("Authorization: Bearer ${TOKEN_FROM_ENV}"), []);
    }

    #[test]
    fn assignments_take_the_value_and_leave_the_name() {
        for (text, clean) in [
            (r#"password = "correct-horse-battery""#, r#"password = "[secret removed]""#),
            ("DB_PASSWORD='hunter2hunter2'", "DB_PASSWORD='[secret removed]'"),
            ("OPENAI_API_KEY=abc123def456ghi789", "OPENAI_API_KEY=[secret removed]"),
            ("client_secret: 9f8e7d6c5b4a39281706", "client_secret: [secret removed]"),
            (r#"{"refresh_token": "1//0abcdefghijklmnop"}"#, r#"{"refresh_token": "[secret removed]"}"#),
            ("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_access_key = [secret removed]"),
            ("tool --password hunter2hunter2 --verbose", "tool --password [secret removed] --verbose"),
            ("tool --api-key=abcdefgh12345678", "tool --api-key=[secret removed]"),
            ("export API_TOKEN=abc123def456 && run", "export API_TOKEN=[secret removed] && run"),
            ("a=1&password=hunter2hunter2&b=2", "a=1&password=[secret removed]&b=2"),
        ] {
            assert_eq!(stripped(text), clean, "{text}");
            assert_eq!(kinds(text), [(ASSIGNED, 1)], "{text}");
        }
    }

    #[test]
    fn code_that_names_a_secret_without_holding_one_is_left_alone() {
        for text in [
            "password = input('Password: ')",
            "token = get_token()",
            "let password: Option<String> = None;",
            "secret: string",
            "password = self.password",
            r#"api_key = os.environ["OPENAI_API_KEY"]"#,
            r#"password: "${DB_PASSWORD}""#,
            r#"token: "{{ secrets.TOKEN }}""#,
            "max_tokens: 8000",
            "tokens = 12345678",
            "the password is not written here",
            "--password <your-password-here>",
            "token = notarealvalue",
            "pwd",
            "password: ********",
        ] {
            assert_eq!(kinds(text), [], "{text}");
            assert_eq!(stripped(text), text);
        }
    }

    #[test]
    fn passwords_and_secrets_in_urls() {
        assert_eq!(stripped("postgres://admin:s3cr3t-pw@db.example.org:5432/app"), "postgres://admin:[secret removed]@db.example.org:5432/app");
        assert_eq!(kinds("mqtts://device:hunter2@broker.example.org"), [(URL_PASSWORD, 1)]);
        assert_eq!(stripped("GET https://api.example.org/v1/items?page=2&token=abcdef0123456789&sort=asc"), "GET https://api.example.org/v1/items?page=2&token=[secret removed]&sort=asc");
        assert_eq!(kinds("wss://example.org/socket?key=abcdefghijkl"), [(URL_SECRET, 1)]);
        // an address with a port, a mail address, a time
        for text in ["https://example.org:8443/path", "write to someone@example.org", "at 12:30:45 today", "https://example.org/?page=2&sort=descending"] {
            assert_eq!(kinds(text), [], "{text}");
        }
    }

    #[test]
    fn keys_this_orgtree_holds_are_found_exactly() {
        assert_eq!(kinds("pasted by mistake: or-key-0123456789abcdef."), [(KNOWN, 1)]);
        assert_eq!(stripped("x=or-key-0123456789abcdef;y=hub-identity-secret-value"), "x=[secret removed];y=[secret removed]");
        // a held key shorter than eight bytes is not searched for
        assert_eq!(kinds("a short word"), []);
        assert_eq!(kinds("or-key-0123456789abcdeX"), []);
        let none = Detector::new(&[]);
        let mut hits = Hits::new();
        assert!(none.scan(b"or-key-0123456789abcdef", true, &mut hits).is_none());
        assert!(hits.is_empty());
    }

    #[test]
    fn several_secrets_are_counted_once_each_and_text_between_them_stays() {
        let text = "a=1\npassword: 'first-secret-1'\nb=2\nghp_AbCdEfGhIjKlMnOpQrSt0123456789\nc=3\npassword: 'second-secret-2'\n";
        assert_eq!(kinds(text), [(ASSIGNED, 2), (TOKEN, 1)]);
        assert_eq!(stripped(text), "a=1\npassword: '[secret removed]'\nb=2\n[secret removed]\nc=3\npassword: '[secret removed]'\n");
        // one secret two patterns see is one secret
        let mut hits = Hits::new();
        detector().scan(b"api_key=sk-AbCdEfGhIjKlMnOpQrSt1234", false, &mut hits);
        assert_eq!(hits.values().sum::<u64>(), 1);
    }

    #[test]
    fn text_that_is_not_ascii_stays_whole_around_a_secret() {
        let text = "caf\u{e9} \u{2014} mot de passe: password=\"s\u{e9}same-ouvre-toi\" \u{2014} fin \u{1f512}";
        assert_eq!(stripped(text), "caf\u{e9} \u{2014} mot de passe: password=\"[secret removed]\" \u{2014} fin \u{1f512}");
        // bytes that are no text at all are scanned too, and stay what they were around the secret
        let mut bytes = vec![0xff, 0xfe, b' '];
        bytes.extend_from_slice(b"token=abcdef123456 ");
        bytes.extend_from_slice(&[0x80, 0x81]);
        let mut hits = Hits::new();
        let clean = detector().scan(&bytes, true, &mut hits).unwrap();
        assert_eq!(clean, [&[0xff, 0xfe, b' '][..], b"token=[secret removed] ", &[0x80, 0x81]].concat());
    }

    #[test]
    fn json_strings_are_scanned_and_named_members_count_when_asked() {
        let d = detector();
        let row = serde_json::json!({
            "role": "assistant",
            "text": "I set password = \"correct-horse-battery\" in the file.",
            "token": "@item:orgtree/4-5-1-triage",
            "tools": [{ "name": "Bash", "input": { "command": "curl -H 'Authorization: Bearer abcdefghij0123456789' x", "password": "plainpassword", "retries": 3 } }],
            "n": 7, "ok": true, "nothing": null,
        });
        // the engine's own member names are not read as settings
        let (mut plain, mut hits) = (row.clone(), Hits::new());
        assert!(!d.scan_json(&mut plain, false, false, &mut hits));
        assert_eq!(hits.into_iter().collect::<Vec<_>>(), [(AUTH_HEADER, 1), (ASSIGNED, 1)]);
        assert_eq!(plain, row);
        let (mut clean, mut hits) = (row.clone(), Hits::new());
        assert!(d.scan_json(&mut clean, true, false, &mut hits));
        assert_eq!(clean["text"], "I set password = \"[secret removed]\" in the file.");
        assert_eq!(clean["tools"][0]["input"]["command"], "curl -H 'Authorization: Bearer [secret removed]' x");
        assert_eq!(clean["tools"][0]["input"]["password"], "plainpassword");
        assert_eq!(clean["token"], "@item:orgtree/4-5-1-triage");
        // a tool's input is what somebody wrote: there a member named password is one
        let (mut input, mut hits) = (row["tools"][0]["input"].clone(), Hits::new());
        assert!(d.scan_json(&mut input, true, true, &mut hits));
        assert_eq!(input, serde_json::json!({ "command": "curl -H 'Authorization: Bearer [secret removed]' x", "password": "[secret removed]", "retries": 3 }));
        assert_eq!(hits.into_iter().collect::<Vec<_>>(), [(AUTH_HEADER, 1), (ASSIGNED, 1)]);
        // a named member that refers to a value, or is too short, is not one
        let (mut refs, mut hits) = (serde_json::json!({ "password": "${DB_PASSWORD}", "token": "short", "secret": "two words here" }), Hits::new());
        assert!(!d.scan_json(&mut refs, true, true, &mut hits));
        assert!(hits.is_empty());
    }

    #[test]
    fn a_deeply_nested_document_is_walked_without_recursion() {
        let mut deep = serde_json::json!("password='inner-secret-1'");
        for _ in 0..20_000 {
            // not `json!([deep])`: the macro would serialize what is inside, level by level
            deep = Value::Array(vec![deep]);
        }
        let mut hits = Hits::new();
        assert!(detector().scan_json(&mut deep, true, true, &mut hits));
        assert_eq!(hits.get(ASSIGNED), Some(&1));
        // taking it apart again must not recurse either
        let mut at = deep;
        while let Value::Array(mut inner) = at {
            at = inner.pop().unwrap();
        }
        assert_eq!(at, "password='[secret removed]'");
    }

    #[test]
    fn credential_files_by_name() {
        for path in [
            ".env", "app/.env.production", ".ENV", "keys/server.pem", "tls/site.key", "cert.pfx", "store.p12", "vault.kdbx", "id_rsa", ".ssh/id_ed25519",
            ".npmrc", "home/.pypirc", ".netrc", ".git-credentials", "gcp/credentials.json", ".aws/credentials", ".docker/config.json", ".kube/config",
            "account_tokens.json", "putty.ppk",
        ] {
            assert!(credential_file(path), "{path}");
        }
        for path in [
            ".env.example", ".env.sample", "environment.md", "id_rsa.pub", "keys.md", "notes/credentials.md", "config.json", "aws/credentials.txt",
            "package.json", "src/token.rs", "monkey", "docs/passwords-policy.md", ".envrc.md",
        ] {
            assert!(!credential_file(path), "{path}");
        }
    }

    #[test]
    fn text_is_told_from_other_bytes_by_its_first_part() {
        assert!(looks_like_text(b"plain text\r\n"));
        assert!(looks_like_text(b""));
        assert!(looks_like_text("\u{feff}caf\u{e9}".as_bytes()));
        assert!(!looks_like_text(&[b'P', b'K', 3, 4, 0, 0]));
        let mut late = vec![b'a'; 9000];
        late.push(0);
        assert!(looks_like_text(&late), "only the first part is looked at");
    }
}
