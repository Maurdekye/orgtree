//! One trace STREAM: a bounded buffer of `orgtree.p03-trace/v1` records with
//! monotone sequence numbers and a loss counter (v6 PROFILING "Coverage").
//!
//! Rules, mirrored by `tools/p03/harness/trace.py::stream_health`:
//! - every record offered gets the NEXT sequence number, even if it is then
//!   dropped, so a drop always leaves a visible gap;
//! - a full buffer drops the new record and counts it; it never blocks the
//!   caller (a logging bottleneck must not become a concurrency bottleneck,
//!   PROFILING test 6);
//! - `end` first reports the losses (`drop{count}`), then `stream_end{last_seq,
//!   clean}`, where `clean` is false if anything was dropped or the caller says
//!   the tail was not flushed. Those two records use a reserved slice of the
//!   buffer, so a full stream can still say that it lost records.

use crate::json::Value;
use std::sync::Mutex;
use std::time::Instant;

pub const SCHEMA: &str = "orgtree.p03-trace/v1";
/// Slots kept free for the stream's own closing records (`drop`, `stream_end`).
const RESERVED: usize = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub stream: String,
    pub seq: u64,
    pub mono_ns: u64,
    pub kind: String,
    pub fields: Vec<(String, Value)>,
}

impl Record {
    pub fn to_value(&self) -> Value {
        let mut obj = vec![
            ("schema".to_string(), Value::str(SCHEMA)),
            ("stream".to_string(), Value::str(self.stream.clone())),
            ("seq".to_string(), Value::Int(self.seq as i64)),
            ("mono_ns".to_string(), Value::Int(self.mono_ns as i64)),
            ("kind".to_string(), Value::str(self.kind.clone())),
        ];
        obj.extend(self.fields.iter().cloned());
        Value::Obj(obj)
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_json()
    }
}

struct Inner {
    next_seq: u64,
    buffer: Vec<Record>,
    dropped: u64,
    ended: bool,
}

pub struct Stream {
    name: String,
    capacity: usize,
    origin: Instant,
    inner: Mutex<Inner>,
}

#[derive(Debug, PartialEq)]
pub enum Pushed {
    Kept(u64),
    Dropped(u64),
    /// the stream has ended; nothing more is accepted (a late record after
    /// `stream_end` would be exactly the unflushed-tail case)
    Refused,
}

impl Stream {
    /// `capacity` counts every record, including the reserved closing ones.
    pub fn new(name: impl Into<String>, capacity: usize) -> Stream {
        assert!(capacity > RESERVED, "capacity must exceed the reserved closing slots");
        Stream {
            name: name.into(),
            capacity,
            origin: Instant::now(),
            inner: Mutex::new(Inner { next_seq: 1, buffer: Vec::new(), dropped: 0, ended: false }),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&self) -> u64 {
        self.origin.elapsed().as_nanos() as u64
    }

    pub fn push(&self, kind: &str, fields: Vec<(String, Value)>) -> Pushed {
        let mono_ns = self.stamp();
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.ended {
            return Pushed::Refused;
        }
        let seq = g.next_seq;
        g.next_seq += 1;
        if g.buffer.len() >= self.capacity - RESERVED {
            g.dropped += 1;
            return Pushed::Dropped(seq);
        }
        g.buffer.push(Record { stream: self.name.clone(), seq, mono_ns, kind: kind.to_string(), fields });
        Pushed::Kept(seq)
    }

    /// Take the buffered records (for export). Sequence numbering continues.
    pub fn drain(&self) -> Vec<Record> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        std::mem::take(&mut g.buffer)
    }

    pub fn dropped(&self) -> u64 {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).dropped
    }

    /// Close the stream: report losses, then `stream_end`. Returns what is left
    /// in the buffer, closing records included. `flushed` is the caller's word
    /// that every record it produced was offered; false marks an unflushed tail.
    pub fn end(&self, flushed: bool) -> Vec<Record> {
        let mono_ns = self.stamp();
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.ended {
            return Vec::new();
        }
        g.ended = true;
        let dropped = g.dropped;
        if dropped > 0 {
            let seq = g.next_seq;
            g.next_seq += 1;
            g.buffer.push(Record {
                stream: self.name.clone(),
                seq,
                mono_ns,
                kind: "drop".into(),
                fields: vec![("count".into(), Value::Int(dropped as i64))],
            });
        }
        let seq = g.next_seq;
        g.next_seq += 1;
        g.buffer.push(Record {
            stream: self.name.clone(),
            seq,
            mono_ns,
            kind: "stream_end".into(),
            fields: vec![
                ("last_seq".into(), Value::Int(seq as i64)),
                ("clean".into(), Value::Bool(flushed && dropped == 0)),
            ],
        });
        std::mem::take(&mut g.buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(n: i64) -> Vec<(String, Value)> {
        vec![("n".into(), Value::Int(n))]
    }

    #[test]
    fn sequence_is_monotone_and_contiguous() {
        let s = Stream::new("s", 16);
        for i in 0..5 {
            assert_eq!(s.push("flush", f(i)), Pushed::Kept(i as u64 + 1));
        }
        let mut all = s.drain();
        all.extend(s.end(true));
        let seqs: Vec<u64> = all.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, (1..=6).collect::<Vec<_>>());
        let last = all.last().unwrap();
        assert_eq!(last.kind, "stream_end");
        assert!(last.fields.contains(&("clean".into(), Value::Bool(true))));
        assert!(last.fields.contains(&("last_seq".into(), Value::Int(6))));
    }

    #[test]
    fn a_full_buffer_drops_counts_and_still_reports_the_loss() {
        let s = Stream::new("s", 5); // 3 usable + 2 reserved
        let got: Vec<Pushed> = (0..5).map(|i| s.push("flush", f(i))).collect();
        assert_eq!(got[..3], [Pushed::Kept(1), Pushed::Kept(2), Pushed::Kept(3)]);
        assert_eq!(got[3..], [Pushed::Dropped(4), Pushed::Dropped(5)]);
        assert_eq!(s.dropped(), 2);
        let end = s.end(true);
        let kinds: Vec<&str> = end.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(kinds, ["flush", "flush", "flush", "drop", "stream_end"]);
        // the dropped records left a gap (4, 5 missing), and the end is unclean
        let seqs: Vec<u64> = end.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [1, 2, 3, 6, 7]);
        assert!(end[3].fields.contains(&("count".into(), Value::Int(2))));
        assert!(end[4].fields.contains(&("clean".into(), Value::Bool(false))));
    }

    #[test]
    fn unflushed_tail_is_unclean_and_nothing_follows_the_end() {
        let s = Stream::new("s", 8);
        s.push("flush", f(0));
        let end = s.end(false);
        assert!(end.last().unwrap().fields.contains(&("clean".into(), Value::Bool(false))));
        assert_eq!(s.push("flush", f(1)), Pushed::Refused);
        assert!(s.end(true).is_empty());
    }

    #[test]
    fn records_serialize_with_the_common_fields() {
        let s = Stream::new("exec-1", 8);
        s.push("op_end", vec![("contacts".into(), Value::Int(0))]);
        let json = s.drain()[0].to_json();
        assert!(json.starts_with(r#"{"schema":"orgtree.p03-trace/v1","stream":"exec-1","seq":1,"mono_ns":"#));
        assert!(json.ends_with(r#""kind":"op_end","contacts":0}"#));
    }
}
