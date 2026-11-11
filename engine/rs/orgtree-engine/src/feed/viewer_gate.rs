//! Listen-only filtering of a viewer's org socket. STUB for the red-test commit.

use serde_json::Value;

pub const IGNORED_LIMIT: u32 = 20;

#[derive(Debug, PartialEq)]
pub enum Gate { Ping, Forward(Value), Ignored, Close }

#[derive(Default)]
pub struct ViewerGate { ignored: u32 }

impl ViewerGate {
    pub fn admit(&mut self, _text: &str) -> Gate { self.ignored += 1; Gate::Ignored }
}
