"""Contact-trace records and the stream-health rule (schema ``orgtree.p03-trace/v1``).

One record is one JSON object on one STREAM (one per process or worker). Every
record carries ``stream``, ``seq`` (monotone within the stream, starting at 1,
no gaps), ``mono_ns`` and ``kind``. A value the adapter cannot observe is the
literal string ``"unknown"``: never 0 and never omitted (v6 PROFILING:17).

A run is a complete-contact run only if every stream it names:
- has contiguous sequence numbers from 1;
- reports no dropped records;
- ends with a ``stream_end`` record whose ``clean`` is true and whose
  ``last_seq`` is the stream's last sequence number.

Anything else is ``incomplete``: its contact claims cannot pass (PROFILING:33).
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

SCHEMA = "orgtree.p03-trace/v1"
UNKNOWN = "unknown"

#: every record kind and the fields it must carry (beyond the common four)
KINDS: dict[str, tuple[str, ...]] = {
    # the executor's records (engine/native/store-trace src/sink.rs maps WS2's events here)
    "conn_opened": ("factory", "backend_pid", "backend_start"),
    "op_begin": ("run_id", "operation_id", "attempt", "op_kind", "op_tag"),
    "tx_begin": ("operation_id", "attempt", "backend_pid", "isolation"),
    "stmt": ("operation_id", "attempt", "backend_pid", "stmt_label", "fingerprint",
             "mode", "relations", "sqlstate"),
    "xact_stats": ("operation_id", "attempt", "backend_pid", "tables"),
    "wait": ("operation_id", "attempt", "backend_pid", "wait_on"),
    "retry": ("operation_id", "attempt", "retry_cause", "sqlstate"),
    "tx_end": ("operation_id", "attempt", "backend_pid", "outcome", "sqlstate"),
    "op_end": ("operation_id", "attempt", "outcome", "contacts"),
    "effect": ("operation_id", "shape"),
    "control_executed": ("control_id", "operation_id", "op_tag"),
    "pause": ("point",),
    "lookup": ("answer",),
    # the harness's own records
    "arrived": ("point", "op_tag", "operation_id", "attempt", "backend_pid"),
    "release": ("point", "op_tag"),
    "conn_activity": ("backend_pid", "factory", "transactions"),
    # stream health
    "drop": ("count",),
    "flush": ("upto_seq",),
    "stream_end": ("last_seq", "clean"),
}
COMMON = ("stream", "seq", "mono_ns", "kind")
#: a transaction's end (tx_end)
TX_OUTCOMES = {"commit", "rollback", "unknown"}
#: an operation's end (op_end): the executor's Outcome names (WS2 exec.rs Outcome::name)
OP_OUTCOMES = {"applied", "replayed", "compensated", "conflict", "fenced", "refused",
               "retry_exhausted", "unknown", "not_disclosed", "error"}
MODES = {"read", "write", "ddl", UNKNOWN}
SHAPES = {"native_tx", "workflow_step", "external_effect", "read_snapshot"}


def record_errors(record: dict[str, Any]) -> list[str]:
    """What is wrong with one record's SHAPE (not with what it says)."""
    errors = [f"missing {f}" for f in COMMON if f not in record]
    kind = record.get("kind")
    if kind not in KINDS:
        return errors + [f"unknown kind {kind!r}"]
    errors += [f"{kind}: missing {f}" for f in KINDS[kind] if f not in record]
    if kind == "stmt" and record.get("mode") not in MODES:
        errors.append(f"stmt: bad mode {record.get('mode')!r}")
    if kind == "tx_end" and record.get("outcome") not in TX_OUTCOMES:
        errors.append(f"tx_end: bad outcome {record.get('outcome')!r}")
    if kind == "op_end" and record.get("outcome") not in OP_OUTCOMES:
        errors.append(f"op_end: bad outcome {record.get('outcome')!r}")
    if kind == "effect" and record.get("shape") not in SHAPES:
        errors.append(f"effect: bad shape {record.get('shape')!r}")
    if kind == "stmt" and record.get("relations") != UNKNOWN and not isinstance(
            record.get("relations"), list):
        errors.append("stmt: relations must be a list or 'unknown'")
    return errors


def stream_health(records: Iterable[dict[str, Any]],
                  expected_streams: Iterable[str]) -> dict[str, Any]:
    """The complete-contact verdict over every stream a run names.

    ``expected_streams`` comes from the run manifest, not from the records: a
    stream that emitted nothing at all is exactly the failure a
    records-only check would miss.
    """
    by_stream: dict[str, list[dict[str, Any]]] = defaultdict(list)
    shape_errors: list[str] = []
    for r in records:
        for e in record_errors(r):
            shape_errors.append(f"{r.get('stream')}#{r.get('seq')}: {e}")
        by_stream[str(r.get("stream"))].append(r)
    streams: dict[str, dict[str, Any]] = {}
    problems: list[str] = list(shape_errors)
    expected = list(expected_streams)
    if not expected:
        problems.append("the run manifest names no stream")
    for name in expected:
        rows = sorted(by_stream.pop(name, []), key=lambda r: r.get("seq", 0))
        seqs = [r.get("seq") for r in rows]
        dropped = sum(int(r.get("count") or 0) for r in rows if r.get("kind") == "drop")
        ends = [r for r in rows if r.get("kind") == "stream_end"]
        s: list[str] = []
        if not rows:
            s.append("no records at all")
        elif seqs != list(range(1, len(seqs) + 1)):
            s.append(f"sequence gap or duplicate (have {len(seqs)} records, "
                     f"max seq {max(seqs)})")
        if dropped:
            s.append(f"{dropped} records dropped")
        if len(ends) != 1:
            s.append(f"{len(ends)} stream_end records (want exactly 1)")
        elif ends[0] is not rows[-1]:
            s.append("records after stream_end")
        elif not ends[0].get("clean"):
            s.append("stream ended unclean (unflushed tail)")
        elif ends[0].get("last_seq") != seqs[-1]:
            s.append("stream_end.last_seq does not match the last record")
        streams[name] = {"records": len(rows), "dropped": dropped, "problems": s}
        problems += [f"{name}: {p}" for p in s]
    for name in by_stream:
        problems.append(f"{name}: a stream the manifest does not name")
    return {"complete": not problems, "streams": streams, "problems": problems}
