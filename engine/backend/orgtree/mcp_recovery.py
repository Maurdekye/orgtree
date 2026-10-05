"""Claude's local MCP health, independent of provider turns and tool mutations."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Callable

PROBE_INTERVAL = 30.0
MAX_BACKOFF = 900.0
_lock = threading.Lock()
_retries: dict[tuple[str, str, str], tuple[int, float]] = {}


class Monitor:
    """Only explicit CLI health evidence can request recovery; silence cannot."""

    def __init__(self, on_failure: Callable[[], None] | None = None) -> None:
        self.on_failure = on_failure
        self.lock = threading.Lock()
        self.prefix = "orgtree-health-" + uuid.uuid4().hex + "-"
        self.pending: str | None = None
        self.failure = ""
        self.transport_failure = ""
        self.missing_since: float | None = None
        self.seen_orgtree = False
        self.stopped = threading.Event()
        self.restarting = False

    def probe(self, send: Callable[[str], None]) -> None:
        rid = self.prefix + uuid.uuid4().hex
        with self.lock:
            self.pending = rid
        send(json.dumps({"type": "control_request", "request_id": rid,
                         "request": {"subtype": "mcp_status"}}) + "\n")

    def observe(self, event: Any) -> bool:
        """Consume our control reply so it cannot acknowledge unread mail."""
        if not isinstance(event, dict):
            return False
        with self.lock:
            was_failed = bool(self.failure or self.transport_failure)
            servers = None
            own = False
            if event.get("type") == "control_response":
                response = event.get("response")
                if not isinstance(response, dict):
                    return False
                rid = response.get("request_id")
                if not isinstance(rid, str) or not rid.startswith(self.prefix):
                    return False
                if rid != self.pending:
                    return True  # a late probe is still never prompt consumption
                self.pending = None
                own = True
                body = response.get("response")
                if response.get("subtype") == "success" and isinstance(body, dict):
                    servers = body.get("mcpServers")
            elif event.get("type") == "system" and event.get("subtype") == "init":
                servers = event.get("mcp_servers")
            elif event.get("type") == "attachment":
                attachment = event.get("attachment")
                if isinstance(attachment, dict) and attachment.get("type") == "deferred_tools_delta":
                    failed = attachment.get("failedMcpServers")
                    has_failure = isinstance(failed, list) and any(
                        isinstance(server, dict) and server.get("name") == "orgtree"
                        for server in failed)
                    if has_failure:
                        self.transport_failure = "orgtree MCP disconnected (CLI tool delta)"
                    else:
                        for field in ("addedNames", "readdedNames"):
                            added = attachment.get(field)
                            if isinstance(added, list) and any(
                                    isinstance(name, str) and name.startswith("mcp__orgtree__")
                                    for name in added):
                                self.transport_failure = self.failure = ""
            # Do not scan assistant text or tool results for error strings.
            if isinstance(servers, list):
                found = False
                for server in servers:
                    if not isinstance(server, dict) or server.get("name") != "orgtree":
                        continue
                    found = self.seen_orgtree = True
                    status = server.get("status")
                    if not isinstance(status, str):
                        continue
                    if status in {"failed", "disconnected"}:
                        self.failure = "orgtree MCP " + status
                    elif status == "connected":
                        self.failure = ""
                if own and self.seen_orgtree and not found:
                    self.failure = "orgtree MCP missing"
            newly_failed = bool(self.failure or self.transport_failure) and not was_failed
        if newly_failed and self.on_failure is not None:
            self.on_failure()
        return own

    def broken(self) -> bool:
        with self.lock:
            return bool(self.failure or self.transport_failure)

    def check_transport(self, proc: Any, now: float | None = None) -> None:
        """The CLI can report connected after its stdio child has exited."""
        present = stdio_child_present(proc)
        at = time.monotonic() if now is None else now
        notify = False
        with self.lock:
            if present is True:
                self.missing_since = None
                if self.transport_failure == "orgtree MCP stdio child exited":
                    self.transport_failure = ""
            elif present is False and self.seen_orgtree:
                if self.missing_since is None:
                    self.missing_since = at
                elif at - self.missing_since >= PROBE_INTERVAL:
                    notify = not (self.failure or self.transport_failure)
                    self.transport_failure = "orgtree MCP stdio child exited"
        if notify and self.on_failure is not None:
            self.on_failure()


def stdio_child_present(proc: Any) -> bool | None:
    """Inspect only this CLI's descendants; denied/incomplete scans are unknown."""
    try:
        import psutil
    except ImportError:
        return None
    try:
        if proc.poll() is not None:
            return None
        for child in psutil.Process(proc.pid).children(recursive=True):
            args = child.cmdline()
            if any(args[i:i + 2] == ["-m", "orgtree.mcptool"]
                   for i in range(len(args) - 1)):
                return True
        return False
    except (OSError, psutil.Error):
        return None


