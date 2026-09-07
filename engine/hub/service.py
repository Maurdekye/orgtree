"""A small integrated v2 mail hub.

The v1 hub is a separately hosted UI/API service.  v2 deliberately keeps only
its correspondence transport semantics: authenticated registrations,
durable at-least-once queueing, idempotent sends, custody ACKs, receipts and
file-backed attachments. This module is an engine-owned service with a
loopback default; an explicitly configured authenticated peer bind is also
supported. It has no UI and is not a Docker entrypoint.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import ssl
import stat
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS orgs (
  slug TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, org_name TEXT NOT NULL,
  username TEXT NOT NULL, blurb TEXT NOT NULL, registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
  body TEXT NOT NULL, kind TEXT, thread_id TEXT, sent_at TEXT,
  received_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  fetched_at TEXT, delivered_at TEXT, read_at TEXT,
  receipts_pushed INTEGER NOT NULL DEFAULT 1, attachments TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_to_state ON messages(to_slug, state);
CREATE INDEX IF NOT EXISTS messages_from_receipts ON messages(from_slug, receipts_pushed);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, name TEXT NOT NULL,
  bytes INTEGER NOT NULL, created_at TEXT NOT NULL, message_id TEXT
);
CREATE TABLE IF NOT EXISTS peers (
  peer_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  bound_slug TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
"""
_MAX_BODY = 20_000
_MAX_ATTACHMENT = 25 * 1024 * 1024
_MAX_ATTACHMENTS = 10


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _safe_name(name: str) -> str:
    # Attachment names are display metadata only; never permit a path to cross
    # the blob root or to be used as a filesystem destination.
    value = os.path.basename(name).replace("\x00", "")[:255]
    return value or "file"


@dataclass(frozen=True)
class HubReadiness:
    host: str
    port: int
    data_root: str
    readiness_path: str
    pid: int
    token: str
    tls: bool = False
    tls_ca_file: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ready": True,
            "protocol": 1,
            "host": self.host,
            "port": self.port,
            "data_root": self.data_root,
            "pid": self.pid,
            "token": self.token,
            "tls": self.tls,
            "tls_ca_file": self.tls_ca_file,
        }


