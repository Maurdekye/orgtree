//! Completed-step AGY thinking. All content-bearing helpers are unlogged.
use std::path::Path;
use serde_json::{json, Value};

const MAX_PAYLOAD: usize = 2 * 1024 * 1024;
const MAX_THINKING: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip { Identity, Unavailable, Schema, Payload }

#[nolog]
pub fn read_history(home: &Path, session: &str, index: i64) -> Result<Option<String>, Skip> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};
    if !valid_session(session) || index < 0 { return Err(Skip::Identity); }
    let path = home.join(".gemini/antigravity-cli/conversations").join(format!("{session}.db"));
    // No writes, SQLite locks, journal recovery or waiting on the live writer.
    // Immutable cannot see WAL; do not silently read a stale checkpoint instead.
    for suffix in ["-wal", "-journal"] {
        if std::fs::metadata(format!("{}{suffix}",path.display())).is_ok_and(|m| m.len()>0) {
            return Err(Skip::Unavailable);
        }
    }
    if !path.is_file() { return Err(Skip::Unavailable); }
    let url = url_for(&path)?;
    let db = Connection::open_with_flags(url,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_URI|OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_|Skip::Unavailable)?;
    db.busy_timeout(std::time::Duration::ZERO).map_err(|_|Skip::Unavailable)?;
    let indexed: bool=db.query_row("SELECT count(*)=1 AND max(name='idx' AND upper(type)='INTEGER') FROM pragma_table_info('steps') WHERE pk>0",
        [],|r|r.get(0)).map_err(|_|Skip::Schema)?;
    if !indexed { return Err(Skip::Schema); }
    let size: Option<i64> = db.query_row("SELECT length(step_payload) FROM steps WHERE idx=?1",[index],|r|r.get(0))
        .optional().map_err(|_|Skip::Schema)?.flatten();
    let Some(size)=size else { return Ok(None) };
    if size<0 || size as usize>MAX_PAYLOAD { return Err(Skip::Payload); }
    let data: Vec<u8> = db.query_row("SELECT step_payload FROM steps WHERE idx=?1 AND length(step_payload)<=?2",
        rusqlite::params![index,MAX_PAYLOAD],|r|r.get(0)).map_err(|_|Skip::Schema)?;
    let Some(planner)=field(&data,20)? else { return Ok(None) };
    // Neither raw_thinking nor signature fields are transcript content.
    if scalar(planner,5)?.unwrap_or(0)!=0 { return Ok(None); }
    let Some(thought)=field(planner,3)? else { return Ok(None) };
    let text=std::str::from_utf8(thought).map_err(|_|Skip::Payload)?;
    Ok((!text.trim().is_empty()).then(||clip(text)))
}

#[nolog]
pub fn rows(session: &str, index: i64, thinking: Option<&str>, response: &str, at: &str) -> Vec<Value> {
    let key=format!("agy-{session}-{index}");
    let mut out=Vec::new();
    if let Some(thought)=thinking.filter(|s|!s.trim().is_empty()) {
        out.push(json!({"role":"assistant","text":"","thinking":clip(thought),"tools":[],"ts":at,"assistant_id":format!("agy-think-{key}")}));
    }
    if !response.trim().is_empty() {
        out.push(json!({"role":"assistant","text":response,"tools":[],"ts":at,"assistant_id":format!("agy-resp-{key}")}));
    }
    out
}

#[nolog]
pub fn completed<'a>(step: &'a Value, bound: &str) -> Option<(&'a str, i64)> {
    let session=step["conversation_id"].as_str()?;
    let index=step["step_index"].as_i64()?;
    (step["state"]=="DONE" && step["step_type"]=="agent_response" && session==bound && valid_session(session) && index>=0)
        .then_some((session,index))
}

/// Future native stream support wins even when the CLI explicitly emits empty
/// or redacted thinking. Never combine native content with the history copy.
#[nolog]
pub fn stream_thinking(step: &Value) -> Option<Option<String>> {
    let thought=step.get("thinking").or_else(||step.pointer("/planner_response/thinking"))?;
    if step["thinking_redacted"]==true || step.pointer("/planner_response/thinking_redacted")==Some(&Value::Bool(true)) {
        return Some(None);
    }
    Some(thought.as_str().filter(|s|!s.trim().is_empty()).map(clip))
}

#[nolog]
fn valid_session(s:&str)->bool {
    uuid::Uuid::parse_str(s).is_ok_and(|id|id.hyphenated().to_string()==s)
}

