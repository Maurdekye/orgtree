"""Generate invented fixture data only, with fixed keys and no machine capture."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .formats import LEDGER_DDL, SIDECAR_DDL
from .legacy import DICT_LOGS, LIST_LOGS, encode, digest

SCENARIOS = ("ordinary", "sqlite", "large", "partial", "interrupted", "malformed")
MARKER = {"format": 1, "synthetic": True, "purpose": "migration-rehearsal"}


def document(slug, size=3, legacy=False):
    nodes = {}
    for i in range(size):
        name = f"agent-{i}"
        nodes[name] = {"session_id": f"synthetic-session-{slug}-{i}", "model": "luna",
                       "parent": None if i == 0 else "agent-0", "grant": 2,
                       "state": "archived" if i == size - 1 else "live",
                       "title": name, "charter": "Invented fixture: café / שלום",
                       "created": "2020-01-01T00:00:00Z", "archived_at": None,
                       "generation": 0, "seat_id": f"synthetic-seat-{slug}-{i}",
                       "scope": {"tools": {"bash": False, "web": False, "edit": False, "mcp": [], "subagents": False}}}
    # Old nodes may lack seat_id. Preserve absence, never mint a substitute.
    if legacy:
        nodes["agent-0"].pop("seat_id")
    mail = {"id": "original-mail-key", "from": "agent-0", "to": "agent-1",
            "body": "Invented pending mail", "at": "2020-01-01T00:00:01Z",
            "op_key": "original-operation-key", "transport_id": "original-transport-key"}
    item = {("id" if legacy else "slug"): ("w00000001" if legacy else "synthetic-work"),
            "title": "Synthetic work", "owner": {"node": "agent-1", "generation": 0,
            "born": nodes["agent-1"]["seat_id"]}, "status": "in_progress",
            "objective": "Invented description", "history": [{"op": "assign", "to": "agent-1"}],
            "scope": [{"seq": 1, "kind": "objective", "before": "Before", "after": "After"}],
            "holders": [{"node": "agent-0", "generation": 0}, {"node": "agent-1", "generation": 0}]}
    return {"version": 1, "slug": slug, "name": "Synthetic " + slug,
            "created": "2020-01-01T00:00:00Z", "nodes": nodes,
            "mail": {"agent-1": [mail]}, "mail_log": {"agent-0": [], "agent-1": [dict(mail, id="original-read-mail-key")]},
            "delivering": {"agent-1": [dict(mail, id="original-inflight-key")]},
            "steered_log": {}, "turn_error_log": {"agent-1": []},
            "steer_attempts": {"agent-1": {"original-attempt-key": {"resolved": False}}},
            "work_items": [item], "work_items_archive": [dict(item, **{("id" if legacy else "slug"): "archived-work", "status": "done"})],
            "events": [{"at": "2020-01-01T00:00:00Z", "op": "hire", "node": name} for name in nodes],
            "op_receipts": [{"key": "original-operation-key", "fingerprint": "original-fingerprint", "result": {"id": "original-mail-key"}}],
            "watchdogs": [{"id": "original-dog", "owner": "agent-1", "once": True, "state": "exited", "fired": 1}],
            "audiences": [{"grantee": "agent-1", "grantor": "agent-0", "target": "user"}],
            "net_spool": {"agent-1": [{"id": "original-transport-key", "ack": False}]}}


def write_ledger(path, doc, eager=False):
    conn = sqlite3.connect(path)
    try:
        conn.executescript(LEDGER_DDL)
        with conn:
            conn.execute("INSERT INTO meta VALUES ('schema_version','1')")
            conn.execute("INSERT INTO meta VALUES ('key_order',?)", (json.dumps(list(doc)),))
            for key, value in doc.items():
                if key == "nodes":
                    for order, (node, row) in enumerate(value.items()):
                        conn.execute("INSERT INTO nodes VALUES (?,?,?)", (node, order, json.dumps(row)))
                elif not eager and key in DICT_LOGS:
                    conn.execute("INSERT INTO meta VALUES (?,?)", ("owners:" + key, json.dumps(list(value))))
                    for owner, rows in value.items():
                        rows = list(rows.items()) if key == "steer_attempts" else rows
                        for row in rows:
                            conn.execute("INSERT INTO log_d(sect,owner,at,val) VALUES (?,?,?,?)", (key, owner, None, json.dumps(row)))
                elif not eager and key in LIST_LOGS:
                    for row in value:
                        conn.execute("INSERT INTO log_l(sect,at,val) VALUES (?,?,?)", (key, None, json.dumps(row)))
                else:
                    conn.execute("INSERT INTO doc VALUES (?,?)", (key, json.dumps(value)))
    finally:
        conn.close()


def write_sidecars(source):
    for filename, ddl in SIDECAR_DDL.items():
        conn = sqlite3.connect(source / filename)
        try:
            conn.executescript(ddl)
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            with conn:
                # Populate EVERY retained table, including transcript auxiliaries.
                for table in tables:
                    columns = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
                    values = []
                    for _, name, kind, *_ in columns:
                        value = 1 if "INT" in kind else 1.25 if "REAL" in kind else f"synthetic-{table}-{name}"
                        if name == "source":
                            value = "original-transcript-source"
                        if name == "body":
                            value = json.dumps({"id": "original-record-key", "text": "Invented retained record"})
                        values.append(value)
                    if table in ("operations", "dead_letters"):
                        values = [f"original-{table}-key", json.dumps({"id": f"original-{table}-key", "state": "completed", "published": False,
                                   "org": "alpha", "node": "agent-1", "seat_id": "synthetic-seat-alpha-1", "result": {"retained": True}})]
                    if table == "deliveries":
                        values = [digest(b"original-opaque-delivery-key"), "original-fingerprint", None]
                    if filename == "reply-events.sqlite3":
                        values = ["alpha", "agent-1", 0, "original-reply-id", "Immutable invented quote", "original-reply-scope"]
                    placeholders = ",".join("?" for _ in columns)
                    conn.execute(f'INSERT INTO "{table}" VALUES ({placeholders})', values)
                if filename == "tool-waits.db":
                    conn.execute("INSERT INTO operations VALUES (?,?)", ("original-running-key", json.dumps({"id": "original-running-key", "state": "running", "published": False})))
        finally:
            conn.close()


def create_fixture(root: Path, scenario="ordinary"):
    if scenario not in SCENARIOS:
        raise ValueError("unknown fixture scenario")
    if scenario == "interrupted":
        scenario = "partial"
    if list(root.iterdir()):
        raise ValueError("fixture creation requires an empty owned directory")
    (root / "synthetic.json").write_bytes(encode(MARKER))
    source = root / "source"
    (source / "orgs").mkdir(parents=True)
    slugs = ("alpha", "beta") if scenario in ("partial", "large") else ("alpha",)
    for slug in slugs:
        doc = document(slug, 500 if scenario == "large" else 3, legacy=scenario == "partial")
        if scenario == "sqlite" or (scenario == "partial" and slug == "alpha"):
            write_ledger(source / "orgs" / (slug + ".db"), doc, eager=scenario == "partial")
            (source / "orgs" / (slug + ".json.premigration")).write_bytes(encode(doc))
        else:
            (source / "orgs" / (slug + ".json")).write_bytes(encode(doc))
        transcript = source / "transcripts" / slug / "agent-1"
        transcript.mkdir(parents=True)
        transcript.joinpath("session.jsonl").write_bytes(b"".join(encode({"id": f"original-record-{i}", "type": "assistant", "body": "Invented text", "tool_call_id": f"original-tool-{i}"}) for i in range(500 if scenario == "large" else 3)))
        content = source / "content" / slug / "agent-1"
        content.mkdir(parents=True)
        content.joinpath("attachment.bin").write_bytes(b"\x00synthetic immutable bytes\xff")
    for filename, value in {
        "app-settings.json": {"version": 1, "providers": {"openai": False}},
        "desktop-settings.json": {"theme": "dark", "windows": []},
        "accounts-registry.json": {"version": 2, "accounts": [{"id": "synthetic-account", "credential_ref": "synthetic-reference-only"}]},
    }.items():
        (source / filename).write_bytes(encode(value))
    write_sidecars(source)
    if scenario == "malformed":
        (source / "orgs" / "alpha.json").write_bytes(b'{"nodes":')
    return source
