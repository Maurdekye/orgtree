"""Seed a THROWAWAY v3 PostgreSQL data root with N live agents, shaped like the real org.

    engine\\runtime\\python.exe tools/scale/seed.py --root <ABS throwaway dir> --agents N
        [--slug scale] [--archived-per-live 1.0] [--admin-url <PG superuser url>]
        [--transcript-kb 256] [--seed 1]

What it builds (v3-scale-qualification-stay-responsive-with-hund):
- a fresh PostgreSQL database on a LOOPBACK dev cluster (default: `devdb` cluster
  of agent mem-leak-probe), dropped only by `--drop`;
- `<root>/data` (ORGTREE_DATA), `<root>/home` (HOME/USERPROFILE), `<root>/temp`;
- ONE org with N LIVE agents in a realistic tree (coordinators → leads → workers)
  plus `archived-per-live × N` retired agents;
- per live agent, sizes drawn from the live org's shape profile
  (`live-shape-profile.json`, measured 2026-09-26 on an online-backup copy of the
  operator org: 24 live / 971 nodes): node `turns` history, MCP tool list,
  mail_log / steered_log / steer_attempts rows, events, ~4 docket items with
  history, a synthetic Claude-CLI transcript of `--transcript-kb`;
  watchdogs (1 per 8 live agents) and reservations (1 per 3 live agents);
- `<root>/scale-descriptor.json` (schema orgtree-scale-v1), consumed by serve.py,
  load.py and the renderer harness.

The org document, nodes and docket go through the real store (`store.save_org`).
The bulky append-only log rows are then COPY'd straight into the org schema's
`log_d` / `log_l` tables — the same rows `save_org` would write — so seeding 2000
agents does not need the whole history in one Python process.

Safety: the root must be a new or empty directory outside every live Orgtree
root; the PG URL must be loopback; the child scrubs ORGTREE_/provider env and
forbids every external process (no CLI can start).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

REPO = Path(__file__).resolve().parents[2]
SCHEMA = "orgtree-scale-v1"
DB_PREFIX = "orgtree_scale_"
LIVE_ROOTS = [os.path.expandvars(r"%APPDATA%\Orgtree v2"), os.path.expandvars(r"%APPDATA%\Orgtree")]

# Live-org quantiles (bytes / rows), from live-shape-profile.json 2026-09-26.
PROFILE = {
    "mail_log_rows": (94, 112, 205), "mail_log_bytes": (1083, 4210, 16061, 200_000),
    "steered_log_rows": (46, 276, 596), "steered_log_bytes": (2024, 7299, 19779, 200_000),
    "steer_attempts_rows": (58, 99, 140), "steer_attempts_bytes": (525, 8752, 41662, 170_000),
    "turns": (230, 600, 1500),
    "work_item_bytes": (6821, 130_900, 1_000_000, 1_000_000),
    "charter_chars": (1036, 3867, 5620, 6106),
    "events_per_live": 40,
}


def quantile_draw(rng: random.Random, q: tuple) -> int:
    """Piecewise-linear draw through (p50, p90, p99[, max]) — a heavy tail
    like the live distributions, without inventing a parametric fit."""
    pts = [(0.0, max(1, q[0] // 8)), (0.5, q[0]), (0.9, q[1]), (0.99, q[2]),
           (1.0, q[3] if len(q) > 3 else q[2])]
    u = rng.random()
    for (u0, v0), (u1, v1) in zip(pts, pts[1:]):
        if u <= u1:
            return int(v0 + (v1 - v0) * (u - u0) / (u1 - u0 or 1))
    return int(pts[-1][1])


WORDS = ("orgtree engine agent docket review landing commit measure memory websocket "
         "postgres transaction lock latency window renderer charter watchdog reservation "
         "mail steer transcript probe baseline rebase worktree release coordinator").split()


def text(rng: random.Random, n: int) -> str:
    out, size = [], 0
    while size < n:
        w = rng.choice(WORDS)
        out.append(w)
        size += len(w) + 1
    return " ".join(out)[:n]


def iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ------------------------------------------------------------------ parent side

def _devdb_admin_url() -> str:
    tool = REPO.parents[1] / "artifacts" / "p03-tools" / "devdb.cmd" \
        if (REPO.parents[1] / "artifacts").exists() else Path(r"E:\Libraries\Desktop\orgtree\artifacts\p03-tools\devdb.cmd")
    subprocess.run(["cmd", "/c", str(tool), "up", "--agent", "mem-leak-probe"],
                   capture_output=True, text=True, timeout=300, check=True)
    out = subprocess.run(["cmd", "/c", str(tool), "env", "--agent", "mem-leak-probe"],
                         capture_output=True, text=True, timeout=120, check=True).stdout
    m = re.search(r"P03_PG_ADMIN_URL='([^']+)'", out)
    if not m:
        raise RuntimeError("devdb env printed no P03_PG_ADMIN_URL")
    return m.group(1)


def _check_root(root: Path) -> None:
    if not root.is_absolute():
        raise SystemExit("--root must be absolute")
    r = str(root.resolve()).lower()
    for live in LIVE_ROOTS:
        if live and r.startswith(os.path.normcase(os.path.abspath(live)).lower()) \
                and "\\scratch\\" not in r:
            raise SystemExit(f"--root {root} is inside a live Orgtree root")
    if root.exists() and any(root.iterdir()):
        raise SystemExit(f"--root {root} exists and is not empty")


def _free_commit_gb() -> float | None:
    try:
        import psutil
        vm = psutil.virtual_memory()
        # Windows commit charge: swap_memory is the page file; psutil has no
        # direct commit counter, so ask the OS (same as pg5_load).
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return round(int(out) / 1024 / 1024, 2)
    except Exception:                                        # noqa: BLE001
        return None


def _create_db(admin: str, name: str) -> str:
    import psycopg
    if not re.search(r"@(127\.0\.0\.1|localhost|\[::1\]):", admin):
        raise SystemExit("the PostgreSQL admin URL must be a loopback (disposable) server")
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {name}")
    p = urlsplit(admin)
    return urlunsplit((p.scheme, p.netloc, "/" + name, p.query, p.fragment))


def child_env(root: Path, pg_url: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
        ("ORGTREE_", "OPENAI_", "ANTHROPIC_", "CLAUDE_", "CODEX_", "GEMINI_", "GOOGLE_API", "PYTHON"))}
    env.update(ORGTREE_DATA=str(root / "data"), ORGTREE_STORE="postgres", ORGTREE_PG_URL=pg_url,
               HOME=str(root / "home"), USERPROFILE=str(root / "home"),
               APPDATA=str(root / "home"), LOCALAPPDATA=str(root / "home"),
               XDG_CONFIG_HOME=str(root / "home"),
               TEMP=str(root / "temp"), TMP=str(root / "temp"), TMPDIR=str(root / "temp"),
               ORGTREE_V2_TOKEN="scale-seed-only", PYTHONIOENCODING="utf-8",
               PYTHONDONTWRITEBYTECODE="1", GIT_OPTIONAL_LOCKS="0", ORGTREE_WARM="0")
    return env


def parent(args) -> int:
    root = Path(args.root)
    _check_root(root)
    free = _free_commit_gb()
    if free is not None and free < args.min_free_commit_gb:
        raise SystemExit(f"free commit {free} GB < floor {args.min_free_commit_gb} GB; not seeding")
    for d in ("data", "home", "temp"):
        (root / d).mkdir(parents=True, exist_ok=True)
    admin = args.admin_url or os.environ.get("P03_PG_ADMIN_URL") or _devdb_admin_url()
    db = f"{DB_PREFIX}{re.sub(r'[^a-z0-9]', '', args.slug.lower())}_{args.agents}_{os.getpid()}"
    pg_url = _create_db(admin, db)
    desc = {"schema": SCHEMA, "agents": args.agents, "org": args.slug,
            "data_root": str(root / "data"), "home": str(root / "home"), "root": str(root),
            "pg_url": pg_url, "pg_database": db, "engine_commit": None,
            "origin": None, "token": None, "load": {"running": False},
            "seed": {"started_at": iso(time.time()), "config": vars(args) | {"admin_url": "<redacted>"}}}
    (root / "scale-descriptor.json").write_text(json.dumps(desc, indent=1), encoding="utf-8")
    cmd = [args.python or sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--child",
           "--root", str(root), "--agents", str(args.agents), "--slug", args.slug,
           "--archived-per-live", str(args.archived_per_live), "--transcript-kb",
           str(args.transcript_kb), "--seed", str(args.seed),
           "--active-items", str(args.active_items),
           "--archived-items-per-live", str(args.archived_items_per_live)]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=REPO, env=child_env(root, pg_url), text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode:
        print(f"seed child failed ({r.returncode}); database {db} left for inspection", file=sys.stderr)
        return r.returncode
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    desc["seed"]["wall_s"] = round(time.time() - t0, 1)
    desc["seed"]["free_commit_gb"] = {"before": free, "after": _free_commit_gb()}
    (root / "scale-descriptor.json").write_text(json.dumps(desc, indent=1), encoding="utf-8")
    print(json.dumps({k: desc[k] for k in ("agents", "org", "root", "pg_database", "engine_commit")}
                     | {"seed": desc["seed"].get("summary"), "wall_s": desc["seed"]["wall_s"]}))
    return 0


# ------------------------------------------------------------------- child side

def child(args) -> int:
    root = Path(args.root).resolve()
    sys.path.insert(0, str(REPO / "tools"))
    from assert_repo_import import assert_repo_import
    prov = assert_repo_import(str(REPO))
    receipt = prov.receipt()

    def forbid(event, a):
        if event in {"subprocess.Popen", "os.system", "os.startfile", "os.posix_spawn", "os.spawn"}:
            cmd = a[1] if len(a) > 1 else a
            if "git" in str(cmd).lower() and ("rev-parse" in str(cmd) or "status" in str(cmd)):
                return
            raise RuntimeError(f"scale seed forbids external process: {event} {str(cmd)[:120]}")
    sys.addaudithook(forbid)

    from orgtree import ledger, pgstore, store
    if Path(store.DATA_ROOT).resolve() != (root / "data").resolve():
        raise RuntimeError("store escaped the scale data root")
    if store.STORE_BACKEND != "postgres":
        raise RuntimeError(f"store is on {store.STORE_BACKEND}, not postgres")
    rng = random.Random(args.seed)
    N, slug = args.agents, args.slug
    t_start = time.time()
    store.claim_data_root()
    org = store.create_org(slug)
    now = time.time()

    # --- tree: coordinators (1 per 100), leads (1 per 10), workers ----------
    tools = {"bash": False, "edit": False, "web": False, "subagents": False, "mcp": []}
    live: list[str] = []
    n_coord = max(1, N // 100)
    n_lead = max(1, N // 10)
    coords = [f"coord-{i}" for i in range(n_coord)]
    for c in coords:
        org.hire(ledger.USER, None, "haiku", 0, c, add_dirs=[], tools=tools,
                 org_visibility="self", charter=text(rng, quantile_draw(rng, PROFILE["charter_chars"])))
        live.append(c)
    leads = []
    for i in range(min(n_lead, N - len(live))):
        name = f"lead-{i}"
        org.hire(ledger.USER, coords[i % n_coord], "haiku", 0, name, add_dirs=[], tools=tools,
                 org_visibility="self", charter=text(rng, quantile_draw(rng, PROFILE["charter_chars"])))
        leads.append(name)
        live.append(name)
    i = 0
    while len(live) < N:
        name = f"worker-{i}"
        org.hire(ledger.USER, leads[i % len(leads)], "haiku", 0, name, add_dirs=[], tools=tools,
                 org_visibility="self", charter=text(rng, quantile_draw(rng, PROFILE["charter_chars"])))
        live.append(name)
        i += 1
    t_hire = time.time()

    # archived agents: hired under a lead, then retired through the real API
    archived = []
    for j in range(int(N * args.archived_per_live)):
        name = f"retired-{j}"
        org.hire(ledger.USER, leads[j % len(leads)], "haiku", 0, name, add_dirs=[], tools=tools,
                 org_visibility="self", charter=text(rng, 400))
        archived.append(name)
    for name in archived:
        org.retire(ledger.USER, name)
    t_retire = time.time()

    # --- live node fields the real org carries (turns, tools, cache) -------
    mcp_tools = [f"mcp__orgtree__orgtree_{w}" for w in (
        "message", "send_notice", "status", "work", "watchdog", "reservation", "chart", "hire",
        "retire", "rehire", "retool", "read_transcript", "read_scratch", "ask", "present",
        "send_file", "staff", "audience", "capabilities", "state_inspect")] + \
        [f"mcp__tool__t{k}" for k in range(20)]
    sessions: dict[str, str] = {}
    for nid in live:
        n = org.nodes[nid]
        k = quantile_draw(rng, PROFILE["turns"])
        t0 = now - 86400 * 3
        n["turns"] = [{"at": iso(t0 + x * 300), "cost": round(rng.random() * 3, 4),
                       "ms": rng.randint(2000, 90000), "denials": 0,
                       "toks": rng.randint(200, 5000), "ran_as": "primary"} for x in range(k)]
        n["last_turn_mcp_tools"] = mcp_tools
        n["cache_continuity"] = {"version": 1, "seq": rng.randint(1, 60),
                                 "forecast": {"state": "compatible_observed",
                                              "reason": text(rng, 300)}}
        sid = str(uuid.UUID(int=rng.getrandbits(128)))
        n["session_id"] = sid
        sessions[nid] = sid
    t_nodes = time.time()

    # --- docket: live ratio is ~4 active items per live agent (100 / 24), but
    # the product caps the ACTIVE docket at 200 per org (ledger.work_create), so
    # seed min(4N, 180) active items round-robin over live agents; the rest of
    # the history goes into work_items_archive rows below (2 per live agent).
    items = 0
    statuses = ["backlogged"] * 53 + ["blocked"] * 31 + ["in_progress"] * 11 + ["open"] * 5
    n_active = min(4 * N, args.active_items)
    template = None
    owners = [live[i % len(live)] for i in range(n_active)]
    for k, nid in enumerate(owners):
        if True:
            st = rng.choice(statuses)
            kw = {"blocked_reason": "waiting on a synthetic dependency"} if st == "blocked" else {}
            it = org.work_create(nid, title=f"{nid} task {k}: {text(rng, 40)}",
                                 objective=text(rng, 800), owner=nid,
                                 done_so_far=[text(rng, 120)], working_on_next=[text(rng, 120)],
                                 status=st, **kw)
            target = quantile_draw(rng, PROFILE["work_item_bytes"])
            want = it.get("slug") or it.get("created")
            w = next((x for x in reversed(org.d.get("work_items") or [])
                      if isinstance(x, dict) and x.get("slug") == want), None)
            if w is None:
                raise RuntimeError("seeded work item not found in org.d['work_items']")
            if w is not None:
                have = len(json.dumps(w))
                while have < target:
                    ev = {"at": iso(now - rng.random() * 86400), "by": nid, "op": "evidence",
                          "note": text(rng, min(4000, target - have + 50))}
                    w.setdefault("evidence", []).append(ev)
                    have += len(json.dumps(ev))
            if template is None and w is not None:
                template = json.loads(json.dumps(w))
            items += 1
    t_work = time.time()

    # --- watchdogs (1 per 8 live) and reservations (1 per 3 live) ----------
    wd_dir = root / "data" / "scale-watch"
    wd_dir.mkdir(exist_ok=True)
    (wd_dir / "never.log").write_text("", encoding="utf-8")
    wds = 0
    for nid in live[::8]:
        try:
            org.watchdog_create(nid, f"{nid}-tripwire", "file", str(wd_dir / "never.log"),
                                pattern="NEVER_MATCHES_\\d{9}", interval_s=60)
            wds += 1
        except Exception as e:                              # noqa: BLE001
            print("watchdog skipped:", nid, type(e).__name__, str(e)[:120], file=sys.stderr)
            break
    res = org.d.setdefault("reservations", [])
    for nid in live[::3]:
        t = now - rng.random() * 3600
        res.append({"id": f"res-{uuid.UUID(int=rng.getrandbits(128)).hex[:20]}", "owner": nid,
                    "item": "", "resource": "main", "candidate": "d379d07", "base": "cb702e7",
                    "paths": [], "state": rng.choice(["landed", "landed", "released", "active"]),
                    "created_at": iso(t), "updated_at": iso(t + 30), "created_ts": t,
                    "updated_ts": t + 30, "expires_ts": t + 900, "expires_at": iso(t + 900),
                    "heartbeat_ts": t, "heartbeat_at": iso(t), "stale_s": 300.0})
    t_misc = time.time()
    store.save_org(org)
    t_save = time.time()
    del org

    # --- bulk history rows: log_d (mail_log, steered_log, steer_attempts), log_l (events)
    import psycopg
    with psycopg.connect(pgstore.url()) as conn:
        row = conn.execute("SELECT org_id FROM public.orgs WHERE slug=%s", (slug,)).fetchone()
        if not row:
            raise RuntimeError("org not found in public.orgs")
        schema = f"org_{row[0]}"             # pgstore: each org's rows live in org_<org_id>
        rows_d = rows_l = bytes_d = 0
        with conn.cursor() as cur:
            with cur.copy(f'COPY "{schema}".log_d (sect, owner, at, val) FROM STDIN') as cp:
                for nid in live:
                    for k in range(quantile_draw(rng, PROFILE["mail_log_rows"])):
                        t = now - rng.random() * 86400 * 7
                        mid = uuid.UUID(int=rng.getrandbits(128)).hex[:12]
                        v = json.dumps({"id": mid, "from": rng.choice(live), "kind": "message",
                                        "body": text(rng, quantile_draw(rng, PROFILE["mail_log_bytes"])),
                                        "at": iso(t), "relationship": "your peer",
                                        "message_id": mid, "operation_id": f"mail:{mid}"})
                        cp.write_row(("mail_log", nid, iso(t), v)); rows_d += 1; bytes_d += len(v)
                    for k in range(quantile_draw(rng, PROFILE["steered_log_rows"])):
                        t = now - rng.random() * 86400 * 7
                        did = uuid.UUID(int=rng.getrandbits(128)).hex[:16]
                        body = text(rng, quantile_draw(rng, PROFILE["steered_log_bytes"]))
                        v = json.dumps({"at": iso(t), "delivery_id": did, "level": "recorded",
                                        "mail_ids": [did[:12]], "delivery_ids": [did],
                                        "acked_ids": [did], "recorded_ids": [did], "attempts": 1,
                                        "retried": False, "confirmed_duplicate": False,
                                        "text": "[MAIL — 1 message(s)]\n" + body,
                                        "visible_id": f"steer:{did}:1",
                                        "segments": [{"kind": "mail", "rows": [
                                            {"id": did[:12], "from": "coordinator", "kind": "message",
                                             "body": body[:200], "at": iso(t)}]}]})
                        cp.write_row(("steered_log", nid, iso(t), v)); rows_d += 1; bytes_d += len(v)
                    for k in range(quantile_draw(rng, PROFILE["steer_attempts_rows"])):
                        t = now - rng.random() * 86400 * 7
                        did = uuid.UUID(int=rng.getrandbits(128)).hex[:16]
                        v = json.dumps([did, {"at": iso(t), "resolved": "recorded",
                                              "text": text(rng, quantile_draw(rng, PROFILE["steer_attempts_bytes"]))}])
                        cp.write_row(("steer_attempts", nid, iso(t), v)); rows_d += 1; bytes_d += len(v)
            with cur.copy(f'COPY "{schema}".log_l (sect, at, val) FROM STDIN') as cp:
                archived_items = 0
                for j in range(int(N * args.archived_items_per_live)):
                    nid = live[j % len(live)]
                    it = json.loads(json.dumps(template))
                    t = now - rng.random() * 86400 * 30
                    it.update(slug=f"archived-{j}-{uuid.UUID(int=rng.getrandbits(128)).hex[:8]}",
                              title=f"{nid} archived {j}: {text(rng, 40)}", status="done",
                              owner={"node": nid, "generation": 0}, archived_at=iso(t),
                              updated_at=iso(t))
                    target = quantile_draw(rng, PROFILE["work_item_bytes"])
                    it["evidence"] = [{"at": iso(t), "by": nid, "op": "evidence",
                                       "note": text(rng, max(0, target - 3000))}]
                    cp.write_row(("work_items_archive", iso(t), json.dumps(it))); rows_l += 1
                    archived_items += 1
                for nid in live:
                    for k in range(PROFILE["events_per_live"]):
                        t = now - rng.random() * 86400 * 7
                        v = json.dumps({"op": rng.choice(["status", "mail", "work", "turn"]),
                                        "actor": nid, "at": iso(t), "detail": {"node": nid}, "warnings": []})
                        cp.write_row(("events", iso(t), v)); rows_l += 1
        conn.commit()
    t_logs = time.time()

    # --- synthetic Claude-CLI transcripts, one per live agent ---------------
    proj = root / "home" / ".claude" / "projects" / f"scale-{slug}"
    proj.mkdir(parents=True, exist_ok=True)
    tbytes = 0
    for nid, sid in sessions.items():
        target = args.transcript_kb * 1024
        lines, size, parent_uuid = [], 0, None
        t = now - 86400
        while size < target:
            u1 = str(uuid.UUID(int=rng.getrandbits(128)))
            user = {"type": "user", "message": {"role": "user", "content": text(rng, rng.randint(80, 600))},
                    "uuid": u1, "parentUuid": parent_uuid, "timestamp": iso(t), "sessionId": sid,
                    "cwd": str(root / "home"), "isSidechain": False, "userType": "external"}
            u2 = str(uuid.UUID(int=rng.getrandbits(128)))
            asst = {"type": "assistant", "uuid": u2, "parentUuid": u1, "timestamp": iso(t + 5),
                    "sessionId": sid, "cwd": str(root / "home"), "isSidechain": False,
                    "userType": "external",
                    "message": {"id": "msg_" + u2.replace("-", "")[:24], "type": "message",
                                "role": "assistant", "model": "claude-haiku-4-5",
                                "content": [{"type": "text", "text": text(rng, rng.randint(200, 3000))}],
                                "stop_reason": "end_turn",
                                "usage": {"input_tokens": rng.randint(100, 4000),
                                          "output_tokens": rng.randint(50, 800),
                                          "cache_read_input_tokens": rng.randint(0, 50000)}}}
            for rec in (user, asst):
                s = json.dumps(rec)
                lines.append(s)
                size += len(s) + 1
            parent_uuid, t = u2, t + 60
        (proj / f"{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        tbytes += size
    t_tr = time.time()

    summary = {"live": len(live), "coordinators": len(coords), "leads": len(leads),
               "archived": len(archived), "work_items": items,
               "work_items_archived": archived_items, "watchdogs": wds,
               "reservations": len(res), "log_d_rows": rows_d, "log_d_bytes": bytes_d,
               "log_l_rows": rows_l, "transcripts": len(sessions), "transcript_bytes": tbytes,
               "phase_s": {"hire": round(t_hire - t_start, 1), "retire": round(t_retire - t_hire, 1),
                           "nodes": round(t_nodes - t_retire, 1), "work": round(t_work - t_nodes, 1),
                           "misc": round(t_misc - t_work, 1), "save_org": round(t_save - t_misc, 1),
                           "logs_copy": round(t_logs - t_save, 1), "transcripts": round(t_tr - t_logs, 1)}}
    desc_path = root / "scale-descriptor.json"
    desc = json.loads(desc_path.read_text(encoding="utf-8"))
    desc["engine_commit"] = (prov.commit or "") + ("+dirty" if prov.dirty else "")
    desc["provenance"] = receipt
    desc["seed"]["summary"] = summary
    desc["live_agents"] = live
    desc_path.write_text(json.dumps(desc, indent=1), encoding="utf-8")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--root", required=True)
    p.add_argument("--agents", type=int, required=True)
    p.add_argument("--slug", default="scale")
    p.add_argument("--archived-per-live", type=float, default=1.0)
    p.add_argument("--transcript-kb", type=int, default=256)
    p.add_argument("--active-items", type=int, default=180, help="active docket items (product cap 200)")
    p.add_argument("--archived-items-per-live", type=float, default=2.0)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--admin-url", default=None)
    p.add_argument("--python", default=None, help="interpreter for the child (default: this one)")
    p.add_argument("--min-free-commit-gb", type=float, default=10.0)
    p.add_argument("--child", action="store_true")
    args = p.parse_args(argv)
    return child(args) if args.child else parent(args)


if __name__ == "__main__":
    sys.exit(main())
