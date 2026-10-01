//! The parameter and column values that cross the [`crate::session`] boundary.
//! Deliberately small: the real driver maps these to PostgreSQL types, the
//! fake session compares them directly.

use uuid::Uuid;

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Null,
    Bool(bool),
    Int(i64),
    Text(String),
    Uuid(Uuid),
    Json(serde_json::Value),
    /// `timestamptz` as microseconds since the Unix epoch.
    Ts(i64),
}

impl Val {
    pub fn text(s: impl Into<String>) -> Val {
        Val::Text(s.into())
    }
    pub fn opt_uuid(u: Option<Uuid>) -> Val {
        u.map(Val::Uuid).unwrap_or(Val::Null)
    }
    pub fn opt_int(i: Option<i64>) -> Val {
        i.map(Val::Int).unwrap_or(Val::Null)
    }
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Val::Text(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Val::Int(i) => Some(*i),
            _ => None,
        }
    }
    pub fn as_ts(&self) -> Option<i64> {
        match self {
            Val::Ts(t) => Some(*t),
            _ => None,
        }
    }
    pub fn as_uuid(&self) -> Option<Uuid> {
        match self {
            Val::Uuid(u) => Some(*u),
            _ => None,
        }
    }
    pub fn as_json(&self) -> Option<&serde_json::Value> {
        match self {
            Val::Json(j) => Some(j),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Val::Null)
    }
}

/// Result rows, in column order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows(pub Vec<Vec<Val>>);

impl Rows {
    pub fn empty() -> Rows {
        Rows(Vec::new())
    }
    pub fn one(row: Vec<Val>) -> Rows {
        Rows(vec![row])
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn first(&self) -> Option<&Vec<Val>> {
        self.0.first()
    }
}
