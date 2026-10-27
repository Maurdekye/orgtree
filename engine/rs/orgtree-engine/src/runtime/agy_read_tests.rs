//! Antigravity file-read content, read from the shapes real AGY histories store.
//! Measured 2026-10-27 on nine real conversations (2,291 tool steps): read_file and
//! view_file are generic tool steps (field 1 = 132) whose call is field 5 -> 4 (tool
//! name = field 2) and whose result is field 140 -> 2 -> 1; field 14 never occurs.
use super::agy_thinking::{read_tool_output, Skip};
use rusqlite::{params, Connection};
use std::path::PathBuf;

const SESSION: &str = "12345678-1234-4321-8765-123456789abc";

struct History {
    root: PathBuf,
    db: PathBuf,
}
impl History {
    #[nolog]
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("agy-read-{}", uuid::Uuid::new_v4()));
        let dir = root.join(".gemini/antigravity-cli/conversations");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join(format!("{SESSION}.db"));
        // the table as AGY creates it
        Connection::open(&db).unwrap().execute_batch(
            "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
             has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob,
             task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
        ).unwrap();
        Self { root, db }
    }
    #[nolog]
    fn insert(&self, index: i64, payload: Vec<u8>) {
        Connection::open(&self.db).unwrap()
            .execute("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?1, 132, 3, ?2)", params![index, payload])
            .unwrap();
    }
}
impl Drop for History {
    #[nolog]
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[nolog]
fn varint(mut n: usize) -> Vec<u8> {
    let mut v = Vec::new();
    while n >= 128 {
        v.push((n as u8 & 127) | 128);
        n >>= 7;
    }
    v.push(n as u8);
    v
}
#[nolog]
fn bytes(field: usize, data: &[u8]) -> Vec<u8> {
    let mut v = varint((field << 3) | 2);
    v.extend(varint(data.len()));
    v.extend(data);
    v
}
#[nolog]
fn int(field: usize, n: usize) -> Vec<u8> {
    let mut v = varint(field << 3);
    v.extend(varint(n));
    v
}
#[nolog]
fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

/// A completed generic tool step as AGY stores it: the call in field 5 -> 4, the result in
/// field 140, with the argument label and the "Analyzed ..." summary beside the text.
#[nolog]
fn tool_step(kind: usize, name: &str, content: Option<&str>) -> Vec<u8> {
    let call = concat(&[bytes(1, &[0; 12]), bytes(2, name.as_bytes()), bytes(3, br#"{"AbsolutePath":"synthetic.txt"}"#)]);
    let meta = concat(&[int(3, 2), bytes(4, &call), int(11, 1417)]);
    let summary = concat(&[bytes(5, b"Analyzed"), bytes(6, b"description"), bytes(7, b"files")]);
    let body = match content {
        Some(text) => concat(&[bytes(1, text.as_bytes()), bytes(3, &summary)]),
        None => bytes(3, &summary), // an error or a media-only result has no text
    };
    let result = concat(&[bytes(1, &concat(&[bytes(1, b"Path"), bytes(2, b"synthetic.txt")])), bytes(2, &body)]);
    concat(&[int(1, kind), int(4, 3), bytes(5, &meta), bytes(140, &result)])
}

#[test]
fn a_read_file_step_returns_the_text_the_model_was_given() {
    let history = History::new();
    let text = "Showing lines 1-3 of 3\n1: alpha\n2: beta\n3: gamma\n".repeat(200);
    history.insert(2, tool_step(132, "read_file", Some(&text)));
    assert_eq!(read_tool_output(&history.root, SESSION, 2), Ok(Some(text)));
}

#[test]
fn a_view_file_step_returns_its_text_too() {
    let history = History::new();
    let text = "File Path: `file:///synthetic.txt`\nTotal Lines: 3\n1: alpha\n";
    history.insert(7, tool_step(132, "view_file", Some(text)));
    assert_eq!(read_tool_output(&history.root, SESSION, 7), Ok(Some(text.into())));
}

#[test]
fn a_step_that_is_not_a_file_read_never_lends_its_text_to_a_read_row() {
    let history = History::new();
    history.insert(3, tool_step(132, "run_command", Some("command output")));
    assert_eq!(read_tool_output(&history.root, SESSION, 3), Ok(None));
}

#[test]
fn a_read_without_result_text_counts_nothing() {
    let history = History::new();
    history.insert(4, tool_step(132, "read_file", None));
    assert_eq!(read_tool_output(&history.root, SESSION, 4), Ok(None));
}

#[test]
fn only_generic_tool_steps_are_reads() {
    let history = History::new();
    history.insert(5, tool_step(15, "read_file", Some("planner step with a result field")));
    assert_eq!(read_tool_output(&history.root, SESSION, 5), Ok(None));
}

#[test]
fn the_unobserved_view_file_field_is_not_a_read_result() {
    let history = History::new();
    // The old assumption: CortexStep.view_file = 14, content = 4. No real history has it.
    history.insert(6, concat(&[int(1, 132), bytes(14, &bytes(4, b"must not be counted"))]));
    assert_eq!(read_tool_output(&history.root, SESSION, 6), Ok(None));
}

#[test]
fn identity_and_missing_steps_stay_safe() {
    let history = History::new();
    assert_eq!(read_tool_output(&history.root, SESSION, 9), Ok(None));
    assert_eq!(read_tool_output(&history.root, "../wrong", 2), Err(Skip::Identity));
    assert_eq!(read_tool_output(&history.root, SESSION, -1), Err(Skip::Identity));
}
