"""Retry a request ONCE when a REUSED keep-alive connection is reset first.

Attempt 6 failed its workload on three client ReadErrors (WinError 10054)
that came back in about 1 ms with no HTTP status. The coordinator's rule
(2026-09-28): retry once, and only when (a) the connection was reused from
the pool, not freshly opened for this request, and (b) no response headers
arrived. Anything else raises exactly as before. Every retry is returned to
the caller so it is recorded and counted, never hidden: the resets may be a
real engine bug that real agents' tool calls can hit too.
"""
import time

import httpx

RESET_ERRORS = (httpx.ReadError, httpx.WriteError, httpx.RemoteProtocolError)


def post_retry_reused_reset(client, url, **kw):
    """Return ``(response, reset)``; ``reset`` is None or a dict describing the retry."""
    events = []
    begun = time.time()
    try:
        return client.post(url, extensions={"trace": lambda name, info: events.append(name)}, **kw), None
    except RESET_ERRORS as exc:
        fresh = any(name.startswith("connection.connect_tcp") for name in events)
        answered = "http11.receive_response_headers.complete" in events
        if fresh or answered:
            raise
        reset = {"err": f"{type(exc).__name__}: {exc}"[:200],
                 "ms": round((time.time() - begun) * 1000, 1)}
    try:
        return client.post(url, **kw), reset
    except Exception as exc:
        exc.scale_reset = reset       # the caller still records the first reset
        raise
