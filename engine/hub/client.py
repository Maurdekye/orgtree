"""Synchronous v2 hub client with a durable offline spool.

The engine can call this client from its own worker.  A send first validates
and copies attachment files into the v2 data root, then attempts delivery.  A
transport failure leaves the complete entry on disk for ``flush``; it never
pretends that a send succeeded merely because a local listener exists.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class HubClientError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class AttachmentPathError(HubClientError):
    pass


_SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, attachments TEXT NOT NULL,
  created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt REAL, state TEXT NOT NULL DEFAULT 'queued', last_error TEXT
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, envelope TEXT NOT NULL, received_at TEXT NOT NULL
);
"""


def _validate_root(value: str | os.PathLike[str]) -> Path:
    root = Path(value).expanduser().resolve()
    if not root.is_absolute() or root == Path(root.anchor):
        raise ValueError("data_root must be an explicit non-root directory")
    root.mkdir(parents=True, exist_ok=True)
    return root


class HubClient:
    def __init__(self, data_root: str | os.PathLike[str], hub_url: str, slug: str, secret: str, instance_token: str, peer_token: bool = False):
        if not re.fullmatch(r"^[a-z0-9][a-z0-9._-]{0,127}$", slug):
            raise ValueError("malformed slug")
        parsed = urllib.parse.urlparse(hub_url.rstrip("/"))
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("hub_url must be an HTTP(S) URL")
        self.root = _validate_root(data_root)
        self.hub_url = hub_url.rstrip("/")
        self.slug = slug
        self.secret = secret
        if len(instance_token) < 32:
            raise ValueError("instance_token is required")
        self.instance_token = instance_token
        self.peer_token = peer_token
        self.db_path = self.root / "mail.sqlite3"
        self.blob_root = self.root / "mail-blobs"
        self.blob_root.mkdir(exist_ok=True)
        with self._db() as con:
            con.executescript(_SCHEMA)
            try:
                con.execute("ALTER TABLE outbox ADD COLUMN next_attempt REAL")
            except sqlite3.OperationalError:
                pass
            try:
                con.execute("ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'queued'")
            except sqlite3.OperationalError:
                pass
            con.commit()

    @contextmanager
    def _db(self) -> Any:
        con = sqlite3.connect(self.db_path, timeout=5.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=5000")
        try:
            yield con
        finally:
            con.close()

    @property
    def auth(self) -> str:
        return f"{self.slug}:{self.secret}"

    def _request(self, method: str, path: str, body: Any = None, raw: bytes | None = None, query: dict[str, str] | None = None) -> Any:
        url = self.hub_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"X-Org-Auth": self.auth, ("X-Hub-Peer-Token" if self.peer_token else "X-Hub-Token"): self.instance_token}
        data = raw
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        timeout = 3.0
        if urllib.parse.urlparse(url).path == "/api/poll":
            wait = float(urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("wait", ["0"])[0])
            timeout = max(timeout, wait + 2.0)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content = response.read()
                if response.headers.get_content_type() == "application/json":
                    return json.loads(content.decode("utf-8") or "{}")
                return content
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("detail", str(exc))
            except Exception:
                detail = str(exc)
            raise HubClientError(str(detail), exc.code) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise HubClientError(f"hub transport unavailable: {type(exc).__name__}") from exc

    def register(self, org_name: str = "", username: str = "", blurb: str = "") -> dict[str, Any]:
        return self._request("POST", "/api/register", {"slug": self.slug, "org_name": org_name, "username": username, "blurb": blurb})

    def roster(self) -> dict[str, Any]:
        return self._request("GET", "/api/roster")

    def unregister(self) -> dict[str, Any]:
        return self._request("POST", "/api/unregister")

    def _stage_attachments(self, entry_id: str, paths: list[str | os.PathLike[str]]) -> list[dict[str, str]]:
        staged: list[dict[str, str]] = []
        entry_root = self.blob_root / entry_id
        for source in paths:
            original = Path(source).expanduser()
            # Do not follow a symlink supplied as an attachment path.  The
            # caller must explicitly provide a regular file in its own tree.
            if original.is_symlink() or not original.is_file():
                raise AttachmentPathError(f"attachment is not a regular file: {original}")
            try:
                resolved = original.resolve(strict=True)
            except OSError as exc:
                raise AttachmentPathError(f"attachment cannot be resolved: {original}") from exc
            if resolved == self.root or not resolved.is_file():
                raise AttachmentPathError(f"attachment is not a regular file: {original}")
            try:
                size = resolved.stat().st_size
            except OSError as exc:
                raise AttachmentPathError(f"attachment cannot be read: {original}") from exc
            if size > 25 * 1024 * 1024:
                raise AttachmentPathError(f"attachment exceeds 25 MB: {original}")
            entry_root.mkdir(parents=True, exist_ok=True)
            staged_path = entry_root / secrets.token_hex(16)
            shutil.copyfile(resolved, staged_path)
            staged.append({"name": os.path.basename(resolved)[:255] or "file", "path": str(staged_path)})
        return staged

    def send(self, to: str, body: str, *, message_id: str | None = None, kind: str | None = None, thread_id: str | None = None, sent_at: str | None = None, attachments: list[str | os.PathLike[str]] | None = None) -> dict[str, Any]:
        entry_id = message_id or secrets.token_hex(16)
        staged = self._stage_attachments(entry_id, list(attachments or []))
        payload = {"id": entry_id, "from": self.slug, "to": to, "body": body, "kind": kind, "thread_id": thread_id, "sent_at": sent_at}
        with self._db() as con:
            con.execute("INSERT OR REPLACE INTO outbox (id,payload,attachments,created_at,attempts,next_attempt,state,last_error) VALUES (?,?,?,?,0,NULL,'queued',NULL)", (entry_id, json.dumps(payload), json.dumps(staged), _now()))
            con.commit()
        try:
            result = self._deliver(entry_id, payload, staged)
        except HubClientError as exc:
            state = self._record_attempt(entry_id, str(exc), permanent=exc.status is not None)
            return {"id": entry_id, "state": state, "error": str(exc)}
        self._remove_outbox(entry_id, staged)
        return {"id": entry_id, "state": "sent", **result}

    def _deliver(self, entry_id: str, payload: dict[str, Any], attachments: list[dict[str, str]]) -> dict[str, Any]:
        remote_ids: list[str] = []
        for item in attachments:
            remote_id = str(item.get("remote_id") or "")
            if not remote_id:
                data = Path(item["path"]).read_bytes()
                result = self._request("POST", "/api/attachments?" + urllib.parse.urlencode({"name": item["name"], "owner": self.slug}), raw=data)
                remote_id = str(result["id"])
                item["remote_id"] = remote_id
                self._save_attachments(entry_id, attachments)
            remote_ids.append(remote_id)
        return self._request("POST", "/api/send", {**payload, "attachments": remote_ids})

    def _save_attachments(self, entry_id: str, attachments: list[dict[str, str]]) -> None:
        with self._db() as con:
            con.execute("UPDATE outbox SET attachments=? WHERE id=?", (json.dumps(attachments), entry_id))
            con.commit()

    def _record_attempt(self, entry_id: str, error: str, permanent: bool = False) -> str:
        with self._db() as con:
            row = con.execute("SELECT attempts FROM outbox WHERE id=?", (entry_id,)).fetchone()
            attempts = int(row["attempts"] if row else 0) + 1
            state = "dead_letter" if permanent and attempts >= 5 else "queued"
            delay = min(30.0, 2.0 ** attempts) if permanent else 0.0
            con.execute("UPDATE outbox SET attempts=?,next_attempt=?,state=?,last_error=? WHERE id=?", (attempts, time.time() + delay, state, error[:500], entry_id))
            con.commit()
            return state

    def _remove_outbox(self, entry_id: str, attachments: list[dict[str, str]]) -> None:
        with self._db() as con:
            con.execute("DELETE FROM outbox WHERE id=?", (entry_id,))
            con.commit()
        for item in attachments:
            try:
                Path(item["path"]).unlink()
            except FileNotFoundError:
                pass
        try:
            Path(attachments[0]["path"]).parent.rmdir() if attachments else None
        except OSError:
            pass

    def flush(self) -> list[dict[str, Any]]:
        delivered: list[dict[str, Any]] = []
        with self._db() as con:
            rows = con.execute("SELECT * FROM outbox WHERE state='queued' AND (next_attempt IS NULL OR next_attempt<=?) ORDER BY created_at,id", (time.time(),)).fetchall()
        for row in rows:
            payload = json.loads(row["payload"])
            attachments = json.loads(row["attachments"])
            try:
                result = self._deliver(row["id"], payload, attachments)
            except (HubClientError, OSError, KeyError, json.JSONDecodeError) as exc:
                self._record_attempt(row["id"], str(exc), permanent=isinstance(exc, HubClientError) and exc.status is not None)
                continue
            self._remove_outbox(row["id"], attachments)
            delivered.append({"id": row["id"], "state": "sent", **result})
        return delivered

    def poll_once(self, wait: float = 0.0) -> list[dict[str, Any]]:
        result = self._request("POST", "/api/poll", query={"wait": str(max(0.0, min(wait, 55.0)))})
        messages = list(result.get("messages") or [])
        ack_ids: list[str] = []
        returned: list[dict[str, Any]] = []
        with self._db() as con:
            for message in messages:
                mid = str(message.get("id") or "")
                if not mid:
                    continue
                stored = dict(message)
                local_attachments: list[dict[str, Any]] = []
                failed_attachment = False
                destination = self.blob_root / "inbox" / mid
                used_names: set[str] = set()
                for attachment in list(message.get("attachments") or []):
                    meta = dict(attachment)
                    name = os.path.basename(str(meta.get("name") or "file")).replace("\x00", "")[:255] or "file"
                    stem, suffix = os.path.splitext(name)
                    candidate, index = name, 1
                    while candidate in used_names:
                        candidate = f"{stem}-{index}{suffix}"
                        index += 1
                    used_names.add(candidate)
                    try:
                        content = self._request("GET", f"/api/attachments/{meta['id']}")
                        if not isinstance(content, bytes):
                            raise HubClientError("attachment response was not binary")
                        destination.mkdir(parents=True, exist_ok=True)
                        target = destination / candidate
                        target.write_bytes(content)
                        meta["path"] = str(target)
                    except (HubClientError, OSError, KeyError) as exc:
                        meta["error"] = str(exc)[:200]
                        failed_attachment = True
                    local_attachments.append(meta)
                stored["attachments"] = local_attachments
                returned.append(stored)
                if failed_attachment:
                    # The hub keeps the message queued.  Remove partial local
                    # delivery so a retry can produce one complete envelope.
                    shutil.rmtree(destination, ignore_errors=True)
                    continue
                # INSERT happens before ACK.  A duplicate is still safe and
                # receives custody acknowledgement, but is never re-delivered.
                con.execute("INSERT OR IGNORE INTO inbox (id,envelope,received_at) VALUES (?,?,?)", (mid, json.dumps(stored), _now()))
                ack_ids.append(mid)
            con.commit()
        if ack_ids:
            self._request("POST", "/api/ack", {"ids": ack_ids})
        return returned

    def inbox(self) -> list[dict[str, Any]]:
        with self._db() as con:
            return [json.loads(row["envelope"]) for row in con.execute("SELECT envelope FROM inbox ORDER BY received_at,id").fetchall()]

    def send_receipts(self, receipts: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request("POST", "/api/receipts", {"receipts": receipts})


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
