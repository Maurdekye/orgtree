//! The driver boundary. The executor talks to PostgreSQL only through
//! [`Session`], so every rule above it can be exercised with the fake session
//! (SQLSTATE injection, lost commits) without a database.

use std::future::Future;

use crate::exec::Isolation;
use crate::value::{Rows, Val};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DbError {
    /// A server error with its SQLSTATE and, for constraint violations, the
    /// violated constraint's name.
    Sql { code: String, constraint: Option<String>, message: String },
    /// The connection is gone. During COMMIT this is an unknown outcome
    /// (v6 I04); anywhere else the server has rolled the transaction back.
    ConnectionLost { message: String },
}

impl DbError {
    pub fn sql(code: &str) -> DbError {
        DbError::Sql { code: code.to_string(), constraint: None, message: String::new() }
    }
    pub fn unique(constraint: &str) -> DbError {
        DbError::Sql { code: "23505".into(), constraint: Some(constraint.into()), message: String::new() }
    }
    pub fn lost() -> DbError {
        DbError::ConnectionLost { message: "connection lost".into() }
    }
    pub fn sqlstate(&self) -> Option<&str> {
        match self {
            DbError::Sql { code, .. } => Some(code),
            DbError::ConnectionLost { .. } => None,
        }
    }
    pub fn constraint(&self) -> Option<&str> {
        match self {
            DbError::Sql { constraint, .. } => constraint.as_deref(),
            DbError::ConnectionLost { .. } => None,
        }
    }
}

/// One connection. Statements are always labelled: the label is the trace
/// and pause identity (CONTRACT-M1 §3.1, §5).
pub trait Session: Send {
    fn begin(&mut self, iso: Isolation) -> impl Future<Output = Result<(), DbError>> + Send;
    fn exec(&mut self, label: &str, sql: &str, params: &[Val]) -> impl Future<Output = Result<Rows, DbError>> + Send;
    fn commit(&mut self) -> impl Future<Output = Result<(), DbError>> + Send;
    fn rollback(&mut self) -> impl Future<Output = Result<(), DbError>> + Send;
    /// Close the socket without COMMIT or ROLLBACK (harness `DropConn`).
    fn drop_connection(&mut self);
    fn backend_pid(&self) -> Option<i32>;
    /// A broken session is discarded, never returned to the pool.
    fn is_broken(&self) -> bool;
}

/// Opens sessions. The real one is the connection factory of CONTRACT-M1
/// §3.8, which registers every connection with the trace sink.
pub trait Connector: Send + Sync {
    type S: Session;
    fn connect(&self) -> impl Future<Output = Result<Self::S, DbError>> + Send;
}
