//! Static checks of the DDL conventions in CONTRACT-M1 §2.
//!
//! This reads the subset of DDL the migrations use: `CREATE TABLE`,
//! `CREATE [UNIQUE] INDEX` and `ALTER TABLE … ADD CONSTRAINT`. Function and
//! trigger bodies are skipped. It is a guard against convention drift, not a
//! SQL parser; PostgreSQL itself is the authority on whether the DDL is valid.

use std::collections::BTreeMap;

use crate::INSTALLATION_TABLES;

#[derive(Clone, Debug, Default)]
pub struct Schema {
    pub tables: Vec<Table>,
    pub indexes: Vec<Index>,
}

#[derive(Clone, Debug)]
pub struct Table {
    pub file: String,
    pub name: String,
    pub columns: Vec<Column>,
    pub constraints: Vec<Constraint>,
}

#[derive(Clone, Debug)]
pub struct Column {
    pub name: String,
    /// Everything after the name, whitespace-collapsed.
    pub def: String,
}

#[derive(Clone, Debug)]
pub struct Constraint {
    pub name: String,
    pub def: String,
}

#[derive(Clone, Debug)]
pub struct Index {
    pub file: String,
    pub name: String,
    pub table: String,
    pub unique: bool,
    pub def: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub rule: &'static str,
    pub table: String,
    pub detail: String,
}

impl Schema {
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.tables.iter().find(|t| t.name == name)
    }

    /// Every constraint and index name, in declaration order.
    pub fn object_names(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for t in &self.tables {
            for c in &t.constraints {
                out.push((t.name.clone(), c.name.clone()));
            }
        }
        for i in &self.indexes {
            out.push((i.table.clone(), i.name.clone()));
        }
        out
    }

    pub fn add(&mut self, file: &str, sql: &str) {
        for stmt in split_statements(&strip_comments(sql)) {
            let words = collapse(&stmt);
            let upper = words.to_ascii_uppercase();
            if upper.starts_with("CREATE TABLE ") {
                if let Some(t) = parse_table(file, &stmt) {
                    self.tables.push(t);
                }
            } else if upper.starts_with("CREATE UNIQUE INDEX ") || upper.starts_with("CREATE INDEX ") {
                let unique = upper.starts_with("CREATE UNIQUE INDEX ");
                let rest: Vec<&str> = words.split(' ').collect();
                let name_at = if unique { 3 } else { 2 };
                if rest.len() > name_at + 2 && rest[name_at + 1].eq_ignore_ascii_case("ON") {
                    self.indexes.push(Index {
                        file: file.to_string(),
                        name: rest[name_at].to_string(),
                        table: rest[name_at + 2].to_string(),
                        unique,
                        def: rest[name_at + 3..].join(" "),
                    });
                }
            } else if upper.starts_with("ALTER TABLE ") {
                let rest: Vec<&str> = words.split(' ').collect();
                if rest.len() > 6 && rest[3].eq_ignore_ascii_case("ADD") && rest[4].eq_ignore_ascii_case("CONSTRAINT") {
                    let table = rest[2].to_string();
                    let c = Constraint { name: rest[5].to_string(), def: rest[6..].join(" ") };
                    if let Some(t) = self.tables.iter_mut().find(|t| t.name == table) {
                        t.constraints.push(c);
                    }
                }
            }
        }
    }
}

