"""A FAKE store service on loopback sockets, wrapping ``fake_executor.FakeExecutor``.

Test scaffolding, NEVER product evidence. It gives ``service_channel.ServiceChannel``
real sockets to talk to without a database, and mirrors what WS2's service does
on the wire:
- the harness endpoint (``orgtree.p03-harness/v1``) answers ``hello`` with the
  handshake, installs ``plan`` frames (a refused plan is an ``error`` frame),
  forwards every ``arrived`` and ``error``, and answers ``finish`` with a
  ``finished`` frame that carries NO records (WS2's endpoint does the same today);
- the channel (``orgtree.p03-store/v1``) serves the fake's op kinds as verbs (one
  request blocks until that operation ends) and the host's ``qual.*`` verbs,
  like ``engine/native/store-trace/tests/live_order.rs``.

``host`` is the same dictionary ``live_order.rs`` writes to ``host.json``.
"""
from __future__ import annotations

import json
import secrets
import socket
import struct
import threading
from typing import Any

from .fake_executor import FakeExecutor
from .protocol import decode, encode


def _send(sock: socket.socket, obj: dict[str, Any]) -> None:
    body = json.dumps(obj).encode("utf-8")
    sock.sendall(struct.pack(">I", len(body)) + body)


def _recv(sock: socket.socket) -> "dict[str, Any] | None":
    head = b""
    while len(head) < 4:
        c = sock.recv(4 - len(head))
        if not c:
            return None
        head += c
    (n,) = struct.unpack(">I", head)
    body = b""
    while len(body) < n:
        c = sock.recv(n - len(body))
        if not c:
            return None
        body += c
    return json.loads(body.decode("utf-8"))


class FakeService:
    def __init__(self, fake: FakeExecutor) -> None:
        self.fake = fake
        self._main = socket.create_server(("127.0.0.1", 0))
        self._harness = socket.create_server(("127.0.0.1", 0))
        self.host = {"port": self._main.getsockname()[1], "token": secrets.token_hex(32),
                     "harness_port": self._harness.getsockname()[1],
                     "harness_token": secrets.token_hex(32), "org": "org-fake",
                     "principal": "agent-fake", "generation": 3, "pid": 0}
        self._hconn: "socket.socket | None" = None
        self._hlock = threading.Lock()
        self._drained = 0
        self._dlock = threading.Lock()
        self._ended = False
        self.stopped = threading.Event()
        for target in (self._serve_main, self._serve_harness, self._forward):
            threading.Thread(target=target, daemon=True).start()

    # -- harness endpoint -----------------------------------------------------
    def _hsend(self, frame: dict[str, Any]) -> None:
        with self._hlock:
            if self._hconn is not None:
                try:
                    self._hconn.sendall(encode(frame))
                except OSError:
                    pass

    def _forward(self) -> None:
        while not self.stopped.is_set():
            ev = self.fake.next_event(0.05)
            if ev is None:
                continue
            if ev.get("kind") == "arrived":
                self._hsend({"type": "arrived", **{k: ev.get(k) for k in (
                    "point", "op_tag", "operation_id", "attempt", "backend_pid",
                    "txid_if_assigned", "seq")}})
            elif ev.get("kind") == "error":
                self._hsend({"type": "error", "detail": ev.get("detail")})

    def _serve_harness(self) -> None:
        while not self.stopped.is_set():
            try:
                conn, _ = self._harness.accept()
            except OSError:
                return
            buf = b""
            try:
                hello = None
                while hello is None:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                    hello, buf = decode(buf)
                if not hello or hello.get("token") != self.host["harness_token"]:
                    conn.close()
                    continue
                conn.sendall(encode(self.fake.handshake()))
                with self._hlock:
                    self._hconn = conn
                while True:
                    frame, buf = decode(buf)
                    if frame is None:
                        chunk = conn.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
                        continue
                    kind = frame.get("type")
                    if kind == "plan":
                        try:
                            self.fake.install_plan(frame)
                        except ValueError as e:
                            self._hsend({"type": "error", "detail": str(e)})
                    elif kind == "release":
                        self.fake.release(frame["op_tag"], frame["point"], frame.get("attempt"))
                    elif kind == "finish":
                        self._hsend({"type": "finished", "streams": [], "records": []})
                    else:
                        self._hsend({"type": "error", "detail": f"unexpected frame {kind!r}"})
            except (OSError, ValueError):
                pass
            finally:
                with self._hlock:
                    self._hconn = None
                conn.close()

    # -- channel --------------------------------------------------------------
    def _serve_main(self) -> None:
        while not self.stopped.is_set():
            try:
                conn, _ = self._main.accept()
            except OSError:
                return
            threading.Thread(target=self._connection, args=(conn,), daemon=True).start()

    def _new_records(self) -> list[dict[str, Any]]:
        with self._dlock:
            recs = self.fake.stream.records[self._drained:]
            self._drained += len(recs)
            return list(recs)

    def _handle(self, req: dict[str, Any]) -> dict[str, Any]:
        verb = req.get("verb")
        if verb == "qual.reset":
            return {"stream": self.fake.stream.name}
        if verb in self.fake.op_kinds:
            tag = req["binding"]["op_tag"]
            self.fake._run(tag, verb, req.get("args") or {})
            ends = [r for r in self.fake.stream.records
                    if r.get("kind") == "op_end" and r.get("op_tag") == tag]
            return {"outcome": ends[-1]["outcome"] if ends else None}
        if verb == "qual.trace_drain":
            return {"records": self._new_records()}
        if verb == "qual.trace_end":
            if not self._ended:
                self._ended = True
                self.fake.finish()
            return {"records": self._new_records(), "stream": self.fake.stream.name}
        if verb == "qual.waits":
            return {"waits": self.fake.sample_waits()}
        if verb == "qual.state":
            return {"rows": dict(self.fake.rows)}
        if verb == "qual.stop":
            self.stopped.set()
            return {"stopping": True}
        return {"error": "unknown_verb", "verb": verb}

    def _connection(self, conn: socket.socket) -> None:
        try:
            hello = _recv(conn)
            if not hello or hello.get("hello") != self.host["token"]:
                return
            _send(conn, {"handshake": {"protocol": "orgtree.p03-store/v1", "qualification": True,
                                       "build_sha": "fake", "verbs": [], "points": [],
                                       "controls": []}})
            while True:
                req = _recv(conn)
                if req is None:
                    return
                _send(conn, self._handle(req))
        except OSError:
            pass
        finally:
            conn.close()

    def close(self) -> None:
        self.stopped.set()
        for s in (self._main, self._harness):
            s.close()

