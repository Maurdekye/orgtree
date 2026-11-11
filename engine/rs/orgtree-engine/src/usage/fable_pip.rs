//! STUB for the red commit: the pip formula is not implemented yet (every reading is "unknown").
use chrono::{DateTime, Utc};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PipReading {
    pub weekly: f64,
    pub fable: f64,
    pub pip: f64,
}

#[nolog]
pub fn is_fable_weekly(_provider: &str, _w: &Value) -> bool {
    false
}

#[nolog]
pub fn pip_percent(_row: &Value, _now: DateTime<Utc>) -> Option<PipReading> {
    None
}
