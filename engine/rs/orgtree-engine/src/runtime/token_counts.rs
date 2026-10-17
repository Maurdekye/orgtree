//! One lazy, immutable public BPE and one lock-free correction per harness.
//! Text stays in bounded actor-owned samples; only counts reach the UI.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::time::{Duration, Instant};
use std::io::Read;
use std::sync::{OnceLock, atomic::{AtomicU64, Ordering}};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SHA256: &str = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";
const PATTERN: &str = concat!(
    r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|",
    r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|",
    r"\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+"
);
const HALF: usize = 32 * 1024;

#[derive(Clone, Copy)]
pub enum Harness { Claude, Codex, Agy, Muse, Acp }

/// Response-level metadata only. Parent tool output never consumes child usage.
#[derive(Default)]
pub struct Receipt {
    pub thoughts: Vec<(String, bool)>,
    pub text: Option<String>,
    pub ambiguous: bool,
    pub calls: bool,
}
impl Receipt {
    #[nolog]
    pub fn thought(&mut self, id: &str, done: bool) {
        if let Some((_, complete)) = self.thoughts.iter_mut().find(|(key,_)| key==id) { *complete |= done; }
        else if self.thoughts.len()<32 { self.thoughts.push((id.into(),done)); }
        else { self.ambiguous=true; }
    }
    #[nolog]
    pub fn text(&mut self, text: &str) {
        if self.text.is_some() || text.len()>HALF*2 { self.ambiguous=true; }
        else { self.text=Some(text.into()); }
    }
    #[nolog]
    pub fn unique_thought(&self) -> Option<&str> {
        (!self.ambiguous && self.thoughts.len()==1 && self.thoughts[0].1).then(||self.thoughts[0].0.as_str())
    }
    #[nolog]
    pub fn complete_text(&self, reasoning: Option<u64>) -> Option<&str> {
        (!self.ambiguous && !self.calls && self.thoughts.is_empty() && reasoning==Some(0)).then_some(self.text.as_deref()).flatten()
    }
}

#[derive(Default)]
pub struct State {
    samples: HashMap<String,Sample>,
    dirty: HashSet<String>,
    pub counts: HashMap<String,Value>,
    pub due: Option<Instant>,
    pub receipt: Receipt,
    pub claude: Option<ClaudeReceipt>,
    pub claude_seen: HashSet<String>,
}
pub struct ClaudeReceipt {
    pub id: String,
    pub thoughts: usize,
    pub texts: usize,
    pub calls: bool,
    pub output: Option<u64>,
    pub thinking: Option<u64>,
}
impl State {
    #[nolog]
    pub fn output(&mut self, id: &str, text: &str, append: bool, now: Instant) {
        if self.samples.len()>=64 && !self.samples.contains_key(id) { return; }
        let sample=self.samples.entry(id.into()).or_default();
        if append { sample.append(text); } else { sample.replace(text); }
        self.dirty.insert(id.into());
        self.due.get_or_insert(now+Duration::from_secs(1));
    }
    #[nolog]
    pub fn work(&mut self) -> Vec<(String,Sample)> {
        self.due=None;
        self.dirty.drain().filter_map(|id|self.samples.get(&id).cloned().map(|s|(id,s))).collect()
    }
    #[nolog]
    pub fn finish(&mut self, id: &str) -> Option<Sample> {
        self.dirty.remove(id); self.counts.remove(id);
        if self.dirty.is_empty() { self.due=None; }
        self.samples.remove(id)
    }
}

#[nolog]
pub fn apply(chip: &mut Value, count: Option<&Value>) {
    if let Some(fields)=count.and_then(Value::as_object) {
        for (key,value) in fields { chip[key]=value.clone(); }
    }
}

/// Read provider output before any display clipping. Status/arguments are not output.
#[nolog]
pub fn codex_output(item: &Value) -> Option<String> {
    let texts=|items:&Value| items.as_array().and_then(|a| {
        let text:Vec<_>=a.iter().filter_map(|c|c["text"].as_str()).collect();
        (!text.is_empty() || a.is_empty()).then(||text.join("\n"))
    });
    match item["type"].as_str()? {
        "commandExecution"=>item["aggregatedOutput"].as_str().map(str::to_string),
        "dynamicToolCall"=>texts(&item["contentItems"]),
        "webSearch"=>item.get("results").filter(|v|!v.is_null()).map(Value::to_string),
        "mcpToolCall"=> {
            let r=item.get("result").filter(|v|!v.is_null()).or_else(||item.get("error").filter(|v|!v.is_null()))?;
            texts(&r["content"]).or_else(||r.as_str().map(str::to_string))
                .or_else(||r.get("structuredContent").map(Value::to_string))
        },
        _=>None,
    }
}

