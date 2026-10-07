//! Bounded immutable HTML downloads and offline previews. No network fetches.
use crate::refuse;
use anyhow::Result;
use base64::Engine as _;
use regex::Regex;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX: usize = 25 * 1024 * 1024;
const FILES: usize = 4096;

#[derive(Debug)]
pub struct Bundle {
    pub body: String,
    pub preview: String,
    pub download: Option<Vec<u8>>,
}

#[logged]
fn safe_name(name: &str) -> Result<()> {
    if name.to_lowercase().ends_with(".credentials.json") {
        refuse!(Forbidden, "HTML bundle names a protected asset");
    }
    for p in name.replace('\\', "/").split('/') {
        let p = p.to_lowercase();
        if p.is_empty()
            || p == "."
            || p == ".."
            || p.contains(':')
            || p.contains('\0')
            || [
                ".bridge",
                ".claude",
                ".credentials.json",
                ".claude.json",
                "credentials.json",
                "secrets.json",
                "id_rsa",
                "id_ed25519",
                ".env",
                ".env.local",
                ".env.production",
                ".npmrc",
            ]
            .contains(&p.as_str())
        {
            refuse!(Forbidden, "HTML bundle names an unsafe or protected asset");
        }
    }
    Ok(())
}

#[logged]
fn entities(text: &str) -> String {
    let re = Regex::new(r"&#(x[0-9a-fA-F]+|[0-9]+);").unwrap();
    let s = re.replace_all(text, |c: &regex::Captures| {
        let n = if c[1].starts_with('x') {
            u32::from_str_radix(&c[1][1..], 16)
        } else {
            c[1].parse::<u32>()
        };
        n.ok()
            .and_then(char::from_u32)
            .map(|v| v.to_string())
            .unwrap_or_else(|| c[0].to_string())
    });
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[logged]
fn resolve(base: &Path, raw: &str, root: &Path) -> Result<Option<PathBuf>> {
    let raw = entities(raw);
    let raw = raw.trim();
    if raw.is_empty()
        || raw.starts_with('#')
        || raw.starts_with("//")
        || Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:")
            .unwrap()
            .is_match(raw)
    {
        return Ok(None);
    }
    let raw = raw.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8()?;
    if decoded.starts_with(['/', '\\']) || decoded.contains('\0') || decoded.contains(':') {
        refuse!(Forbidden, "HTML asset names an unsafe path");
    }
    let candidate = std::fs::canonicalize(base.parent().unwrap().join(decoded.replace('\\', "/")))?;
    let candidate = crate::config::strip_verbatim(&candidate);
    if !crate::domain::scope::path_within(&candidate.to_string_lossy(), &root.to_string_lossy()) {
        refuse!(Forbidden, "HTML asset escapes its source directory");
    }
    let rel = candidate
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");
    safe_name(&rel)?;
    Ok(Some(candidate))
}

#[logged]
fn css_refs(text: &str) -> Vec<String> {
    let re = Regex::new(
        r#"(?is)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')"#,
    )
    .unwrap();
    re.captures_iter(text)
        .filter_map(|c| (1..=5).find_map(|i| c.get(i).map(|m| m.as_str().trim().to_string())))
        .collect()
}

#[derive(Debug)]
struct Tag {
    start: usize,
    end: usize,
    name: String,
    attrs: Vec<(String, String, usize, usize)>,
}

#[logged]
fn tags(text: &str) -> Vec<Tag> {
    let re = Regex::new(r#"(?is)<!--.*?-->|<([a-z][a-z0-9:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>"#)
        .unwrap();
    let attr = Regex::new(r#"(?is)([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        .unwrap();
    let lower = text.to_ascii_lowercase();
    let mut skip = 0;
    let mut out = Vec::new();
    for c in re.captures_iter(text) {
        let all = c.get(0).unwrap();
        if all.start() < skip {
            continue;
        }
        let Some(n) = c.get(1) else {
            continue;
        };
        let a = c.get(2).unwrap();
        let name = n.as_str().to_ascii_lowercase();
        let attrs = attr
            .captures_iter(a.as_str())
            .filter_map(|v| {
                let val = (2..=4).find_map(|i| v.get(i))?;
                Some((
                    v[1].to_ascii_lowercase(),
                    entities(val.as_str()),
                    a.start() + val.start(),
                    a.start() + val.end(),
                ))
            })
            .collect();
        if name == "script" || name == "style" {
            skip = lower[all.end()..]
                .find(&format!("</{name}"))
                .map(|i| all.end() + i)
                .unwrap_or(text.len());
        }
        out.push(Tag {
            start: all.start(),
            end: all.end(),
            name,
            attrs,
        });
    }
    out
}

#[logged]
fn resource_attr(tag: &Tag, key: &str) -> bool {
    match tag.name.as_str() {
        "link" => {
            key == "href"
                && tag.attrs.iter().any(|(k, v, _, _)| {
                    k == "rel"
                        && v.split_whitespace()
                            .any(|r| r.eq_ignore_ascii_case("stylesheet"))
                })
        }
        "script" | "audio" | "track" | "iframe" => key == "src",
        "img" | "source" => key == "src" || key == "srcset",
        "video" => key == "src" || key == "poster",
        "object" => key == "data",
        _ => false,
    }
}

#[logged]
fn refs(path: &Path, data: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(data);
    if path
        .extension()
        .map(|x| x.eq_ignore_ascii_case("css"))
        .unwrap_or(false)
    {
        return css_refs(&text);
    }
    let mut out = Vec::new();
    for tag in tags(&text) {
        for (key, val, _, _) in &tag.attrs {
            if resource_attr(&tag, key) {
                if key == "srcset" {
                    out.extend(
                        val.split(',')
                            .filter_map(|v| v.split_whitespace().next().map(str::to_string)),
                    );
                } else {
                    out.push(val.clone());
                }
            }
        }
    }
    let style = Regex::new(r"(?is)<style\b[^>]*>(.*?)</style\s*>").unwrap();
    for c in style.captures_iter(&text) {
        out.extend(css_refs(&c[1]));
    }
    out
}

#[logged]
fn read_bounded(path: &Path, left: usize) -> Result<Vec<u8>> {
    if !path.is_file() {
        refuse!(NotFound, "HTML asset is not a file");
    }
    let mut data = Vec::new();
    std::fs::File::open(path)?
        .take((left + 1) as u64)
        .read_to_end(&mut data)?;
    if data.len() > left {
        refuse!(BadRequest, "HTML bundle exceeds 25 MB");
    }
    Ok(data)
}

#[logged]
fn uri(
    path: &Path,
    files: &BTreeMap<PathBuf, Vec<u8>>,
    root: &Path,
    stack: &mut Vec<PathBuf>,
) -> Result<String> {
    if stack.contains(&path.to_path_buf()) {
        return Ok("data:text/css;base64,".into());
    }
    if stack.len() >= 128 {
        refuse!(BadRequest, "HTML CSS dependency depth limit");
    }
    let data = files
        .get(path)
        .ok_or_else(|| anyhow::anyhow!("HTML asset was not captured"))?;
    let bytes = if path
        .extension()
        .map(|x| x.eq_ignore_ascii_case("css"))
        .unwrap_or(false)
    {
        stack.push(path.to_path_buf());
        let out =
            rewrite_css(path, &String::from_utf8_lossy(data), files, root, stack)?.into_bytes();
        stack.pop();
        out
    } else {
        data.clone()
    };
    let value = format!(
        "data:{};base64,{}",
        mime_guess::from_path(path).first_or_octet_stream(),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    if value.len() > MAX {
        refuse!(BadRequest, "HTML preview exceeds 25 MB");
    }
    Ok(value)
}

#[logged]
fn rewrite_css(
    path: &Path,
    text: &str,
    files: &BTreeMap<PathBuf, Vec<u8>>,
    root: &Path,
    stack: &mut Vec<PathBuf>,
) -> Result<String> {
    let re = Regex::new(
        r#"(?is)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')"#,
    )
    .unwrap();
    let mut edits = Vec::new();
    for c in re.captures_iter(text) {
        if let Some(m) = (1..=5).find_map(|i| c.get(i)) {
            if let Some(p) = resolve(path, m.as_str(), root)? {
                edits.push((m.start(), m.end(), uri(&p, files, root, stack)?));
            }
        }
    }
    let mut result = text.to_string();
    for (start, end, value) in edits.into_iter().rev() {
        result.replace_range(start..end, &value);
        if result.len() > MAX {
            refuse!(BadRequest, "HTML preview exceeds 25 MB");
        }
    }
    Ok(result)
}

#[logged]
pub fn capture(source: &Path) -> Result<Bundle> {
    let source = crate::config::strip_verbatim(&std::fs::canonicalize(source)?);
    let root = source
        .parent()
        .ok_or_else(|| anyhow::anyhow!("HTML source has no directory"))?;
    safe_name(&source.file_name().unwrap().to_string_lossy())?;
    let body = read_bounded(&source, 4 * 1024 * 1024)?;
    let mut total = body.len();
    let mut files = BTreeMap::new();
    files.insert(source.clone(), body.clone());
    let mut pending = VecDeque::from([source.clone()]);
    while let Some(current) = pending.pop_front() {
        for raw in refs(&current, &files[&current]) {
            if let Some(p) = resolve(&current, &raw, root)? {
                if files.contains_key(&p) {
                    continue;
                }
                if files.len() >= FILES {
                    refuse!(BadRequest, "HTML bundle has too many assets");
                }
                let data = read_bounded(&p, MAX - total)?;
                total += data.len();
                if p.extension()
                    .map(|x| x.eq_ignore_ascii_case("css"))
                    .unwrap_or(false)
                {
                    pending.push_back(p.clone());
                }
                files.insert(p, data);
            }
        }
    }
    let body = String::from_utf8(body)?;
    let mut edits = Vec::new();
    for tag in tags(&body) {
        for (key, val, start, end) in &tag.attrs {
            if resource_attr(&tag, key) {
                let value = if key == "srcset" {
                    let mut parts = Vec::new();
                    for chunk in val.split(',') {
                        let mut bits = chunk.split_whitespace();
                        if let Some(raw) = bits.next() {
                            let replacement = match resolve(&source, raw, root)? {
                                Some(p) => uri(&p, &files, root, &mut Vec::new())?,
                                None => raw.to_string(),
                            };
                            parts.push(format!(
                                "{} {}",
                                replacement,
                                bits.collect::<Vec<_>>().join(" ")
                            ));
                        }
                    }
                    parts.join(", ")
                } else {
                    match resolve(&source, val, root)? {
                        Some(p) => uri(&p, &files, root, &mut Vec::new())?,
                        None => continue,
                    }
                };
                edits.push((*start, *end, value));
            }
        }
        let _ = (tag.start, tag.end);
    }
    let style = Regex::new(r"(?is)<style\b[^>]*>(.*?)</style\s*>").unwrap();
    for c in style.captures_iter(&body) {
        let m = c.get(1).unwrap();
        edits.push((
            m.start(),
            m.end(),
            rewrite_css(&source, m.as_str(), &files, root, &mut Vec::new())?,
        ));
    }
    edits.sort_by_key(|e| e.0);
    let mut preview = body.clone();
    for (start, end, value) in edits.into_iter().rev() {
        preview.replace_range(start..end, &value);
        if preview.len() > MAX {
            refuse!(BadRequest, "HTML preview exceeds 25 MB");
        }
    }
    let download = if files.len() > 1 {
        Some(zip(&files, root)?)
    } else {
        None
    };
    Ok(Bundle {
        body,
        preview,
        download,
    })
}

/// ZIP's stored method avoids an extra archive dependency; all sizes are bounded well below ZIP64.
#[logged]
fn zip(files: &BTreeMap<PathBuf, Vec<u8>>, root: &Path) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (path, data) in files {
        let name = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        safe_name(&name)?;
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let size = data.len() as u32;
        let offset = out.len() as u32;
        out.write_all(&0x04034b50u32.to_le_bytes())?;
        for n in [20u16, 0x800, 0, 0, 33] {
            out.write_all(&n.to_le_bytes())?;
        }
        for n in [crc, size, size] {
            out.write_all(&n.to_le_bytes())?;
        }
        out.write_all(&(name.len() as u16).to_le_bytes())?;
        out.write_all(&0u16.to_le_bytes())?;
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        central.write_all(&0x02014b50u32.to_le_bytes())?;
        for n in [20u16, 20, 0x800, 0, 0, 33] {
            central.write_all(&n.to_le_bytes())?;
        }
        for n in [crc, size, size] {
            central.write_all(&n.to_le_bytes())?;
        }
        for n in [name.len() as u16, 0, 0, 0, 0] {
            central.write_all(&n.to_le_bytes())?;
        }
        central.write_all(&0u32.to_le_bytes())?;
        central.write_all(&offset.to_le_bytes())?;
        central.extend_from_slice(name.as_bytes());
    }
    let offset = out.len() as u32;
    let size = central.len() as u32;
    out.extend(central);
    out.write_all(&0x06054b50u32.to_le_bytes())?;
    for n in [0u16, 0, files.len() as u16, files.len() as u16] {
        out.write_all(&n.to_le_bytes())?;
    }
    for n in [size, offset] {
        out.write_all(&n.to_le_bytes())?;
    }
    out.write_all(&0u16.to_le_bytes())?;
    Ok(out)
}