/// Remove `--` comments outside quotes and dollar-quoted bodies.
pub fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let b: Vec<char> = sql.chars().collect();
    let mut i = 0;
    let mut in_quote = false;
    let mut in_dollar = false;
    while i < b.len() {
        let c = b[i];
        if !in_quote && !in_dollar && c == '-' && i + 1 < b.len() && b[i + 1] == '-' {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if !in_dollar && c == '\'' {
            in_quote = !in_quote;
        } else if !in_quote && c == '$' && i + 1 < b.len() && b[i + 1] == '$' {
            in_dollar = !in_dollar;
            out.push_str("$$");
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Split on `;` outside quotes and `$$` bodies.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut in_dollar = false;
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_dollar && c == '\'' {
            in_quote = !in_quote;
        } else if !in_quote && c == '$' && i + 1 < chars.len() && chars[i + 1] == '$' {
            in_dollar = !in_dollar;
            cur.push_str("$$");
            i += 2;
            continue;
        } else if !in_quote && !in_dollar && c == ';' {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_table(file: &str, stmt: &str) -> Option<Table> {
    let open = stmt.find('(')?;
    let close = stmt.rfind(')')?;
    let head = collapse(&stmt[..open]);
    let name = head.split(' ').nth(2)?.to_string();
    let body = &stmt[open + 1..close];
    let mut items = Vec::new();
    let mut depth = 0i32;
    let mut in_quote = false;
    let mut cur = String::new();
    for c in body.chars() {
        match c {
            '\'' => in_quote = !in_quote,
            '(' if !in_quote => depth += 1,
            ')' if !in_quote => depth -= 1,
            ',' if !in_quote && depth == 0 => {
                items.push(collapse(&cur));
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        items.push(collapse(&cur));
    }
    let mut t = Table { file: file.to_string(), name, columns: Vec::new(), constraints: Vec::new() };
    for item in items {
        let mut parts = item.splitn(2, ' ');
        let first = parts.next().unwrap_or("").to_string();
        let rest = parts.next().unwrap_or("").to_string();
        if first.eq_ignore_ascii_case("CONSTRAINT") {
            let mut p = rest.splitn(2, ' ');
            let cname = p.next().unwrap_or("").to_string();
            let def = p.next().unwrap_or("").to_string();
            t.constraints.push(Constraint { name: cname, def });
        } else {
            t.columns.push(Column { name: first, def: rest });
        }
    }
    Some(t)
}

/// Textual columns compared for identity: byte-exact collation required.
pub fn is_identity_text(column: &str) -> bool {
    matches!(column, "name" | "slug" | "resource" | "handle" | "candidate" | "base" | "fingerprint")
        || column.ends_with("_name")
        || column.ends_with("_key")
}

fn upper(s: &str) -> String {
    s.to_ascii_uppercase()
}

/// Run every rule. An empty result on a schema with no tables is NOT a pass:
/// callers must also check that tables were parsed.
pub fn lint(s: &Schema) -> Vec<Finding> {
    let mut out = Vec::new();
    let org_scoped = |t: &str| !INSTALLATION_TABLES.contains(&t);
    let f = |rule, table: &str, detail: String| Finding { rule, table: table.to_string(), detail };

    for t in &s.tables {
        // R1: org-scoped tables carry org_id first in their primary key.
        if org_scoped(&t.name) {
            let has_org = t.columns.iter().any(|c| c.name == "org_id" && upper(&c.def).starts_with("UUID") && upper(&c.def).contains("NOT NULL"));
            let pk_org = t.constraints.iter().any(|c| upper(&c.def).replace(' ', "").starts_with("PRIMARYKEY(ORG_ID"));
            if !has_org {
                out.push(f("R1-org-id", &t.name, "no `org_id uuid NOT NULL` column".into()));
            }
            if !pk_org {
                out.push(f("R1-org-id", &t.name, "primary key does not start with org_id".into()));
            }
        }
        for c in &t.columns {
            let d = upper(&c.def);
            // R2: identity text is COLLATE "C".
            if is_identity_text(&c.name) && d.starts_with("TEXT") && !d.starts_with("TEXT[]") && !d.contains("COLLATE \"C\"") {
                out.push(f("R2-collate-c", &t.name, format!("column {} is identity text without COLLATE \"C\"", c.name)));
            }
            // R3: credits are bigint hundredths; no numeric/money anywhere.
            if c.name.ends_with("_centi") && !d.starts_with("BIGINT") {
                out.push(f("R3-credits", &t.name, format!("credit column {} is not bigint", c.name)));
            }
            if d.starts_with("NUMERIC") || d.starts_with("MONEY") || d.starts_with("DECIMAL") || d.starts_with("REAL") {
                out.push(f("R3-credits", &t.name, format!("column {} uses an inexact or decimal type", c.name)));
            }
            // R7: no unnamed inline constraints (names are API).
            if d.contains("PRIMARY KEY") || d.contains("REFERENCES") || d.contains(" UNIQUE") || d.contains("CHECK") {
                out.push(f("R7-named", &t.name, format!("column {} has an unnamed inline constraint", c.name)));
            }
        }
        for c in &t.constraints {
            // R4: object names are prefixed by their table.
            if !c.name.starts_with(&format!("{}_", t.name)) {
                out.push(f("R4-prefix", &t.name, format!("constraint {} is not prefixed by its table", c.name)));
            }
            // R6: org-scoped foreign keys include org_id first.
            let d = upper(&c.def);
            if let Some(pos) = d.find("REFERENCES ") {
                let target = c.def[pos + "REFERENCES ".len()..].split(|ch: char| ch == ' ' || ch == '(').next().unwrap_or("").to_string();
                if org_scoped(&target) && !d.replace(' ', "").starts_with("FOREIGNKEY(ORG_ID") {
                    out.push(f("R6-org-fk", &t.name, format!("foreign key {} to {} does not include org_id first", c.name, target)));
                }
            }
        }
    }
    for i in &s.indexes {
        if !i.name.starts_with(&format!("{}_", i.table)) {
            out.push(f("R4-prefix", &i.table, format!("index {} is not prefixed by its table", i.name)));
        }
        if s.table(&i.table).is_none() {
            out.push(f("R8-index-table", &i.table, format!("index {} is on an unknown table", i.name)));
        }
    }
    // R5: object names are unique (PostgreSQL index names are schema-wide).
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for (table, name) in s.object_names() {
        if let Some(prev) = seen.insert(name.clone(), table.clone()) {
            out.push(f("R5-unique-name", &table, format!("{} also declared on {}", name, prev)));
        }
    }
    out
}
