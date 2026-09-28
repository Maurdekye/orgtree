"""conn_reset: retry ONCE, only for a reused keep-alive connection reset before any response."""
import socket
import struct
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "scale"))

import httpx  # noqa: E402

from conn_reset import post_retry_reused_reset  # noqa: E402


class ScriptedServer:
    """Answers each request by the next scripted action: ok, rst or headers_then_rst."""

    def __init__(self, actions):
        self.actions = list(actions)
        self.requests = 0
        self.connections = 0
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.url = f"http://127.0.0.1:{self.sock.getsockname()[1]}"
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    @staticmethod
    def rst(conn):
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        conn.close()

    def handle(self, conn):
        buf = b""
        while True:
            while b"\r\n\r\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    conn.close()
                    return
                buf += chunk
            head, buf = buf.split(b"\r\n\r\n", 1)
            length = 0
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":")[1])
            while len(buf) < length:
                buf += conn.recv(65536)
            buf = buf[length:]
            self.requests += 1
            action = self.actions.pop(0) if self.actions else "ok"
            if action == "rst":
                self.rst(conn)
                return
            if action == "headers_then_rst":
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"par")
                self.rst(conn)
                return
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}")

    def close(self):
        self.sock.close()


class ConnResetTest(unittest.TestCase):
    def run_script(self, actions):
        server = ScriptedServer(actions)
        self.addCleanup(server.close)
        client = httpx.Client(base_url=server.url, timeout=5)
        self.addCleanup(client.close)
        return server, client

    def test_reused_connection_reset_is_retried_once_and_reported(self):
        server, client = self.run_script(["ok", "rst", "ok"])
        first, reset = post_retry_reused_reset(client, "/x", json={})
        self.assertIsNone(reset)
        response, reset = post_retry_reused_reset(client, "/x", json={})
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(reset)
        self.assertIn("Error", reset["err"])
        self.assertEqual(server.requests, 3)
        self.assertEqual(server.connections, 2)

    def test_fresh_connection_reset_is_not_retried(self):
        server, client = self.run_script(["rst", "ok"])
        with self.assertRaises(httpx.TransportError):
            post_retry_reused_reset(client, "/x", json={})
        self.assertEqual(server.requests, 1)

    def test_reset_after_response_headers_is_not_retried(self):
        server, client = self.run_script(["ok", "headers_then_rst", "ok"])
        post_retry_reused_reset(client, "/x", json={})
        with self.assertRaises(httpx.TransportError):
            post_retry_reused_reset(client, "/x", json={})
        self.assertEqual(server.requests, 2)

    def test_failed_retry_raises_and_still_carries_the_first_reset(self):
        server, client = self.run_script(["ok", "rst", "rst"])
        post_retry_reused_reset(client, "/x", json={})
        with self.assertRaises(httpx.TransportError) as caught:
            post_retry_reused_reset(client, "/x", json={})
        self.assertIsNotNone(getattr(caught.exception, "scale_reset", None))
        self.assertEqual(server.requests, 3)


class MutatingAndKeepAlive(unittest.TestCase):
    def test_mutating_reset_is_never_resent_but_is_counted(self):
        server = ScriptedServer(["ok", "rst", "ok"])
        self.addCleanup(server.close)
        client = httpx.Client(base_url=server.url, timeout=5)
        self.addCleanup(client.close)
        post_retry_reused_reset(client, "/x", json={}, retry=False)
        with self.assertRaises(httpx.TransportError) as caught:
            post_retry_reused_reset(client, "/x", json={}, retry=False)
        self.assertEqual(caught.exception.scale_reset["retried"], False)
        self.assertEqual(server.requests, 2)       # the write was NOT sent again

    def test_idle_connection_expires_before_the_server_closes_it(self):
        from conn_reset import KEEPALIVE_EXPIRY_S, keepalive_limits
        self.assertLess(KEEPALIVE_EXPIRY_S, 5.0)   # uvicorn closes idle keep-alive at 5 s
        server = ScriptedServer([])
        self.addCleanup(server.close)
        client = httpx.Client(base_url=server.url, timeout=5, limits=keepalive_limits())
        self.addCleanup(client.close)
        client.post("/x", json={})
        time.sleep(0.3)
        client.post("/x", json={})
        self.assertEqual(server.connections, 1)    # reused while fresh
        time.sleep(KEEPALIVE_EXPIRY_S + 0.5)
        client.post("/x", json={})
        self.assertEqual(server.connections, 2)    # expired, not reused


if __name__ == "__main__":
    unittest.main()
