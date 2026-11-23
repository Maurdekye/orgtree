//! Names: the one an imported node gets, and which names of a zip may become files.

use std::collections::{HashMap, HashSet};

/// The longest name a node may have (`domain::ops::valid_name`).
const NAME_MAX: usize = 64;

/// The name an imported node gets: its own when nothing has it, else `name-2`, `name-3` and
/// so on, the Quick staff rule (`domain/staffing.rs`; USER 2026-11-23 10:43Z: "consecutive
/// numbering"). `taken` holds names in lower case: two names that differ only in case would
/// share one scratch folder on Windows. The name given out joins `taken`. `name` is a valid
/// node name already, so it is ASCII.
#[nolog]
pub fn free_name(name: &str, taken: &mut HashSet<String>) -> String {
    let mut candidate = name.to_string();
    let mut n = 2u64;
    while !taken.insert(candidate.to_ascii_lowercase()) {
        let suffix = format!("-{n}");
        // a long name is cut so the number still fits
        let keep = NAME_MAX.saturating_sub(suffix.len()).min(name.len());
        candidate = format!("{}{suffix}", &name[..keep]);
        n += 1;
    }
    candidate
}

/// The parts of a zip entry's name when it names a file or folder inside the place it is
/// unpacked to, and nothing else: `/` between plain parts, each a name every system can
/// keep (`http::scratch_files::upload_name`: no `..`, no drive or stream, no reserved device
/// name, no dot or space at its end). A folder's trailing `/` is allowed. `None` for
/// anything else: an absolute path, a backslash, an empty part.
#[nolog]
pub fn safe_parts(name: &str) -> Option<Vec<&str>> {
    let inner = name.strip_suffix('/').unwrap_or(name);
    if inner.is_empty() || inner.contains('\\') {
        return None;
    }
    let parts: Vec<&str> = inner.split('/').collect();
    parts.iter().all(|part| crate::http::scratch_files::upload_name(part)).then_some(parts)
}

/// `text` with every mention of a renamed node naming it as it is called now: `@old`, where
/// the name ends there, becomes `@new`. Only a mention is touched: a bare word that happens
/// to be a node's name is left alone, and so is a mention of another kind (`@item:...`) and
/// an address (`someone@old`). USER 2026-11-23 20:30Z, question 4: mentions are rewritten in
/// charters, project descriptions and watchdog definitions, and nowhere else.
#[nolog]
pub fn rewrite_mentions(text: &str, renamed: &HashMap<String, String>) -> String {
    if renamed.is_empty() || !text.contains('@') {
        return text.to_string();
    }
    let named = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        let before = rest[..at].chars().next_back();
        out.push_str(&rest[..=at]);
        rest = &rest[at + 1..];
        if before.is_some_and(named) {
            continue;
        }
        let run = rest.find(|c: char| !named(c)).unwrap_or(rest.len());
        if rest[run..].starts_with(':') {
            continue;
        }
        // a sentence's own full stop or dash after the name is not part of it
        let mut end = run;
        while end > 0 {
            if let Some(new) = renamed.get(&rest[..end]) {
                out.push_str(new);
                rest = &rest[end..];
                break;
            }
            match rest[..end].chars().next_back() {
                Some('.' | '-' | '_') => end -= 1,
                _ => break,
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mention_of_a_renamed_node_follows_it_and_nothing_else_does() {
        let renamed: HashMap<String, String> = [("lead", "lead-2"), ("lead.dev", "lead.dev-2"), ("item", "item-2")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        for (text, want) in [
            ("Report to @lead.", "Report to @lead-2."),
            ("@lead, then @worker and @lead again", "@lead-2, then @worker and @lead-2 again"),
            ("Ask @lead.dev about it", "Ask @lead.dev-2 about it"),
            ("(@lead)", "(@lead-2)"),
            // another node whose name only starts alike, a bare word, an address, another kind of mention
            ("@leader and @lead-3 stay", "@leader and @lead-3 stay"),
            ("the lead decides", "the lead decides"),
            ("mail boss@lead for it", "mail boss@lead for it"),
            ("see @item:org/some-slug and @item", "see @item:org/some-slug and @item-2"),
            ("a lone @ and @@lead", "a lone @ and @@lead-2"),
            ("no mention here", "no mention here"),
        ] {
            assert_eq!(rewrite_mentions(text, &renamed), want, "{text}");
        }
        assert_eq!(rewrite_mentions("@lead", &HashMap::new()), "@lead");
    }

    fn taken(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| n.to_ascii_lowercase()).collect()
    }

    #[test]
    fn a_free_name_is_kept_and_a_taken_one_is_numbered_from_two() {
        let mut t = taken(&["lead", "worker", "worker-2"]);
        assert_eq!(free_name("scout", &mut t), "scout");
        assert_eq!(free_name("lead", &mut t), "lead-2");
        assert_eq!(free_name("worker", &mut t), "worker-3");
        // what was given out is taken for the next one of the same import
        assert_eq!(free_name("scout", &mut t), "scout-2");
        assert_eq!(free_name("lead", &mut t), "lead-3");
        assert!(t.contains("scout-2") && t.contains("lead-3"));
    }

    #[test]
    fn names_that_differ_only_in_case_do_not_share_a_folder() {
        let mut t = taken(&["Lead"]);
        assert_eq!(free_name("lead", &mut t), "lead-2");
        assert_eq!(free_name("LEAD", &mut t), "LEAD-3");
    }

    #[test]
    fn a_long_name_is_cut_so_that_its_number_fits() {
        let long = "n".repeat(64);
        let mut t = taken(&[&long]);
        let second = free_name(&long, &mut t);
        assert_eq!((second.len(), second.ends_with("-2")), (64, true));
        for _ in 0..8 {
            free_name(&long, &mut t);
        }
        let eleventh = free_name(&long, &mut t);
        assert_eq!((eleventh.len(), eleventh.ends_with("-11")), (64, true));
    }

    #[test]
    fn only_names_inside_the_folder_are_safe() {
        assert_eq!(safe_parts("nodes/0001-lead/scratch/notes.md"), Some(vec!["nodes", "0001-lead", "scratch", "notes.md"]));
        assert_eq!(safe_parts("nodes/0001-lead/scratch/"), Some(vec!["nodes", "0001-lead", "scratch"]));
        assert_eq!(safe_parts("manifest.json"), Some(vec!["manifest.json"]));
        assert_eq!(safe_parts(".hidden/\u{e9}t\u{e9} 2.txt"), Some(vec![".hidden", "\u{e9}t\u{e9} 2.txt"]));
        for bad in [
            "", "/", "/etc/passwd", "../outside", "a/../../b", "a/./b", "a//b", "a/b//", "C:/Windows/x", "a\\b", "\\\\server\\share",
            "a/con", "a/NUL.txt", "a/com1", "a/name.", "a/name ", "a/ name", "a/b:stream", "a/what?", "a/x*y", "a/tab\there", "a/.up1.orgtree-part",
        ] {
            assert_eq!(safe_parts(bad), None, "{bad:?}");
        }
        assert_eq!(safe_parts(&format!("a/{}", "n".repeat(256))), None);
    }
}