class TranscriptTail:
    """Read only new CLI-owned attachment records, never old session failures."""

    def __init__(self, resolve: Callable[[], str | None]) -> None:
        self.resolve = resolve
        self.path = self._resolve()
        self.offset = 0
        self.pending = b""
        self.discarding = False
        if self.path:
            try:
                self.offset = os.path.getsize(self.path)
            except OSError:
                self.path = None

    def _resolve(self) -> str | None:
        try:
            return self.resolve()
        except Exception:  # optional observation must never prevent CLI startup
            return None

    def read(self, monitor: Monitor) -> None:
        try:
            if self.path is None:
                self.path = self._resolve()
            if not self.path:
                return
            size = os.path.getsize(self.path)
            if size < self.offset:
                # A rewritten transcript is not a fresh disconnect event.
                self.offset, self.pending = size, b""
                self.discarding = False
                return
            if size == self.offset:
                return
            with open(self.path, "rb") as stream:
                stream.seek(self.offset)
                chunk = stream.read(1024 * 1024)
                self.offset = stream.tell()
            parts = (self.pending + chunk).split(b"\n")
            self.pending = parts.pop()
            for raw in parts:
                if self.discarding:
                    self.discarding = False
                    continue
                if b'deferred_tools_delta' not in raw:
                    continue
                try:
                    event = json.loads(raw)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(event, dict) and event.get("type") == "attachment":
                    monitor.observe(event)
            if len(self.pending) >= 1024 * 1024:
                self.pending = b""
                self.discarding = True
        except OSError:
            return


def attach(proc: Any, send: Callable[[str], None],
           on_failure: Callable[[], None] | None = None,
           transcript: Callable[[], str | None] | None = None) -> Monitor:
    """A local control probe, never initialize, prompt, reconnect or tool call."""
    existing = getattr(proc, "_orgtree_mcp_monitor", None)
    if isinstance(existing, Monitor):
        return existing
    monitor = Monitor(on_failure)
    proc._orgtree_mcp_monitor = monitor
    tail = TranscriptTail(transcript) if transcript is not None else None

    def run() -> None:
        # Let the CLI's own startup proceed. Pending/unsupported is unknown.
        while not monitor.stopped.wait(5.0):
            if proc.poll() is not None:
                return
            try:
                if tail is not None:
                    tail.read(monitor)
                monitor.check_transport(proc)
                monitor.probe(send)
            except (OSError, ValueError, AttributeError):
                return
            if monitor.stopped.wait(PROBE_INTERVAL - 5.0):
                return

    threading.Thread(target=run, daemon=True, name="orgtree-mcp-health").start()
    return monitor


def observe_line(proc: Any, line: str) -> bool:
    monitor = getattr(proc, "_orgtree_mcp_monitor", None)
    if not isinstance(monitor, Monitor):
        return False
    try:
        event = json.loads(line)
    except ValueError:
        return False
    return monitor.observe(event)


def stop(proc: Any) -> None:
    monitor = getattr(proc, "_orgtree_mcp_monitor", None)
    if isinstance(monitor, Monitor):
        monitor.stopped.set()


def reserve(slug: str, nid: str, sid: str, proc: Any,
            now: float | None = None) -> dict[str, Any] | None:
    """Called only at a safe boundary. One request per generation, bounded retry."""
    monitor = getattr(proc, "_orgtree_mcp_monitor", None)
    if not isinstance(monitor, Monitor):
        return None
    at = time.monotonic() if now is None else now
    with monitor.lock, _lock:
        if not (monitor.failure or monitor.transport_failure) or monitor.restarting:
            return None
        key = (slug, nid, sid)
        count, due = _retries.get(key, (0, 0.0))
        if at < due:
            return None
        # A long stable interval resets the escalation, not one healthy ping.
        if at > due + MAX_BACKOFF:
            count = 0
        delay = min(MAX_BACKOFF, 30.0 * 2 ** min(count, 5))
        _retries[key] = (count + 1, at + delay)
        monitor.restarting = True
        return {"reason": monitor.transport_failure or monitor.failure, "attempt": count + 1,
                "retry_after_s": delay, "session_id": sid,
                "pid": getattr(proc, "pid", None)}