#[nolog]
fn url_for(path:&Path)->Result<String,Skip> {
    // Percent encode URI metacharacters in a home directory; flags cannot be injected.
    let abs=path.canonicalize().map_err(|_|Skip::Unavailable)?;
    let raw=abs.to_string_lossy().replace('\\',"/");
    let raw=raw.strip_prefix("//?/").unwrap_or(&raw);
    let escaped=raw.replace('%',"%25").replace('?',"%3F").replace('#',"%23");
    Ok(format!("file:{escaped}?mode=ro&immutable=1"))
}

#[nolog]
fn clip(s:&str)->String {
    let mut end=s.len().min(MAX_THINKING);
    while !s.is_char_boundary(end) { end-=1; }
    s[..end].to_string()
}

#[nolog]
fn varint(input:&[u8],at:&mut usize)->Result<u64,Skip> {
    let mut value=0;
    for shift in (0..70).step_by(7) {
        let b=*input.get(*at).ok_or(Skip::Payload)?; *at+=1;
        if shift==63 && b>1 { return Err(Skip::Payload); }
        value|=((b&127) as u64)<<shift;
        if b&128==0 { return Ok(value); }
    }
    Err(Skip::Payload)
}

/// A small bounded protobuf wire reader, not a decoder for unknown AGY fields.
/// Reject malformed/duplicate target fields rather than guessing at changed schemas.
#[nolog]
fn wire(input:&[u8],wanted:u64)->Result<Option<(u8,&[u8],u64)>,Skip> {
    let mut at=0; let mut found=None;
    while at<input.len() {
        let tag=varint(input,&mut at)?;
        if tag>>3==0 { return Err(Skip::Payload); }
        let kind=(tag&7) as u8;
        let (slice,value)=match kind {
            0 => (&[][..],varint(input,&mut at)?),
            1|5 => {
                let end=at.checked_add(if kind==1 {8}else{4}).ok_or(Skip::Payload)?;
                let b=input.get(at..end).ok_or(Skip::Payload)?; at=end; (b,0)
            }
            2 => {
                let len=usize::try_from(varint(input,&mut at)?).map_err(|_|Skip::Payload)?;
                let end=at.checked_add(len).ok_or(Skip::Payload)?;
                let b=input.get(at..end).ok_or(Skip::Payload)?; at=end; (b,0)
            }
            _ => return Err(Skip::Payload),
        };
        if tag>>3==wanted {
            if found.is_some() { return Err(Skip::Payload); }
            found=Some((kind,slice,value));
        }
    }
    Ok(found)
}

#[nolog]
fn field(input:&[u8],wanted:u64)->Result<Option<&[u8]>,Skip> {
    match wire(input,wanted)? { Some((2,b,_))=>Ok(Some(b)),None=>Ok(None),_=>Err(Skip::Payload) }
}
#[nolog]
fn scalar(input:&[u8],wanted:u64)->Result<Option<u64>,Skip> {
    match wire(input,wanted)? { Some((0,_,v))=>Ok(Some(v)),None=>Ok(None),_=>Err(Skip::Payload) }
}

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

    #[test]
    fn native_stream_thinking_wins_including_redacted_or_empty() {
        assert_eq!(stream_thinking(&json!({})),None);
        assert_eq!(stream_thinking(&json!({"thinking":"native synthetic"})),Some(Some("native synthetic".into())));
        assert_eq!(stream_thinking(&json!({"thinking":""})),Some(None));
        assert_eq!(stream_thinking(&json!({"thinking":"secret","thinking_redacted":true})),Some(None));
    }
    #[test]
    fn malformed_wire_data_is_rejected_without_leaking_other_fields() {
        for data in [vec![0],vec![162,1,128],vec![162,1,255,255,255,255,255,255,255,255,255,2],vec![162,1,2,26]] {
            assert_eq!(field(&data,20),Err(Skip::Payload));
        }
        let mut duplicate=bytes(20,b""); duplicate.extend(bytes(20,b""));
        assert_eq!(field(&duplicate,20),Err(Skip::Payload));
        let f=Fixture::new(SESSION);
        let invalid=bytes(20,&bytes(3,&[255]));
        Connection::open(&f.db).unwrap().execute("INSERT INTO steps VALUES (1,15,0,?1,0)",[invalid]).unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Err(Skip::Payload));
    }
    #[test]
    fn wal_or_changed_primary_key_skips_instead_of_reading_stale_or_scanning() {
        let f=Fixture::new(SESSION); f.step(1,"synthetic");
        let wal=PathBuf::from(format!("{}-wal",f.db.display())); std::fs::write(&wal,b"synthetic WAL").unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Err(Skip::Unavailable)); std::fs::remove_file(wal).unwrap();
        Connection::open(&f.db).unwrap().execute_batch("ALTER TABLE steps RENAME TO old_steps; CREATE TABLE steps(idx INTEGER,step_payload BLOB)").unwrap();
        assert_eq!(read_history(&f.root,SESSION,1),Err(Skip::Schema));
    }
}