#[nolog]
pub fn muse_output(item: &Value) -> Option<String> {
    match item["kind"].as_str()? {
        "toolCall"|"userShell"=>item["visibleOutput"].as_str(),
        "subagent"=>item.pointer("/result/summary").or(item.pointer("/result/text")).and_then(Value::as_str),
        "workflow"=>item["finalSummary"].as_str().or(item["message"].as_str()),
        _=>None,
    }.map(str::to_string)
}

pub struct Calibration(AtomicU64);
impl Calibration {
    #[nolog]
    const fn new() -> Self { Self(AtomicU64::new(1.0f64.to_bits())) }
    #[nolog]
    pub fn factor(&self) -> f64 { f64::from_bits(self.0.load(Ordering::Relaxed)) }
    /// A receipt must count exactly the supplied complete text. Caller proves scope.
    #[nolog]
    pub fn observe(&self, bpe: u64, reported: u64) {
        if bpe < 32 || reported == 0 { return; }
        let ratio = reported as f64 / bpe as f64;
        if !(0.25..=4.0).contains(&ratio) { return; }
        let _ = self.0.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| {
            Some((f64::from_bits(old) * 0.9 + ratio * 0.1).to_bits())
        });
    }
}
static CORRECTIONS: [Calibration; 5] = [const { Calibration::new() }; 5];

struct Encoder { ranks: HashMap<Vec<u8>, u32>, pattern: fancy_regex::Regex }
static ENCODER: OnceLock<Option<Encoder>> = OnceLock::new();

#[nolog]
fn encoder() -> Option<&'static Encoder> {
    ENCODER.get_or_init(|| {
        let mut data = Vec::new();
        flate2::read::GzDecoder::new(&include_bytes!("tokenizer/o200k_base.tiktoken.gz")[..]).read_to_end(&mut data).ok()?;
        if hex::encode(Sha256::digest(&data)) != SHA256 { return None; }
        let mut ranks = HashMap::with_capacity(200_000);
        for line in std::str::from_utf8(&data).ok()?.lines() {
            let (token, rank) = line.split_once(' ')?;
            ranks.insert(base64::engine::general_purpose::STANDARD.decode(token).ok()?, rank.parse().ok()?);
        }
        Some(Encoder { ranks, pattern: fancy_regex::Regex::new(PATTERN).ok()? })
    }).as_ref()
}

impl Encoder {
    #[nolog]
    fn piece(&self, text: &[u8]) -> u64 {
        if text.is_empty() { return 0; }
        if self.ranks.contains_key(text) { return 1; }
        let n = text.len();
        let mut ends: Vec<usize> = (1..=n).collect();
        let mut next: Vec<usize> = (1..=n).collect();
        let mut prev: Vec<usize> = (0..n).map(|i| i.wrapping_sub(1)).collect();
        let mut alive = vec![true; n];
        let mut heap = BinaryHeap::new();
        let push = |heap: &mut BinaryHeap<Reverse<(u32,usize,usize,usize)>>, left: usize, right: usize, ends: &[usize]| {
            if right < n {
                if let Some(rank) = self.ranks.get(&text[left..ends[right]]) {
                    heap.push(Reverse((*rank, left, ends[left], ends[right])));
                }
            }
        };
        for i in 0..n.saturating_sub(1) { push(&mut heap, i, i + 1, &ends); }
        let mut count = n as u64;
        while let Some(Reverse((_, left, left_end, right_end))) = heap.pop() {
            let right = next[left];
            if !alive[left] || right >= n || !alive[right] || ends[left] != left_end || ends[right] != right_end { continue; }
            ends[left] = right_end;
            next[left] = next[right];
            if next[left] < n { prev[next[left]] = left; }
            alive[right] = false;
            count -= 1;
            let before = prev[left];
            if before < n { push(&mut heap, before, left, &ends); }
            push(&mut heap, left, next[left], &ends);
        }
        count
    }
    #[nolog]
    fn count(&self, text: &str) -> Option<u64> {
        let mut end = 0;
        let mut count = 0;
        for found in self.pattern.find_iter(text) {
            let part = found.ok()?;
            if part.start() != end { return None; }
            count += self.piece(part.as_str().as_bytes());
            end = part.end();
        }
        (end == text.len()).then_some(count)
    }
}

