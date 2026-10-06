"""A Claude CLI may persist; its authenticated MCP child never crosses a run.

Control replies belong to this local handoff, never to mail delivery. Every
failure leaves the caller responsible for discarding the CLI before cold spawn.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
import hashlib
import json
import os
import threading
import time
import uuid
from typing import Any, Callable

from .orgdb import turn_context, turn_requests

READY_ENV = 'ORGTREE_TRANSPORT_READY'
READY_TOOL = 'orgtree_transport_ready'
TIMEOUT = 15.0


def digest(tools: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(tools, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False).encode()).hexdigest()


@dataclass
class Pending:
    run: turn_context.Run
    ready: threading.Event = field(default_factory=threading.Event)
    tools_digest: str = ''
    pid: int = 0


_lock = threading.Lock()
_pending: dict[str, Pending] = {}


def acknowledge(run: turn_context.Run | None, args: dict[str, Any]) -> dict[str, Any]:
    """Called ONLY after the ordinary agent credential/run/halt gates."""
    nonce, value, pid = args.get('nonce'), args.get('tools_digest'), args.get('pid')
    with _lock:
        pending = _pending.get(nonce) if isinstance(nonce, str) else None
        if (pending is None or run != pending.run or pending.ready.is_set()
                or not isinstance(value, str) or len(value) != 64
                or type(pid) is not int or pid <= 0):
            raise ValueError('transport acknowledgement does not match its admitted run')
        pending.tools_digest, pending.pid = value, pid
        pending.ready.set()
    return {'transport_ready': True}


def child_ready(post: Callable[..., tuple[str, str]], org: str, node: str,
                tools: list[dict[str, Any]]) -> None:
    """An immutable child authenticates before answering its MCP initialize."""
    nonce = os.environ.get(READY_ENV)
    if not nonce:
        return
    kind, body = post({'org': org, 'node': node, 'tool': READY_TOOL,
                       'args': {'nonce': nonce, 'tools_digest': digest(tools),
                                'pid': os.getpid()}}, timeout=TIMEOUT)
    if kind != 'ok' or json.loads(body).get('transport_ready') is not True:
        raise RuntimeError('new MCP transport was not authenticated')


class Rotation:
    def __init__(self, proc: Any, send: Callable[[str], Any]) -> None:
        self.proc, self.send = proc, send
        self.stage = 'idle'
        self.lock = threading.Lock()
        self.waiters: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self.prefix = 'orgtree-transport-' + uuid.uuid4().hex + '-'
        self.run: turn_context.Run | None = None
        self.finished = True
        self.tool_ids: set[str] = set()
        self.background: set[str] = set()
        self.background_unknown = False
        self.tainted = False
        self.servers: dict[str, Any] = {}
        self.tools_digest: str | None = None
        self.child: Any = None
        self.process_baseline: set[tuple[int, float]] = set()

    def descendants(self) -> set[tuple[int, float]]:
        import psutil
        return {(p.pid, p.create_time())
                for p in psutil.Process(self.proc.pid).children(recursive=True)}

    def drained_descendants(self, allowed: set[tuple[int, float]]) -> set[tuple[int, float]]:
        """Wait briefly for control cleanup workers; never adopt their identities."""
        import psutil
        current = self.descendants()
        deadline = time.monotonic() + 2.0
        for pid, birth in current - allowed:
            try:
                proc = psutil.Process(pid)
                if proc.create_time() != birth:
                    continue
                proc.wait(timeout=max(0.0, deadline - time.monotonic()))
            except psutil.NoSuchProcess:
                pass
            except psutil.TimeoutExpired:
                break
        return self.descendants()

    def observe(self, line: str) -> bool:
        try:
            event = json.loads(line)
        except ValueError:
            return False
        if not isinstance(event, dict):
            return False
        response = event.get('response')
        if event.get('type') == 'control_response' and isinstance(response, dict):
            rid = response.get('request_id')
            if isinstance(rid, str) and rid.startswith(self.prefix):
                with self.lock:
                    waiter = self.waiters.get(rid)
                    if waiter is not None:
                        waiter[1].update(response)
                        waiter[0].set()
                return True  # late replies cannot acknowledge a new prompt
        with self.lock:
            if self.run is None:
                return False
            kind = event.get('type')
            if self.finished and kind in ('assistant', 'user'):
                self.tainted = True
            if kind in ('assistant', 'user'):
                message = event.get('message')
                if not isinstance(message, dict):
                    self.tainted = True
                    return False
                content = message.get('content')
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get('type') == 'tool_use':
                            identity = block.get('id')
                            if isinstance(identity, str) and identity:
                                self.tool_ids.add(identity)
                            else:
                                self.tainted = True
                        elif block.get('type') == 'tool_result':
                            self.tool_ids.discard(str(block.get('tool_use_id') or ''))
            if kind == 'system' and event.get('subtype') == 'background_tasks_changed':
                tasks = event.get('tasks')
                if not isinstance(tasks, list):
                    self.tainted = True
                else:
                    self.background_unknown = False
                    self.background = {str(t.get('task_id') or '?') for t in tasks
                                       if isinstance(t, dict)}
                    if len(self.background) != len(tasks):
                        self.tainted = True
            if kind == 'system' and event.get('subtype') == 'task_started':
                # Only the CLI's next full snapshot can establish quiescence;
                # completion notifications can be delayed and do not clear it.
                self.background_unknown = True
        return False

    def request(self, body: dict[str, Any]) -> dict[str, Any]:
        rid = self.prefix + uuid.uuid4().hex
        ready, result = threading.Event(), {}
        with self.lock:
            self.waiters[rid] = (ready, result)
        try:
            self.send(json.dumps({'type': 'control_request', 'request_id': rid,
                                  'request': body}) + '\n')
            if not ready.wait(TIMEOUT) or result.get('subtype') != 'success':
                raise RuntimeError('Claude transport control was not acknowledged')
            value = result.get('response')
            if not isinstance(value, dict) or value.get('errors'):
                raise RuntimeError('Claude transport control failed')
            return value
        finally:
            with self.lock:
                self.waiters.pop(rid, None)

    def begin(self, run: turn_context.Run, host: Any,
              servers: dict[str, Any], check: Callable[[], None]) -> None:
        """An old claim must be durably closed before the new child is born."""
        self.stage = 'quiescence'
        check()
        with self.lock:
            if (not self.finished or self.tainted or self.tool_ids
                    or self.background or self.background_unknown):
                raise RuntimeError('Claude has unfinished work from its previous run')
        if self.run is not None:
            self.stage = 'prior-run-fence'
            try:
                host.authorize(self.run)
            except turn_requests.StaleRun:
                pass
            else:
                raise RuntimeError('previous Claude run is still authorized')
        host.authorize(run)
        before = self.descendants()
        if self.run is not None and before - self.process_baseline:
            raise RuntimeError('unknown child appeared while Claude was parked')
        nonce = uuid.uuid4().hex
        pending = Pending(run)
        chosen = copy.deepcopy(servers)
        chosen['orgtree']['env'].update({turn_context.ENV: host.credential(run),
                                        READY_ENV: nonce})
        with _lock:
            _pending[nonce] = pending
        try:
            self.stage = 'replace-child'
            self.request({'subtype': 'mcp_set_servers', 'servers': chosen})
            self.stage = 'authenticate-child'
            if not pending.ready.wait(TIMEOUT):
                raise RuntimeError('new MCP transport did not authenticate')
            if self.tools_digest is not None and self.tools_digest != pending.tools_digest:
                raise RuntimeError('MCP tool catalogue changed between turns')
            # Confirm this acknowledgement came from our own living child.
            self.stage = 'verify-child'
            import psutil
            child = psutil.Process(pending.pid)
            if self.proc.pid not in {p.pid for p in child.parents()}:
                raise RuntimeError('MCP transport is not a child of this Claude CLI')
            identity = (pending.pid, child.create_time())
            # Windows creates a console host for the authenticated Python child.
            # Only that child's own console host is part of the replacement;
            # sibling shells/control cleanup workers must actually disappear.
            replacement = {identity}
            for console in child.children(recursive=False):
                if getattr(console, 'name', lambda: '')().lower() == 'conhost.exe':
                    replacement.add((console.pid, console.create_time()))
            self.drained_descendants(before | replacement)
            check()
            host.authorize(run)
            baseline = self.descendants()
            if baseline - before - replacement:
                raise RuntimeError('unknown child appeared during Claude transport rotation')
            self.child, self.servers = child, copy.deepcopy(servers)
            self.tools_digest = pending.tools_digest
            monitor = getattr(self.proc, '_orgtree_mcp_monitor', None)
            if monitor is not None:
                with monitor.lock:
                    monitor.pending = None  # discard probes from the removed child
                    monitor.failure = monitor.transport_failure = ''
                    monitor.missing_since = None
            with self.lock:
                if self.tainted or self.tool_ids or self.background or self.background_unknown:
                    raise RuntimeError('late work arrived during Claude transport rotation')
                self.process_baseline = baseline
                self.run, self.finished = run, False
                self.stage = 'serving'
        finally:
            with _lock:
                _pending.pop(nonce, None)

    def end(self, *, result_ok: bool, tasks: int, bg_tasks: int,
            check: Callable[[], None]) -> bool:
        """Drain and remove the immutable old child before parking the CLI."""
        self.stage = 'drain-child'
        check()
        if self.descendants() - self.process_baseline:
            return False  # an untracked shell/child outlived its tool result
        with self.lock:
            if (not result_ok or tasks or bg_tasks or self.tainted
                    or self.tool_ids or self.background or self.background_unknown):
                return False
            self.finished = True
        others = {k: v for k, v in self.servers.items() if k != 'orgtree'}
        self.request({'subtype': 'mcp_set_servers', 'servers': others})
        if self.child is not None:
            # Connection removal is not proof the subprocess actually died.
            import psutil
            try:
                self.child.wait(timeout=2)
            except psutil.TimeoutExpired:
                return False
        if self.drained_descendants(self.process_baseline) - self.process_baseline:
            return False  # recheck after the potentially slow drain and exit
        check()
        if self.descendants() - self.process_baseline:
            return False
        with self.lock:
            if self.tainted or self.tool_ids or self.background or self.background_unknown:
                return False
        return True
