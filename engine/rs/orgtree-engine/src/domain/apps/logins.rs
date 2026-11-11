//! RED STUB (piece 3, saved logins): replaced by the implementation in the next commit.
use anyhow::Result;
use serde_json::Value;
pub const VALUE_MAX: usize = 8 * 1024;
#[derive(Clone, PartialEq, Eq)]
pub enum Kind {
    Bearer,
    Header,
}
impl Kind {
    #[nolog]
    pub fn as_str(&self) -> &'static str {
        "bearer"
    }
}
#[derive(Clone, PartialEq, Eq)]
pub struct Login {
    pub kind: Kind,
    pub name: Option<String>,
    pub value: String,
}
impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Login({})", self.value)
    }
}
#[nolog]
pub fn validate(_kind: &str, _name: Option<&str>, _value: &str) -> Result<Login> {
    unimplemented!("red stub")
}
impl Login {
    #[nolog]
    pub fn header(&self) -> (String, String) {
        unimplemented!("red stub")
    }
    #[nolog]
    pub fn apply(&self, _headers: &mut Vec<(String, String)>) {
        unimplemented!("red stub")
    }
}
#[nolog]
pub fn seal(_key: &crate::mqtt::seal::Key, _org: i64, _app: &str, _site: &str, _login: &Login) -> Result<Vec<u8>> {
    unimplemented!("red stub")
}
#[nolog]
pub fn open(_key: &crate::mqtt::seal::Key, _org: i64, _app: &str, _site: &str, _sealed: &[u8]) -> Result<Login> {
    unimplemented!("red stub")
}
#[nolog]
pub fn shown(_site: &str, _kind: &str, _set_at: &str) -> Value {
    unimplemented!("red stub")
}
#[nolog]
pub fn site_allows_login(_app: &Value, _site: &str) -> bool {
    true
}
#[cfg(test)]
#[path = "logins_tests.rs"]
mod tests;
