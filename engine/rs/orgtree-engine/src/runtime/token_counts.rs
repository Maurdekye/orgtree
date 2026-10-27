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
impl Harness {
    /// The name a reported count is attributed to.
    #[nolog]
    pub fn label(self) -> &'static str {
        match self { Self::Claude=>"Claude", Self::Codex=>"Codex", Self::Agy=>"Antigravity", Self::Muse=>"Muse", Self::Acp=>"ACP" }
    }
}

/// Response-level metadata only. Parent tool output never consumes child usage.
#[derive(Default)]
pub struct Receipt {
    pub thoughts: Vec<(String, bool)>,
    pub text: Option<String>,
    /// The row the text belongs to, so a count that is exactly the text can be shown on it.
    pub text_id: Option<String>,
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
    pub fn text_of(&mut self, id: &str, text: &str) {
        self.text(text);
        if !self.ambiguous { self.text_id=Some(id.into()); }
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
    pub claude_stream: Option<(String,Value)>,
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
    /// A Claude response's output count. The CLI's assistant event for each block carries
    /// the usage as it stood before the response finished; the response's final usage
    /// arrives later, in its message_delta (user 2026-10-27 mf421a040506c: a reply of about
    /// 130 tokens showed 8t). Output only grows within a response, so the largest seen is
    /// its count; another response's usage never lands here.
    #[nolog]
    pub fn claude_output(&mut self, id: &str, output: Option<u64>, thinking: Option<u64>) {
        if let Some(r) = self.claude.as_mut().filter(|r| r.id == id) {
            if let Some(n) = output { r.output = Some(r.output.map_or(n, |o| o.max(n))); }
            if let Some(n) = thinking { r.thinking = Some(r.thinking.map_or(n, |o| o.max(n))); }
        }
    }
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

/// Text carried by a root Claude result, including an explicitly empty result.
#[nolog]
pub fn claude_output(event: &Value, block: &Value, name: &str) -> Option<String> {
    // SDKUserMessage.tool_use_result belongs to the single matching result,
    // not to every block in a parallel/malformed envelope.
    if is_file_read(name) && block["is_error"]!=true {
        let results:Vec<_>=event.pointer("/message/content").and_then(Value::as_array).into_iter().flatten()
            .filter(|b|b["type"]=="tool_result").collect();
        if results.len()==1 && block["tool_use_id"].as_str().is_some()
            && results[0]["tool_use_id"]==block["tool_use_id"] && event["tool_use_result"]["type"]=="text" {
            if let Some(text)=event.pointer("/tool_use_result/file/content").and_then(Value::as_str) {return Some(text.into());}
        }
    }
    let content=&block["content"];
    if let Some(text)=content.as_str() { return Some(text.into()); }
    let blocks=content.as_array()?;
    let mut observed=false;let mut text=String::new();
    for b in blocks.iter().filter(|b|b["type"]=="text") {
        observed|=b["text"].is_string();
        if !text.is_empty(){text.push('\n');}
        text.push_str(b["text"].as_str().unwrap_or(""));
    }
    observed.then_some(text)
}

#[nolog]
pub fn agy_output(info: &Value) -> Option<String> {
    ["result","output","response"].iter().find_map(|k|info.get(*k).filter(|v|!v.is_null()))
        .map(|v|v.as_str().map(str::to_string).unwrap_or_else(||v.to_string()))
        .or_else(||info.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
}

/// Canonical native file-read names; never infer output from input paths.
#[nolog]
pub fn is_file_read(name: &str) -> bool {
    matches!(name.rsplit([':', '.']).next().unwrap_or(name).to_ascii_lowercase().as_str(),"read"|"read_file"|"view_file")
}

#[nolog]
pub fn muse_read_request(item: &Value) -> Option<(String,u64)> {
    if item["kind"]!="toolCall" || !is_file_read(item["tool"].as_str()?) {return None;}
    let r=&item["outputRef"];
    let id=r["id"].as_str().filter(|s|!s.is_empty() && s.len()<=512)?;
    (r["availability"]=="available").then(||Some((id.into(),r["byteLen"].as_u64()?))).flatten()
}

#[nolog]
pub fn muse_read_ranges(bytes: u64) -> Vec<(u64,u64)> {
    if bytes<=HALF as u64*2 {vec![(0,bytes)]}
    else {vec![(0,HALF as u64),(bytes-HALF as u64,HALF as u64)]}
}

/// Validate stored-byte pages against the requested immutable output reference.
/// No URI/path is opened. Bounded samples retain the full observed byte length.
#[nolog]
pub fn muse_read_sample(bytes: u64, pages: &[Value]) -> Option<Sample> {
    let ranges=muse_read_ranges(bytes);
    if pages.len()!=ranges.len() {return None;}
    let mut windows=Vec::new();
    for (page,(offset,len)) in pages.iter().zip(ranges) {
        if page["offsetBytes"].as_u64()!=Some(offset) || page["byteLen"].as_u64()!=Some(len)
            || !page["mediaType"].as_str()?.starts_with("text/") || page["eof"].as_bool()!=Some(offset+len==bytes) {return None;}
        let content=page["content"].as_str()?;
        if content.len()>HALF*3 {return None;}
        let data=match page["encoding"].as_str()? {
            "utf8"=>content.as_bytes().to_vec(),
            "base64"=>base64::engine::general_purpose::STANDARD.decode(content).ok()?,
            _=>return None,
        };
        if data.len() as u64!=len {return None;}windows.push(data);
    }
    let mut sample=Sample::default();
    if windows.len()==1 {sample.replace(std::str::from_utf8(&windows[0]).ok()?);return Some(sample);}
    // A byte-ranged sample may cut one UTF-8 scalar at either outer edge.
    let head=&windows[0];let tail=&windows[1];
    let head_end=(0..=3).find_map(|n|head.len().checked_sub(n).filter(|end|std::str::from_utf8(&head[..*end]).is_ok()))?;
    let tail_start=(0..=3).find(|n|std::str::from_utf8(&tail[*n..]).is_ok())?;
    sample.head=std::str::from_utf8(&head[..head_end]).ok()?.into();
    sample.tail=std::str::from_utf8(&tail[tail_start..]).ok()?.into();sample.bytes=bytes;Some(sample)
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

/// At most this many labelled parts or itemized extras per row.
pub const PARTS_MAX: usize = 16;

/// A response row's estimate (user 2026-10-27 m10e4ca6d8934: "token counts in messages of
/// all kinds"): one estimate of exactly the text given, with its labelled parts each
/// estimated alone. Marked estimated, and sampled when only a bounded head and tail were
/// counted. Counted once, off the actor's task.
#[nolog]
pub async fn row_count(text: &str, parts: Vec<(String, String)>, harness: Harness) -> Option<Value> {
    let mut total = Sample::default(); total.replace(text);
    let parts: Vec<(String, Sample)> = parts.into_iter().take(PARTS_MAX).map(|(label, text)| { let mut s = Sample::default(); s.replace(&text); (label, s) }).collect();
    tokio::task::spawn_blocking(move || {
        let factor = CORRECTIONS[harness as usize].factor();
        let n = |s: &Sample| s.count().map(|c| (c as f64 * factor).round() as u64);
        let mut out = json!({"count": n(&total)?, "estimated": true, "sampled": total.sampled()});
        let listed: Vec<Value> = parts.iter().filter_map(|(label, s)| Some(json!({"label": label, "count": n(s)?}))).collect();
        if !listed.is_empty() { out["parts"] = json!(listed); }
        Some(out)
    }).await.ok().flatten()
}

/// A delivered message's counts (user 2026-10-27 m7c48d80b13f4 "the token count in the
/// message header should be only that which is directly attributable to my message.
/// anything extra should have an extra "+xyt" token count", md965e01802ba "explaining
/// exactly what components are carried with it", m90b8a18987ea "the mail framing
/// itself, which always accompanies the mail, should always be included in the first
/// count"): the whole text sent (`count`), each message as if sent alone with the framing
/// that always comes with it, by its id (`own`), and the conditional parts sent with them,
/// itemized (`extras`, their sum `extra`). All estimates, each counted alone; marked
/// sampled when only a bounded head and tail were counted. Counted once, off the actor's
/// task.
#[nolog]
pub async fn delivery_count(text: &str, own: Vec<(String, String)>, extras: Vec<(String, String)>, harness: Harness) -> Option<Value> {
    let sample = |text: &str| { let mut s = Sample::default(); s.replace(text); s };
    let total = sample(text);
    let own: Vec<(String, Sample)> = own.into_iter().map(|(id, text)| { let s = sample(&text); (id, s) }).collect();
    let extras: Vec<(String, Sample)> = extras.into_iter().take(PARTS_MAX).map(|(label, text)| { let s = sample(&text); (label, s) }).collect();
    tokio::task::spawn_blocking(move || {
        let factor = CORRECTIONS[harness as usize].factor();
        let n = |s: &Sample| s.count().map(|c| (c as f64 * factor).round() as u64);
        let mut out = json!({"count": n(&total)?, "estimated": true, "sampled": total.sampled()});
        out["own"] = json!(own.iter().filter_map(|(id, s)| Some(json!({"id": id, "count": n(s)?, "estimated": true, "sampled": s.sampled()})))
            .collect::<Vec<_>>());
        let listed: Vec<(&String, u64)> = extras.iter().filter_map(|(label, s)| Some((label, n(s)?))).collect();
        if !listed.is_empty() {
            out["extra"] = json!(listed.iter().map(|(_, count)| count).sum::<u64>());
            out["extras"] = json!(listed.iter().map(|(label, count)| json!({"label": label, "count": count})).collect::<Vec<_>>());
        }
        Some(out)
    }).await.ok().flatten()
}
/// A count the provider reported for exactly this row.
#[nolog]
pub fn reported(count: u64, harness: Harness) -> Value { json!({"count": count, "reported": harness.label()}) }
/// Why a row has no count. A display-only row never reaches the agent; an
/// engine compaction's summary opens the next turn and is counted there; the
/// provider keeps its own compaction summary; a slash command goes to the CLI.
pub const NOT_SENT: &str = "not sent to the agent";
pub const SUMMARY_NEXT: &str = "its summary opens the next turn's message and is counted there";
pub const PROVIDER_SUMMARY: &str = "the provider keeps the compaction summary";
pub const CLI_COMMAND: &str = "a command for the CLI, not a message to the model";
/// A shown thought is the provider's summary, so it is never estimated.
pub const THINKING_UNREPORTED: &str = "thinking tokens were not reported for this response";
/// A row that is not counted says why; it never shows 0.
#[nolog]
pub fn not_counted(reason: &str) -> Value { json!({"not_counted": reason}) }

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
    /// User 2026-10-27 m10e4ca6d8934: rows carry an estimate with its parts, a count
    /// a provider reported for exactly that row, or why there is none.
    #[tokio::test]
    async fn row_counts_are_estimates_with_parts_and_reports_name_their_harness() {
        let c = row_count("hello world", vec![("Text".into(), "hello world".into())], Harness::Codex).await.unwrap();
        assert_eq!(c["estimated"], true); assert!(c["count"].as_u64().unwrap() >= 1);
        assert_eq!(c["sampled"], false); assert_eq!(c["parts"][0]["label"], "Text");
        let big = row_count(&"word ".repeat(100_000), Vec::new(), Harness::Claude).await.unwrap();
        assert_eq!(big["sampled"], true); assert!(big.get("parts").is_none());
        assert_eq!(reported(412, Harness::Claude), json!({"count": 412, "reported": "Claude"}));
        assert_eq!(not_counted(NOT_SENT)["not_counted"], "not sent to the agent");
    }
    /// User 2026-10-27 m7c48d80b13f4, md965e01802ba, m90b8a18987ea.
    #[tokio::test]
    async fn delivery_counts_are_estimates_with_each_message_alone_and_itemized_extras() {
        let c = delivery_count("hello world, and the org state", vec![("m1".into(), "hello world".into())],
            vec![("Org state".into(), "and the org state".into()), ("Provider usage".into(), "rows".into())], Harness::Codex).await.unwrap();
        assert_eq!(c["estimated"], true); assert!(c["count"].as_u64().unwrap() >= 1);
        assert_eq!(c["sampled"], false);
        assert_eq!(c["own"][0]["id"], "m1"); assert!(c["own"][0]["count"].as_u64().unwrap() >= 1); assert_eq!(c["own"][0]["estimated"], true);
        assert_eq!(c["extras"][0]["label"], "Org state"); assert_eq!(c["extras"][1]["label"], "Provider usage");
        assert_eq!(c["extra"].as_u64(), Some(c["extras"][0]["count"].as_u64().unwrap() + c["extras"][1]["count"].as_u64().unwrap()));
        let big = delivery_count(&"word ".repeat(100_000), vec![("m2".into(), "word ".repeat(100_000))], Vec::new(), Harness::Claude).await.unwrap();
        assert_eq!(big["sampled"], true); assert_eq!(big["own"][0]["sampled"], true);
        assert!(big.get("extras").is_none() && big.get("extra").is_none(), "nothing conditional, no +N");
    }
    /// User 2026-10-27 mf421a040506c: the count is the response's final output, not the
    /// snapshot a block's assistant event carried.
    #[test]
    fn a_claude_response_keeps_its_final_output_not_a_block_snapshot() {
        let mut s = State::default();
        s.claude = Some(ClaudeReceipt { id: "m".into(), thoughts: 0, texts: 1, calls: true, output: None, thinking: None });
        s.claude_output("m", Some(8), Some(20));
        s.claude_output("m", Some(161), None);
        s.claude_output("m", Some(8), Some(20));
        s.claude_output("other", Some(500), Some(90));
        let r = s.claude.as_ref().unwrap();
        assert_eq!((r.output, r.thinking), (Some(161), Some(20)));
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

    #[test]
    fn read_result_measurement_claude_uses_returned_slice_instead_of_summary() {
        let content="hello world\n".repeat(4000);
        let summary="Read 4000 lines.";
        let block=json!({"type":"tool_result","tool_use_id":"read","content":summary});
        let event=json!({"message":{"content":[block.clone()]},"tool_use_result":{"type":"text","file":{
            "filePath":"synthetic-large.txt","content":content,"numLines":4000,"startLine":101,"totalLines":10000}}});
        let before=claude_output(&event,&block,"Read").unwrap();
        let e=encoder().unwrap();
        println!("READ_MEASUREMENT {}",json!({"harness":"Claude","row":e.count(&before),"returned":e.count(&content),"bytes":content.len(),"estimated":true}));
        assert!(before==content,"count the supplied slice; never re-read the path or totalLines");
    }

    #[test]
    fn read_result_measurement_muse_fetches_declared_stored_output() {
        let content="hello world\n".repeat(4000);
        let item=json!({"itemId":"read","kind":"toolCall","tool":"read_file","visibleOutput":"Read 4000 lines.",
            "outputRef":{"id":"stored-read","byteLen":content.len(),"availability":"available","mediaType":"text/plain"}});
        let e=encoder().unwrap();
        let request=muse_read_request(&item);
        assert_eq!(request,Some(("stored-read".into(),content.len() as u64)));
        let page=json!({"offsetBytes":0,"byteLen":content.len(),"content":content,"encoding":"utf8","mediaType":"text/plain","eof":true});
        let sample=muse_read_sample(content.len() as u64,&[page]).unwrap();
        println!("READ_MEASUREMENT {}",json!({"harness":"Muse","row":sample.count(),"returned":e.count(&content),"bytes":content.len(),"estimated":true}));
        assert_eq!(sample.count(),e.count(&content));
    }

    #[test]
    fn read_result_measurement_agy_uses_exact_native_step() {
        let content="hello world\n".repeat(4000);
        let info=json!({"result":"Read 4000 lines."});
        let e=encoder().unwrap();
        let root=std::env::temp_dir().join(format!("read-native-{}",std::process::id()));
        let session="12345678-1234-4321-8765-123456789abc";
        let dir=root.join(".gemini/antigravity-cli/conversations");std::fs::create_dir_all(&dir).unwrap();
        let db=rusqlite::Connection::open(dir.join(format!("{session}.db"))).unwrap();
        db.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_payload BLOB)").unwrap();
        let bytes=|field:u8,s:&[u8]|{let mut v=vec![(field<<3)|2];let mut n=s.len();while n>=128{v.push((n as u8&127)|128);n>>=7;}v.push(n as u8);v.extend(s);v};
        // the stored shape of a native read: a generic tool step (field 1 = 132), call 5 -> 4 -> 2, result 140 -> 2 -> 1
        let payload=[vec![8,132,1],bytes(5,&bytes(4,&bytes(2,b"read_file"))),bytes(140,&bytes(2,&bytes(1,content.as_bytes())))].concat();
        db.execute("INSERT INTO steps VALUES (6,?1)",[payload]).unwrap();drop(db);
        let observed=crate::runtime::agy_thinking::read_tool_output(&root,session,6).unwrap();
        println!("READ_MEASUREMENT {}",json!({"harness":"Antigravity","row":e.count(observed.as_deref().unwrap_or(&agy_output(&info).unwrap())),"returned":e.count(&content),"bytes":content.len(),"estimated":true,"source":"synthetic native generic tool step (field 140 result) fixture"}));
        assert!(observed.as_deref()==Some(content.as_str()));
        assert_eq!(crate::runtime::agy_thinking::read_tool_output(&root,session,5),Ok(None));
        assert_eq!(crate::runtime::agy_thinking::read_tool_output(&root,"../wrong",6),Err(crate::runtime::agy_thinking::Skip::Identity));
    }

    #[test]
    fn read_result_measurement_codex_and_acp_preserve_complete_text() {
        let content="hello world\n".repeat(4000);
        let e=encoder().unwrap();
        let codex=codex_output(&json!({"type":"dynamicToolCall","tool":"read_file","contentItems":[{"type":"inputText","text":content}]})).unwrap();
        let acp=json!({"content":[{"type":"content","content":{"type":"text","text":content}}]});
        let acp_text=acp["content"].as_array().unwrap().iter().filter_map(|v|v.pointer("/content/text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n");
        for (harness,observed) in [("Codex",codex),("OpenCode ACP",acp_text)] {
            println!("READ_MEASUREMENT {}",json!({"harness":harness,"row":e.count(&observed),"returned":e.count(&content),"bytes":content.len(),"estimated":true,"scope":"declared text-content fixture only"}));
            assert_eq!(observed,content);
        }
    }

    #[test]
    fn claude_native_read_cannot_cross_parallel_calls_or_errors() {
        let b=json!({"type":"tool_result","tool_use_id":"read","content":"summary"});
        let mut event=json!({"message":{"content":[b.clone()]},"tool_use_result":{"type":"text","file":{"content":""}}});
        assert_eq!(claude_output(&event,&b,"Read"),Some(String::new()));
        assert_eq!(claude_output(&event,&b,"Bash"),Some("summary".into()));
        let mut error=b.clone();error["is_error"]=json!(true);
        assert_eq!(claude_output(&event,&error,"Read"),Some("summary".into()));
        event["message"]["content"].as_array_mut().unwrap().push(json!({"type":"tool_result","tool_use_id":"other","content":"other slice"}));
        assert_eq!(claude_output(&event,&b,"Read"),Some("summary".into()));
        assert_eq!(claude_output(&json!({}),&json!({"content":[{"type":"image"}]}),"Read"),None);
    }

    #[test]
    fn muse_pages_are_bounded_validated_and_never_include_ref_metadata() {
        let bytes=120000;let ranges=muse_read_ranges(bytes);assert_eq!(ranges,vec![(0,32768),(87232,32768)]);
        let pages:Vec<_>=ranges.iter().map(|(offset,len)|json!({"offsetBytes":offset,"byteLen":len,"content":"x".repeat(*len as usize),"encoding":"utf8","mediaType":"text/plain","eof":offset+len==bytes})).collect();
        let sample=muse_read_sample(bytes,&pages).unwrap();assert!(sample.sampled());assert_eq!(sample.bytes,bytes);assert!(sample.head.len()+sample.tail.len()<=HALF*2);
        for field in ["offsetBytes","byteLen","encoding","mediaType","eof"] {
            let mut bad=pages.clone();bad[0][field]=Value::Null;assert!(muse_read_sample(bytes,&bad).is_none(),"{field}");
        }
        assert!(muse_read_sample(bytes,&pages[..1]).is_none());
        assert!(muse_read_request(&json!({"kind":"toolCall","tool":"read_file","outputRef":{"id":"x","availability":"missing","byteLen":10}})).is_none());
        let all="日".repeat(40000);let raw=all.as_bytes();
        let unicode:Vec<_>=ranges.iter().map(|(offset,len)|json!({"offsetBytes":offset,"byteLen":len,"content":base64::engine::general_purpose::STANDARD.encode(&raw[*offset as usize..(*offset+*len) as usize]),"encoding":"base64","mediaType":"text/plain","eof":offset+len==bytes})).collect();
        let sample=muse_read_sample(bytes,&unicode).unwrap();assert!(sample.count().unwrap()>0);assert!(sample.sampled());
    }
}
