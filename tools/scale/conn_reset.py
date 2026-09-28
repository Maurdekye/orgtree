"""Keep-alive reuse for the scale load clients, and the one allowed retry.

Attempt 6 failed its workload on three client ReadErrors (WinError 10054)
that came back in about 1 ms with no HTTP status. n1-review-astra measured
the cause: httpx keeps an idle connection for 5 s and uvicorn closes it at
5 s, so under GIL load the two race. Real agents cannot hit it (mcptool
opens a fresh connection per call).

The fix is ``keepalive_limits()``: every load client expires idle
connections at 2 s, well inside the server's 5 s. ``post_retry_reused_reset``
stays as a guard, per coordinator-opus (2026-09-28): a reset of a REUSED
connection before any response headers is retried ONCE only for
NON-MUTATING requests (``retry=True``). A mutating POST may already have
been applied, so with ``retry=False`` it raises as before, carrying the
reset record. Every reset is returned or attached so the caller counts it.
"""
import time

import httpx

KEEPALIVE_EXPIRY_S = 2.0
RESET_ERRORS = (httpx.ReadError, httpx.WriteError, httpx.RemoteProtocolError)


def keepalive_limits(**kw):
    """``httpx.Limits`` for a load client: idle connections expire at 2 s."""
    return httpx.Limits(keepalive_expiry=KEEPALIVE_EXPIRY_S, **kw)


def post_retry_reused_reset(client, url, *, retry=True, **kw):
    """Return ``(response, reset)``; ``reset`` is None or a dict describing the reset."""
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
                 "ms": round((time.time() - begun) * 1000, 1), "retried": retry}
        if not retry:
            exc.scale_reset = reset   # mutating: never resent, still counted
            raise
    try:
        return client.post(url, **kw), reset
    except Exception as exc:
        exc.scale_reset = reset       # the caller still records the first reset
        raise
