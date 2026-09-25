//! Derive, from one statement's SQL TEXT, the relations it names and how:
//! `read`, `write`, and the row-lock mode of a `FOR ... [OF ...]` clause.
//!
//! This is the EXECUTOR-side half of a contact (CONTRACT-M1 §5: "relations and
//! lock modes are WS7's to derive"). By itself it is only a statement's own
//! claim, which v6 PROFILING:19 says is not proof: the server-side
//! `trace.xact_stats` rows are the cross-check, and the Q-C5 oracle
//! (`tools/p03/harness/oracle.py`) compares both with the declared table.
//!
//! Only names in the caller's KNOWN relation set (the schema's tables) are
//! relations. A name in a relation position (after FROM, JOIN, INTO, UPDATE,
//! DELETE FROM, USING, MERGE INTO) that is not known, not a CTE of the same
//! statement and not a function call is returned as UNRESOLVED, never silently
//! dropped: it is either a table the known set is missing or a derivation gap.
//! String literals, dollar-quoted bodies, comments and parameters are skipped;
//! values never reach the result.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, PartialEq)]
pub struct Contacts {
    /// relation -> modes ("read", "write", "for_key_share", "for_share",
    /// "for_no_key_update", "for_update")
    pub relations: BTreeMap<String, BTreeSet<&'static str>>,
    /// relation-position names that are not known relations, CTEs or functions
    pub unresolved: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String), // lowercased identifier or keyword (quoted identifiers keep case, unquoted)
    Punct(char),
}

