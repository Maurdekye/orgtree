"""Transport only: never import the engine or normalize its answers."""
from __future__ import annotations

import json
import queue
import subprocess
import threading
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self):
        return json.loads(self.body)


class Stdio:
    """One persistent MCP process; every line and response stays observable."""

    def __init__(self, command, *, env, cwd):
        self.process = subprocess.Popen(command, cwd=cwd, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True,
                                        encoding="utf-8")
        self.lines = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.lines.put(line)
        finally:
            self.lines.put(None)

    def send(self, value):
        self.send_raw(json.dumps(value))

    def send_raw(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def receive(self, timeout=8):
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError("MCP response deadline expired") from None
        if line is None:
            raise AssertionError("MCP closed before its response")
        return json.loads(line)

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class LoopbackTransport:
    """Target factories own endpoint, credentials and process lifecycle.

    No CLI switch accepts a running endpoint. A factory must provision the
    disposable fixture before handing these transports to the assertions.
    """

    def http(self, path, *, method="GET", payload=None, raw=None,
             auth="operator", org="wire-actions", headers=None):
        if payload is not None and raw is not None:
            raise ValueError("choose JSON payload or raw body")
        request_headers = {"Content-Type": "application/json",
                           **self.auth_headers(auth, org), **(headers or {})}
        data = json.dumps(payload).encode() if payload is not None else raw
        request = Request(self.url + path, data=data, method=method, headers=request_headers)
        # Do not send test credentials through an inherited HTTP proxy.
        try:
            answer = build_opener(ProxyHandler({})).open(request, timeout=8)
        except HTTPError as error:
            answer = error
        with answer:
            return Response(answer.status,
                            {key.lower(): value for key, value in answer.headers.items()},
                            answer.read())

    def websocket(self, *, auth="operator", org="wire-actions"):
        from websockets.sync.client import connect
        return connect(self.url.replace("http:", "ws:") + f"/api/orgs/{org}/ws",
                       additional_headers=self.auth_headers(auth, org),
                       open_timeout=8, close_timeout=3, proxy=None)
