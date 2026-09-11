"""Run startup recovery without occupying the server's readiness path.

The desktop can serve its shell and lifetime endpoints immediately. API writes
wait asynchronously for recovery: a new message must not overtake a retained
turn or its queued model switch. Automatic drivers start only after repair.
"""
import asyncio
import threading
from collections.abc import Callable


def progress(phase: str) -> None:
    """The desktop launcher installs its structured checkpoint reporter."""


class Recovery:
    def __init__(self) -> None:
        self.complete: asyncio.Event | None = None
        self.task: asyncio.Task | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.cancelled = threading.Event()
        self.error: Exception | None = None

    @property
    def pending(self) -> bool:
        return self.complete is not None and not self.complete.is_set()

    def start(self, repair: Callable[[], None]) -> None:
        if self.task is not None and not self.task.done():
            raise RuntimeError("Startup recovery already running")
        self.complete = complete = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        self.cancelled.clear()
        self.error = None

        async def run():
            try:
                await asyncio.to_thread(repair)
            except Exception as exc:
                self.error = exc
                print(f"[orgtree] startup recovery failed: {exc}", flush=True)
            finally:
                complete.set()

        self.task = asyncio.create_task(run(), name="startup-recovery")

    def cancel(self) -> None:
        self.cancelled.set()
        # A shutdown request must release queued writes before uvicorn waits
        # for requests to drain; its lifespan shutdown hook is too late.
        if self.loop is not None and self.complete is not None:
            self.loop.call_soon_threadsafe(self.complete.set)

    async def wait(self) -> None:
        if self.complete is not None:
            await self.complete.wait()
        if self.error is not None or self.cancelled.is_set():
            raise RuntimeError("Startup recovery did not finish; restart the engine to retry")


recovery = Recovery()


class RecoveryBarrier:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        mutation = (scope["type"] == "http" and scope.get("method") not in {"GET", "HEAD", "OPTIONS"})
        # Shutdown must work even when startup is stuck. GETs and websocket
        # observations may reflect recovery as it lands; their writes go through
        # the ordinary HTTP/MCP mutation routes guarded here.
        if mutation and path != "/api/desktop/shutdown":
            try:
                await recovery.wait()
            except RuntimeError as exc:
                body = str(exc).encode("utf-8")
                await send({"type": "http.response.start", "status": 503,
                            "headers": [(b"content-type", b"text/plain; charset=utf-8")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