fn lex(sql: &str) -> Vec<Tok> {
    let b: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && b.get(i + 1) == Some(&'-') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && b.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == '\'' {
            i += 1;
            while i < b.len() {
                if b[i] == '\'' {
                    if b.get(i + 1) == Some(&'\'') {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
        } else if c == '$' && b.get(i + 1).map_or(false, |n| n.is_ascii_digit()) {
            i += 1; // $1 parameter
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        } else if c == '$' {
            // dollar-quoted body: $tag$ ... $tag$
            let start = i;
            let mut j = i + 1;
            while j < b.len() && (b[j].is_alphanumeric() || b[j] == '_') {
                j += 1;
            }
            if j < b.len() && b[j] == '$' {
                let tag: String = b[start..=j].iter().collect();
                let body_start = j + 1;
                let rest: String = b[body_start..].iter().collect();
                match rest.find(&tag) {
                    Some(k) => i = body_start + rest[..k].chars().count() + tag.chars().count(),
                    None => i = b.len(),
                }
            } else {
                out.push(Tok::Punct('$'));
                i += 1;
            }
        } else if c == '"' {
            let mut s = String::new();
            i += 1;
            while i < b.len() {
                if b[i] == '"' {
                    if b.get(i + 1) == Some(&'"') {
                        s.push('"');
                        i += 2;
                        continue;
                    }
                    break;
                }
                s.push(b[i]);
                i += 1;
            }
            i += 1;
            out.push(Tok::Word(s));
        } else if c.is_alphabetic() || c == '_' {
            let mut s = String::new();
            while i < b.len() && (b[i].is_alphanumeric() || b[i] == '_') {
                s.push(b[i].to_ascii_lowercase());
                i += 1;
            }
            out.push(Tok::Word(s));
        } else if c.is_ascii_digit() {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == '.') {
                i += 1;
            }
        } else {
            out.push(Tok::Punct(c));
            i += 1;
        }
    }
    out
}

fn word(t: Option<&Tok>) -> Option<&str> {
    match t {
        Some(Tok::Word(w)) => Some(w.as_str()),
        _ => None,
    }
}

/// Read a possibly schema-qualified name at `i`; returns (last part, next index).
fn name_at(t: &[Tok], i: usize) -> Option<(String, usize)> {
    let mut last = word(t.get(i))?.to_string();
    let mut j = i + 1;
    while t.get(j) == Some(&Tok::Punct('.')) {
        match word(t.get(j + 1)) {
            Some(w) => {
                last = w.to_string();
                j += 2;
            }
            None => break,
        }
    }
    Some((last, j))
}

const CLAUSE_WORDS: &[&str] = &[
    "select", "where", "group", "order", "limit", "offset", "for", "on", "using", "join", "inner",
    "left", "right", "full", "cross", "natural", "lateral", "set", "values", "returning", "union",
    "except", "intersect", "window", "having", "as", "only", "default", "do", "conflict",
];

pub fn derive(sql: &str, known: &BTreeSet<String>) -> Contacts {
    let t = lex(sql);
    let mut c = Contacts::default();
    // CTE names of this statement: WITH [RECURSIVE] name [(cols)] AS ( ... ), name AS (...)
    let mut ctes = BTreeSet::new();
    for i in 0..t.len() {
        if let (Some(w), Some("as")) = (word(t.get(i)), word(t.get(i + 1))) {
            if t.get(i + 2) == Some(&Tok::Punct('(')) {
                let before = if i == 0 { None } else { t.get(i - 1) };
                let starts_cte = matches!(before, Some(Tok::Punct(',')))
                    || matches!(word(before), Some("with") | Some("recursive"));
                if starts_cte {
                    ctes.insert(w.to_string());
                }
            }
        }
    }
    let add = |c: &mut Contacts, rel: &str, mode: &'static str| {
        if known.contains(rel) {
            c.relations.entry(rel.to_string()).or_default().insert(mode);
        } else if !ctes.contains(rel) {
            c.unresolved.insert(rel.to_string());
        }
    };
    let mut read_rels: Vec<String> = Vec::new();
    let mut i = 0;
    while i < t.len() {
        let w = word(t.get(i));
        let target = match w {
            Some("into") if matches!(word(t.get(i.wrapping_sub(1))), Some("insert") | Some("merge")) => {
                Some("write")
            }
            Some("update") if !matches!(word(t.get(i.wrapping_sub(1))), Some("for") | Some("key") | Some("no") | Some("do")) => {
                // `UPDATE rel` (not `FOR UPDATE`, `NO KEY UPDATE`, `DO UPDATE`)
                Some("write")
            }
            Some("from") if matches!(word(t.get(i.wrapping_sub(1))), Some("delete")) => Some("write"),
            Some("from") | Some("join") | Some("using") => Some("read"),
            _ => None,
        };
        if let Some(mode) = target {
            let mut j = i + 1;
            if word(t.get(j)) == Some("only") {
                j += 1;
            }
            loop {
                if t.get(j) == Some(&Tok::Punct('(')) {
                    break; // a subquery or a VALUES list, handled by its own tokens
                }
                let Some((name, next)) = name_at(&t, j) else { break };
                if CLAUSE_WORDS.contains(&name.as_str()) || name == "lateral" {
                    break;
                }
                if mode == "read" && t.get(next) == Some(&Tok::Punct('(')) {
                    break; // a function call (generate_series(...), unnest(...));
                           // after INTO the parenthesis is the column list
                }
                add(&mut c, &name, mode);
                if mode == "read" {
                    read_rels.push(name.clone());
                }
                // skip an alias: `rel [AS] alias`
                let mut k = next;
                if word(t.get(k)) == Some("as") {
                    k += 1;
                }
                if let Some(a) = word(t.get(k)) {
                    if !CLAUSE_WORDS.contains(&a) && t.get(k + 1) != Some(&Tok::Punct('(')) {
                        k += 1;
                    }
                }
                // a comma continues an old-style FROM list (reads only)
                if mode == "read" && t.get(k) == Some(&Tok::Punct(',')) {
                    j = k + 1;
                    continue;
                }
                break;
            }
        }
        // row-lock clause: FOR [NO KEY] UPDATE | FOR [KEY] SHARE [OF rel, ...]
        if w == Some("for") {
            let (mode, len) = match (word(t.get(i + 1)), word(t.get(i + 2)), word(t.get(i + 3))) {
                (Some("update"), _, _) => ("for_update", 2),
                (Some("share"), _, _) => ("for_share", 2),
                (Some("key"), Some("share"), _) => ("for_key_share", 3),
                (Some("no"), Some("key"), Some("update")) => ("for_no_key_update", 4),
                _ => ("", 0),
            };
            if len > 0 {
                let mut j = i + len;
                let mut of = Vec::new();
                if word(t.get(j)) == Some("of") {
                    j += 1;
                    while let Some((name, next)) = name_at(&t, j) {
                        of.push(name);
                        if t.get(next) == Some(&Tok::Punct(',')) {
                            j = next + 1;
                        } else {
                            break;
                        }
                    }
                }
                // OF names aliases or relations; an alias we cannot resolve locks
                // every read relation, which over-reports rather than hides a lock
                let resolved: Vec<&String> = of.iter().filter(|n| known.contains(*n)).collect();
                let apply: Vec<String> = if !of.is_empty() && resolved.len() == of.len() {
                    of.clone()
                } else {
                    read_rels.clone()
                };
                for rel in apply {
                    add(&mut c, &rel, mode);
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> BTreeSet<String> {
        ["agents", "operation_receipts", "items", "mailbox_heads", "messages", "org_control"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn modes(c: &Contacts, rel: &str) -> Vec<&'static str> {
        c.relations.get(rel).map(|m| m.iter().copied().collect()).unwrap_or_default()
    }

    #[test]
    fn select_insert_update_delete() {
        let k = known();
        assert_eq!(modes(&derive("SELECT v FROM items WHERE id = $1", &k), "items"), ["read"]);
        assert_eq!(modes(&derive("INSERT INTO operation_receipts (k) VALUES ($1)", &k), "operation_receipts"), ["write"]);
        assert_eq!(modes(&derive("UPDATE items SET v = v + 1 WHERE id = $1", &k), "items"), ["write"]);
        assert_eq!(modes(&derive("DELETE FROM messages WHERE id = $1", &k), "messages"), ["write"]);
    }

    #[test]
    fn row_lock_clauses_and_of() {
        let k = known();
        let c = derive("SELECT 1 FROM agents a JOIN org_control o ON o.org = a.org WHERE a.id = $1 FOR SHARE OF a", &k);
        // OF names an alias the deriver cannot resolve: the lock is applied to every
        // read relation, over-reporting rather than hiding it
        assert_eq!(modes(&c, "agents"), ["for_share", "read"]);
        assert_eq!(modes(&c, "org_control"), ["for_share", "read"]);
        let c = derive("SELECT 1 FROM agents WHERE id = $1 FOR NO KEY UPDATE", &k);
        assert_eq!(modes(&c, "agents"), ["for_no_key_update", "read"]);
        let c = derive("SELECT 1 FROM mailbox_heads WHERE id = $1 FOR KEY SHARE", &k);
        assert_eq!(modes(&c, "mailbox_heads"), ["for_key_share", "read"]);
        let c = derive("SELECT 1 FROM agents, items WHERE agents.id = items.owner FOR UPDATE OF items", &k);
        assert_eq!(modes(&c, "items"), ["for_update", "read"]);
        assert_eq!(modes(&c, "agents"), ["read"]);
    }

    #[test]
    fn unresolved_names_are_reported_not_dropped() {
        let c = derive("SELECT * FROM ghost_table g JOIN items i ON i.id = g.id", &known());
        assert_eq!(c.unresolved.iter().collect::<Vec<_>>(), ["ghost_table"]);
        assert_eq!(modes(&c, "items"), ["read"]);
    }

    #[test]
    fn ctes_functions_literals_and_comments_are_not_relations() {
        let sql = "WITH moved AS (UPDATE items SET v = 1 WHERE id = $1 RETURNING id), \
                   extra AS (SELECT 'FROM agents' AS s) \
                   SELECT * FROM moved, generate_series(1, 3) -- FROM messages\n \
                   /* JOIN mailbox_heads */ JOIN extra ON true";
        let c = derive(sql, &known());
        assert_eq!(modes(&c, "items"), ["write"]);
        assert!(c.relations.get("agents").is_none());
        assert!(c.relations.get("messages").is_none());
        assert!(c.relations.get("mailbox_heads").is_none());
        assert!(c.unresolved.is_empty(), "{:?}", c.unresolved);
    }

    #[test]
    fn upsert_and_schema_qualified_names() {
        let c = derive(
            "INSERT INTO public.operation_receipts AS r (k) VALUES ($1) ON CONFLICT (k) DO UPDATE SET k = r.k",
            &known(),
        );
        assert_eq!(modes(&c, "operation_receipts"), ["write"]);
        assert!(c.unresolved.is_empty(), "{:?}", c.unresolved);
    }

    #[test]
    fn dollar_quoted_bodies_are_skipped() {
        let c = derive("DO $body$ BEGIN PERFORM 1 FROM agents; END $body$", &known());
        assert!(c.relations.is_empty());
    }
}
