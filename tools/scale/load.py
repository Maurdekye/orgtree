"""Drive simulated agent + UI load at a served scale root and record what it costs.

    engine\\runtime\\python.exe tools/scale/load.py --root <root> --duration 600
        [--rate <tool calls/s> | --turn-rate-per-agent 0.039 --calls-per-turn 2]
        [--windows 4] [--stream-frac 0.05 | --stream-nodes K] [--stream-hz 8]
        [--label name] [--workers 64]

Four drivers run together (fixed DEMAND, open loop: a call is issued at its
scheduled time whether or not earlier ones returned — that is what agents do):

1. AGENT TOOL CALLS — POST /api/agent as real agents (real agent tokens from
   the served process), random live agent, mix derived from the live org's last
   48 h (events 2026-09-24..26: mail 64 %, docket ops ~24 %, watchdog ~7 %)
   plus status and reads. Default rate = 0.039 × N × 2 calls/s: the live
   fleet's peak aggregate turn rate (0.936 Hz over 24 live agents, relayed
   charter figure) scaled per agent, × an ASSUMED 2 orgtree calls per turn
   (measured ≈1.1 write events per turn; reads/status are not logged).
2. UI WINDOWS — W windows each polling as the renderer does: org tree every
   6 s (If-None-Match), org list every 3 s, docket list every 5 s
   (If-None-Match), and the chat of one streaming node every 2.5 s.
3. SCREEN FEED — each window holds the org websocket (?win=scale-w<i>) and
   times every numbered stream marker it receives.
4. LIVE TEXT — K streaming nodes (default 5 % of N) emit a frame at
   --stream-hz, each carrying a unique marker `[[m<seq>]]`; the marker → emit
   time map is written to metrics/<label>/markers.jsonl.

A sampler records engine private/RSS bytes, CPU, threads, handles, and
PostgreSQL connections / lock waits every 2 s, and engine-stats every 5 s.

Everything lands under <root>/metrics/<label>/ and summary.json holds the
per-tool and per-route p50/p95/p99, error counts, feed latency and drops,
memory trend, and the offered vs achieved rates (equal-demand check).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import random
import re
import statistics
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import update_descriptor  # noqa: E402

MARK = re.compile(r"\[\[m(\d+)\]\]")

# (weight, tool, args-builder) — args-builder(me, ctx) -> dict
MIX = [
    (0.30, "orgtree_message", lambda me, c: {"to": c.superior(me), "kind": "message",
                                             "body": c.text(300)}),
    (0.05, "orgtree_send_notice", lambda me, c: {"to": c.superior(me), "body": c.text(200)}),
    (0.18, "orgtree_status", lambda me, c: {"status": "working", "summary": c.text(80)}),
    (0.10, "orgtree_work", lambda me, c: {"action": "update", "slug": c.item(me),
                                          "done_so_far": [c.text(100)],
                                          "working_on_next": [c.text(100)]}),
    (0.03, "orgtree_work", lambda me, c: {"action": "evidence", "slug": c.item(me), "kind": "note",
                                          "ref": "scale", "note": c.text(400)}),
    (0.08, "orgtree_work", lambda me, c: {"action": "get", "slug": c.item(me), "projection": "compact"}),
    (0.04, "orgtree_work", lambda me, c: {"action": "list"}),
    (0.02, "orgtree_work", lambda me, c: {"action": "create", "title": "scale " + c.text(30),
                                          "objective": c.text(600), "owner": me}),
    (0.08, "orgtree_chart", lambda me, c: {"include_standing_charter": False}),
    (0.05, "orgtree_watchdog", lambda me, c: {"action": "list"}),
    (0.04, "orgtree_reservation", lambda me, c: {"action": "list"}),
    (0.03, "orgtree_read_scratch", lambda me, c: {"node": me}),
]
WORDS = "scale load engine docket window mail status review lock latency memory".split()


class Ctx:
    def __init__(self, desc: dict, items: dict[str, list[str]], parents: dict[str, str | None],
                 rng: random.Random):
        self.live = desc["live_agents"]
        self.items, self.parents, self.rng = items, parents, rng

    def text(self, n: int) -> str:
        return " ".join(self.rng.choice(WORDS) for _ in range(max(1, n // 7)))[:n]

    def superior(self, me: str) -> str:
        return self.parents.get(me) or self.peer(me)

    def peer(self, me: str) -> str:
        while True:
            p = self.rng.choice(self.live)
            if p != me:
                return p

    def item(self, me: str) -> str:
        own = self.items.get(me)
        return self.rng.choice(own) if own else "none"


def pct(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0}
    s = sorted(xs)
    q = lambda f: s[min(len(s) - 1, int(f * len(s)))]
    return {"n": len(s), "p50": round(q(.5), 1), "p95": round(q(.95), 1), "p99": round(q(.99), 1),
            "max": round(s[-1], 1), "mean": round(statistics.fmean(s), 1)}


class Recorder:
    def __init__(self, out: Path):
        self.out = out
        self.lock = threading.Lock()
        self.files: dict[str, object] = {}

    def write(self, name: str, row: dict) -> None:
        with self.lock:
            f = self.files.get(name)
            if f is None:
                f = self.files[name] = open(self.out / f"{name}.jsonl", "a", encoding="utf-8")
            f.write(json.dumps(row) + "\n")

    def close(self) -> None:
        for f in self.files.values():
            f.close()


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--duration", type=float, default=600)
    p.add_argument("--rate", type=float, default=None, help="aggregate agent tool calls/s")
    p.add_argument("--turn-rate-per-agent", type=float, default=0.039)
    p.add_argument("--calls-per-turn", type=float, default=2.0)
    p.add_argument("--windows", type=int, default=4)
    p.add_argument("--stream-frac", type=float, default=0.05)
    p.add_argument("--stream-nodes", type=int, default=None)
    p.add_argument("--stream-hz", type=float, default=8.0)
    p.add_argument("--workers", type=int, default=64)
    p.add_argument("--label", default=None)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--no-ui", action="store_true")
    p.add_argument("--min-free-commit-gb", type=float, default=10.0)
    args = p.parse_args(argv)

    sys.path.insert(0, str(REPO / "tools"))
    import httpx
    import psutil
    from websockets.sync.client import connect as ws_connect

    root = Path(args.root).resolve()
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    if (desc.get("serve") or {}).get("state") != "ready" or not desc.get("origin"):
        raise SystemExit("the root is not being served (run serve.py and wait for ready)")
    N = int(desc["agents"])
    origin, token, slug = desc["origin"], desc["token"], desc["org"]
    rate = args.rate if args.rate is not None else args.turn_rate_per_agent * N * args.calls_per_turn
    label = args.label or f"n{N}-r{rate:g}-w{args.windows}-{time.strftime('%H%M%S')}"
    out = root / "metrics" / label
    out.mkdir(parents=True, exist_ok=True)
    rec = Recorder(out)
    rng = random.Random(args.seed)
    H = {"X-Orgtree-Desktop-Token": token}

    boot = httpx.Client(base_url=origin, headers=H, timeout=120)
    tokens = boot.get("/scale/tokens").raise_for_status().json()
    tree = boot.get(f"/api/orgs/{slug}").raise_for_status().json()
    parents = {}
    def walk(n, parent=None):
        if isinstance(n, dict):
            nid = n.get("id")
            if nid:
                parents[nid] = parent
            for ch in n.get("children") or []:
                walk(ch, nid or parent)
    for r in (tree.get("roots") or tree.get("tree") or []):
        walk(r)
    wl = boot.get(f"/api/orgs/{slug}/work-items?backlogged=1").raise_for_status().json()
    items: dict[str, list[str]] = {}
    for it in (wl.get("items") or []) + (wl.get("backlogged") or []):
        o = (it.get("owner") or {}).get("node") if isinstance(it.get("owner"), dict) else it.get("owner")
        if o:
            items.setdefault(o, []).append(it["slug"])
    live = [a for a in desc["live_agents"] if a in tokens]
    ctx = Ctx(desc, items, parents, rng)
    K = args.stream_nodes if args.stream_nodes is not None else max(1, int(N * args.stream_frac))
    stream_nodes = rng.sample(live, min(K, len(live)))
    engine_pid = int(desc["serve"]["pid"])
    eproc = psutil.Process(engine_pid)
    stop = threading.Event()
    t0 = time.time()
    config = {"label": label, "agents": N, "rate_calls_s": rate, "windows": args.windows,
              "stream_nodes": len(stream_nodes), "stream_hz": args.stream_hz,
              "duration_s": args.duration, "workers": args.workers,
              "derivation": {"turn_rate_per_agent": args.turn_rate_per_agent,
                             "calls_per_turn": args.calls_per_turn, "explicit_rate": args.rate},
              "parents_known": len(parents), "items_known": sum(len(v) for v in items.values()),
              "engine_commit": desc.get("engine_commit"), "started": t0}
    (out / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")
    update_descriptor(root, {"agent": stream_nodes[0] if stream_nodes else None,
                             "load": {"running": True, "rate": rate, "since": t0, "label": label,
                                      "windows": args.windows, "stream_nodes": stream_nodes,
                                      "stream_hz": args.stream_hz,
                                      "markers": str(out / "markers.jsonl")}})

    # ---------------- 1. agent tool calls (open loop) ----------------------
    weights = [w for w, _, _ in MIX]
    local = threading.local()

    def client():
        c = getattr(local, "c", None)
        if c is None:
            c = local.c = httpx.Client(base_url=origin, timeout=120)
        return c

    def one_call(due: float, me: str, tool: str, targs: dict) -> None:
        begun = time.time()
        status, err, state = None, None, None
        try:
            r = client().post("/api/agent", json={"org": slug, "node": me, "tool": tool, "args": targs},
                              headers={"X-Orgtree-Agent-Token": tokens[me]})
            status = r.status_code
            if status != 200:
                err = r.text[:300]
            else:
                try:
                    j = r.json()
                    state = j.get("state") if isinstance(j, dict) else None
                    if isinstance(j, dict) and j.get("error"):
                        err = str(j.get("error"))[:300]
                except Exception:                            # noqa: BLE001
                    pass
        except Exception as e:                               # noqa: BLE001
            err = f"{type(e).__name__}: {e}"[:300]
        end = time.time()
        rec.write("calls", {"t": round(due - t0, 3), "tool": tool,
                            "action": targs.get("action"), "status": status, "state": state,
                            "err": err, "lag_ms": round((begun - due) * 1000, 1),
                            "http_ms": round((end - begun) * 1000, 1),
                            "total_ms": round((end - due) * 1000, 1)})

    def call_driver():
        with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
            i = 0
            nxt = time.time()
            while not stop.is_set() and time.time() - t0 < args.duration:
                nxt += rng.expovariate(rate) if rate > 0 else 3600
                d = nxt - time.time()
                if d > 0:
                    stop.wait(d)
                me = rng.choice(live)
                w, tool, build = rng.choices(MIX, weights=weights)[0]
                targs = build(me, ctx)
                if targs.get("slug") == "none":
                    # this agent owns no active item (the docket is capped at
                    # 200 per org): it reports status instead
                    tool, targs = "orgtree_status", {"status": "working", "summary": ctx.text(80)}
                pool.submit(one_call, nxt, me, tool, targs)
                i += 1

    # ---------------- 2. UI windows + 3. screen feed -----------------------
    received: dict[int, dict[int, float]] = {w: {} for w in range(args.windows)}
    ws_state = {w: {"connects": 0, "closes": 0, "frames": 0, "bytes": 0} for w in range(args.windows)}

    def ui_window(w: int):
        c = httpx.Client(base_url=origin, headers=H, timeout=120)
        etags: dict[str, str] = {}
        watch = stream_nodes[w % len(stream_nodes)] if stream_nodes else live[0]
        polls = [("org_tree", f"/api/orgs/{slug}", 6.0, True),
                 ("org_list", "/api/orgs", 3.0, False),
                 ("work_items", f"/api/orgs/{slug}/work-items?archived=1&backlogged=1", 5.0, True),
                 ("chat", f"/api/orgs/{slug}/nodes/{watch}/chat?last=300", 2.5, False)]
        due = {name: time.time() + rng.random() * period for name, _, period, _ in polls}
        while not stop.is_set() and time.time() - t0 < args.duration:
            name, url, period, cond = min(polls, key=lambda x: due[x[0]])
            d = due[name] - time.time()
            if d > 0:
                stop.wait(d)
                if stop.is_set():
                    break
            begun = time.time()
            hdr = {"If-None-Match": etags[name]} if cond and name in etags else {}
            status, size, err = None, 0, None
            try:
                r = c.get(url, headers=hdr)
                status, size = r.status_code, len(r.content)
                if r.headers.get("etag"):
                    etags[name] = r.headers["etag"]
                if status not in (200, 304):
                    err = r.text[:200]
            except Exception as e:                           # noqa: BLE001
                err = f"{type(e).__name__}: {e}"[:200]
            end = time.time()
            rec.write("ui", {"t": round(begun - t0, 3), "w": w, "route": name, "status": status,
                             "bytes": size, "err": err, "ms": round((end - begun) * 1000, 1),
                             "late_ms": round((begun - due[name]) * 1000, 1)})
            due[name] = max(due[name] + period, time.time())

    def ws_window(w: int):
        url = origin.replace("http", "ws") + f"/api/orgs/{slug}/ws?win=scale-w{w}"
        while not stop.is_set() and time.time() - t0 < args.duration:
            try:
                with ws_connect(url, additional_headers=H, max_size=None, open_timeout=30) as s:
                    ws_state[w]["connects"] += 1
                    rec.write("ws", {"t": round(time.time() - t0, 3), "w": w, "ev": "open"})
                    while not stop.is_set() and time.time() - t0 < args.duration:
                        try:
                            raw = s.recv(timeout=1.0)
                        except TimeoutError:
                            continue
                        now = time.time()
                        ws_state[w]["frames"] += 1
                        ws_state[w]["bytes"] += len(raw)
                        if "[[m" in raw:
                            for m in MARK.finditer(raw):
                                received[w].setdefault(int(m.group(1)), now)
            except Exception as e:                           # noqa: BLE001
                rec.write("ws", {"t": round(time.time() - t0, 3), "w": w, "ev": "close",
                                 "why": f"{type(e).__name__}: {e}"[:200]})
            ws_state[w]["closes"] += 1
            if not stop.is_set():
                stop.wait(1.5)                               # the renderer's reconnect delay

    # ---------------- 4. live text ------------------------------------------
    emitted: dict[int, tuple[float, str]] = {}

    def streamer():
        if not stream_nodes:
            return
        c = httpx.Client(base_url=origin, headers=H, timeout=120)
        seq = 0
        period = 1.0 / args.stream_hz
        nxt = time.time()
        first = True
        while not stop.is_set() and time.time() - t0 < args.duration:
            frames = []
            now = time.time()
            for node in stream_nodes:
                seq += 1
                emitted[seq] = (now, node)
                rec.write("markers", {"m": seq, "emit": now, "node": node})
                frames.append({"node": node, "reset": first,
                               "text": f"[[m{seq}]] " + ctx.text(40) + " "})
            first = False
            begun = time.time()
            err = None
            try:
                r = c.post("/scale/stream", json={"frames": frames})
                if r.status_code != 200 or not r.json().get("ok"):
                    err = r.text[:200]
            except Exception as e:                           # noqa: BLE001
                err = f"{type(e).__name__}: {e}"[:200]
            rec.write("stream", {"t": round(begun - t0, 3), "frames": len(frames), "err": err,
                                 "ms": round((time.time() - begun) * 1000, 1),
                                 "first_seq": seq - len(frames) + 1, "emit": now})
            nxt += period
            d = nxt - time.time()
            if d > 0:
                stop.wait(d)

    # ---------------- sampler -----------------------------------------------
    def sampler():
        import psycopg
        pg = None
        try:
            pg = psycopg.connect(desc["pg_url"], autocommit=True)
        except Exception as e:                               # noqa: BLE001
            rec.write("samples", {"t": 0, "pg_error": str(e)[:200]})
        eproc.cpu_percent(None)
        last_stats = 0.0
        sc = httpx.Client(base_url=origin, headers=H, timeout=30)
        while not stop.is_set():
            row = {"t": round(time.time() - t0, 1)}
            try:
                mi = eproc.memory_info()
                row.update(private=getattr(mi, "private", None), rss=mi.rss,
                           cpu=eproc.cpu_percent(None), threads=eproc.num_threads(),
                           handles=eproc.num_handles() if hasattr(eproc, "num_handles") else None)
            except Exception as e:                           # noqa: BLE001
                row["engine_error"] = str(e)[:120]
            if pg is not None:
                try:
                    db = pg.info.dbname
                    acts = pg.execute("SELECT state, wait_event_type, count(*) FROM pg_stat_activity "
                                      "WHERE datname=%s GROUP BY 1,2", (db,)).fetchall()
                    row["pg_conns"] = sum(r[2] for r in acts)
                    row["pg_active"] = sum(r[2] for r in acts if r[0] == "active")
                    row["pg_lock_wait"] = sum(r[2] for r in acts if r[1] == "Lock")
                    row["pg_locks_waiting"] = pg.execute(
                        "SELECT count(*) FROM pg_locks WHERE NOT granted").fetchone()[0]
                    x = pg.execute("SELECT xact_commit, xact_rollback, deadlocks, blks_hit, blks_read, "
                                   "tup_inserted, tup_updated FROM pg_stat_database WHERE datname=%s",
                                   (db,)).fetchone()
                    row["pg_db"] = list(x) if x else None
                except Exception as e:                       # noqa: BLE001
                    row["pg_error"] = str(e)[:120]
            if time.time() - last_stats >= 5:
                last_stats = time.time()
                try:
                    es = sc.get("/api/diagnostics/engine-stats").json()
                    row["ws"] = {"queued": sum(s["pending"] for s in es["websockets"]["sockets"]),
                                 "queued_bytes": sum(s["pending_bytes"] for s in es["websockets"]["sockets"]),
                                 "sockets": len(es["websockets"]["sockets"]),
                                 "drops": es["websockets"]["drops"]}
                    row["work_list"] = es["work_list"]
                except Exception as e:                       # noqa: BLE001
                    row["stats_error"] = str(e)[:120]
            rec.write("samples", row)
            stop.wait(2.0)

    threads = [threading.Thread(target=sampler, daemon=True, name="sampler"),
               threading.Thread(target=call_driver, daemon=True, name="calls"),
               threading.Thread(target=streamer, daemon=True, name="stream")]
    if not args.no_ui:
        for w in range(args.windows):
            threads.append(threading.Thread(target=ws_window, args=(w,), daemon=True, name=f"ws{w}"))
            threads.append(threading.Thread(target=ui_window, args=(w,), daemon=True, name=f"ui{w}"))
    for t in threads:
        t.start()
    try:
        while time.time() - t0 < args.duration:
            time.sleep(1)
            if int(time.time() - t0) % 30 == 0:
                free = psutil.virtual_memory()  # physical, for the log only
                rec.write("progress", {"t": round(time.time() - t0), "phys_avail_gb":
                                       round(free.available / 2 ** 30, 2)})
    except KeyboardInterrupt:
        pass
    time.sleep(3)                                            # let the last frames land
    stop.set()
    for t in threads:
        t.join(timeout=150)
    rec.close()

    # ---------------- summary ------------------------------------------------
    def rows(name):
        f = out / f"{name}.jsonl"
        return [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines()] if f.exists() else []
    calls, ui, samples = rows("calls"), rows("ui"), rows("samples")
    by_tool: dict[str, list] = {}
    for c in calls:
        by_tool.setdefault(c["tool"] + (":" + c["action"] if c.get("action") else ""), []).append(c)
    tools_summary = {k: {"total_ms": pct([c["total_ms"] for c in v]),
                         "http_ms": pct([c["http_ms"] for c in v]),
                         "errors": sum(1 for c in v if c["err"] or c["status"] != 200),
                         "running": sum(1 for c in v if c.get("state") == "running"),
                         "sample_errors": list({str(c["err"])[:160] for c in v if c["err"]})[:3]}
                     for k, v in sorted(by_tool.items())}
    by_route: dict[str, list] = {}
    for u in ui:
        by_route.setdefault(u["route"], []).append(u)
    routes_summary = {k: {"ms": pct([u["ms"] for u in v]),
                          "ms_200": pct([u["ms"] for u in v if u["status"] == 200]),
                          "n304": sum(1 for u in v if u["status"] == 304),
                          "errors": sum(1 for u in v if u["err"]),
                          "bytes_200": pct([u["bytes"] for u in v if u["status"] == 200])}
                      for k, v in sorted(by_route.items())}
    feed = {}
    horizon = max((e for e, _ in emitted.values()), default=0) - 5  # markers emitted >5 s before stop
    for w in range(args.windows):
        lat = [(received[w][s] - e) * 1000 for s, (e, _) in emitted.items() if s in received[w]]
        due = [s for s, (e, _) in emitted.items() if e <= horizon]
        missing = [s for s in due if s not in received[w]]
        feed[w] = {"latency_ms": pct(lat), "emitted_due": len(due), "missing": len(missing),
                   **ws_state[w]}
    mem = [(s["t"], s["private"] or s["rss"]) for s in samples if s.get("private") or s.get("rss")]
    def slope(pts):
        if len(pts) < 3:
            return None
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        den = sum((x - mx) ** 2 for x in xs) or 1
        return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    half = mem[len(mem) // 2:]
    elapsed = (max((c["t"] for c in calls), default=0) or 1)
    summary = {"config": config,
               "achieved": {"calls": len(calls), "calls_per_s": round(len(calls) / elapsed, 2),
                            "offered_calls_per_s": rate,
                            "ui_requests": len(ui), "stream_markers": len(emitted)},
               "tools": tools_summary, "routes": routes_summary, "feed": feed,
               "memory": {"start_mb": round(mem[0][1] / 2 ** 20) if mem else None,
                          "end_mb": round(mem[-1][1] / 2 ** 20) if mem else None,
                          "max_mb": round(max(m for _, m in mem) / 2 ** 20) if mem else None,
                          "slope_mb_per_min_2nd_half": round((slope(half) or 0) * 60 / 2 ** 20, 2)},
               "cpu": pct([s["cpu"] for s in samples if s.get("cpu") is not None]),
               "pg": {"conns": pct([s["pg_conns"] for s in samples if "pg_conns" in s]),
                      "lock_wait": pct([s["pg_lock_wait"] for s in samples if "pg_lock_wait" in s]),
                      "locks_waiting": pct([s["pg_locks_waiting"] for s in samples if "pg_locks_waiting" in s])},
               "ws_engine": [s["ws"] for s in samples if "ws" in s][-1:] or None}
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    update_descriptor(root, {"load": {"running": False, "rate": rate, "since": t0, "ended": time.time(),
                                      "label": label, "windows": args.windows,
                                      "stream_nodes": stream_nodes, "stream_hz": args.stream_hz,
                                      "markers": str(out / "markers.jsonl"),
                                      "summary": str(out / "summary.json")}})
    print(json.dumps({"label": label, "achieved": summary["achieved"], "memory": summary["memory"],
                      "cpu": summary["cpu"]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
