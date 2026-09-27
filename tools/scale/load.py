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
2. UI WINDOWS — declared visible docket, desk, Attention and chooser roles
   from ui_mix.py, with conditional light lists, closed optional groups and
   live-change refreshes. Earlier runs polled all endpoints in every window;
   that was a stress mix, not the renderer's normal visible-view traffic.
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
import asyncio
import json
import hashlib
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
from serve import share_dir, update_descriptor  # noqa: E402
from control import BoundedPool, Workload, Feed, free_commit_gb, memory_breach
from ui_mix import WINDOWS, polls as ui_polls
from streaming import drive_streams, send_frames

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
    def __init__(self, out: Path, mirror: dict[str, Path] | None = None):
        self.out = out
        self.mirror = mirror or {}
        self.lock = threading.Lock()
        self.files: dict[str, object] = {}

    def write(self, name: str, row: dict) -> None:
        line = json.dumps(row) + "\n"
        with self.lock:
            f = self.files.get(name)
            if f is None:
                f = self.files[name] = open(self.out / f"{name}.jsonl", "a", encoding="utf-8")
            f.write(line)
            if name in self.mirror:
                # the shared mirror is line-buffered: a reader tails it live
                m = self.files.get("mirror:" + name)
                if m is None:
                    m = self.files["mirror:" + name] = open(self.mirror[name], "a",
                                                           encoding="utf-8", buffering=1)
                m.write(line)

    def close(self) -> None:
        for f in self.files.values():
            f.close()


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--duration", type=float, default=600)
    p.add_argument("--warmup", type=float, default=0, help="continuous warmup before the measured duration")
    p.add_argument("--rate", type=float, default=None, help="aggregate agent tool calls/s")
    p.add_argument("--turn-rate-per-agent", type=float, default=0.039)
    p.add_argument("--calls-per-turn", type=float, default=2.0)
    p.add_argument("--steer-per-turn", type=float, default=10.0,
                   help="steer polls per turn: the PostToolUse hook polls after EVERY tool call "
                        "(Bash, Edit, ...), not only orgtree calls; 10 is an ASSUMPTION")
    p.add_argument("--steer-rate", type=float, default=None, help="aggregate steer polls/s (overrides)")
    p.add_argument("--windows", type=int, default=4)
    p.add_argument("--stream-frac", type=float, default=0.05)
    p.add_argument("--stream-nodes", type=int, default=None)
    p.add_argument("--stream-hz", type=float, default=8.0)
    p.add_argument("--stream-mode", choices=("independent", "batch"), default="independent",
                   help="batch preserves the old cross-agent barrier for diagnostic comparison only")
    p.add_argument("--workers", type=int, default=64)
    p.add_argument("--label", default=None)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--no-ui", action="store_true")
    p.add_argument("--renderer-hooks", action="store_true")
    p.add_argument("--write-oracle", action="store_true")
    p.add_argument("--plan-only", action="store_true")
    p.add_argument("--plans-dir", type=Path)
    p.add_argument("--min-free-commit-gb", type=float, default=10.0)
    p.add_argument("--max-engine-gb", type=float, default=5.0,
                   help="GUARD: stop the run and KILL the (throwaway) engine above this private size")
    args = p.parse_args(argv)
    measured_duration = args.duration
    if args.warmup < 0:
        p.error("warmup cannot be negative")
    args.duration += args.warmup
    if measured_duration <= 0 or args.workers < 1 or args.stream_hz <= 0:
        p.error("duration, workers and stream-hz must be positive")

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
    steer_rate = (args.steer_rate if args.steer_rate is not None
                  else args.turn_rate_per_agent * N * args.steer_per_turn)
    label = args.label or f"n{N}-r{rate:g}-w{args.windows}-{time.strftime('%H%M%S')}"
    out = root / "metrics" / label
    out.mkdir(parents=True, exist_ok=False)  # Never append a second run to old measurements.
    share = share_dir(root)
    rec = Recorder(out, {"markers": share / f"markers-{label}.jsonl"})
    rng = random.Random(args.seed)  # Used only by tool request planning.
    steer_rng = random.Random(args.seed + 1)
    stream_rng = random.Random(args.seed + 2)
    H = {"X-Orgtree-Desktop-Token": token}

    boot = httpx.Client(base_url=origin, headers=H, timeout=30)
    tokens = boot.get("/scale/tokens").raise_for_status().json()
    metadata = boot.get("/scale/workload").raise_for_status().json()
    live = [a for a in desc["live_agents"] if a in tokens]
    if len(live) != N:
        raise RuntimeError("missing live agent credentials")
    live = [a for a in live if a in metadata["callers"]]
    workload = Workload(metadata, live)
    parents = workload.parents
    items = {}
    for item in workload.items:
        items.setdefault(item["owner"], []).append(item["slug"])
    ctx = Ctx(desc, items, parents, rng)
    boot.close()
    K = args.stream_nodes if args.stream_nodes is not None else max(1, int(N * args.stream_frac))
    stream_nodes = stream_rng.sample(live, min(K, len(live)))
    stream_ctx = Ctx(desc, items, parents, stream_rng)
    engine_pid = int(desc["serve"]["pid"])
    eproc = psutil.Process(engine_pid)
    stop = threading.Event()
    guard_stop = threading.Event()
    guard: dict = {}
    t0 = time.time()

    command = eproc.cmdline()
    if "--child" not in command or "--root" not in command or str(root) not in command:
        raise RuntimeError("descriptor PID does not identify this disposable engine")
    if not desc["serve"].get("provenance"):
        raise RuntimeError("engine import provenance missing")
    if (desc["serve"].get("env_orgtree") or {}).get("ORGTREE_SCALE_REQPROF") == "1":
        raise RuntimeError("request profiler changes concurrency; disable it for load qualification")
    fc0 = free_commit_gb()  # Fail closed: no load without observable commit headroom.
    if fc0 < args.min_free_commit_gb:
        raise SystemExit(f"free commit {fc0:.2f} GiB below floor; not starting load")
    config = {"label": label, "agents": N, "active_callers": len(live), "caller_ids": live, "rate_calls_s": rate, "steer_polls_s": steer_rate,
              "windows": args.windows,
              "ui_mix": {"windows": [WINDOWS[w % len(WINDOWS)] for w in range(args.windows)],
                         "groups": "archive/backlog closed; full details only on user open",
                         "chat_window": 8, "changed_events": "120ms coalesced refresh",
                         "limits": "Visible idle views; no clicks, scrolling or hidden-window simulation"},
              "stream_nodes": len(stream_nodes), "stream_hz": args.stream_hz,
              "stream_mode": args.stream_mode,
              "duration_s": args.duration, "workers": args.workers,
              "warmup_s": args.warmup, "measured_s": measured_duration,
              "phase_boundary": "continuous drivers, sockets and caches; no warmup restart",
              "derivation": {"turn_rate_per_agent": args.turn_rate_per_agent,
                             "calls_per_turn": args.calls_per_turn, "explicit_rate": args.rate},
              "parents_known": len(parents), "items_known": sum(len(v) for v in items.values()),
              "engine_commit": desc.get("engine_commit"), "started": t0,
              "provenance": desc["serve"]["provenance"],
              "engine_environment": desc["serve"].get("env_orgtree"),
              "workload_limits": "Finite evidence/create capacity becomes owned updates; substitutions reported.",
              "simulation": "Real tool/admission paths; external provider launches refused; no LLM.",
              "client_capacity_per_driver": "2 * workers, excess offered requests recorded as overload"}
    (out / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")
    update_descriptor(root, {"agent": stream_nodes[0] if stream_nodes else None,
                             "load": {"running": True, "rate": rate, "since": t0, "label": label,
                                      "windows": args.windows, "stream_nodes": stream_nodes,
                                      "stream_hz": args.stream_hz,
                                      "markers": str(out / "markers.jsonl"),
                                      "markers_share": str(share / f"markers-{label}.jsonl")}})

    # ---------------- 1. agent tool calls (open loop) ----------------------
    weights = [w for w, _, _ in MIX]
    local = threading.local()

    def client():
        c = getattr(local, "c", None)
        if c is None:
            c = local.c = httpx.Client(base_url=origin, timeout=30)
        return c

    def execute_call(due: float, me: str, tool: str, targs: dict, request_id: int) -> None:
        begun = time.time()
        response_at = begun
        status, err, state, receipt = None, None, None, None
        try:
            r = client().post("/api/agent", json={"org": slug, "node": me, "tool": tool, "args": targs},
                              headers={"X-Orgtree-Agent-Token": tokens[me],
                                       "X-Scale-Kind": tool + ":" + targs.get("action", "")})
            status = r.status_code
            response_at = time.time()
            if status != 200:
                err = r.text[:300]
            else:
                try:
                    j = r.json()
                    state = j.get("state") if isinstance(j, dict) else None
                    if isinstance(j, dict):
                        receipt = {k: j[k] for k in ("id", "created", "slug", "state", "ok", "operation_id") if k in j}
                    if tool in ("orgtree_message", "orgtree_send_notice", "orgtree_status") or (
                            tool == "orgtree_work" and targs.get("action") in ("update", "evidence", "create")):
                        rec.write("write-receipts", {"request_id": request_id, "actor": me,
                                                     "tool": tool, "args": targs, "response": j})
                    if isinstance(j, dict) and j.get("error"):
                        err = str(j.get("error"))[:300]
                    if oracle is not None:
                        check = oracle.check(me, tool, targs, j)
                        if check is not None:
                            rec.write("write-checks", {"request_id": request_id, **check})
                            if not check["passed"]:
                                err = "independent write verification failed"
                except Exception:                            # noqa: BLE001
                    err = "HTTP 200 response was not valid JSON"
        except Exception as e:                               # noqa: BLE001
            err = f"{type(e).__name__}: {e}"[:300]
        end = time.time()
        rec.write("calls", {"t": round(due - t0, 3), "tool": tool,
                            "request_id": request_id, "actor": me, "receipt": receipt,
                            "action": targs.get("action"), "status": status, "state": state,
                            "err": err, "lag_ms": round((begun - due) * 1000, 1),
                            "http_ms": round((response_at - begun) * 1000, 1),
                            "verification_ms": round((end - response_at) * 1000, 1),
                            "total_ms": round((response_at - due) * 1000, 1), "end_t": round(response_at - t0, 3)})

    def one_call(due, me, tool, targs, request_id):
        import contextlib
        with oracle.lock(me, tool, targs) if oracle else contextlib.nullcontext():
            execute_call(due, me, tool, targs, request_id)

    # Plans are complete before the timed window and have byte hashes. Their
    # size stays on disk, independent of duration and the response schedule.
    def write_plan(name, source):
        h, count = hashlib.sha256(), 0
        with (out / f"{name}.jsonl").open("wb") as target:
            for row in source:
                line = (json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode()
                target.write(line)
                h.update(line)
                count += 1
        return {"sha256": h.hexdigest(), "requests": count}

    def tool_plan():
        due, request_id = 0.0, 0
        while rate > 0:
            due += rng.expovariate(rate)
            if due >= args.duration:
                return
            me = rng.choice(live)
            _, tool, build = rng.choices(MIX, weights=weights)[0]
            me, tool, targs = workload.select(me, tool, build(me, ctx), rng)
            request_id += 1
            marker = f"[scale:{args.seed}:{request_id}] "
            for key in ("body", "summary", "note", "title"):
                if key in targs:
                    targs[key] = marker + targs[key]
            for key in ("done_so_far", "working_on_next"):
                if key in targs:
                    targs[key] = [marker + text for text in targs[key]]
            yield {"request_id": request_id, "t": due, "actor": me, "tool": tool, "args": targs}

    def steer_plan():
        due, request_id = 0.0, 0
        while steer_rate > 0:
            due += steer_rng.expovariate(steer_rate)
            if due >= args.duration:
                return
            request_id += 1
            yield {"request_id": request_id, "t": due, "actor": steer_rng.choice(live)}

    def stream_plan():
        marker, tick = 0, 0
        while tick / args.stream_hz < args.duration:
            for node in stream_nodes:
                marker += 1
                yield {"m": marker, "t": tick / args.stream_hz, "node": node,
                       "reset": tick == 0, "text": f"[[m{marker}]] " + stream_ctx.text(40) + " "}
            tick += 1

    if args.plans_dir:
        plan_config = json.loads((args.plans_dir / "config.json").read_text(encoding="utf-8"))
        config["plans"] = {}
        for key, name in (("tools", "plan"), ("steer", "steer-plan"), ("stream", "stream-plan")):
            with (args.plans_dir / (name + ".jsonl")).open(encoding="utf-8") as source:
                actual = write_plan(name, (json.loads(line) for line in source))
            if actual != plan_config["plans"][key]:
                raise ValueError("frozen workload plan changed")
            config["plans"][key] = actual
        workload.substitutions = plan_config["plan_substitutions"]
    else:
        config["plans"] = {"tools": write_plan("plan", tool_plan()),
                           "steer": write_plan("steer-plan", steer_plan()),
                           "stream": write_plan("stream-plan", stream_plan())}
    config["plan_substitutions"] = workload.substitutions
    (out / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")
    if args.plan_only:
        rec.close()
        update_descriptor(root, {"load": {"running": False, "plan_only": True}})
        return 0
    from baseline_oracle import WriteOracle
    oracle = WriteOracle(desc) if args.write_oracle else None
    # Allocate bounded observer capacity before any traffic starts.
    import psycopg
    observer = psycopg.connect(desc["pg_url"], autocommit=True, connect_timeout=5,
        application_name="scale-sampler", options="-c statement_timeout=5000")
    boundary_observer = None
    if oracle:
        from baseline_oracle import table_snapshot
        boundary_observer = psycopg.connect(desc["pg_url"], autocommit=True, connect_timeout=5,
            application_name="scale-boundary-observer",
            options="-c default_transaction_read_only=on -c statement_timeout=120000")
        config["database_before"] = table_snapshot(boundary_observer, oracle.schema)
        config["instrumentation_connections"] = 3
    pools = {"calls": BoundedPool(args.workers), "steer": BoundedPool(max(8, args.workers // 2))}

    def run_plan(name, driver, call):
        pool = pools[driver]
        try:
            with (out / f"{name}.jsonl").open(encoding="utf-8") as source:
                for line in source:
                    job = json.loads(line)
                    due = t0 + job["t"]
                    if stop.wait(max(0, due - time.time())):
                        break
                    values = [due, job["actor"]]
                    if driver == "calls":
                        values += [job["tool"], job["args"]]
                    values += [job["request_id"]]
                    if not pool.submit(call, *values):
                        rec.write("overload", {"t": job["t"], "driver": driver,
                                               "request_id": job["request_id"]})
        finally:
            pool.shutdown(cancel_pending=stop.is_set())

    def call_driver():
        run_plan("plan", "calls", one_call)

    def steer_driver():
        run_plan("steer-plan", "steer", one_steer)

    def one_steer(due: float, me: str, request_id: int) -> None:
        begun = time.time()
        status, err = None, None
        try:
            r = client().post(f"/api/orgs/{slug}/nodes/{me}/steer",
                              json={"tool_use_id": f"toolu_scale_{args.seed}_{request_id}"},
                              headers={"X-Orgtree-Agent-Token": tokens[me]})
            status = r.status_code
            if status != 200:
                err = r.text[:200]
        except Exception as e:                               # noqa: BLE001
            err = f"{type(e).__name__}: {e}"[:200]
        end = time.time()
        rec.write("steer", {"t": round(due - t0, 3), "status": status, "err": err,
                            "request_id": request_id, "actor": me,
                            "lag_ms": round((begun - due) * 1000, 1),
                            "http_ms": round((end - begun) * 1000, 1),
                            "total_ms": round((end - due) * 1000, 1), "end_t": round(end - t0, 3)})

    # ---------------- 2. UI windows + 3. screen feed -----------------------
    feed_tracker = Feed(0 if args.no_ui else args.windows)
    ws_ready = {w: threading.Event() for w in range(0 if args.no_ui else args.windows)}
    ws_state = {w: {"connects": 0, "closes": 0, "frames": 0, "bytes": 0} for w in range(args.windows)}
    ui_changed = {w: threading.Event() for w in range(args.windows)}
    from ui_hooks import WindowDriver
    hook_drivers = {w: WindowDriver(slug,
        stream_nodes[w % len(stream_nodes)] if stream_nodes else live[0],
        w, origin, H, rec, stop) for w in ws_ready} if args.renderer_hooks else {}

    def ui_window(w: int):
        if args.renderer_hooks:
            return hook_drivers[w].run(t0, args.duration)
        c = httpx.Client(base_url=origin, headers=H, timeout=30)
        etags: dict[str, str] = {}
        watch = stream_nodes[w % len(stream_nodes)] if stream_nodes else live[0]
        polls = ui_polls(slug, watch, w, bool(stream_nodes))
        ui_rng = random.Random(args.seed + 100 + w)
        due = {name: t0 + ui_rng.random() * period for name, _, period, _ in polls}
        while not stop.is_set() and time.time() - t0 < args.duration:
            if ui_changed[w].is_set():
                ui_changed[w].clear()
                when = time.time() + 0.120
                for name, _, _, _ in polls:
                    if name != "org_list":
                        due[name] = min(due[name], when)
            name, url, period, cond = min(polls, key=lambda x: due[x[0]])
            d = due[name] - time.time()
            if d > 0:
                if ui_changed[w].wait(min(d, 0.5)):
                    continue
                if stop.is_set():
                    break
                if time.time() < due[name]:
                    continue
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
                             "late_ms": round((begun - due[name]) * 1000, 1),
                             "total_ms": round((end - due[name]) * 1000, 1)})
            due[name] = max(due[name] + period, time.time())

    def ws_window(w: int):
        url = origin.replace("http", "ws") + f"/api/orgs/{slug}/ws?win=scale-w{w}"
        while not stop.is_set():
            try:
                with ws_connect(url, additional_headers=H, max_size=None, open_timeout=30) as s:
                    ws_state[w]["connects"] += 1
                    ws_ready[w].set()
                    rec.write("ws", {"t": round(time.time() - t0, 3), "w": w, "ev": "open"})
                    while not stop.is_set():
                        try:
                            raw = s.recv(timeout=1.0)
                        except TimeoutError:
                            continue
                        now = time.time()
                        ws_state[w]["frames"] += 1
                        ws_state[w]["bytes"] += len(raw)
                        try:
                            frame = json.loads(raw)
                            if w in hook_drivers:
                                hook_drivers[w].event(frame)
                            if frame.get("type") == "changed":
                                ui_changed[w].set()
                        except (ValueError, AttributeError):
                            pass
                        if "[[m" in raw:
                            for m in MARK.finditer(raw):
                                receipt = feed_tracker.receive(w, int(m.group(1)), now)
                                if receipt is not None:
                                    rec.write("feed-receipts", receipt)
            except Exception as e:                           # noqa: BLE001
                rec.write("ws", {"t": round(time.time() - t0, 3), "w": w, "ev": "close",
                                 "why": f"{type(e).__name__}: {e}"[:200]})
            if not stop.is_set():
                ws_state[w]["closes"] += 1
                stop.wait(1.5)                               # the renderer's reconnect delay

    # ---------------- 4. live text ------------------------------------------
    emitted_count = [0]

    def streamer():
        if not stream_nodes:
            return
        seq = 0

        async def submit(c, nodes, first, due):
            nonlocal seq
            frames = []
            now = time.time()
            for node in nodes:
                seq += 1
                feed_tracker.emit(seq, now)
                emitted_count[0] += 1
                rec.write("markers", {"m": seq, "emit": now, "node": node})
                frames.append({"node": node, "reset": first,
                               "text": f"[[m{seq}]] " + stream_ctx.text(40) + " "})
            # Other producers may advance seq while this request awaits I/O.
            # Keep each submission's IDs local for acknowledgement and logs.
            first_seq = seq - len(frames) + 1
            await send_frames(c, frames, first_seq=first_seq, emit=now, due=due,
                              started=t0, feed=feed_tracker, rec=rec)

        async def run():
            # A shared connection limit below the producer count would add
            # another artificial cross-agent admission queue in the client.
            limits = httpx.Limits(max_connections=len(stream_nodes),
                                 max_keepalive_connections=len(stream_nodes))
            async with httpx.AsyncClient(base_url=origin, headers=H, timeout=30, limits=limits) as c:
                if args.renderer_hooks:
                    jobs = {node: [] for node in stream_nodes}
                    with (out / "stream-plan.jsonl").open(encoding="utf-8") as source:
                        for line in source:
                            job = json.loads(line)
                            jobs[job["node"]].append(job)
                    async def producer(rows):
                        for row in rows:
                            due = t0 + row["t"]
                            while time.time() < due and not stop.is_set():
                                await asyncio.sleep(min(.1, max(0, due-time.time())))
                            if stop.is_set():
                                return
                            now = time.time()
                            feed_tracker.emit(row["m"], now)
                            emitted_count[0] += 1
                            rec.write("markers", {"m": row["m"], "emit": now, "node": row["node"], "due": due})
                            await send_frames(c, [{k: row[k] for k in ("node", "reset", "text")}],
                                first_seq=row["m"], emit=now, due=due, started=t0, feed=feed_tracker, rec=rec)
                    await asyncio.gather(*(producer(rows) for rows in jobs.values()))
                else:
                    await drive_streams(stream_nodes, lambda nodes, first, due: submit(c, nodes, first, due),
                        started=t0, duration=args.duration, hz=args.stream_hz, stop=stop, mode=args.stream_mode)
        try:
            asyncio.run(run())
        except Exception as exc:  # fail qualification if a producer itself dies
            rec.write("stream", {"t": time.time() - t0, "frames": 0,
                                 "err": f"stream driver: {type(exc).__name__}: {exc}"[:200]})

    # ---------------- sampler -----------------------------------------------
    def sampler():
        import psycopg
        pg = observer
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
        if pg is not None:
            pg.close()
        sc.close()

    def memory_guard():
        own = psutil.Process()
        while not guard_stop.is_set():
            try:
                em, cm = eproc.memory_info(), own.memory_info()
                free = free_commit_gb()
                eng = getattr(em, "private", em.rss)
                cli = getattr(cm, "private", cm.rss)
                breach = memory_breach(free, eng, cli, floor_gb=args.min_free_commit_gb,
                                       engine_cap_gb=args.max_engine_gb)
                rec.write("guard", {"t": time.time() - t0, "free_commit_gb": free,
                                    "engine_private": eng, "client_private": cli})
            except Exception as exc:
                breach = f"memory guard cannot observe process/headroom: {type(exc).__name__}"
            if (root / "metrics" / "qualification-invalid.json").exists():
                breach = "unexpected external launch; inspect serve-refused.jsonl"
            if breach:
                guard["breach"] = {"t": time.time() - t0, "why": breach}
                # Critical stop evidence must survive driver exceptions/termination.
                (out / "guard-stop.json").write_text(json.dumps(guard["breach"]), encoding="utf-8")
                rec.write("guard-stop", guard["breach"])
                stop.set()
                try:
                    eproc.kill()  # psutil checks process creation identity; PID verified above.
                except psutil.NoSuchProcess:
                    pass
                return
            guard_stop.wait(1)

    threads = [threading.Thread(target=memory_guard, daemon=True, name="memory-guard"),
               threading.Thread(target=sampler, daemon=True, name="sampler"),
               threading.Thread(target=call_driver, daemon=True, name="calls"),
               threading.Thread(target=steer_driver, daemon=True, name="steer"),
               threading.Thread(target=streamer, daemon=True, name="stream")]
    if not args.no_ui:
        for w in range(args.windows):
            threads.append(threading.Thread(target=ui_window, args=(w,), daemon=True, name=f"ui{w}"))
    sockets = [threading.Thread(target=ws_window, args=(w,), daemon=True, name=f"ws{w}")
               for w in ws_ready]
    guard_thread = threads.pop(0)
    guard_thread.start()
    for t in sockets:
        t.start()
    ready_deadline = time.monotonic() + 30
    for ready in ws_ready.values():
        if not ready.wait(max(0, ready_deadline - time.monotonic())):
            stop.set()
            guard_stop.set()
            for t in sockets + [guard_thread]:
                t.join(timeout=35)
            rec.close()
            raise RuntimeError("all websocket windows must connect before measuring")
    steady = (desc["serve"].get("env_orgtree") or {}).get("ORGTREE_SCALE_SIMULATED_PROVIDER") == "1"
    activity_before = httpx.get(origin + "/scale/activity", headers=H, timeout=30).raise_for_status().json()
    t0 = time.time()
    config["started"] = t0
    config["activity_before"] = activity_before
    config["simulation"] = ("Completed synthetic provider turns through real admission/confirmation/finish"
                            if steady else config["simulation"])
    (out / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")
    for t in threads:
        t.start()
    threads += sockets
    try:
        while time.time() - t0 < args.duration and not stop.is_set():
            time.sleep(1)
            if int(time.time() - t0) % 30 == 0:
                free = psutil.virtual_memory()  # physical, for the log only
                rec.write("progress", {"t": round(time.time() - t0), "phys_avail_gb":
                                       round(free.available / 2 ** 30, 2)})
    except KeyboardInterrupt:
        pass
    if not stop.is_set():
        time.sleep(5)  # Final accepted frames get the same five-second delivery horizon.
    feed_tracker.retire(time.time())
    stop.set()
    drain_deadline = time.monotonic() + 90
    for t in threads:
        t.join(timeout=max(0, drain_deadline - time.monotonic()))
    alive = [t.name for t in threads if t.is_alive()]
    if alive:
        (out / "incomplete.json").write_text(json.dumps({"unfinished_threads": alive}), encoding="utf-8")
        eproc.kill()
        raise RuntimeError(f"drivers did not finish; no qualification verdict: {alive}")
    feed_tracker.retire(time.time())
    settlement = None
    if steady and not guard:
        deadline = time.monotonic() + 120
        with httpx.Client(base_url=origin, headers=H, timeout=30) as boundary:
            while time.monotonic() < deadline and not guard:
                settlement = boundary.get("/scale/settlement").raise_for_status().json()
                rec.write("settlement", {"t": time.time() - t0, **settlement})
                activity = settlement["activity"]
                if not any(settlement[k] for k in ("mail", "delivering", "inflight", "busy", "queued")) and (
                        activity["started"] == activity["finished"]):
                    break
                time.sleep(2)
    guard_stop.set()
    guard_thread.join(timeout=5)
    rec.close()

    # ---------------- summary ------------------------------------------------
    def rows(name):
        f = out / f"{name}.jsonl"
        if f.exists():
            with f.open(encoding="utf-8") as source:
                for line in source:
                    yield json.loads(line)
    calls, ui, samples = list(rows("calls")), list(rows("ui")), list(rows("samples"))
    from array import array
    steer_latencies, steer_errors, steer_error_examples = array("d"), 0, set()
    for row in rows("steer"):
        steer_latencies.append(row["total_ms"])
        if row["err"]:
            steer_errors += 1
            if len(steer_error_examples) < 3:
                steer_error_examples.add(str(row["err"])[:160])
    by_tool: dict[str, list] = {}
    for c in calls:
        by_tool.setdefault(c["tool"] + (":" + c["action"] if c.get("action") else ""), []).append(c)
    tools_summary = {k: {"total_ms": pct([c["total_ms"] for c in v]),
                         "http_ms": pct([c["http_ms"] for c in v]),
                         "successful_total_ms": pct([c["total_ms"] for c in v
                                                     if not c["err"] and c["status"] == 200]),
                         "errors": sum(1 for c in v if c["err"] or c["status"] != 200),
                         "running": sum(1 for c in v if c.get("state") == "running"),
                         "sample_errors": list({str(c["err"])[:160] for c in v if c["err"]})[:3]}
                     for k, v in sorted(by_tool.items())}
    by_route: dict[str, list] = {}
    for u in ui:
        by_route.setdefault(u["route"], []).append(u)
    routes_summary = {k: {"ms": pct([u["ms"] for u in v]),
                          "total_ms": pct([u["total_ms"] for u in v]),
                          "ms_200": pct([u["ms"] for u in v if u["status"] == 200]),
                          "n304": sum(1 for u in v if u["status"] == 304),
                          "errors": sum(1 for u in v if u["err"]),
                          "bytes_200": pct([u["bytes"] for u in v if u["status"] == 200])}
                      for k, v in sorted(by_route.items())}
    feed = {w: {"latency_ms": pct(feed_tracker.latencies[w]),
                "emitted_due": c["due"], "missing_after_5s": c["missing"],
                "over_1s": c["over_1s"], **ws_state[w]}
            for w, c in feed_tracker.counts.items()}
    mem = [(row["t"], row["engine_private"]) for row in rows("guard")
           if 0 <= row["t"] <= args.duration]
    def slope(pts):
        if len(pts) < 3:
            return None
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        den = sum((x - mx) ** 2 for x in xs) or 1
        return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    half = mem[len(mem) // 2:]
    elapsed = min(args.duration, time.time() - t0)
    completed_in_window = sum(c["end_t"] <= args.duration for c in calls)
    stream_errors = sum(bool(row["err"]) for row in rows("stream"))
    counters = {name: dict(pool.counts) for name, pool in pools.items()}
    ui_counters = {w: dict(driver.pool.counts) for w, driver in hook_drivers.items()}
    valid = not guard and not steer_errors and not stream_errors and not any(c["err"] for c in calls + ui)
    valid = valid and not any(v["rejected"] or v["cancelled"] or v["worker_errors"] for v in counters.values())
    plan_counts = dict(calls=config["plans"]["tools"]["requests"], steer=config["plans"]["steer"]["requests"])
    valid = valid and all(counters[name]["completed"] == count for name, count in plan_counts.items())
    if not args.no_ui:
        valid = valid and all(any(u["w"] == w for u in ui) for w in range(args.windows))
    if stream_nodes:
        valid = valid and emitted_count[0] > 0
        if args.renderer_hooks:
            valid = valid and emitted_count[0] == config["plans"]["stream"]["requests"]
    if feed_tracker.pending or any(x["missing_after_5s"] or x["closes"] for x in feed.values()):
        valid = False
    if steady:
        settled = bool(settlement) and not any(settlement[k] for k in ("mail", "delivering", "inflight", "busy", "queued"))
        activity = (settlement or {}).get("activity", {})
        provider = activity.get("provider", {})
        # A successful no-op workload cannot stand in for turn completion.
        progressed = provider.get("completed", 0) > activity_before.get("provider", {}).get("completed", 0)
        valid = valid and settled and progressed and not provider.get("failed") and activity.get("started") == activity.get("finished")
        valid = valid and not provider.get("failed_bookings") and provider.get("booked") == provider.get("completed")
    activity_after = httpx.get(origin + "/scale/activity", headers=H, timeout=30).raise_for_status().json()
    valid = valid and activity_after["launch_attempts"]["unexpected"] == 0
    valid = valid and not any(c["rejected"] or c["worker_errors"] or c["cancelled"]
                             for c in ui_counters.values())
    oracle_counts = dict(oracle.counts) if oracle else None
    database_after = None
    if oracle:
        database_after = table_snapshot(boundary_observer, oracle.schema)
        boundary_observer.close()
        valid = valid and not oracle_counts["failed"] and oracle_counts["acknowledged"] == oracle_counts["checked"]
        oracle.close()
    valid = valid and not (root / "metrics" / "qualification-invalid.json").exists()
    summary = {"activity_after": activity_after, "config": config, "guard": guard or None, "settlement": settlement,
               "workload_completed_without_errors_or_overload": bool(valid),
               "qualification": "Per-target assessment required; this field does not certify renderer or 60-minute stability.",
               "client_counters": counters, "ui_counters": ui_counters,
               "write_oracle": oracle_counts, "workload_substitutions": workload.substitutions,
               "database_after": database_after,
               "achieved": {"calls": len(calls), "calls_per_s": round(completed_in_window / elapsed, 2),
                            "completed_in_window": completed_in_window, "drain_finished_s": time.time() - t0,
                            "offered_calls_per_s": rate, "steer_polls": len(steer_latencies),
                            "offered_steer_per_s": steer_rate,
                            "ui_requests": len(ui), "stream_markers": emitted_count[0],
                            "stream_markers_failed_submit": feed_tracker.failed,
                            "stream_markers_not_yet_assessed": len(feed_tracker.pending)},
               "tools": tools_summary, "routes": routes_summary, "feed": feed,
               "steer": {"total_ms": pct(steer_latencies), "errors": steer_errors,
                         "sample_errors": list(steer_error_examples)},
               "memory": {"start_mb": round(mem[0][1] / 2 ** 20) if mem else None,
                          "end_mb": round(mem[-1][1] / 2 ** 20) if mem else None,
                          "max_mb": round(max(m for _, m in mem) / 2 ** 20) if mem else None,
                          "observed_seconds": mem[-1][0] - mem[0][0] if mem else 0,
                          "samples": len(mem),
                          "slope_mb_per_min_2nd_half": round(slope(half) * 60 / 2 ** 20, 2) if slope(half) is not None else None},
               "cpu": pct([s["cpu"] for s in samples if s.get("cpu") is not None]),
               "pg": {"conns": pct([s["pg_conns"] for s in samples if "pg_conns" in s]),
                      "lock_wait": pct([s["pg_lock_wait"] for s in samples if "pg_lock_wait" in s]),
                      "locks_waiting": pct([s["pg_locks_waiting"] for s in samples if "pg_locks_waiting" in s])},
               "ws_engine": [s["ws"] for s in samples if "ws" in s][-1:] or None}
    from baseline_measurement import summarize_window
    summary["measurement"] = summarize_window(out, config)
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    update_descriptor(root, {"load": {"running": False, "rate": rate, "since": t0, "ended": time.time(),
                                      "label": label, "windows": args.windows,
                                      "stream_nodes": stream_nodes, "stream_hz": args.stream_hz,
                                      "markers": str(out / "markers.jsonl"),
                                      "summary": str(out / "summary.json")}})
    print(json.dumps({"label": label, "achieved": summary["achieved"], "memory": summary["memory"],
                      "cpu": summary["cpu"]}, indent=1))
    return 0 if valid else 2


if __name__ == "__main__":
    sys.exit(main())
