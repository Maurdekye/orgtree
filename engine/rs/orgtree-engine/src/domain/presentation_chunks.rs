//! Bounded, character-aligned database windows for full presentation reads.
use anyhow::Result;
use serde_json::{json, Value};

// At most 64KiB of UTF-8, even when every character occupies four bytes.
pub const CHARS: i32 = 16 * 1024;

/// Presentations can be replaced in place. Bind continuation to the database
/// row revision rather than silently combining windows from different edits.
#[nolog]
pub fn revision(req: &Value, index: i64, current: &str) -> Result<()> {
    if index > 0 || req.get("body_revision").is_some_and(|v| !v.is_null()) {
        if req["body_revision"].as_str() != Some(current) {
            crate::refuse!(
                Conflict,
                "presentation changed or body_revision is missing; restart at chunk_index=0"
            )
        }
    }
    Ok(())
}

#[nolog]
pub fn index(req: &Value) -> Result<(i64, i32)> {
    let index = match req.get("chunk_index").filter(|v| !v.is_null()) {
        None => 0,
        Some(v) => v
            .as_i64()
            .filter(|n| *n >= 0)
            .ok_or_else(|| anyhow::anyhow!("chunk_index must be a nonnegative integer"))?,
    };
    let start = index
        .checked_mul(i64::from(CHARS))
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| *n < i32::MAX)
        .ok_or_else(|| anyhow::anyhow!("chunk_index is outside this presentation"))?;
    Ok((index, start + 1)) // PostgreSQL substring positions are one-based.
}

#[nolog]
pub fn body(body: String, total_chars: i32, index: i64) -> Result<Value> {
    let chunks = ((i64::from(total_chars) + i64::from(CHARS) - 1) / i64::from(CHARS)).max(1);
    if index >= chunks {
        crate::refuse!(BadRequest, "chunk_index is outside this presentation")
    }
    Ok(json!({"body":body,"chunk_index":index,"chunk_total":chunks,
        "next_chunk_index":if index+1<chunks {Some(index+1)}else{None},
        "truncated":index+1<chunks,"complete":chunks==1}))
}

#[cfg(test)]
mod project_agent_tool_tests {
    use super::*;
    #[test]
    fn project_tools_full_unicode_presentation_reassembles_without_clipping() {
        let source = "🦀é\n".repeat(CHARS as usize);
        let chars: Vec<char> = source.chars().collect();
        let mut rebuilt = String::new();
        let mut i = 0;
        loop {
            let (index, start) = self::index(&json!({"chunk_index":i})).unwrap();
            let window = chars
                .iter()
                .skip((start - 1) as usize)
                .take(CHARS as usize)
                .collect::<String>();
            assert!(window.len() <= 65536);
            let part = body(window, chars.len() as i32, index).unwrap();
            rebuilt.push_str(part["body"].as_str().unwrap());
            match part["next_chunk_index"].as_i64() {
                Some(next) => i = next,
                None => break,
            }
        }
        assert_eq!(rebuilt, source);
        assert_eq!(i, 2);
    }
    #[test]
    fn project_tools_empty_body_and_invalid_chunk_bounds() {
        assert_eq!(body(String::new(), 0, 0).unwrap()["complete"], true);
        assert!(body(String::new(), 0, 1).is_err());
        for bad in [json!(-1), json!(1.5), json!("1"), json!(i64::MAX)] {
            assert!(index(&json!({"chunk_index":bad})).is_err())
        }
        assert!(revision(&json!({}), 0, "v1").is_ok());
        assert!(revision(&json!({}), 1, "v1").is_err());
        assert!(revision(&json!({"body_revision":"v1"}), 1, "v1").is_ok());
        assert!(revision(&json!({"body_revision":"v1"}), 1, "v2").is_err());
    }
}
