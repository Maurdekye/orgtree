//! The folders an import brought along, as its transcript names them
//! (docs/rust-engine/agent-export.md, "Paths in the transcript").
//!
//! USER 2026-11-24 mf7c65a1b2403: "can we do 2 only if the paths refer to
//! locations in the saved scratch folders in the export?". A transcript row
//! that names a file under a scratch or team folder the export carried names
//! that file where it lies now. Every other path stays as it was written: a
//! folder that was not carried, a folder whose name only begins like a
//! carried one (`foo-bar` beside `foo`), a path on another drive.
//!
//! One pass over a text, the longest folder first, so that a new folder which
//! is itself an old one of another node (a second import of the same file)
//! is never rewritten twice.

use regex::Regex;
use serde_json::Value;

/// What may follow a folder's path where the path ends: a separator, white space, or a
/// character no file name of the folder's kind continues with. A letter, a digit, `-`, `_` or
/// `.` continues the name, and so it is another folder.
const AFTER: &str = r#"[\\/\s"'`)\]}>,;|*?<]|$"#;

pub struct Rewriter {
    find: Option<Regex>,
    /// The new folder of each alternative, as its parts.
    to: Vec<Vec<String>>,
}

#[nolog]
fn parts(path: &str) -> Vec<String> {
    path.split(['\\', '/']).filter(|part| !part.is_empty()).map(str::to_string).collect()
}

