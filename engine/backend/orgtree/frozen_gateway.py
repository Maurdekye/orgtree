# pyright: strict
"""Fixed-upstream relay for frozen sandbox networks.

The agent container has no route outside its per-org Docker-internal network.
This process is the only dual-homed member and can talk only to the backend's
host bridge.  It intentionally is not a general HTTP proxy: absolute-form
targets, CONNECT, unknown paths, and every method except the three required
POST operations are rejected before an upstream socket is opened.

It is a standalone stdlib program because the sandbox image already contains
Python; the relay adds no package or image dependency to the frozen boundary.
"""

from __future__ import annotations

import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import re
import socket
from typing import ClassVar
from urllib.parse import SplitResult, urlsplit


_STEER = re.compile(
    r"^/api/orgs/[a-z0-9@-]+/nodes/[^/]+/steer$")
_ANTHROPIC = re.compile(
    # bridgeauth accepts at most 4096 token bytes. The fixed syntax consumes
    # 38 bytes outside the canonical base64url org payload.
    r"^/anthropic/otb1\.[A-Za-z0-9_-]{1,4058}\.[a-f0-9]{32}/v1/messages$")
_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
_MAX_BODY = 256 * 1024 * 1024


class _IncompleteBody(Exception):
    pass


def allowed_operation(method: str, target: str) -> bool:
    """Pure operation allowlist, intentionally easy to mutation-test."""
    if method != "POST":
        return False
    try:
        parsed = urlsplit(target)
    except ValueError:
        return False
    # An absolute-form request target is how a general forward proxy selects
    # another host.  Never accept one, even if its path looks sanctioned.
    if parsed.scheme or parsed.netloc or parsed.fragment:
        return False
    path = parsed.path
    return (path == "/api/agent"
            or _STEER.fullmatch(path) is not None
            or _ANTHROPIC.fullmatch(path) is not None)


class FrozenGatewayHandler(BaseHTTPRequestHandler):
    """HTTP/1.0 close-delimited streaming relay to one configured host."""

    protocol_version = "HTTP/1.0"
    upstream: ClassVar[SplitResult]

    def parse_request(self) -> bool:
        # BaseHTTPRequestHandler deliberately canonicalises a leading ``//``
        # to ``/`` before do_POST sees it.  That is reasonable for a web
        # server but turns a denied proxy-style spelling into an allowed
        # operation here. Preserve the wire target for authorization.
        try:
            parts = self.raw_requestline.decode("iso-8859-1").split()
            self.raw_target = parts[1] if len(parts) >= 2 else ""
        except UnicodeDecodeError:
            self.raw_target = ""
        return super().parse_request()

    def _answer(self, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _deny_method(self) -> None:
        self._answer(405, "operation not allowed by frozen gateway")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        target_text = getattr(self, "raw_target", self.path)
        if not allowed_operation("POST", target_text):
            self._answer(403, "path not allowed by frozen gateway")
            return
        if self.headers.get("Transfer-Encoding"):
            self._answer(400, "chunked request bodies are not accepted")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            self._answer(400, "multiple content lengths are not accepted")
            return
        raw_len = lengths[0] if lengths else "0"
        try:
            length = int(raw_len)
        except ValueError:
            self._answer(400, "invalid content length")
            return
        if length < 0 or length > _MAX_BODY:
            self._answer(413, "request body too large")
            return
        # RFC 7230: Connection may name additional hop-by-hop fields.
        connection_fields = {
            x.strip().lower()
            for value in self.headers.get_all("Connection", [])
            for x in value.split(",") if x.strip()
        }
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in _HOP | connection_fields
            and k.lower() not in {"host", "content-length", "expect"}
        }
        host = self.upstream.hostname
        assert host is not None                  # validated by configure()
        port = self.upstream.port
        assert port is not None                  # validated by configure()
        target = urlsplit(target_text)
        fixed_target = target.path + (("?" + target.query)
                                      if target.query else "")
        conn = http.client.HTTPConnection(host, port, timeout=600)
        response_started = False
        try:
            # Stream the request rather than holding a model prompt in the
            # relay's 128 MiB memory cgroup.  The declared length is preserved;
            # an early client close tears down the fixed upstream connection.
            self.connection.settimeout(30)
            conn.putrequest("POST", fixed_target)
            for k, v in headers.items():
                conn.putheader(k, v)
            conn.putheader("Content-Length", str(length))
            conn.endheaders()
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(64 * 1024, remaining))
                if not chunk:
                    raise _IncompleteBody
                conn.send(chunk)
                remaining -= len(chunk)
            upstream = conn.getresponse()
            response_started = True
            self.send_response(upstream.status, upstream.reason)
            response_connection = {
                x.strip().lower()
                for x in (upstream.getheader("Connection") or "").split(",")
                if x.strip()
            }
            for k, v in upstream.getheaders():
                if k.lower() not in _HOP | response_connection \
                        and k.lower() != "content-length":
                    self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except _IncompleteBody:
            if not response_started:
                self._answer(400, "incomplete request body")
        except (OSError, http.client.HTTPException) as e:
            # If no response has started, return an actionable gateway error.
            # A failure after streaming began is represented by the connection
            # closing; a second status line would corrupt the response.
            if not response_started:
                self._answer(502, f"host bridge unavailable: {e}")
        finally:
            conn.close()
            self.close_connection = True

    do_GET = _deny_method
    do_HEAD = _deny_method
    do_PUT = _deny_method
    do_DELETE = _deny_method
    do_PATCH = _deny_method
    do_OPTIONS = _deny_method
    do_CONNECT = _deny_method
    do_TRACE = _deny_method

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep Docker logs useful without leaking request paths, which carry a
        # bridge credential on the Anthropic operation.
        print(f"[frozen-gateway] request from {self.client_address[0]}",
              flush=True)


def configure(upstream: str) -> None:
    try:
        parsed = urlsplit(upstream)
    except ValueError as e:
        raise ValueError("--upstream must be a valid http origin") from e
    try:
        port = parsed.port
    except ValueError as e:
        raise ValueError("--upstream contains an invalid port") from e
    if parsed.scheme != "http" or not parsed.hostname or parsed.path not in ("", "/") \
            or parsed.query or parsed.fragment or parsed.username is not None \
            or port is None or not 1 <= port <= 65535:
        raise ValueError("--upstream must be one fixed http://host:port origin")
    FrozenGatewayHandler.upstream = parsed


def bind_address(host: str, port: int) -> str:
    """Resolve the private Docker alias without accepting a wildcard bind."""
    try:
        answers = socket.getaddrinfo(
            host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise ValueError("--bind must resolve to the private gateway address") \
            from e
    for answer in answers:
        addr = ipaddress.ip_address(answer[4][0])
        if addr.is_private and not addr.is_unspecified \
                and not addr.is_multicast:
            return str(addr)
    raise ValueError("--bind must resolve to a private, non-wildcard address")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--upstream", required=True)
    p.add_argument("--bind", required=True)
    p.add_argument("--port", required=True, type=int)
    args = p.parse_args()
    configure(args.upstream)
    server = ThreadingHTTPServer(
        (bind_address(args.bind, args.port), args.port), FrozenGatewayHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
