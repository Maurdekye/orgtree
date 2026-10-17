//! Completed-step AGY thinking. All content-bearing helpers are unlogged.
use std::path::Path;
use serde_json::{json, Value};

const MAX_PAYLOAD: usize = 2 * 1024 * 1024;
const MAX_THINKING: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip { Identity, Unavailable, Schema, Payload }

// Red control: the driver currently discards all history thinking.
#[nolog]
pub fn read_history(_home: &Path, _session: &str, _index: i64) -> Result<Option<String>, Skip> {
    Ok(None)
}

#[nolog]
pub fn rows(_session: &str, _index: i64, _thinking: Option<&str>, _response: &str, _at: &str) -> Vec<Value> {
    Vec::new()
}

#[nolog]
pub fn completed<'a>(_step: &'a Value, _bound: &str) -> Option<(&'a str, i64)> { None }

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::path::PathBuf;
    const SESSION: &str = "12345678-1234-4321-8765-123456789abc";
    const OTHER: &str = "abcdefab-1234-4321-8765-123456789abc";

    struct Fixture { root: PathBuf, db: PathBuf }
    impl Fixture {
        fn new(session: &str) -> Self {
            let root = std::env::temp_dir().join(format!("agy-thinking-{}", uuid::Uuid::new_v4()));
            let dir = root.join(".gemini/antigravity-cli/conversations");
            std::fs::create_dir_all(&dir).unwrap();
            let db = dir.join(format!("{session}.db"));
            let c = Connection::open(&db).unwrap();
            c.execute_batch("CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT,trajectory_type INTEGER,source INTEGER);
                CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,step_payload BLOB,step_format INTEGER);").unwrap();
            c.execute("INSERT INTO trajectory_meta VALUES (?1,?1,0,0)", [session]).unwrap();
            Self { root, db }
        }
        fn step(&self, index: i64, thought: &str) {
            let payload = bytes(20, &bytes(3, thought.as_bytes()));
            Connection::open(&self.db).unwrap().execute("INSERT INTO steps VALUES (?1,15,0,?2,0)", params![index,payload]).unwrap();
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    fn varint(mut n: usize) -> Vec<u8> {
        let mut v = Vec::new();
        while n >= 128 { v.push((n as u8 & 127) | 128); n >>= 7; }
        v.push(n as u8); v
    }
    fn bytes(field: usize, data: &[u8]) -> Vec<u8> {
        let mut v = varint((field << 3) | 2); v.extend(varint(data.len())); v.extend(data); v
    }

    #[test]
    fn exact_session_and_step_including_thinking_only_steps() {
        let f = Fixture::new(SESSION); f.step(1,"synthetic step one"); f.step(6,"synthetic step six");
        assert_eq!(read_history(&f.root,SESSION,6),Ok(Some("synthetic step six".into())));
        assert_eq!(read_history(&f.root,SESSION,5),Ok(None));
        assert!(read_history(&f.root,OTHER,6).is_err());
    }
    #[test]
    fn step_must_match_process_session_and_completion_exactly() {
        let mut step=json!({"conversation_id":SESSION,"step_index":6,"step_type":"agent_response","state":"DONE"});
        assert_eq!(completed(&step,SESSION),Some((SESSION,6)));
        assert_eq!(completed(&step,OTHER),None);
        for state in ["RUNNING","ERROR",""] { step["state"]=json!(state); assert_eq!(completed(&step,SESSION),None); }
        step["state"]=json!("DONE"); step["step_index"]=json!(-1); assert_eq!(completed(&step,SESSION),None);
    }
    #[test]
    fn missing_database_and_changed_schema_skip_without_creating_files() {
        let f = Fixture::new(SESSION);
        assert!(read_history(&f.root,OTHER,1).is_err());
        assert!(!f.db.with_file_name(format!("{OTHER}.db")).exists());
        Connection::open(&f.db).unwrap().execute_batch("DROP TABLE steps").unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Err(Skip::Schema));
    }
    #[test]
    fn invalid_identity_and_negative_index_never_open_paths() {
        let f = Fixture::new(SESSION);
        for session in ["../elsewhere", "", "abc?mode=rw", "12345678123443218765123456789abc"] {
            assert_eq!(read_history(&f.root,session,1),Err(Skip::Identity));
        }
        assert_eq!(read_history(&f.root,SESSION,-1),Err(Skip::Identity));
    }
    #[test]
    fn bounded_payload_and_utf8_thoughts() {
        let f = Fixture::new(SESSION); f.step(1,&"é".repeat(MAX_THINKING));
        let thought = read_history(&f.root,SESSION,1).unwrap().unwrap();
        assert!(thought.len()<=MAX_THINKING); assert!(thought.is_char_boundary(thought.len()));
        Connection::open(&f.db).unwrap().execute("UPDATE steps SET step_payload=zeroblob(?1)",[MAX_PAYLOAD+1]).unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Err(Skip::Payload));
    }
    #[test]
    fn never_returns_signatures_raw_thinking_or_redacted_text() {
        let f = Fixture::new(SESSION);
        let mut planner=bytes(4,b"signature"); planner.extend(bytes(16,b"raw thinking"));
        Connection::open(&f.db).unwrap().execute("INSERT INTO steps VALUES (1,15,0,?1,0)",[bytes(20,&planner)]).unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Ok(None));
        planner.extend(bytes(3,b"hidden")); planner.extend([40,1]);
        Connection::open(&f.db).unwrap().execute("UPDATE steps SET step_payload=?1",[bytes(20,&planner)]).unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Ok(None));
    }
    #[test]
    fn immutable_reader_does_not_write_or_wait_for_writer() {
        let f = Fixture::new(SESSION); f.step(1,"synthetic committed thought");
        let before=std::fs::read(&f.db).unwrap();
        let writer=Connection::open(&f.db).unwrap(); writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let start=std::time::Instant::now();
        assert_eq!(read_history(&f.root,SESSION,1),Ok(Some("synthetic committed thought".into())));
        assert!(start.elapsed()<std::time::Duration::from_secs(1));
        writer.execute_batch("ROLLBACK").unwrap(); assert_eq!(std::fs::read(&f.db).unwrap(),before);
    }
    #[test]
    fn thinking_rows_precede_response_and_keys_include_session_and_step() {
        let r=rows(SESSION,6,Some("synthetic thought"),"synthetic response","now");
        assert_eq!(r.len(),2); assert_eq!(r[0]["thinking"],"synthetic thought");
        assert_eq!(r[0]["text"],""); assert_eq!(r[1]["text"],"synthetic response");
        assert_ne!(r[0]["assistant_id"],rows(OTHER,6,Some("synthetic thought"),"","now")[0]["assistant_id"]);
        assert_eq!(rows(SESSION,1,Some("synthetic"),"","now").len(),1);
        assert!(rows(SESSION,1,None,"","now").is_empty());
    }
}
