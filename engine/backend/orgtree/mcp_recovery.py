"""Claude's local MCP health, independent of provider turns and tool mutations."""
from __future__ import annotations

import json
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
            was_failed = bool(self.failure)
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
            newly_failed = bool(self.failure) and not was_failed
        if newly_failed and self.on_failure is not None:
            self.on_failure()
        return own

    def broken(self) -> bool:
        with self.lock:
            return bool(self.failure)


def attach(proc: Any, send: Callable[[str], None],
           on_failure: Callable[[], None] | None = None) -> Monitor:
    """A local control probe, never initialize, prompt, reconnect or tool call."""
    existing = getattr(proc, "_orgtree_mcp_monitor", None)
    if isinstance(existing, Monitor):
        return existing
    monitor = Monitor(on_failure)
    proc._orgtree_mcp_monitor = monitor

    def run() -> None:
        # Let the CLI's own startup proceed. Pending/unsupported is unknown.
        while not monitor.stopped.wait(5.0):
            if proc.poll() is not None:
                return
            try:
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
        if not monitor.failure or monitor.restarting:
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
        return {"reason": monitor.failure, "attempt": count + 1,
                "retry_after_s": delay, "session_id": sid,
                "pid": getattr(proc, "pid", None)}
