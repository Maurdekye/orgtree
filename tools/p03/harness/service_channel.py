"""A real ``schedule.Channel``: the harness endpoint and the channel of a live store service.

Two loopback connections, both length-prefixed JSON (``protocol.encode``/``decode``):

- the HARNESS endpoint (``orgtree.p03-harness/v1``, WS2's ``harness::serve``):
  ``hello`` -> ``handshake``; then ``plan``/``release``/``finish`` out, and
  ``arrived``/``error``/``finished`` in, read by one reader thread;
- the service CHANNEL (``orgtree.p03-store/v1``, WS2's ``server::serve``):
  ``{"hello": token}`` -> ``{"handshake": ...}``, then one request and one response
  at a time. Each started operation gets its own connection (a request blocks
  until the operation ends), and the harness's own control requests share one
  more, under a lock.

The service cannot yet return trace records in ``finished`` (WS2's endpoint
answers with empty lists), so the records come from the host's
``records_verb``/``end_verb`` (``tools/p03/probes/order_live_check.py`` hosts
``engine/native/store-trace/tests/live_order.rs``). A ``finished`` frame that does
carry records is used as well. Nothing here judges anything: ``schedule.run_order``
does.

Event mapping for the recorder: an ``arrived`` frame becomes ``kind: arrived``, an
``error`` frame becomes ``kind: error``, and every trace record is passed on as
soon as a drain finds it (after each operation's response, and before each wait
sample, so the recorder knows which backend pid runs which tagged operation
while it is still waiting).
"""
from __future__ import annotations

import json
import queue
import socket
import struct
import threading
import time
import uuid
from typing import Any

from .protocol import PROTOCOL, decode, encode, frame_errors

STORE_PROTOCOL = "orgtree.p03-store/v1"
MAX_FRAME = 16 * 1024 * 1024


def _send_raw(sock: socket.socket, obj: dict[str, Any]) -> None:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sock.sendall(struct.pack(">I", len(body)) + body)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("the service closed the connection")
        buf += chunk
    return buf


def _recv_raw(sock: socket.socket) -> dict[str, Any]:
    (n,) = struct.unpack(">I", _recv_exact(sock, 4))
    if n > MAX_FRAME:
        raise ValueError(f"frame of {n} bytes exceeds {MAX_FRAME}")
    return json.loads(_recv_exact(sock, n).decode("utf-8"))


