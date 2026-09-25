//! P03 WS7 contact-trace collector (`orgtree.p03-trace/v1`).
//!
//! - [`stream`]: one bounded trace stream: monotone sequence numbers, a loss
//!   counter, and a closing `drop`/`stream_end` that says whether the stream is
//!   complete (v6 PROFILING "Coverage"). The Python harness's
//!   `tools/p03/harness/trace.py::stream_health` checks exactly these rules.
//! - [`sqlmap`]: the executor-side relation and row-lock-mode deriver, from a
//!   statement's SQL text (CONTRACT-M1 §5: "relations and lock modes are WS7's
//!   to derive"). The server-side `trace.xact_stats` rows are its cross-check.
//! - [`json`]: a minimal JSON writer, so this crate has no dependencies.
//!
//! - [`sink`] (feature `sink`): the collector implementing WS2's
//!   `orgtree_store::hooks::TraceSink`, mapping every event onto a record of
//!   `trace.py::KINDS`.

pub mod json;
#[cfg(feature = "sink")]
pub mod sink;
pub mod sqlmap;
pub mod stream;
