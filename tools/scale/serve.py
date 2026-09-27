"""Serve a seeded scale root on a real uvicorn server, with no CLI able to start.

    engine\\runtime\\python.exe tools/scale/serve.py --root <root> [--port P]

Runs the production app (`engine.launch.load_app` â†’ TokenGate(api.app)) with its
lifespan ON, so the startup recovery, watchdog engine, maildrain and the hub's
websocket wiring all run as they do in the product. What cannot run:
- every external process is refused by an audit hook (counted in
  `<root>/metrics/serve-refused.jsonl`) â€” no claude / codex / git write;
- ORGTREE_CLAUDE / ORGTREE_CODEX point at a path that does not exist;
- the warm pool is off (ORGTREE_WARM=0).

Harness-only route (not product code; exists only in this process):
  POST /scale/stream {"frames": [{"node", "text", "reset"?}]} â€” hands live-text
  frames to `supervisor.stream`, the exact function the CLI reader calls for a
  text delta, so they are captured and broadcast to every open window like
  real streaming.
  GET /scale/tokens â€” the live agents' real agent tokens (minted in-process).

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
    extra = dict(kv.split("=", 1) for kv in (args.env or []))
    env.update(extra)
    (root / "metrics").mkdir(exist_ok=True)
    update_descriptor(root, {"origin": None, "token": token, "serve": {"state": "starting",
                             "port": port, "spawned_at": time.time(), "fence": args.fence,
                             "env": extra}})
    # -X tracemalloc=N traces from the first allocation, so memory taken
    # during startup/recovery is attributable (PYTHONTRACEMALLOC is ignored under -I)
    trace = ["-X", f"tracemalloc={args.tracemalloc}"] if args.tracemalloc else []
    cmd = [args.python or sys.executable, "-I", "-B", *trace, str(Path(__file__).resolve()), "--child",
           "--root", str(root), "--port", str(port)]
    log = open(root / "metrics" / "serve.log", "a", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
    update_descriptor(root, {"serve": {"state": "starting", "port": port, "pid": proc.pid,
                                       "spawned_at": time.time(), "fence": args.fence,
                                       "env": extra}})
    try:
        from control import guarded_wait
        return guarded_wait(proc, report=root / "metrics" / "serve-guard.json")
    except KeyboardInterrupt:
        proc.terminate()
        return proc.wait(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=30)
        log.close()
        update_descriptor(root, {"serve": {"state": "stopped", "pid": proc.pid,
                                           "exit_code": proc.returncode}})


def _reqprof_wrap(app, root: Path):
    """PROFILING ONLY (ORGTREE_SCALE_REQPROF=1): a request carrying the header
    `x-scale-prof: <label>` is cProfiled end to end. Sync endpoints and
    dependencies are run INLINE on the event-loop thread (not the thread pool)
    so one profiler on one thread sees the whole request; send such requests
    ONE AT A TIME on an otherwise idle engine. One JSON record per request
    goes to metrics/reqprof.jsonl: thread CPU ms, wall ms, SQL statements,
    whole-org loads, JSON decodes, and the top functions by cumulative time."""
    import cProfile
    import io
    import pstats
    import fastapi.dependencies.utils as fdu
    import fastapi.routing as fr
    import fastapi.concurrency as fc

    async def _inline(func, *a, **k):
        return func(*a, **k)
    fr.run_in_threadpool = _inline
    fdu.run_in_threadpool = _inline
    # /api/agent imports this alias inside its async route. Patching routing
    # alone misses the worker doing the request and profiles unrelated loop work.
    fc.run_in_threadpool = _inline
    out_path = root / "metrics" / "reqprof.jsonl"
    keep = ("orgtree", "psycopg", "json")
    from orgtree import reply_events
    original_incarnation = reply_events.incarnation
    incarnation_calls = threading.local()

    def _incarnation_fast(org, nid):
        return original_incarnation(org, nid)

    def _incarnation_missing(org, nid):
        return original_incarnation(org, nid)

    def traced_incarnation(org, nid):
        counts = getattr(incarnation_calls, 'counts', None)
        if counts is not None:
            fast = bool(org.d.get('reply_incarnation') and org.node(nid).get('reply_incarnation'))
            branch = 'fast' if fast else 'missing_ids'
            counts[branch] = counts.get(branch, 0) + 1
        if org.d.get('reply_incarnation') and org.node(nid).get('reply_incarnation'):
            return _incarnation_fast(org, nid)
        return _incarnation_missing(org, nid)

    reply_events.incarnation = traced_incarnation

    async def wrapped(scope, receive, send):
        if scope.get("type") != "http":
            return await app(scope, receive, send)
        hdr = dict(scope.get("headers") or [])
        label = hdr.get(b"x-scale-prof")
        if not label:
            return await app(scope, receive, send)
        pr = cProfile.Profile()
        incarnation_calls.counts = {}
        t_cpu, p_cpu, t_wall = time.thread_time(), time.process_time(), time.perf_counter()
        pr.enable()
        try:
            return await app(scope, receive, send)
        finally:
            pr.disable()
            rec = {"label": label.decode(), "path": scope.get("path"),
                   "thread_cpu_ms": round((time.thread_time() - t_cpu) * 1000, 1),
                   "process_cpu_ms": round((time.process_time() - p_cpu) * 1000, 1),
                   "wall_ms": round((time.perf_counter() - t_wall) * 1000, 1)}
            st = pstats.Stats(pr)
            rec['reply_incarnation_branches'] = incarnation_calls.counts
            incarnation_calls.counts = None
            rec['incarnations'] = [
                {'file': fn, 'line': ln, 'calls': nc, 'self_ms': tt * 1000,
                 'cumulative_ms': ct * 1000,
                 'callers': {str(k): v for k, v in callers.items()}}
                for (fn, ln, name), (cc, nc, tt, ct, callers) in st.stats.items()
                if name == 'incarnation'
            ]
            calls = {}
            for (fn, ln, name), (cc, nc, tt, ct, _c) in st.stats.items():  # type: ignore[attr-defined]
                calls[(os.path.basename(fn), name)] = calls.get((os.path.basename(fn), name), 0) + nc
            def n(file, func):
                return sum(v for (f, fu), v in calls.items() if f == file and fu == func)
            rec["sql_execute"] = n("cursor.py", "execute") + n("cursor.py", "executemany")
            rec["whole_org_loads"] = n("store.py", "_load_sqlite_org")
            rec["load_lazy"] = n("store.py", "_load_lazy")
            rec["org_read"] = n("orgtx.py", "org_read")
            rec["cached_org"] = n("store.py", "cached_org")
            rec['reply_incarnation_branches'] = {
                'fast': n('serve.py', '_incarnation_fast'),
                'missing_ids': n('serve.py', '_incarnation_missing'),
            }
            rec["json_decodes"] = n("decoder.py", "raw_decode")
            rec["json_encodes"] = n("encoder.py", "encode")
            buf = io.StringIO()
            ps = pstats.Stats(pr, stream=buf).sort_stats("cumulative")
            ps.print_stats("|".join(keep), 25)
            rec["top"] = buf.getvalue()[-6000:]
            with open(out_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + chr(10))
    return wrapped


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
            # FileNotFoundError, not RuntimeError: the engine already treats it
            # as "CLI not installed", so /api/providers and /api/host answer
            # instead of 500ing (scale-ui-astra 2026-09-26)
            raise FileNotFoundError(f"scale serve forbids external process: {cmd[:120]}")
    sys.addaudithook(forbid)

    t_import = time.time()
    from engine.launch import load_app
    dump_s = float(os.environ.get("ORGTREE_SCALE_TRACE_DUMP", "0") or 0)
    if dump_s:
        # trace from just before load_app (imports stay fast) and dump the top
        # holders every dump_s seconds: startup memory is otherwise unattributable
        import tracemalloc
        import psutil
        frames_n = int(os.environ.get("ORGTREE_SCALE_TRACE_FRAMES", "8"))
        if frames_n:
            tracemalloc.start(frames_n)
        dump_path = root / "metrics" / "trace-dump.jsonl"

        def _dumper() -> None:
            t0 = time.time()
            while True:
                time.sleep(dump_s)
                names = {t.ident: t.name for t in threading.enumerate()}
                stacks = {}
                for ident, fr in sys._current_frames().items():
                    chain = []
                    while fr is not None:
                        fn = fr.f_code.co_filename
                        if "orgtree" in fn and "tools" not in fn:
                            chain.append(f"{os.path.basename(fn)}:{fr.f_code.co_name}:{fr.f_lineno}")
                        fr = fr.f_back
                    if chain:
                        stacks[names.get(ident, str(ident))] = " < ".join(chain[:14])
                rec = {"t": round(time.time() - t0, 1),
                       "private_mb": round(psutil.Process().memory_info().private / 2**20),
                       "stacks": stacks}
                if os.environ.get("ORGTREE_SCALE_TRACE_ORGS"):
                    # live whole-org objects: distinct pinned versions of the document
                    import gc
                    want = {"Org", "LazyDoc", "OrgTx"}
                    cnt: dict = {}
                    ids = set()
                    for o in gc.get_objects():
                        tn = type(o).__name__
                        if tn in want:
                            cnt[tn] = cnt.get(tn, 0) + 1
                            if tn == "LazyDoc":
                                ids.add(id(o))
                    rec["orgs"] = cnt
                    # which running frames hold a whole org (local var -> type)
                    holders: dict = {}
                    for ident, fr in sys._current_frames().items():
                        while fr is not None:
                            try:
                                loc = fr.f_locals
                            except Exception:
                                loc = {}
                            for k, v in list(loc.items()):
                                tn = type(v).__name__
                                if tn in want:
                                    key = f"{os.path.basename(fr.f_code.co_filename)}:{fr.f_code.co_name}:{k}:{tn}"
                                    holders[key] = holders.get(key, 0) + 1
                            fr = fr.f_back
                    rec["holders"] = holders
                if frames_n:
                    snap = tracemalloc.take_snapshot().filter_traces(
                        [tracemalloc.Filter(False, tracemalloc.__file__)])
                    rec["traced_mb"] = round(tracemalloc.get_traced_memory()[0] / 2**20)
                    rec["by_line"] = [[str(st.traceback[0]), round(st.size / 2**20, 1), st.count]
                                      for st in snap.statistics("lineno")[:15]]
                    rec["by_tb"] = [[round(st.size / 2**20, 1), st.count,
                                     [f"{os.path.basename(f.filename)}:{f.lineno}" for f in st.traceback]]
                                    for st in snap.statistics("traceback")[:8]]
                with open(dump_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec) + chr(10))
        threading.Thread(target=_dumper, name="scale-trace-dump", daemon=True).start()
    app, *_ = load_app()
    from orgtree import api, store, supervisor
    if os.environ.get("ORGTREE_SCALE_HALT_FENCE") == "0":
        # halt._FENCE is a hard-coded True that ignores ORGTREE_ORGTX_FENCE
        # (p03-lead 2026-09-26); a real fence-off arm needs both off
        from orgtree import halt
        halt._FENCE = False  # pyright: ignore[reportPrivateUsage]
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

    _tok: dict = {}

    @api.app.get("/scale/tokens")
    def _scale_tokens() -> dict:
        # agent tokens are HMACs under a per-process key, so only this process
        # can mint them; load.py then calls /api/agent exactly as an agent does
        # memoized: child_env reads the whole org per node (O(N) full reads),
        # which under tracemalloc outlasts the loader's timeout
        if "tokens" not in _tok:
            from orgtree import agentauth
            org = store.load_org(slug)
            _tok["tokens"] = {nid: agentauth.node_env(slug, nid, n)["ORGTREE_AGENT_TOKEN"]
                              for nid, n in org.nodes.items() if n.get("state") == "live"}
        return _tok["tokens"]

    @api.app.get("/scale/workload")
    def _scale_workload() -> dict:
        # Read actual node/item identities once before measurement. This avoids
        # assuming the renderer tree's shape or silently sending forbidden mail.
        org = store.load_org(slug)
        nodes = {nid: n for nid, n in org.nodes.items() if n.get("state") == "live"}
        active = list(org.d.get("work_items") or [])
        return {"parents": {nid: n.get("parent") for nid, n in nodes.items()},
                "active_items": len(active),
                "items": [{"slug": it["slug"],
                           "owner": it["owner"].get("node") if isinstance(it.get("owner"), dict) else it.get("owner"),
                           "evidence": len(it.get("evidence") or [])}
                          for it in active if it.get("status") not in ("done", "dropped")]}

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

    @api.app.get("/scale/threadcpu")
    def _scale_threadcpu(seconds: float = 10.0, top: int = 12) -> dict:
        """CPU seconds per OS thread over `seconds` (psutil), each named and
        with a few stack samples, so a busy thread is told apart from a sleeping
        one (the stack sampler above cannot: time.sleep has no Python frame)."""
        import collections
        import traceback
        import psutil
        proc = psutil.Process()
        def snap():
            return {t.id: t.user_time + t.system_time for t in proc.threads()}
        by_native = {t.native_id: t for t in threading.enumerate()}
        a = snap()
        frames: dict = collections.defaultdict(collections.Counter)
        end = time.time() + min(seconds, 60)
        while time.time() < end:
            cur = sys._current_frames()
            for nid, t in by_native.items():
                f = cur.get(t.ident)
                if f is not None:
                    st = traceback.extract_stack(f)[-5:]
                    frames[nid][" > ".join(f"{os.path.basename(x.filename)}:{x.name}:{x.lineno}" for x in st)] += 1
            time.sleep(0.05)
        b = snap()
        rows = sorted(((b[k] - a.get(k, 0.0), k) for k in b), reverse=True)[:top]
        return {"seconds": seconds, "process_cpu_s": sum(b.values()) - sum(a.values()),
                "threads": [{"native_id": k, "cpu_s": round(d, 3),
                             "name": by_native[k].name if k in by_native else None,
                             "stacks": frames[k].most_common(3) if k in frames else []}
                            for d, k in rows]}

    @api.app.get("/scale/profile")
    def _scale_profile(target: str, top: int = 30, args: str = "[]", kwargs: str = "{}") -> dict:
        """cProfile ONE call of a zero-argument engine function named
        `module.func` (e.g. supervisor._abandoned_docket_recovery_pass), with
        optional JSON `args` (list) and `kwargs` (object).
        Throwaway roots only: the call has its real side effects."""
        import cProfile
        import importlib
        import io
        import pstats
        mod, _, fn = target.rpartition(".")
        f = getattr(importlib.import_module(f"orgtree.{mod}"), fn)
        pr = cProfile.Profile()
        t0 = time.perf_counter(); c0 = time.process_time()
        pr.enable()
        try:
            f(*json.loads(args), **json.loads(kwargs))
        finally:
            pr.disable()
        wall = time.perf_counter() - t0
        buf = io.StringIO()
        pstats.Stats(pr, stream=buf).sort_stats("cumulative").print_stats(top)
        return {"target": target, "wall_s": round(wall, 3),
                "thread_cpu_s_approx": round(time.process_time() - c0, 3),
                "stats": buf.getvalue()}

    _tm: dict = {}

    @api.app.get("/scale/mem")
    async def _scale_mem(action: str = "snap", frames: int = 12, top: int = 25) -> dict:
        """Memory attribution. action=start: tracemalloc.start(frames) and a
        baseline snapshot. action=snap: diff against the previous snapshot
        (by line and by traceback for the biggest growers) plus the private
        bytes, the traced total and the top object types by count.
        ASYNC on purpose: it must not queue behind a saturated request pool
        (it blocks the loop for the snapshot instead, which is the point)."""
        import collections
        import gc
        import tracemalloc
        import psutil
        out: dict = {"private_mb": round(psutil.Process().memory_info().private / 2**20, 1)}
        if action == "start":
            if not tracemalloc.is_tracing():
                tracemalloc.start(frames)
            _tm["prev"] = tracemalloc.take_snapshot()
            out["traced_mb"] = round(tracemalloc.get_traced_memory()[0] / 2**20, 1)
            return out
        if not tracemalloc.is_tracing():
            return {"error": "call action=start first"}
        snap = tracemalloc.take_snapshot()
        flt = [tracemalloc.Filter(False, tracemalloc.__file__)]
        snap = snap.filter_traces(flt)
        prev = _tm.get("prev")
        cur, peak = tracemalloc.get_traced_memory()
        out.update(traced_mb=round(cur / 2**20, 1), traced_peak_mb=round(peak / 2**20, 1))
        if prev is not None:
            prev = prev.filter_traces(flt)
            out["by_line"] = [[str(d.traceback[0]), round(d.size_diff / 2**20, 2), d.count_diff,
                               round(d.size / 2**20, 2)]
                              for d in snap.compare_to(prev, "lineno")[:top]]
            out["by_tb"] = [{"size_diff_mb": round(d.size_diff / 2**20, 2), "count_diff": d.count_diff,
                             "tb": [f"{os.path.basename(f.filename)}:{f.lineno}" for f in d.traceback][-frames:]}
                            for d in snap.compare_to(prev, "traceback")[:8]]
        out["cur_by_line"] = [[str(st.traceback[0]), round(st.size / 2**20, 2), st.count]
                              for st in snap.statistics("lineno")[:top]]
        if prev is None:
            # first snapshot of a process traced from start: WHO holds it now
            out["cur_by_tb"] = [{"size_mb": round(st.size / 2**20, 2), "count": st.count,
                                 "tb": [f"{os.path.basename(f.filename)}:{f.lineno}" for f in st.traceback][-frames:]}
                                for st in snap.statistics("traceback")[:10]]
        _tm["prev"] = snap
        types = collections.Counter(type(o).__name__ for o in gc.get_objects())
        out["gc_types"] = types.most_common(20)
        out["gc_count"] = gc.get_count()
        out["threads"] = threading.active_count()
        return out

    if os.environ.get("ORGTREE_SCALE_REQPROF"):
        app = _reqprof_wrap(app, root)
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
                "ORGTREE_ORGTX_FENCE"), "halt_fence": getattr(__import__("orgtree.halt", fromlist=["_FENCE"]), "_FENCE", None),
                      "provenance": prov.receipt(),
                      "env_orgtree": {k: v for k, v in os.environ.items()
                                      if k.startswith("ORGTREE_") and "TOKEN" not in k
                                      and "URL" not in k},
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
    p.add_argument("--tracemalloc", type=int, default=0, help="trace allocations from process start with N frames")
    p.add_argument("--env", action="append", help="KEY=VALUE for the engine env (repeatable; recorded in the descriptor)")
    p.add_argument("--child", action="store_true")
    args = p.parse_args(argv)
    return child(args) if args.child else parent(args)


if __name__ == "__main__":
    sys.exit(main())
