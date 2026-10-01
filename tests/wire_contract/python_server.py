"""Disposable real API server, with background/provider services not started.

Only fixture construction and startup wiring know Python. The HTTP token gate,
validation, handlers, persistence, receipt admission and WebSocket Hub are real.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading


def main():
    import import_provenance  # asserts this checkout before product imports
    from engine.launch import load_app
    app, _, data, port, _ = load_app()
    from orgtree import agentauth, api, store
    from orgtree.ledger import USER

    fixture = json.loads(Path(__file__).with_name("fixture.json").read_text(encoding="utf-8"))
    assert fixture["schema"] == "orgtree.wire-fixture/v1"
    assert Path(store.DATA_ROOT).resolve() == data.resolve()
    agents = {}
    for slug in fixture["orgs"]:
        org = store.create_org(slug)
        for node in fixture["nodes"]:
            org.hire(USER, None, "haiku", 0, node)
        org.node(fixture["stale_node"])["generation"] = 1
        if slug == "wire-gallery":
            org.d["documents"] = fixture["documents"]
        store.save_org(org)
        agents[slug] = {node: agentauth.child_env(slug, node, generation=0)["ORGTREE_AGENT_TOKEN"]
                        for node in fixture["nodes"]}

    # A storage fault injected below the real gallery handler exercises the
    # production exception response. No synthetic route/error handler is added.
    read_gallery = store.read_document_gallery

    def gallery_with_fault(slug):
        if slug == "wire-fault":
            raise OSError("synthetic fixture read failure")
        return read_gallery(slug)
    store.read_document_gallery = gallery_with_fault

    # Deliberate defects, only in this disposable process. These replace real
    # production decisions, not assertions or expected-response fixtures.
    control = os.environ.get("ORGTREE_WIRE_UNSAFE_CONTROL")
    if control == "live_identity_bypass":
        api._agent_identity = lambda *args, **kwargs: {}
    elif control == "receipt_admission_bypass":
        api._op_admit = lambda *args, **kwargs: None
    elif control == "reversed_gallery":
        store.read_document_gallery = lambda slug: list(reversed(gallery_with_fault(slug)))
    elif control == "constant_stream_revision":
        api._next_sync_rev = lambda slug: 1
    elif control == "stale_snapshot_revision":
        view = api._org_view

        def stale_view(*args, **kwargs):
            result = view(*args, **kwargs)
            result["sync_rev"] = 0
            return result
        api._org_view = stale_view

    # No provider/child process may run in this server; MCP runs in the parent.
    def forbidden_process(*args, **kwargs):
        raise AssertionError("Wire fixture attempted to launch a child process")
    subprocess.Popen = forbidden_process

    real_connect = socket.socket.connect

    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in {"127.0.0.1", "::1"}:
            raise AssertionError("Wire fixture attempted a non-loopback connection")
        return real_connect(sock, address)
    socket.socket.connect = loopback_only

    import uvicorn
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           lifespan="off", access_log=False, log_level="error"))

    def stop_on_eof():
        sys.stdin.read()
        server.should_exit = True
    threading.Thread(target=stop_on_eof, daemon=True).start()

    async def serve():
        # The only wiring taken from _wire_notify: no recovery, warm pools,
        # discovery, watchdog, mailhub, provider or background driver startup.
        api._LOOP = asyncio.get_running_loop()
        store.on_save = api.hub_changed
        task = asyncio.create_task(server.serve())
        while not server.started and not task.done():
            await asyncio.sleep(0.01)
        if task.done():
            await task
            raise RuntimeError("Fixture failed before readiness")
        print(json.dumps({"schema": "orgtree.wire-ready/v1", "port": port,
                          "agents": agents}), flush=True)
        await task

    asyncio.run(serve())


if __name__ == "__main__":
    main()