class ChannelClient:
    """One authenticated connection to the service channel."""

    def __init__(self, port: int, token: str, timeout: float) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        _send_raw(self.sock, {"hello": token})
        hs = _recv_raw(self.sock).get("handshake")
        if not isinstance(hs, dict) or hs.get("protocol") != STORE_PROTOCOL:
            raise ConnectionError(f"not a {STORE_PROTOCOL} handshake: {hs!r}")
        self.handshake = hs

    def call(self, request: dict[str, Any]) -> dict[str, Any]:
        _send_raw(self.sock, request)
        return _recv_raw(self.sock)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class ServiceChannel:
    def __init__(self, host: dict[str, Any], *, run: str, timeout: float = 30.0,
                 records_verb: str = "qual.trace_drain", end_verb: str = "qual.trace_end",
                 waits_verb: "str | None" = "qual.waits", state_verb: "str | None" = "qual.state",
                 reset_verb: "str | None" = "qual.reset", wait_sample_s: float = 0.05) -> None:
        self.host = host
        self.timeout = timeout
        self.records_verb, self.end_verb = records_verb, end_verb
        self.waits_verb, self.state_verb = waits_verb, state_verb
        self.wait_sample_s = wait_sample_s
        self._events: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self._finished: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self._records: list[dict[str, Any]] = []
        self._seen: set[tuple[Any, Any]] = set()
        self._ctl_lock = threading.Lock()
        self._rec_lock = threading.Lock()
        self._hsend = threading.Lock()
        self._threads: list[threading.Thread] = []
        self.responses: dict[str, dict[str, Any]] = {}
        self.stream: "str | None" = None
        self._last_wait_sample = 0.0
        self.ctl = ChannelClient(host["port"], host["token"], timeout)
        if reset_verb:
            r = self._ctl(reset_verb, {"run": run})
            if "error" in r:
                raise RuntimeError(f"{reset_verb} failed: {r}")
            self.stream = r.get("stream")
        # the harness endpoint last: WS2 serves one harness connection at a time,
        # and a plan lives exactly as long as this connection
        self.hsock = socket.create_connection(("127.0.0.1", host["harness_port"]), timeout=timeout)
        self.hsock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.hsock.sendall(encode({"type": "hello", "token": host["harness_token"],
                                   "protocol": PROTOCOL}))
        self._hbuf = b""
        self._handshake = self._read_harness_frame()
        errors = frame_errors(self._handshake)
        if self._handshake.get("type") != "handshake" or errors:
            raise ConnectionError(f"bad harness handshake: {errors or self._handshake}")
        self.hsock.settimeout(None)
        reader = threading.Thread(target=self._reader, daemon=True)
        reader.start()

    # -- plumbing -------------------------------------------------------------
    def _read_harness_frame(self) -> dict[str, Any]:
        while True:
            frame, self._hbuf = decode(self._hbuf)
            if frame is not None:
                return frame
            chunk = self.hsock.recv(65536)
            if not chunk:
                raise ConnectionError("the harness endpoint closed the connection")
            self._hbuf += chunk

    def _reader(self) -> None:
        try:
            while True:
                frame = self._read_harness_frame()
                kind = frame.get("type")
                if kind == "arrived":
                    self._events.put({**frame, "kind": "arrived"})
                elif kind == "error":
                    self._events.put({"kind": "error", "detail": frame.get("detail")})
                elif kind == "finished":
                    self._finished.put(frame)
                else:
                    self._events.put({"kind": "error",
                                      "detail": f"unexpected harness frame {kind!r}"})
        except (ConnectionError, OSError, ValueError) as e:
            self._finished.put({"type": "closed", "detail": str(e)})

    def _request(self, verb: str, args: dict[str, Any], *, key: "str | None" = None,
                 op_tag: "str | None" = None) -> dict[str, Any]:
        return {"verb": verb, "org": self.host["org"], "args": args,
                "binding": {"principal_kind": "agent", "principal": self.host["principal"],
                            "generation": self.host["generation"], "acting": None,
                            "key": key, "op_tag": op_tag}}

    def _ctl(self, verb: str, args: "dict[str, Any] | None" = None) -> dict[str, Any]:
        with self._ctl_lock:
            return self.ctl.call(self._request(verb, args or {}))

    def _absorb_records(self, records: list[dict[str, Any]]) -> None:
        with self._rec_lock:          # operation threads and the harness thread both drain
            for r in records:
                k = (r.get("stream"), r.get("seq"))
                if k in self._seen:   # a finished frame may repeat what a drain returned
                    continue
                self._seen.add(k)
                self._records.append(r)
                self._events.put(r)

    def _drain(self) -> None:
        r = self._ctl(self.records_verb)
        if "error" in r:
            self._events.put({"kind": "error", "detail": f"{self.records_verb}: {r}"})
            return
        self._absorb_records(r.get("records", []))

    def _run_op(self, tag: str, op_kind: str, args: dict[str, Any]) -> None:
        client = None
        try:
            client = ChannelClient(self.host["port"], self.host["token"], self.timeout)
            client.sock.settimeout(None)   # an operation may be held for as long as the plan says
            key = args.get("key") or f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:24]}"
            call_args = {k: v for k, v in args.items() if k != "key"}
            resp = client.call(self._request(op_kind, call_args, key=key, op_tag=tag))
            self.responses[tag] = resp
            if "error" in resp:
                self._events.put({"kind": "error", "detail": f"{tag} ({op_kind}): {resp}"})
            self._drain()
        except (ConnectionError, OSError, ValueError) as e:
            self._events.put({"kind": "error", "detail": f"{tag} ({op_kind}): {e}"})
        finally:
            if client is not None:
                client.close()

    # -- the Channel protocol -------------------------------------------------
    def handshake(self) -> dict[str, Any]:
        return self._handshake

    def install_plan(self, plan: dict[str, Any]) -> None:
        with self._hsend:
            self.hsock.sendall(encode(plan))
        # WS2 installs a plan asynchronously and answers only with an error frame;
        # give the reader a moment so a refused plan fails the run before any start
        time.sleep(0.1)

    def start(self, tag: str, op_kind: str, args: dict[str, Any]) -> None:
        t = threading.Thread(target=self._run_op, args=(tag, op_kind, args), daemon=True)
        self._threads.append(t)
        t.start()

    def next_event(self, timeout: float) -> "dict[str, Any] | None":
        try:
            return self._events.get(timeout=timeout)
        except queue.Empty:
            return None

    def release(self, tag: str, point: str, attempt: "int | None" = None) -> None:
        frame: dict[str, Any] = {"type": "release", "op_tag": tag, "point": point}
        if attempt is not None:
            frame["attempt"] = attempt
        with self._hsend:
            self.hsock.sendall(encode(frame))

    def sample_waits(self) -> list[dict[str, Any]]:
        if not self.waits_verb:
            return []
        now = time.monotonic()
        if now - self._last_wait_sample < self.wait_sample_s:
            return []
        self._last_wait_sample = now
        self._drain()
        r = self._ctl(self.waits_verb)
        return list(r.get("waits") or [])

    def kill_backend(self, pid: int) -> bool:
        """Harness-side kill (M1 §3), through the host's ``qual.kill`` verb."""
        r = self._ctl("qual.kill", {"pid": pid})
        if r.get("terminated") is not True:
            self._events.put({"kind": "error", "detail": f"qual.kill {pid}: {r}"})
            return False
        return True

    def finish(self) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout
        for t in self._threads:
            t.join(max(0.0, deadline - time.monotonic()))
        stuck = [t for t in self._threads if t.is_alive()]
        with self._hsend:
            self.hsock.sendall(encode({"type": "finish"}))
        try:
            finished = self._finished.get(timeout=max(1.0, deadline - time.monotonic()))
        except queue.Empty:
            finished = {"type": "missing"}
        events: list[dict[str, Any]] = []
        if stuck:
            events.append({"kind": "error", "detail": f"{len(stuck)} operation(s) never returned"})
        if finished.get("type") != "finished":
            events.append({"kind": "error", "detail": f"no finished frame: {finished}"})
        self._absorb_records(finished.get("records") or [])
        end = self._ctl(self.end_verb)
        if "error" in end:
            events.append({"kind": "error", "detail": f"{self.end_verb}: {end}"})
        self._absorb_records(end.get("records", []))
        while True:
            try:
                events.append(self._events.get_nowait())
            except queue.Empty:
                break
        streams = list(finished.get("streams") or []) or [end.get("stream") or self.stream]
        state = self._ctl(self.state_verb) if self.state_verb else {}
        return {"type": "finished", "records": list(self._records), "streams": streams,
                "events": events, "state": state, "responses": dict(self.responses)}

    def close(self) -> None:
        for s in (self.hsock,):
            try:
                s.close()
            except OSError:
                pass
        self.ctl.close()