#[derive(Clone, Default)]
pub struct Sample { head: String, tail: String, bytes: u64 }
impl Sample {
    #[nolog]
    pub fn append(&mut self, text: &str) {
        self.bytes = self.bytes.saturating_add(text.len() as u64);
        let mut take = if self.tail.is_empty() { (HALF - self.head.len()).min(text.len()) } else { 0 };
        while !text.is_char_boundary(take) { take -= 1; }
        self.head.push_str(&text[..take]);
        let rest = &text[take..];
        if rest.len() > HALF {
            let mut start = rest.len() - HALF;
            while !rest.is_char_boundary(start) { start += 1; }
            self.tail.clear();
            self.tail.push_str(&rest[start..]);
        } else { self.tail.push_str(rest); }
        if self.tail.len() > HALF {
            let mut cut = self.tail.len() - HALF;
            while !self.tail.is_char_boundary(cut) { cut += 1; }
            self.tail.drain(..cut);
        }
    }
    #[nolog]
    pub fn replace(&mut self, text: &str) { *self = Self::default(); self.append(text); }
    #[nolog]
    pub fn sampled(&self) -> bool { self.bytes > (self.head.len() + self.tail.len()) as u64 }
    #[nolog]
    fn count(&self) -> Option<u64> {
        let e = encoder()?;
        if !self.sampled() { return e.count(&format!("{}{}", self.head, self.tail)); }
        let seen = self.head.len() + self.tail.len();
        if seen == 0 { return None; }
        Some(((e.count(&self.head)? + e.count(&self.tail)?) as f64 * self.bytes as f64 / seen as f64).round() as u64)
    }
}

/// CPU work and first decode run on Tokio's blocking pool, never a render/event task.
#[nolog]
pub async fn estimate(sample: Sample, harness: Harness) -> Option<Value> {
    tokio::task::spawn_blocking(move || {
        let n = (sample.count()? as f64 * CORRECTIONS[harness as usize].factor()).round() as u64;
        Some(json!({"output_tokens":n,"output_tokens_estimated":true,"output_tokens_sampled":sample.sampled()}))
    }).await.ok().flatten()
}

#[nolog]
pub async fn calibrate(harness: Harness, text: String, reported: u64) {
    if text.len() > HALF * 2 { return; } // sampled/truncated corpora never train a factor
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(n) = encoder().and_then(|e| e.count(&text)) { CORRECTIONS[harness as usize].observe(n, reported); }
    }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_public_encoding_counts_ordinary_unicode_and_literal_special_text() {
        let e = encoder().expect("pinned gzip/hash/pattern");
        for (text, expected) in [("hello world",2),("2 + 2 = 4",7),("antidisestablishmentarianism",6),("お誕生日おめでとう",8),("",0)] {
            assert_eq!(e.count(text), Some(expected));
        }
        assert!(e.count("<|endoftext|>").unwrap() > 1);
    }
    #[test]
    fn chunk_boundaries_do_not_change_a_complete_count_and_large_samples_are_bounded() {
        let text = "hello お誕生日 world\n".repeat(100);
        let mut streamed = Sample::default();
        for c in text.chars() { streamed.append(&c.to_string()); }
        assert_eq!(streamed.count(), encoder().unwrap().count(&text));
        let mut boundary = Sample::default();
        boundary.append(&"a".repeat(HALF-1)); boundary.append("日"); boundary.append("b");
        assert_eq!(boundary.count(),encoder().unwrap().count(&format!("{}日b","a".repeat(HALF-1))));
        streamed.append(&"x".repeat(500_000));
        assert!(streamed.sampled());
        assert!(streamed.head.len() + streamed.tail.len() <= HALF * 2);
    }
    #[test]
    fn calibration_rejects_missing_tiny_and_implausible_receipts() {
        let c = Calibration::new();
        for (bpe,real) in [(0,100),(4,6),(100,0),(100,10000)] { c.observe(bpe,real); }
        assert_eq!(c.factor(),1.0);
        c.observe(100,150);
        assert!((c.factor()-1.05).abs()<1e-10);
    }
    #[test]
    fn receipt_scope_never_assigns_request_or_child_totals_to_multiple_thoughts() {
        let mut r=Receipt::default();
        r.thought("one",false); assert_eq!(r.unique_thought(),None);
        r.thought("one",true); assert_eq!(r.unique_thought(),Some("one"));
        r.thought("two",true); assert_eq!(r.unique_thought(),None);
        r.text("visible"); assert_eq!(r.complete_text(Some(0)),None);
        let mut plain=Receipt::default(); plain.text("visible");
        assert_eq!(plain.complete_text(None),None);
        assert_eq!(plain.complete_text(Some(0)),Some("visible"));
        plain.calls=true; assert_eq!(plain.complete_text(Some(0)),None);
    }
    #[test]
    fn output_projection_keeps_full_provider_text_and_omits_metadata_and_images() {
        let text="synthetic output ".repeat(1000);
        assert_eq!(codex_output(&json!({"type":"mcpToolCall","result":{"content":[{"text":text}]}})),Some(text));
        assert_eq!(codex_output(&json!({"type":"fileChange","status":"completed","changes":[{"path":"x"}]})),None);
        assert_eq!(codex_output(&json!({"type":"webSearch","query":"input-only"})),None);
        assert_eq!(codex_output(&json!({"type":"dynamicToolCall","contentItems":[{"type":"image","data":"synthetic"}]})),None);
        assert_eq!(muse_output(&json!({"kind":"toolCall","status":"completed","usage":{"outputTokens":9999}})),None);
        assert_eq!(muse_output(&json!({"kind":"toolCall","visibleOutput":""})),Some(String::new()));
    }
}
