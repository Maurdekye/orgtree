//! One lazy, immutable public BPE and one lock-free correction per harness.
//! Text stays in bounded actor-owned samples; only counts reach the UI.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
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
}