#[nolog]
impl Rewriter {
    /// `pairs`: a carried folder as the export names it, and where it lies here. A pair with
    /// an empty or one-part old path (a drive, a bare name) is not used, nor one that goes nowhere new.
    pub fn new(pairs: &[(String, String)]) -> Rewriter {
        let mut usable: Vec<(Vec<String>, Vec<String>)> = pairs.iter().map(|(old, new)| (parts(old), parts(new)))
            .filter(|(old, new)| old.len() >= 2 && !new.is_empty() && !old.iter().map(|p| p.to_lowercase()).eq(new.iter().map(|p| p.to_lowercase())))
            .collect();
        usable.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| b.0.join("/").len().cmp(&a.0.join("/").len())));
        usable.dedup_by(|a, b| a.0.iter().map(|p| p.to_lowercase()).eq(b.0.iter().map(|p| p.to_lowercase())));
        if usable.is_empty() {
            return Rewriter { find: None, to: Vec::new() };
        }
        // each alternative: the first part, the first run of separators (kept for the answer), the rest, what follows
        let alternatives: Vec<String> = usable.iter().map(|(old, _)| {
            let rest: Vec<String> = old[1..].iter().map(|part| regex::escape(part)).collect();
            format!(r"{}([\\/]+){}({AFTER})", regex::escape(&old[0]), rest.join(r"[\\/]+"))
        }).collect();
        let find = Regex::new(&format!("(?i){}", alternatives.join("|"))).ok();
        Rewriter { find, to: usable.into_iter().map(|(_, new)| new).collect() }
    }

    pub fn is_empty(&self) -> bool {
        self.find.is_none()
    }

    /// `text` with every carried folder named where it lies now, or `None` when it names none.
    pub fn text(&self, text: &str) -> Option<String> {
        let find = self.find.as_ref()?;
        let mut out = String::new();
        let mut copied = 0;
        for found in find.captures_iter(text) {
            let whole = found.get(0)?;
            // a path that only ends like a carried folder is another path
            if text[..whole.start()].chars().next_back().is_some_and(|before| before.is_alphanumeric() || matches!(before, '\\' | '/' | ':' | '.' | '-' | '_')) {
                continue;
            }
            let Some(at) = (0..self.to.len()).find(|at| found.get(1 + 2 * at).is_some()) else { continue };
            let (separator, after) = (found.get(1 + 2 * at)?.as_str(), found.get(2 + 2 * at)?.as_str());
            out.push_str(&text[copied..whole.start()]);
            out.push_str(&self.to[at].join(separator));
            out.push_str(after);
            copied = whole.end();
        }
        if copied == 0 {
            return None;
        }
        out.push_str(&text[copied..]);
        Some(out)
    }

    /// Every text inside `value` (never a member's name), rewritten in place. How many changed.
    pub fn json(&self, value: &mut Value) -> usize {
        if self.is_empty() {
            return 0;
        }
        match value {
            Value::String(text) => match self.text(text) {
                Some(new) => {
                    *text = new;
                    1
                }
                None => 0,
            },
            Value::Array(items) => items.iter_mut().map(|item| self.json(item)).sum(),
            Value::Object(members) => members.values_mut().map(|member| self.json(member)).sum(),
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pair(old: &str, new: &str) -> (String, String) {
        (old.to_string(), new.to_string())
    }

    #[test]
    fn a_path_in_a_carried_folder_follows_it_and_no_other_path_changes() {
        let r = Rewriter::new(&[pair(r"C:\data\scratch\org\foo", r"S:\orgtree\scratch\second\foo-2")]);
        // one carried path
        assert_eq!(r.text(r"Wrote C:\data\scratch\org\foo\notes\plan.md (12 lines)").as_deref(), Some(r"Wrote S:\orgtree\scratch\second\foo-2\notes\plan.md (12 lines)"));
        // the folder itself, at the end of the text and before a quote
        assert_eq!(r.text(r"cd C:\data\scratch\org\foo").as_deref(), Some(r"cd S:\orgtree\scratch\second\foo-2"));
        assert_eq!(r.text(r#"{"cwd":"C:\data\scratch\org\foo"}"#).as_deref(), Some(r#"{"cwd":"S:\orgtree\scratch\second\foo-2"}"#));
        // one that was not carried
        assert_eq!(r.text(r"Read C:\data\scratch\org\other\notes.md"), None);
        assert_eq!(r.text(r"Read D:\work\repo\src\main.rs"), None);
        // a folder whose name only begins like the carried one
        assert_eq!(r.text(r"Read C:\data\scratch\org\foo-bar\notes.md"), None);
        assert_eq!(r.text(r"Read C:\data\scratch\org\foo.bak\notes.md and C:\data\scratch\org\foo_old and C:\data\scratch\org\foo2"), None);
        // and one that only ends like it
        assert_eq!(r.text(r"Read X:\backup\C:\data\scratch\org\foo\notes.md"), None);
        // both in one text: only the carried one changes
        assert_eq!(r.text(r"copy C:\data\scratch\org\foo\a.txt C:\data\scratch\org\foo-bar\a.txt").as_deref(),
                   Some(r"copy S:\orgtree\scratch\second\foo-2\a.txt C:\data\scratch\org\foo-bar\a.txt"));
    }

    #[test]
    fn the_path_keeps_the_way_it_was_written() {
        let r = Rewriter::new(&[pair(r"C:\data\scratch\org\foo", r"S:\orgtree\scratch\second\foo-2")]);
        assert_eq!(r.text("cat C:/data/scratch/org/foo/a.txt").as_deref(), Some("cat S:/orgtree/scratch/second/foo-2/a.txt"));
        // a path inside text that was itself written as JSON keeps its doubled separators
        assert_eq!(r.text(r#"{\"file\":\"C:\\data\\scratch\\org\\foo\\a.txt\"}"#).as_deref(), Some(r#"{\"file\":\"S:\\orgtree\\scratch\\second\\foo-2\\a.txt\"}"#));
        // Windows does not tell the letters' case apart
        assert_eq!(r.text(r"dir c:\DATA\scratch\org\FOO\sub").as_deref(), Some(r"dir S:\orgtree\scratch\second\foo-2\sub"));
    }

    #[test]
    fn one_pass_the_longest_folder_first() {
        // a second import of the same file: alice is alice-2 here, and the alice-2 of the file is alice-3
        let r = Rewriter::new(&[pair(r"C:\s\org\alice", r"C:\s\org\alice-2"), pair(r"C:\s\org\alice-2", r"C:\s\org\alice-3"),
                                pair(r"C:\s\org\alice\deep", r"C:\elsewhere\deep")]);
        assert_eq!(r.text(r"C:\s\org\alice\a.txt and C:\s\org\alice-2\b.txt and C:\s\org\alice\deep\c.txt").as_deref(),
                   Some(r"C:\s\org\alice-2\a.txt and C:\s\org\alice-3\b.txt and C:\elsewhere\deep\c.txt"));
    }

    #[test]
    fn nothing_to_follow_changes_nothing() {
        for r in [Rewriter::new(&[]), Rewriter::new(&[pair("", r"C:\new")]), Rewriter::new(&[pair("C:", r"D:")]), Rewriter::new(&[pair(r"C:\a\b", r"c:/A/B")])] {
            assert!(r.is_empty());
            assert_eq!(r.text(r"C:\a\b\c.txt"), None);
        }
    }

    #[test]
    fn every_text_of_a_row_and_never_a_members_name() {
        let r = Rewriter::new(&[pair(r"C:\s\org\foo", r"C:\s\two\foo")]);
        let mut row = json!({ "text": r"Saved C:\s\org\foo\out.txt", r"C:\s\org\foo\key": 1, "tools": [{ "name": "Read", "summary": r"C:\s\org\foo\in.txt" }, { "n": 3 }],
                              "other": r"C:\s\org\foo-bar\x" });
        assert_eq!(r.json(&mut row), 2);
        assert_eq!(row, json!({ "text": r"Saved C:\s\two\foo\out.txt", r"C:\s\org\foo\key": 1, "tools": [{ "name": "Read", "summary": r"C:\s\two\foo\in.txt" }, { "n": 3 }],
                                "other": r"C:\s\org\foo-bar\x" }));
    }
}
