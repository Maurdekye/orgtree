use std::fmt;
use std::path::Path;

/// Every refusal carries a stable dotted `code`, so tests (and the unsafe
/// controls) assert WHICH check fired rather than that something failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodianError {
    pub code: &'static str,
    pub message: String,
}

impl CustodianError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn io(code: &'static str, path: &Path, e: std::io::Error) -> Self {
        Self::new(code, format!("{}: {e}", path.display()))
    }
}

impl fmt::Display for CustodianError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CustodianError {}

pub type Result<T> = std::result::Result<T, CustodianError>;
