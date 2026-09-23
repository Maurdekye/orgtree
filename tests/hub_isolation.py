"""Keep test rigs off the operator's real mail hub.

THE DEFECT THIS CLOSES (measured 2026-09-23). ``tests/test_engine_http.py``
boots a real engine against a throwaway data root, and that engine's fixture
organisations registered themselves on the OPERATOR'S live hub: 25 rows named
``auth-fixture``, ``duplicate-one``, ``duplicate-two``, ``ordinary-missing`` and
``unrelated-native`` sat in the user's client list. Two independent routes led
there, and either one alone was enough:

1. AN INHERITED ADDRESS. The installed engine publishes its hub in
   ``ORGTREE_LOCAL_HUB_ADDRESS`` (``engine/mailhub_runtime.py``), every agent
   CLI it spawns inherits it, and every command the agent types inherits it
   again. ``net._default_address`` lets that variable outrank the temp-root
   floor (``net._under_os_temp``) on purpose — for a rig's OWN hub — so a
   value inherited from the live engine sends fixtures to the live hub.
2. A SHARED PORT. A fresh data root has no ``mailhub-hosting.json``, so the
   rig's hub asks for the standard port 7370 — the port the live hub already
   holds. ``MailhubRuntime.start`` waits for ``/healthz``, the LIVE hub
   answers it, and the rig then names the live hub as its own.

The repair is test-only and fails closed in three layers:

- ``scrub_inherited_hub`` removes the inherited address from a rig's
  environment (``import_provenance`` does the same for every test process);
- ``isolate_data_root`` gives the rig an unroutable default hub address and a
  hub of its OWN on a free port, under a unique name the rig checks, so a hub
  answering under any other name is visibly not the rig's;
- ``install_transport_guard`` runs inside the rig's engine process and refuses
  every HTTP request aimed at a live hub port BEFORE it is sent, whichever
  code path makes it (register, poll/reconnect, send, receipts, unregister,
  health). Each refusal is reported, so the rig fails instead of staying quiet.

Standard library only: the engine child loads this file by path before the
engine is imported.
"""

from __future__ import annotations

import json
import socket
import urllib.parse
import uuid
from collections.abc import Callable, MutableMapping
from pathlib import Path
from typing import Any

# net.DEFAULT_HUB_PORT and mailhub_runtime.PUBLIC_LISTENER_PORT. Not imported:
# this module loads before the engine does. test_hub_isolation pins both.
LIVE_HUB_PORTS = frozenset({7370, 7371})
# net.UNROUTABLE_HUB_ADDRESS: the discard port refuses at once, so a
# registration fails into the ordinary backoff instead of hanging.
UNROUTABLE_HUB_ADDRESS = "http://127.0.0.1:9"
# Must equal import_provenance.INHERITED_HUB_ENV (test_hub_isolation pins it).
INHERITED_HUB_ENV = ("ORGTREE_LOCAL_HUB_ADDRESS",)
RIG_HUB_PREFIX = "test-rig-"


class LiveHubRefused(ConnectionRefusedError):
    """A rig tried to reach a live hub port. Raised before anything is sent.

    A ConnectionRefusedError, so a caller that already treats an unreachable
    hub as "not yet" keeps doing that instead of losing a daemon thread."""


def scrub_inherited_hub(env: MutableMapping[str, str]) -> list[str]:
    """Remove the inherited hub address from ``env``; return what was removed."""
    removed = [key for key in INHERITED_HUB_ENV if key in env]
    for key in removed:
        env.pop(key, None)
    return removed


def hub_port(address: str) -> int | None:
    """The port an address reaches, read the way ``net`` reads a hub address:
    no scheme means http, and http without a port means the hub default."""
    text = str(address or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "http://" + text
    try:
        parts = urllib.parse.urlsplit(text)
        port = parts.port
    except ValueError:
        return None
    if port is not None:
        return port
    return 443 if parts.scheme == "https" else 7370


def is_live_hub_address(address: str) -> bool:
    """Does this address reach a port a live hub listens on?

    Host-blind on purpose: a rig has no business with ANY hub on those ports,
    local or remote, and a host test is one more thing to get wrong
    (localhost, 0.0.0.0, a LAN name for this machine)."""
    return hub_port(address) in LIVE_HUB_PORTS


def free_port() -> int:
    """A loopback port nobody holds right now, never one a live hub uses."""
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        if port not in LIVE_HUB_PORTS:
            return port


def isolate_data_root(data: Path) -> dict[str, Any]:
    """Configure a FRESH rig data root so its engine reaches only its own hub.

    Writes ``defaults.json`` (an unroutable default hub address, so an org
    whose hub is not the rig's has nothing live to fall back to) and
    ``mailhub-hosting.json`` (the rig's own hub on a free loopback port under
    a unique name). Refuses a root that already holds either file: a rig that
    inherited a configuration is not isolated, and saying so beats silently
    overwriting it."""
    data = Path(data)
    defaults = data / "defaults.json"
    hosting = data / "mailhub-hosting.json"
    for existing in (defaults, hosting):
        if existing.exists():
            raise RuntimeError(f"{existing} already exists: hub isolation needs a "
                               f"fresh data root")
    port = free_port()
    name = f"{RIG_HUB_PREFIX}{uuid.uuid4().hex[:12]}"
    defaults.write_text(json.dumps({"net_hub_address": UNROUTABLE_HUB_ADDRESS}),
                        encoding="utf-8")
    hosting.write_text(json.dumps({
        "version": 2, "port": port, "bind": "127.0.0.1", "name": name,
        "retention_days": 1, "org_retention_days": 1, "public_listener": False,
    }), encoding="utf-8")
    return {"port": port, "name": name, "address": f"http://127.0.0.1:{port}"}


def _url_of(target: Any) -> str:
    for attribute in ("full_url", "url"):
        value = getattr(target, attribute, None)
        if value is not None:
            return str(value)
    return str(target)


def install_transport_guard(report: Callable[[str], None]) -> None:
    """Refuse, inside THIS process, every HTTP request to a live hub port.

    Wraps ``httpx.Client.send`` (the hub client in ``net``) and
    ``urllib.request.OpenerDirector.open`` (``MailhubRuntime``'s health
    check). ``report(url)`` runs before the refusal is raised, so the rig can
    surface it even when the refused call sits in a daemon thread that
    swallows exceptions. Idempotent. Without httpx only the urllib half is
    installed — nothing in the process can use an httpx that is not there."""
    import urllib.request

    def refuse(url: str) -> None:
        report(url)
        raise LiveHubRefused(f"test rig refused a request to a live mail hub "
                             f"port: {url}")

    opener = urllib.request.OpenerDirector
    if not getattr(opener.open, "_hub_isolation_guard", False):
        original_open = opener.open

        def guarded_open(self: Any, fullurl: Any, *args: Any, **kwargs: Any) -> Any:
            url = _url_of(fullurl)
            if is_live_hub_address(url):
                refuse(url)
            return original_open(self, fullurl, *args, **kwargs)

        guarded_open._hub_isolation_guard = True  # type: ignore[attr-defined]
        opener.open = guarded_open  # type: ignore[method-assign]
    try:
        import httpx
    except ImportError:
        return
    if not getattr(httpx.Client.send, "_hub_isolation_guard", False):
        original_send = httpx.Client.send

        def guarded_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
            url = _url_of(request)
            if is_live_hub_address(url):
                refuse(url)
            return original_send(self, request, *args, **kwargs)

        guarded_send._hub_isolation_guard = True  # type: ignore[attr-defined]
        httpx.Client.send = guarded_send  # type: ignore[method-assign]