class _HubServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], root: Path, token: str):
        super().__init__(address, _HubHandler)
        self.root = root
        self.instance_token = token
        self.hub_name = os.environ.get("ORGTREE_HUB_NAME", "orgtree-v2-hub")
        self.retention_days = None  # user-visible history is retained; only ACKed transport blobs may be cleaned
        self.db_path = root / "hub.sqlite3"
        self.blob_root = root / "blobs"
        self.blob_root.mkdir(parents=True, exist_ok=True)
        with self.db() as con:
            con.executescript(_SCHEMA)

    def cleanup_acked_attachments(self, con: sqlite3.Connection, message_ids: list[str]) -> None:
        """Remove only transport blob copies after recipient custody ACK."""
        for message_id in message_ids:
            rows = con.execute("SELECT id FROM attachments WHERE message_id=?", (message_id,)).fetchall()
            for row in rows:
                try:
                    self.blob_path(str(row["id"])).unlink()
                except (FileNotFoundError, ValueError):
                    pass

    @contextmanager
    def db(self) -> Any:
        con = sqlite3.connect(self.db_path, timeout=5.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=5000")
        con.execute("PRAGMA synchronous=NORMAL")
        try:
            yield con
        finally:
            con.close()

    def blob_path(self, attachment_id: str) -> Path:
        # IDs are generated locally; reject anything that is not an ID-shaped
        # value before it can become a path even if a caller is compromised.
        if not re.fullmatch(r"[0-9a-f]{32}", attachment_id):
            raise ValueError("invalid attachment id")
        return self.blob_root / attachment_id


class _HubHandler(BaseHTTPRequestHandler):
    server: _HubServer
    peer_binding: str | None = None
    peer_bindings: set[str] = set()

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
        raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def _error(self, status: int, detail: str) -> None:
        self._send(status, {"detail": detail})

    def _require_access(self) -> bool:
        self.peer_binding = None
        self.peer_bindings = set()
        local = self.headers.get("X-Hub-Token", "")
        if local and hmac.compare_digest(local, self.server.instance_token):
            return True
        supplied_values = self.headers.get_all("X-Hub-Peer-Token", [])
        supplied_tokens = [token for value in supplied_values for token in value.split()]
        if supplied_tokens:
            with self.server.db() as con:
                fingerprints = [_fingerprint(token) for token in supplied_tokens]
                marks = ",".join("?" for _ in fingerprints)
                rows = con.execute(
                    f"SELECT bound_slug FROM peers WHERE fingerprint IN ({marks}) AND revoked_at IS NULL",
                    fingerprints,
                ).fetchall()
            if rows:
                self.peer_bindings = {str(row["bound_slug"]) for row in rows}
                # Keep the singular field for the existing peer-management
                # checks; a multiplexed request is represented by the set.
                self.peer_binding = next(iter(self.peer_bindings)) if len(self.peer_bindings) == 1 else None
                return True
        self._error(401, "invalid hub access token")
        return False

    def _json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2 * 1024 * 1024:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(value, dict):
            raise ValueError("body must be an object")
        return value

    def _auth(self, con: sqlite3.Connection) -> list[str]:
        result: list[str] = []
        for pair in self.headers.get("X-Org-Auth", "").split():
            slug, separator, secret = pair.partition(":")
            if not separator or not slug or not secret:
                continue
            row = con.execute("SELECT fingerprint FROM orgs WHERE slug=?", (slug,)).fetchone()
            if row and hmac.compare_digest(str(row["fingerprint"]), _fingerprint(secret)):
                result.append(slug)
        return result

    def _mark_seen(self, con: sqlite3.Connection, slugs: list[str]) -> None:
        now = _now()
        for slug in slugs:
            con.execute("UPDATE orgs SET last_seen=? WHERE slug=?", (now, slug))

    def _roster(self, con: sqlite3.Connection) -> list[dict[str, Any]]:
        return [{"slug": row["slug"], "org_name": row["org_name"], "username": row["username"], "blurb": row["blurb"], "online": True, "last_seen": row["last_seen"]} for row in con.execute("SELECT slug,org_name,username,blurb,last_seen FROM orgs ORDER BY slug").fetchall()]

    def _envelope(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "from": row["from_slug"],
            "to": row["to_slug"],
            "body": row["body"],
            "kind": row["kind"],
            "thread_id": row["thread_id"],
            "sent_at": row["sent_at"],
            "received_at": row["received_at"],
            "attachments": json.loads(row["attachments"] or "[]"),
        }

    def do_GET(self) -> None:  # noqa: N802
        if not self._require_access():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            with self.server.db() as con:
                orgs = con.execute("SELECT COUNT(*) AS n FROM orgs").fetchone()["n"]
                queued = con.execute("SELECT COUNT(*) AS n FROM messages WHERE state='queued'").fetchone()["n"]
            self._send(200, {"ok": True, "name": self.server.hub_name, "orgs": orgs, "queued": queued, "retention_days": self.server.retention_days})
            return
        if parsed.path.startswith("/api/attachments/"):
            self._download(parsed.path.rsplit("/", 1)[-1])
            return
        if parsed.path == "/api/roster":
            with self.server.db() as con:
                slugs = self._authorized(con)
                if slugs:
                    self._mark_seen(con, slugs)
                    con.commit()
                    self._send(200, {"name": self.server.hub_name, "roster": self._roster(con)})
            return
        self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._require_access():
                return
            route = urlparse(self.path).path
            if route == "/api/register":
                self._register()
            elif route == "/api/unregister":
                self._unregister()
            elif route == "/api/peers":
                self._create_peer()
            elif route == "/api/send":
                self._send_message()
            elif route == "/api/poll":
                self._poll()
            elif route == "/api/ack":
                self._ack()
            elif route == "/api/receipts":
                self._receipts()
            elif route == "/api/attachments":
                self._upload()
            else:
                self._error(404, "not found")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(400, str(exc))
        except sqlite3.Error:
            self._error(503, "hub storage unavailable")

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._require_access() or self.peer_bindings:
            if self.peer_bindings:
                self._error(403, "peer tokens cannot manage peers")
            return
        peer_id = urlparse(self.path).path.rsplit("/", 1)[-1]
        with self.server.db() as con:
            changed = con.execute("UPDATE peers SET revoked_at=? WHERE peer_id=? AND revoked_at IS NULL", (_now(), peer_id)).rowcount
            con.commit()
        self._send(200, {"revoked": changed == 1, "peer_id": peer_id})

    def _register(self) -> None:
        body = self._json()
        slug = str(body.get("slug") or "").strip()
        if not _SLUG.fullmatch(slug):
            self._error(422, "malformed slug")
            return
        supplied = {p.partition(":")[0]: p.partition(":")[2] for p in self.headers.get("X-Org-Auth", "").split()}
        secret = supplied.get(slug, "")
        if not secret:
            self._error(401, "registration requires X-Org-Auth")
            return
        if self.peer_bindings and slug not in self.peer_bindings:
            self._error(403, "peer token is bound to another identity")
            return
        now = _now()
        with self.server.db() as con:
            row = con.execute("SELECT fingerprint FROM orgs WHERE slug=?", (slug,)).fetchone()
            fp = _fingerprint(secret)
            if row and not hmac.compare_digest(str(row["fingerprint"]), fp):
                self._error(403, "slug is owned by another identity")
                return
            if row:
                con.execute("UPDATE orgs SET org_name=?, username=?, blurb=?, last_seen=? WHERE slug=?", (str(body.get("org_name") or ""), str(body.get("username") or ""), str(body.get("blurb") or ""), now, slug))
            else:
                con.execute("INSERT INTO orgs VALUES (?,?,?,?,?,?,?)", (slug, fp, str(body.get("org_name") or ""), str(body.get("username") or ""), str(body.get("blurb") or ""), now, now))
            con.commit()
            roster = self._roster(con)
        self._send(200, {"ok": True, "name": self.server.hub_name, "retention_days": self.server.retention_days, "slug": slug, "roster": roster})

    def _create_peer(self) -> None:
        if self.peer_bindings:
            self._error(403, "peer tokens cannot create peers")
            return
        body = self._json()
        peer_id = str(body.get("peer_id") or "").strip()
        bound_slug = str(body.get("slug") or "").strip()
        if not re.fullmatch(r"[a-zA-Z0-9._-]{1,128}", peer_id) or not _SLUG.fullmatch(bound_slug):
            self._error(422, "malformed peer binding")
            return
        token = secrets.token_urlsafe(32)
        with self.server.db() as con:
            if con.execute("SELECT 1 FROM peers WHERE peer_id=?", (peer_id,)).fetchone():
                self._error(409, "peer id already exists; choose a new id")
                return
            con.execute("INSERT INTO peers (peer_id,fingerprint,bound_slug,created_at,revoked_at) VALUES (?,?,?,?,NULL)", (peer_id, _fingerprint(token), bound_slug, _now()))
            con.commit()
        self._send(200, {"peer_id": peer_id, "slug": bound_slug, "peer_token": token})

    def _unregister(self) -> None:
        with self.server.db() as con:
            slugs = self._authorized(con)
            if not slugs:
                return
            marks = ",".join("?" for _ in slugs)
            con.execute(f"DELETE FROM orgs WHERE slug IN ({marks})", slugs)
            con.commit()
        self._send(200, {"unregistered": slugs})

    def _authorized(self, con: sqlite3.Connection) -> list[str]:
        slugs = self._auth(con)
        if self.peer_bindings:
            slugs = [slug for slug in slugs if slug in self.peer_bindings]
        if not slugs:
            self._error(401, "no valid org credentials")
        return slugs

    def _send_message(self) -> None:
        body = self._json()
        to = str(body.get("to") or "").strip()
        with self.server.db() as con:
            slugs = self._authorized(con)
            if not slugs:
                return
            sender = str(body.get("from") or (slugs[0] if slugs else ""))
            if sender not in slugs:
                self._error(401, "sender credentials required")
                return
            if self.peer_bindings and sender not in self.peer_bindings:
                self._error(403, "peer token is bound to another identity")
                return
            if not con.execute("SELECT 1 FROM orgs WHERE slug=?", (to,)).fetchone():
                self._error(422, "recipient is not registered")
                return
            message_id = str(body.get("id") or secrets.token_hex(16))
            if not re.fullmatch(r"[0-9A-Za-z_-][0-9A-Za-z._-]{0,199}", message_id):
                self._error(422, "malformed message id")
                return
            attachment_ids = [str(x) for x in (body.get("attachments") or [])]
            if len(attachment_ids) > _MAX_ATTACHMENTS:
                self._error(422, "too many attachments")
                return
            metas: list[dict[str, Any]] = []
            for aid in attachment_ids:
                row = con.execute("SELECT id,name,bytes,owner_slug,message_id FROM attachments WHERE id=?", (aid,)).fetchone()
                # A v1 net.py client may multiplex identities in one auth
                # header and uploads under the first identity.  It is allowed
                # to send as any other identity it proved in that same call;
                # an unrelated caller still cannot bind the blob.
                if not row or row["owner_slug"] not in slugs or (row["message_id"] and row["message_id"] != message_id):
                    self._error(422, "unknown or already-bound attachment")
                    return
                metas.append({"id": row["id"], "name": row["name"], "bytes": row["bytes"]})
            text = str(body.get("body") or "")
            if len(text) > _MAX_BODY:
                self._error(413, f"body exceeds {_MAX_BODY} characters")
                return
            received = _now()
            cur = con.execute("INSERT OR IGNORE INTO messages (id,from_slug,to_slug,body,kind,thread_id,sent_at,received_at,attachments) VALUES (?,?,?,?,?,?,?,?,?)", (message_id, sender, to, text, body.get("kind"), body.get("thread_id"), body.get("sent_at"), received, json.dumps(metas)))
            fresh = cur.rowcount == 1
            if fresh:
                for aid in attachment_ids:
                    con.execute("UPDATE attachments SET message_id=? WHERE id=?", (message_id, aid))
            else:
                received = str(con.execute("SELECT received_at FROM messages WHERE id=?", (message_id,)).fetchone()["received_at"])
            self._mark_seen(con, [sender])
            con.commit()
        self._send(200, {"id": message_id, "received_at": received, "duplicate": not fresh})

    def _poll(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        wait = min(max(float(query.get("wait", ["0"])[0]), 0.0), 55.0)
        deadline = time.monotonic() + wait
        while True:
            with self.server.db() as con:
                slugs = self._authorized(con)
                if not slugs:
                    return
                marks = ",".join("?" for _ in slugs)
                rows = con.execute(f"SELECT * FROM messages WHERE state='queued' AND to_slug IN ({marks}) ORDER BY received_at,rowid", slugs).fetchall()
                receipts = con.execute(f"SELECT id,state,fetched_at,delivered_at,read_at FROM messages WHERE receipts_pushed=0 AND from_slug IN ({marks})", slugs).fetchall()
                if rows or receipts or time.monotonic() >= deadline:
                    if receipts:
                        ids = [r["id"] for r in receipts]
                        con.execute(f"UPDATE messages SET receipts_pushed=1 WHERE id IN ({','.join('?' for _ in ids)})", ids)
                    self._mark_seen(con, slugs)
                    con.commit()
                    self._send(200, {"name": self.server.hub_name, "messages": [self._envelope(row) for row in rows], "receipts": [{"id": r["id"], "state": "read" if r["read_at"] else "delivered" if r["delivered_at"] else "fetched" if r["fetched_at"] else "received", "fetched_at": r["fetched_at"], "delivered_at": r["delivered_at"], "read_at": r["read_at"]} for r in receipts], "roster": self._roster(con)})
                    return
            time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))

    def _ack(self) -> None:
        body = self._json()
        ids = [str(x) for x in (body.get("ids") or [])]
        with self.server.db() as con:
            slugs = self._authorized(con)
            if not slugs:
                return
            marks = ",".join("?" for _ in slugs)
            count = 0
            acknowledged: list[str] = []
            for mid in ids:
                changed = con.execute(f"UPDATE messages SET state='fetched',fetched_at=?,receipts_pushed=0 WHERE id=? AND state='queued' AND to_slug IN ({marks})", (_now(), mid, *slugs)).rowcount
                count += changed
                if changed:
                    acknowledged.append(mid)
            self.server.cleanup_acked_attachments(con, acknowledged)
            self._mark_seen(con, slugs)
            con.commit()
        self._send(200, {"acked": count})

    def _receipts(self) -> None:
        body = self._json()
        with self.server.db() as con:
            slugs = self._authorized(con)
            if not slugs:
                return
            marks = ",".join("?" for _ in slugs)
            recorded = 0
            for receipt in body.get("receipts") or []:
                state = str(receipt.get("state") or "")
                if state not in ("delivered", "read"):
                    continue
                column = "delivered_at" if state == "delivered" else "read_at"
                recorded += con.execute(f"UPDATE messages SET {column}=?,receipts_pushed=0 WHERE id=? AND {column} IS NULL AND to_slug IN ({marks})", (str(receipt.get("at") or _now()), str(receipt.get("id") or ""), *slugs)).rowcount
            self._mark_seen(con, slugs)
            con.commit()
        self._send(200, {"recorded": recorded})

    def _upload(self) -> None:
        with self.server.db() as con:
            slugs = self._authorized(con)
            if not slugs:
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                length = -1
            if length < 0:
                self._error(411, "Content-Length is required")
                return
            if length > _MAX_ATTACHMENT:
                self._error(413, "attachment too large")
                return
            attachment_id = secrets.token_hex(16)
            path = self.server.blob_path(attachment_id)
            query = parse_qs(urlparse(self.path).query)
            owner = query.get("owner", [slugs[0]])[0]
            if owner not in slugs:
                self._error(401, "attachment owner credentials required")
                return
            if self.peer_bindings and owner not in self.peer_bindings:
                self._error(403, "peer token is bound to another identity")
                return
            name = _safe_name(query.get("name", ["file"])[0])
            try:
                remaining, total = length, 0
                with path.open("wb") as blob:
                    while remaining:
                        chunk = self.rfile.read(min(64 * 1024, remaining))
                        if not chunk:
                            raise ValueError("truncated attachment")
                        blob.write(chunk)
                        total += len(chunk)
                        remaining -= len(chunk)
                con.execute("INSERT INTO attachments VALUES (?,?,?,?,?,NULL)", (attachment_id, owner, name, total, _now()))
                self._mark_seen(con, slugs)
                con.commit()
            except Exception:
                try:
                    path.unlink()
                except OSError:
                    pass
                raise
        self._send(200, {"id": attachment_id, "bytes": total, "name": name})

    def _download(self, attachment_id: str) -> None:
        try:
            path = self.server.blob_path(attachment_id)
        except ValueError:
            self._error(404, "no such attachment")
            return
        with self.server.db() as con:
            slugs = self._authorized(con)
            if not slugs:
                return
            row = con.execute("SELECT owner_slug,name,message_id FROM attachments WHERE id=?", (attachment_id,)).fetchone()
            if not row:
                self._error(404, "no such attachment")
                return
            allowed = row["owner_slug"] in slugs
            if not allowed and row["message_id"]:
                msg = con.execute("SELECT to_slug FROM messages WHERE id=?", (row["message_id"],)).fetchone()
                allowed = bool(msg and msg["to_slug"] in slugs)
            if not allowed:
                self._error(403, "not yours")
                return
            if not path.is_file():
                self._error(410, "blob expired")
                return
            data = path.read_bytes()
            self._mark_seen(con, slugs)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f"attachment; filename={json.dumps(str(row['name']))}")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class HubService:
    """Lifecycle owner used by the engine startup/shutdown coordinator."""

    def __init__(self, data_root: str | os.PathLike[str], host: str = "127.0.0.1", port: int = 0, advertise_host: str | None = None, tls_certfile: str | os.PathLike[str] | None = None, tls_keyfile: str | os.PathLike[str] | None = None, tls_ca_file: str | os.PathLike[str] | None = None):
        root = Path(data_root).expanduser().resolve()
        if not root.is_absolute() or root == Path(root.anchor):
            raise ValueError("data_root must be an explicit non-root directory")
        if host == "localhost":
            host = "127.0.0.1"
        if host != "0.0.0.0":
            try:
                ipaddress.ip_address(host)
            except ValueError as exc:
                raise ValueError("hub host must be an IP address") from exc
        if not 0 <= port <= 65535:
            raise ValueError("invalid port")
        if bool(tls_certfile) != bool(tls_keyfile):
            raise ValueError("tls_certfile and tls_keyfile must be provided together")
        self.tls_certfile = Path(tls_certfile).expanduser().resolve() if tls_certfile else None
        self.tls_keyfile = Path(tls_keyfile).expanduser().resolve() if tls_keyfile else None
        self.tls_ca_file = Path(tls_ca_file).expanduser().resolve() if tls_ca_file else None
        if self.tls_certfile and (not self.tls_certfile.is_file() or not self.tls_keyfile or not self.tls_keyfile.is_file()):
            raise ValueError("TLS certificate and key must be regular files")
        if self.tls_ca_file and not self.tls_ca_file.is_file():
            raise ValueError("TLS CA file must be a regular file")
        if not ipaddress.ip_address(host).is_loopback and not self.tls_certfile:
            raise ValueError("explicit non-loopback hub binds require TLS certificate and key")
        self.root = root / "hub"
        self.host = host
        self.advertise_host = advertise_host or ("127.0.0.1" if host == "0.0.0.0" else host)
        self.port = port
        self._server: _HubServer | None = None
        self._thread: threading.Thread | None = None
        self._readiness: HubReadiness | None = None

    @property
    def readiness_path(self) -> Path:
        return self.root / "readiness.json"

    @property
    def readiness(self) -> HubReadiness | None:
        return self._readiness

    def start(self) -> HubReadiness:
        if self._server is not None:
            if self._readiness is None:
                raise RuntimeError("hub has no readiness")
            return self._readiness
        self.root.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(32)
        server = _HubServer((self.host, self.port), self.root, token)
        if self.tls_certfile and self.tls_keyfile:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(self.tls_certfile), str(self.tls_keyfile))
            server.socket = context.wrap_socket(server.socket, server_side=True)
        self._server = server
        self.port = int(server.server_address[1])
        self._readiness = HubReadiness(self.advertise_host, self.port, str(self.root.parent), str(self.readiness_path), os.getpid(), token, bool(self.tls_certfile), str(self.tls_ca_file) if self.tls_ca_file else None)
        temporary = self.readiness_path.with_suffix(".tmp")
        try:
            temporary.write_text(json.dumps(self._readiness.as_dict()) + "\n", encoding="utf-8")
            os.replace(temporary, self.readiness_path)
            # POSIX honors this as owner-only (0600). Windows ignores these
            # permission bits, so callers must still treat the token as a
            # private same-user credential.
            os.chmod(self.readiness_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError as exc:
            if os.name == "nt":
                try:
                    subprocess.run(["icacls", str(self.readiness_path), "/reset"], capture_output=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
                except OSError:
                    pass
                for path in (self.readiness_path, temporary):
                    try:
                        path.unlink()
                    except FileNotFoundError:
                        pass
                    except OSError:
                        pass
                server.server_close()
                self._server = None
                self._thread = None
                self._readiness = None
                raise RuntimeError("could not set readiness file permissions") from exc
            raise
        try:
            if os.name == "nt":
                self._restrict_windows_readiness_acl()
        except BaseException:
            for path in (self.readiness_path, temporary):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
            server.server_close()
            self._server = None
            self._thread = None
            self._readiness = None
            raise
        self._thread = threading.Thread(target=server.serve_forever, name="orgtree-v2-hub", daemon=True)
        self._thread.start()
        return self._readiness

    def _restrict_windows_readiness_acl(self) -> None:
        """Remove inherited readiness ACLs and grant the current user full access.

        ``chmod`` does not restrict Windows ACLs.  ``icacls`` is already the
        project's supported Windows ACL mechanism (used by supervisor.py), and
        this operation targets only the generated readiness file.
        """
        try:
            principal = subprocess.check_output(
                ["whoami"],
                text=True,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=5,
            ).strip()
        except (OSError, subprocess.SubprocessError):
            username = os.environ.get("USERNAME", "").strip()
            domain = os.environ.get("USERDOMAIN", "").strip()
            principal = f"{domain}\\{username}" if domain else username
        if not principal:
            raise OSError("current Windows user is unavailable")
        result = subprocess.run(
            ["icacls", str(self.readiness_path), "/inheritance:r", "/grant:r", f"{principal}:F"],
            capture_output=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if result.returncode != 0:
            raise OSError("icacls could not restrict readiness permissions")

    def wait_ready(self, timeout: float = 5.0) -> HubReadiness:
        deadline = time.monotonic() + timeout
        while self._readiness is None and time.monotonic() < deadline:
            time.sleep(0.01)
        if self._readiness is None:
            raise TimeoutError("v2 hub did not become ready")
        return self._readiness

    def stop(self) -> None:
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        self._readiness = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)
        try:
            self.readiness_path.unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "HubService":
        self.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.stop()


HubLifecycle = HubService


def start_hub(data_root: str | os.PathLike[str], **kwargs: Any) -> HubService:
    service = HubService(data_root, **kwargs)
    service.start()
    return service


def discover_hub(data_root: str | os.PathLike[str]) -> HubReadiness:
    """Read and validate the current engine-owned dynamic endpoint."""
    root = Path(data_root).expanduser().resolve()
    path = root / "hub" / "readiness.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise RuntimeError("v2 hub is not ready") from exc
    if payload.get("protocol") != 1 or payload.get("ready") is not True:
        raise RuntimeError("invalid v2 hub readiness record")
    if payload.get("data_root") != str(root):
        raise RuntimeError("hub readiness belongs to a different data root")
    host, port = str(payload.get("host") or ""), int(payload.get("port") or 0)
    if not host or host in ("0.0.0.0", "::") or not 1 <= port <= 65535:
        raise RuntimeError("invalid advertised hub endpoint")
    token = str(payload.get("token") or "")
    if len(token) < 32:
        raise RuntimeError("invalid hub token")
    tls = bool(payload.get("tls", False))
    tls_ca_file = str(payload.get("tls_ca_file") or "") or None
    if tls_ca_file and not Path(tls_ca_file).is_file():
        raise RuntimeError("hub readiness references a missing TLS CA file")
    return HubReadiness(host, port, str(root), str(path), int(payload.get("pid") or 0), token, tls, tls_ca_file)
