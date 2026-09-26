"""Serve a seeded scale root on a real uvicorn server, with no CLI able to start.

    engine\\runtime\\python.exe tools/scale/serve.py --root <root> [--port P]

Runs the production app (`engine.launch.load_app` → TokenGate(api.app)) with its
lifespan ON, so the startup recovery, watchdog engine, maildrain and the hub's
websocket wiring all run as they do in the product. What cannot run:
- every external process is refused by an audit hook (counted in
  `<root>/metrics/serve-refused.jsonl`) — no claude / codex / git write;
- ORGTREE_CLAUDE / ORGTREE_CODEX point at a path that does not exist;
- the warm pool is off (ORGTREE_WARM=0).

Harness-only route (not product code; exists only in this process):
  POST /scale/stream {"frames": [{"node", "text", "reset"?}]} — hands live-text
  frames to `supervisor.stream`, the exact function the CLI reader calls for a
  text delta, so they are captured and broadcast to every open window like
  real streaming.
  GET /scale/tokens — the live agents' real agent tokens (minted in-process).

On readiness it writes `origin`, `token`, `pid` and startup timings into
`<root>/scale-descriptor.json` and runs until killed.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))


def share_dir(root: Path) -> Path:
    """A mirror of the descriptor and live marker log INSIDE the repo worktree,
    for consumers whose folder grant covers the repo but not the throwaway
    root (scale-ui-astra). data_root in the mirror still names the real root."""
    d = REPO / ".scale-share" / Path(root).name
    d.mkdir(parents=True, exist_ok=True)
    return d


def update_descriptor(root: Path, patch: dict) -> dict:
    p = root / "scale-descriptor.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    d.update(patch)
    body = json.dumps(d, indent=1)
    for target in (p, share_dir(root) / "scale-descriptor.json"):
        tmp = target.with_suffix(".tmp")
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, target)
    return d


def parent(args) -> int:
    from seed import child_env
    root = Path(args.root).resolve()
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    port = args.port
    if not port:
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    token = secrets.token_hex(16)
    env = child_env(root, desc["pg_url"])
    env.update(ORGTREE_V2_TOKEN=token, ORGTREE_V2_PORT=str(port),
               ORGTREE_CLAUDE=str(root / "no-cli" / "claude.exe"),
               ORGTREE_CODEX=str(root / "no-cli" / "codex.exe"))
    if args.fence is not None:
        env["ORGTREE_ORGTX_FENCE"] = args.fence
    (root / "metrics").mkdir(exist_ok=True)
    update_descriptor(root, {"origin": None, "token": token, "serve": {"state": "starting",
                             "port": port, "spawned_at": time.time(), "fence": args.fence}})
    cmd = [args.python or sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--child",
           "--root", str(root), "--port", str(port)]
    log = open(root / "metrics" / "serve.log", "a", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
    update_descriptor(root, {"serve": {"state": "starting", "port": port, "pid": proc.pid,
                                       "spawned_at": time.time(), "fence": args.fence}})
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        return proc.wait()


def child(args) -> int:
    t_proc = time.time()
    root = Path(args.root).resolve()
    sys.path.insert(0, str(REPO / "tools"))
    from assert_repo_import import assert_repo_import
    prov = assert_repo_import(str(REPO))
    refused_path = root / "metrics" / "serve-refused.jsonl"
    refused_lock = threading.Lock()

    def forbid(event, a):
        if event in {"subprocess.Popen", "os.system", "os.startfile", "os.posix_spawn", "os.spawn"}:
            cmd = str(a[1] if len(a) > 1 else a)
            low = cmd.lower()
            if "git" in low and any(v in low for v in (" rev-parse", " status", " merge-base",
                                                       " log", " show", " diff", " ls-files",
                                                       " for-each-ref", " worktree list")):
                return
            with refused_lock, open(refused_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": time.time(), "event": event, "cmd": cmd[:300]}) + "\n")
            raise RuntimeError(f"scale serve forbids external process: {cmd[:120]}")
    sys.addaudithook(forbid)

    t_import = time.time()
    from engine.launch import load_app
    app, *_ = load_app()
    from orgtree import api, store, supervisor
    if Path(store.DATA_ROOT).resolve() != (root / "data").resolve():
        raise RuntimeError("store escaped the scale data root")
    if store.STORE_BACKEND != "postgres":
        raise RuntimeError(f"store is on {store.STORE_BACKEND}")
    t_app = time.time()
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    slug = desc["org"]

    from fastapi import Body

    @api.app.post("/scale/stream")
    def _scale_stream(payload: dict = Body(...)) -> dict:
        """One tick of live text: {"frames": [{"node", "text", "reset"?}, ...]}.
        Each frame goes through `supervisor.stream`, which is what the CLI
        reader calls per batched text delta; batching the HTTP hop keeps the
        harness from adding one request per frame that real streaming never pays."""
        fn = supervisor.stream
        if fn is None:
            return {"ok": False, "why": "supervisor.stream not wired (lifespan did not run)"}
        frames = payload.get("frames") or [payload]
        for f in frames:
            node = str(f["node"])
            fn(slug, node, {"kind": "delta", "text": str(f["text"]),
                            "assistant_id": str(f.get("assistant_id") or f"scale-{node}"),
                            "assistant_reset": bool(f.get("reset"))})
        return {"ok": True, "frames": len(frames)}

    @api.app.get("/scale/tokens")
    def _scale_tokens() -> dict:
        # agent tokens are HMACs under a per-process key, so only this process
        # can mint them; load.py then calls /api/agent exactly as an agent does
        from orgtree import agentauth
        org = store.load_org(slug)
        return {nid: agentauth.child_env(slug, nid)["ORGTREE_AGENT_TOKEN"]
                for nid, n in org.nodes.items() if n.get("state") == "live"}

    @api.app.get("/scale/stacks")
    def _scale_stacks(seconds: float = 20.0, interval_ms: float = 10.0, top: int = 40) -> dict:
        """A poor man's sampling profiler (no py-spy on this machine): sample
        every thread's Python stack every `interval_ms` for `seconds` and count
        (a) the innermost orgtree frame, (b) the full orgtree call path. A thread
        blocked in a lock or socket counts where it waits, so read `waiting` too."""
        import collections
        import traceback
        me = threading.get_ident()
        names = {t.ident: t.name for t in threading.enumerate()}
        leaf: collections.Counter = collections.Counter()
        path: collections.Counter = collections.Counter()
        waiting: collections.Counter = collections.Counter()
        samples = 0
        end = time.time() + min(seconds, 120)
        while time.time() < end:
            for tid, frame in sys._current_frames().items():
                if tid == me:
                    continue
                st = traceback.extract_stack(frame)
                ours = [f for f in st if "orgtree" in f.filename.replace(os.sep, "/")
                        and "tools/scale" not in f.filename.replace(os.sep, "/")]
                if not ours:
                    continue
                top_frame = st[-1]
                blocked = top_frame.name in ("wait", "acquire", "_wait_for_tstate_lock", "select",
                                             "recv", "recv_into", "sleep", "get", "_worker")
                inner = ours[-1]
                key = f"{os.path.basename(inner.filename)}:{inner.name}"
                (waiting if blocked else leaf)[key] += 1
                if not blocked:
                    path[" > ".join(f"{os.path.basename(f.filename)}:{f.name}" for f in ours[-6:])] += 1
            samples += 1
            time.sleep(interval_ms / 1000)
        return {"samples": samples, "threads": len(names),
                "running_leaf": leaf.most_common(top), "running_path": path.most_common(top),
                "waiting_leaf": waiting.most_common(top)}

    import uvicorn
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port, lifespan="on",
                                           access_log=False, log_level="warning",
                                           ws_max_size=64 * 2 ** 20))

    def mark_ready() -> None:
        while not server.started:
            time.sleep(0.05)
        t_ready = time.time()
        # startup recovery runs in the background after readiness; record when it ends
        recovered = None
        try:
            from orgtree import startup
            deadline = time.time() + 1800
            while time.time() < deadline:
                if not startup.recovery.pending:
                    recovered = time.time()
                    break
                time.sleep(0.25)
        except Exception:                                        # noqa: BLE001
            pass
        update_descriptor(root, {
            "origin": f"http://127.0.0.1:{args.port}", "engine_commit": (prov.commit or "")
            + ("+dirty" if prov.dirty else ""),
            "serve": {"state": "ready", "port": args.port, "pid": os.getpid(), "fence": os.environ.get(
                "ORGTREE_ORGTX_FENCE"), "provenance": prov.receipt(),
                "startup_s": {"interpreter_to_import": round(t_import - t_proc, 2),
                              "load_app": round(t_app - t_import, 2),
                              "to_listening": round(t_ready - t_proc, 2),
                              "to_recovery_complete": round(recovered - t_proc, 2) if recovered else None}}})
    threading.Thread(target=mark_ready, daemon=True).start()
    server.run()
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--python", default=None)
    p.add_argument("--fence", default=None, help="ORGTREE_ORGTX_FENCE for the engine (default: as built)")
    p.add_argument("--child", action="store_true")
    args = p.parse_args(argv)
    return child(args) if args.child else parent(args)


if __name__ == "__main__":
    sys.exit(main())
