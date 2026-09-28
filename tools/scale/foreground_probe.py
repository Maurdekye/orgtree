"""M1 probe for foreground-tree-at-n1000-full-server-rebuilds-on (harness only).

Seeds the same tiny N=10 and N=100 orgs as rows_preflight, serves each with
SQL counters AND per-query labels on, and records for GET /foreground-tree:

- the cold snapshot body, raw (identity) and on the wire (gzip);
- PG value bytes per statement shape and per result column inside a rebuild;
- the stored node body (nodes.val) bytes per top-level key, live nodes only;
- after each kind of change, a conditional GET with the previous ETag:
  HTTP status, answer kind (delta/snapshot), body bytes and the server's SQL
  work, which tells a full rebuild from the status fast path.

Nothing here is judged; the receipt is evidence for the fix plan.
"""
import json
import os
import sys
import time

import httpx

SIZES = tuple(int(n) for n in os.environ.get("FG_PROBE_SIZES", "10,100").split(","))
KIND = "fg-probe"
# FG_PROBE_DIAG=0: timers only. SQL counters, labels and the why-log add work
# inside the measured read, so a timing arm must run without them.
DIAG = os.environ.get("FG_PROBE_DIAG", "1") == "1"


def _get(client, url, label, etag=None, gzip=True):
    headers = {"X-Scale-Kind": f"{KIND}:{label}",
               "Accept-Encoding": "gzip" if gzip else "identity"}
    if etag:
        headers["If-None-Match"] = etag
    started = time.perf_counter()
    response = client.get(url, headers=headers)
    elapsed = time.perf_counter() - started
    if response.status_code not in (200, 304):
        response.raise_for_status()
    row = dict(label=label, status=response.status_code, client_seconds=elapsed,
               wire_bytes=response.num_bytes_downloaded, body_bytes=len(response.content),
               etag=response.headers.get("ETag"), sent_etag=etag)
    if response.status_code == 200:
        body = response.json()
        row["answer_kind"] = body.get("kind")
        row["nodes"] = len(body.get("nodes") or {})
    return row


def _agent(client, org, actor, token, tool, args, label):
    response = client.post("/api/agent", json=dict(org=org, node=actor, tool=tool, args=args),
                           headers={"X-Orgtree-Agent-Token": token, "X-Scale-Kind": f"{KIND}:{label}"})
    return dict(label=label, status=response.status_code, tool=tool)


def calls(desc):
    headers = {"X-Orgtree-Desktop-Token": desc["token"]}
    out = []
    with httpx.Client(base_url=desc["origin"], headers=headers, timeout=120) as client:
        tokens = client.get("/scale/tokens", headers={"X-Scale-Kind": f"{KIND}:tokens"}).raise_for_status().json()
        parents = client.get("/scale/workload", headers={"X-Scale-Kind": f"{KIND}:workload"}
                             ).raise_for_status().json()["parents"]
        org = desc["org"]
        url = f"/api/orgs/{org}/foreground-tree"
        target = sorted(desc["live_agents"])[0]
        actor = parents.get(target) or next(n for n, p in parents.items() if p == target)
        cold = _get(client, url, "cold-identity", gzip=False); out.append(cold)
        warm = _get(client, url, "warm-gzip"); out.append(warm)
        etag = warm["etag"]
        same = _get(client, url, "unchanged", etag); out.append(same)
        etag = same["etag"] or etag
        def after(label, tool, args, settle=0.0):
            nonlocal etag
            out.append(_agent(client, org, actor, tokens[actor], tool, args, label + "-write"))
            if settle:
                time.sleep(settle)
            row = _get(client, url, label, etag); out.append(row)
            etag = row["etag"] or etag
        after("status", "orgtree_status", dict(status="working", summary="[fg-probe] status only"))
        after("message", "orgtree_message", dict(to=target, kind="message",
              body="[fg-probe] synthetic message."), settle=3.0)
        # Let the simulated turn the message may have started finish too.
        row = _get(client, url, "message-settled", etag); out.append(row)
        etag = row["etag"] or etag
        after("work-create", "orgtree_work", dict(action="create", title="fg-probe item",
              objective="Synthetic probe item. It exists only in the throwaway org.", kind="non-code"))
        # Runtime stamp includes a 30 s wall-clock bucket: cross one boundary
        # with no write at all.
        bucket = int(time.time() // 30)
        while int(time.time() // 30) == bucket:
            time.sleep(0.25)
        time.sleep(0.5)
        row = _get(client, url, "time-bucket", etag); out.append(row)
        etag = row["etag"] or etag
        out.append(_get(client, url, "time-bucket-again", etag))
        if REPS:
            out.extend(proof(client, desc, tokens, actor, url, row["etag"] or etag))
    return out


# N1000 proof (FG_PROBE_REPS > 0): repeated warm reads, each right after one
# foreground-style write, while a background thread applies status writes
# from other agents at FG_PROBE_LOAD_HZ (the fleet's observed aggregate peak
# is ~0.94 Hz). No turn bursts: the turn memory climb is a separate item.
REPS = int(os.environ.get("FG_PROBE_REPS", "0"))
LOAD_HZ = float(os.environ.get("FG_PROBE_LOAD_HZ", "1.0"))


def proof(client, desc, tokens, actor, url, etag):
    import random
    import threading
    out = []
    stop = threading.Event()
    load = dict(writes=0, errors=0, hz=LOAD_HZ)
    others = sorted(a for a in tokens if a != actor)
    rng = random.Random(7)

    def background():
        with httpx.Client(base_url=desc["origin"], headers={"X-Orgtree-Desktop-Token": desc["token"]},
                          timeout=120) as bg:
            i = 0
            while LOAD_HZ > 0 and not stop.wait(1.0 / LOAD_HZ):
                who = rng.choice(others)
                r = _agent(bg, desc["org"], who, tokens[who], "orgtree_status",
                           dict(status="working", summary=f"[fg-probe] load {i}"), "load-write")
                load["writes"] += 1
                load["errors"] += r["status"] != 200
                i += 1

    writes = {
        "node-only": lambda i: ("orgtree_retool", dict(node=actor, team_charter=f"[fg-probe] charter {i}")),
        "doc-write": lambda i: ("orgtree_work", dict(action="create", title=f"fg-probe item {i}",
                                objective="Synthetic probe item. It exists only in the throwaway org.",
                                kind="non-code")),
        "status": lambda i: ("orgtree_status", dict(status="working", summary=f"[fg-probe] proof {i}")),
    }
    thread = threading.Thread(target=background, daemon=True)
    thread.start()
    started = time.monotonic()
    try:
        for i in range(REPS):
            for kind, make in writes.items():
                tool, args = make(i)
                w = _agent(client, desc["org"], actor, tokens[actor], tool, args, f"proof-{kind}-write")
                w["rep"] = i
                out.append(w)
                if w["status"] != 200:
                    raise RuntimeError(f"proof write {kind} #{i} answered {w['status']}")
                row = _get(client, url, f"proof-{kind}", etag)
                row["rep"] = i
                out.append(row)
                etag = row["etag"] or etag
                time.sleep(0.2)
    finally:
        stop.set()
        thread.join(timeout=30)
    load["seconds"] = round(time.monotonic() - started, 1)
    out.append(dict(label="proof-load", status=200, **load))
    return out


def node_keys(pg_url, slug):
    import psycopg
    with psycopg.connect(pg_url) as conn:
        org_id = conn.execute("SELECT org_id FROM public.orgs WHERE slug=%s AND deleted_at IS NULL",
                              (slug,)).fetchone()[0]
        conn.execute(f"SET search_path TO org_{int(org_id)}, public")
        rows = conn.execute(
            "SELECT k, count(*), sum(octet_length(v::text)) FROM nodes n "
            "JOIN node_index i ON i.id=n.id CROSS JOIN LATERAL jsonb_each(n.val::jsonb) e(k, v) "
            "WHERE i.meta->>'state'<>'archived' GROUP BY k ORDER BY 3 DESC").fetchall()
        live, total = conn.execute(
            "SELECT count(*), sum(octet_length(n.val::text)) FROM nodes n JOIN node_index i ON i.id=n.id "
            "WHERE i.meta->>'state'<>'archived'").fetchone()
    return dict(live_nodes=live, val_bytes=int(total or 0),
                keys=[dict(key=k, nodes=c, bytes=int(b)) for k, c, b in rows])


def write_cost(pg_url, slug, saves=60):
    """Commit time of single-node saves (each its own transaction, so the
    deferred node triggers run inside the timed COMMIT). The node is the live
    one with the most turns; each save changes one small key."""
    import psycopg
    times = []
    with psycopg.connect(pg_url) as conn:
        org_id = conn.execute("SELECT org_id FROM public.orgs WHERE slug=%s AND deleted_at IS NULL",
                              (slug,)).fetchone()[0]
        conn.execute(f"SET search_path TO org_{int(org_id)}, public")
        nid, val = conn.execute(
            "SELECT n.id, n.val FROM nodes n JOIN node_index i ON i.id=n.id "
            "WHERE i.meta->>'state'<>'archived' "
            "ORDER BY jsonb_array_length(coalesce(n.val::jsonb->'turns','[]'::jsonb)) DESC LIMIT 1").fetchone()
        conn.commit()
        node = json.loads(val)
        for i in range(saves):
            node["probe_write"] = i
            text = json.dumps(node, separators=(",", ":"))
            started = time.perf_counter()
            conn.execute("UPDATE nodes SET val=%s WHERE id=%s", (text, nid))
            conn.commit()
            times.append((time.perf_counter() - started) * 1000)
    times.sort()
    return dict(node=nid, turns=len(node.get("turns") or []), val_bytes=len(val), saves=saves,
                median_ms=round(times[len(times) // 2], 3), p90_ms=round(times[int(len(times) * 0.9)], 3),
                min_ms=round(times[0], 3))


def arm(ctrl, admin, n):
    from baseline import read, write, database_name, REPO
    root = ctrl.root / f"fgprobe-{n}"
    name = f"fgprobe-{n}"
    ctrl.script("seed.py", name + "-seed", "--root", root, "--agents", n, "--active-items", 20,
                "--archived-per-live", 0, "--archived-items-per-live", 0, "--transcript-kb", 1,
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 12, "--no-profile-item")
    desc = read(root / "scale-descriptor.json")
    try:
        ctrl.script("prepare_steady.py", name + "-prepare", "--root", root, "--seconds", .25, "--output-bytes", 256)
        ctrl.phase = name + "-serve"
        server = ctrl.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"),
            "--root", str(root), "--env", "ORGTREE_SCALE_SIMULATED_PROVIDER=1",
            *(["--env", "ORGTREE_SCALE_SQL_COUNTS=1", "--env", "ORGTREE_SCALE_SQL_LABELS=1",
               "--env", "ORGTREE_SCALE_FG_WHY=1"] if DIAG else []),
            *(["--env", "ORGTREE_SCALE_FG_STALL=1"] if os.environ.get("FG_PROBE_STALL") == "1" else []),
            "--env", "ORGTREE_SCALE_FG_PROFILE=1"], name + "-serve")
        try:
            deadline = time.monotonic() + 300
            while True:
                ctrl.check()
                if server.poll() is not None:
                    raise RuntimeError(f"{name} server exited during startup")
                desc = read(root / "scale-descriptor.json")
                ctrl.engine_pid = desc.get("serve", {}).get("pid")
                if desc.get("serve", {}).get("state") == "ready":
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(f"{name} startup deadline expired")
                time.sleep(.2)
            client_rows = calls(desc)
        finally:
            ctrl.kill(server)
            ctrl.engine_pid = None
        if (root / "metrics/qualification-invalid.json").exists():
            raise RuntimeError(f"{name}: unexpected process launch")
        server_rows = {}
        counts = root / "metrics/sql-counts.jsonl"
        for line in (counts.read_text(encoding="utf-8").splitlines() if DIAG else []):
            row = json.loads(line)
            if row["kind"].startswith(KIND + ":"):
                label = row["kind"][len(KIND) + 1:]
                if label in server_rows:
                    raise RuntimeError(f"{name}: two server rows for {label}")
                server_rows[label] = row
        for row in (client_rows if DIAG else []):
            if row["label"] not in server_rows:
                raise RuntimeError(f"{name}: no server row for {row['label']}")
            row["server"] = server_rows[row["label"]]
        why = root / "metrics/fg-why.jsonl"
        result = dict(n=n, calls=client_rows, node_val=node_keys(desc["pg_url"], desc["org"]),
                      write_cost=write_cost(desc["pg_url"], desc["org"]),
                      why=[json.loads(line) for line in why.read_text(encoding="utf-8").splitlines()]
                          if why.exists() else None,
                      profile=[json.loads(line) for line in
                               (root / "metrics/fg-timers.jsonl").read_text(encoding="utf-8").splitlines()]
                              if (root / "metrics/fg-timers.jsonl").exists() else None,
                      gc=[json.loads(line) for line in
                          (root / "metrics/fg-gc.jsonl").read_text(encoding="utf-8").splitlines()]
                         if (root / "metrics/fg-gc.jsonl").exists() else None)
        write(ctrl.root / "receipts" / f"{name}.json", result)
        return result
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))


def _pct(values, q):
    values = sorted(values)
    return round(values[min(len(values) - 1, int(round(q * (len(values) - 1))))] * 1000, 1) if values else None


def proof_summary(calls):
    """Client wall ms of the proof reads per write kind (p50/p95/max), the
    answers they got, and the background load actually applied."""
    kinds = {}
    for c in calls:
        label = c["label"]
        if label.startswith("proof-") and "tool" not in c and label != "proof-load":
            kinds.setdefault(label[len("proof-"):], []).append(c)
    out = {kind: dict(reads=len(rows), p50_ms=_pct([r["client_seconds"] for r in rows], .5),
                      p95_ms=_pct([r["client_seconds"] for r in rows], .95),
                      max_ms=_pct([r["client_seconds"] for r in rows], 1.0),
                      answers={a: sum(1 for r in rows if (r.get("answer_kind") or str(r["status"])) == a)
                               for a in {r.get("answer_kind") or str(r["status"]) for r in rows}})
           for kind, rows in kinds.items()}
    out["load"] = next((c for c in calls if c["label"] == "proof-load"), None)
    out["cold_ms"] = next((round(c["client_seconds"] * 1000, 1) for c in calls if c["label"] == "cold-identity"), None)
    return out


def probe(ctrl, admin):
    if REPS and DIAG:
        raise RuntimeError("FG_PROBE_REPS needs FG_PROBE_DIAG=0: the proof is a timing arm")
    results = {n: arm(ctrl, admin, n) for n in SIZES}
    summary = {}
    for n, result in results.items():
        if REPS:
            summary[f"proof-{n}"] = proof_summary(result["calls"])
        summary[n] = dict(node_val_bytes=result["node_val"]["val_bytes"],
                          live_nodes=result["node_val"]["live_nodes"],
                          timers=result["profile"],
                          calls=[dict(label=c["label"], status=c["status"], kind=c.get("answer_kind"),
                                      wire=c.get("wire_bytes"), body=c.get("body_bytes"),
                                      client_seconds=round(c.get("client_seconds") or 0.0, 4),
                                      **({k: c["server"][k] for k in ("statements", "rows", "value_bytes")}
                                         if "server" in c else {}))
                                 for c in result["calls"]])
    from baseline import write
    write(ctrl.root / "receipts" / "fg-probe.json", summary)
    return summary


RUNTIME_PARTS = ("fingerprint", "limits_at", "primed_restart", "inval", "bucket")


def install_why(path):
    """Harness only: log why the foreground status fast path did or did not apply.

    Re-evaluates foreground_cache._status's checks in order before calling it,
    and logs every full select_foreground. One JSON line per event.
    """
    import threading
    from orgtree import foreground_cache as cache, foreground_store, pgfeed, store, tree_changes
    lock = threading.Lock()
    seen = {}

    def log(row):
        row["at"] = time.time()
        with lock, open(path, "a", encoding="utf-8") as target:
            target.write(json.dumps(row, default=str) + "\n")

    if hasattr(cache, "_changes"):
        original_changes = cache._changes

        def changes(raw, slug, entry, stamp, feed):
            why = dict(event="change-check")
            previous, state = entry["stamp"], entry["fast"]
            if any(previous[k] != stamp[k] for k in ("org_id", "catalog_revision")):
                why["miss"] = "identity/catalog moved"
            elif not pgfeed.snapshot_changes_published(feed, slug, previous["org_revision"], stamp["org_revision"]):
                why["miss"] = "feed has not published the change"
            else:
                detail = tree_changes.since_detail(store.DATA_ROOT, slug, state["seq"], stamp["seq"])
                if detail is None:
                    why["miss"] = "journal has no record"
                else:
                    why.update(keys=sorted(detail["keys"]), ids=sorted(detail["nodes"]),
                               writes=detail["node_writes"], structural=detail["structural"],
                               node_delta=stamp["node_revision"] - previous["node_revision"])
                    if detail["structural"]:
                        why["miss"] = "structural"
                    elif why["node_delta"] != detail["node_writes"]:
                        why["miss"] = "node writes not all journaled"
            result = original_changes(raw, slug, entry, stamp, feed)
            why["result"] = None if result is None else ("status" if result["status"] is not None else "advance")
            log(why)
            return result
        cache._changes = changes

    original_status = getattr(cache, "_status", None) or (lambda *a, **k: None)

    def status(raw, slug, entry, stamp, mark, feed):
        why = dict(event="status-check")
        previous, state = entry["stamp"], entry["fast"]
        if state is None:
            why["miss"] = "no fast state (first build was not stable)"
        elif state["mark"][1] != mark[1]:
            old, new = state["mark"][1], mark[1]
            why["miss"] = "runtime moved"
            why["runtime_changed"] = [RUNTIME_PARTS[i] if i < len(RUNTIME_PARTS) else i
                                      for i in range(max(len(old), len(new)))
                                      if i >= len(old) or i >= len(new) or old[i] != new[i]]
        elif any(previous[k] != stamp[k] for k in ("org_id", "catalog_revision", "view_revision")):
            why["miss"] = "stamp identity moved"
            why["stamp_changed"] = [k for k in previous if previous.get(k) != stamp.get(k)]
        elif not pgfeed.snapshot_changes_published(feed, slug, previous["org_revision"], stamp["org_revision"]):
            why["miss"] = "feed has not published the change"
        else:
            change = tree_changes.since(store.DATA_ROOT, slug, state["mark"][0], mark[0])
            if change is None:
                why["miss"] = "journal has no record"
                why["seq"] = [state["mark"][0], mark[0]]
            else:
                keys, ids, structural = change
                why.update(keys=sorted(keys), ids=sorted(ids), structural=structural,
                           node_revision_delta=stamp["node_revision"] - previous["node_revision"])
                if structural or keys - {"nodes", "log"}:
                    why["miss"] = "non-status keys or structural change"
                elif why["node_revision_delta"] != len(ids):
                    why["miss"] = "node_revision delta != changed ids"
                elif not ids <= state["hashes"].keys():
                    why["miss"] = "changed id not in the cached selection"
        result = original_status(raw, slug, entry, stamp, mark, feed)
        why["fast"] = result is not None
        if result is None and "miss" not in why:
            why["miss"] = "changed node not live or signature beyond last_status moved"
            rows = foreground_store._rows(raw, sorted(why.get("ids") or []))
            why["changed_fields"] = {nid: sorted(k for k in set(row["node"]) | set(seen.get(nid, {}))
                                                 if row["node"].get(k) != seen.get(nid, {}).get(k))
                                     for nid, row in rows.items()}
            why["states"] = {nid: row["meta"]["state"] for nid, row in rows.items()}
        log(why)
        return result

    original_select = foreground_store.select_foreground

    def select(raw, stamp, include=()):
        log(dict(event="full select", org_revision=stamp.get("org_revision"),
                 node_revision=stamp.get("node_revision")))
        graph = original_select(raw, stamp, include)
        seen.clear()
        seen.update({nid: json.loads(json.dumps(row["node"])) for nid, row in graph["rows"].items()})
        return graph

    if hasattr(cache, "_status"):
        cache._status = status
    foreground_store.select_foreground = select

    import traceback
    from orgtree import pgfeed, pgstore

    def short(limit):
        return [f"{f.filename.replace(chr(92), '/').rsplit('/', 1)[-1]}:{f.name}"
                for f in traceback.extract_stack(limit=limit)[:-2]]

    original_commit = pgstore.on_save_commit

    def on_save_commit(conn, changed, **kwargs):
        result = original_commit(conn, changed, **kwargs)
        if changed:
            log(dict(event="revision", revision=conn.last_revision, pinned=bool(getattr(conn, "pinned", False)),
                     stack=short(14)))
        return result
    pgstore.on_save_commit = on_save_commit
    original_local = pgfeed.note_local

    def note_local(slug, revision):
        log(dict(event="note_local", revision=revision))
        return original_local(slug, revision)
    pgfeed.note_local = note_local
    original_take = pgfeed._take_local

    def take_local(slug, revision):
        mine = original_take(slug, revision)
        log(dict(event="feed saw", revision=revision, mine=mine))
        return mine
    pgfeed._take_local = take_local
    for attr in ("_publish_changes_unknown", "external_change"):
        def unknown(slug, _original=getattr(store, attr), _attr=attr):
            frames = [f"{f.filename.replace(chr(92), '/').rsplit('/', 1)[-1]}:{f.name}"
                      for f in traceback.extract_stack(limit=8)[:-1]]
            log(dict(event="journal unknown", via=_attr, stack=frames))
            return _original(slug)
        setattr(store, attr, unknown)


PHASES = {
    "select_foreground": "foreground_store.py:select_foreground",
    "context_build": "foreground_context.py:build",
    "context_init": "foreground_context.py:__init__",
    "prepare(tree_node loop)": "foreground_view.py:prepare",
    "annotate": "api.py:_annotate_org_view",
    "finish": "foreground_view.py:finish",
    "version(encode+hash)": "foreground_cache.py:_version",
    "wire(full body)": "foreground_cache.py:_full",
    "delta": "foreground_cache.py:_delta",
    "status_fast_path": "foreground_cache.py:_status",
}


def install_profile(directory):
    """Harness only: cProfile every foreground_cache.read; one .prof per call."""
    import cProfile
    import io
    import pstats
    import threading
    from orgtree import foreground_cache as cache
    directory.mkdir(parents=True, exist_ok=True)
    counter = iter(range(1_000_000))
    lock = threading.Lock()
    original = cache.read

    def read(*args, **kwargs):
        profile = cProfile.Profile()
        started = time.perf_counter()
        try:
            return profile.runcall(original, *args, **kwargs)
        finally:
            elapsed = time.perf_counter() - started
            with lock:
                index = next(counter)
            profile.dump_stats(str(directory / f"read-{index:03d}.prof"))
            stats = pstats.Stats(profile)
            phases = {}
            for (filename, _line, name), (_cc, _nc, _tt, cumulative, _callers) in stats.stats.items():
                key = f"{filename.replace(chr(92), '/').rsplit('/', 1)[-1]}:{name}"
                for phase, target in PHASES.items():
                    if key == target:
                        phases[phase] = round(phases.get(phase, 0.0) + cumulative, 4)
            text = io.StringIO()
            pstats.Stats(profile, stream=text).sort_stats("cumulative").print_stats(30)
            (directory / f"read-{index:03d}.txt").write_text(text.getvalue(), encoding="utf-8")
            with lock, open(directory / "summary.jsonl", "a", encoding="utf-8") as target:
                target.write(json.dumps(dict(index=index, at=time.time(), seconds=round(elapsed, 4),
                                             phases=phases)) + "\n")

    cache.read = read


def install_timers(path):
    """Harness only: wall time per phase of each foreground_cache.read, counted
    only on the reading thread (cProfile on 3.13 also sees other threads)."""
    import threading
    from orgtree import (api, foreground_api, foreground_cache as cache, foreground_context,
                         foreground_store as store_, foreground_view as view, tree_delta)
    local = threading.local()
    lock = threading.Lock()

    def timed(owner, attr, name):
        original = getattr(owner, attr, None)
        if original is None:
            return

        def wrapper(*args, **kwargs):
            acc = getattr(local, "acc", None)
            if acc is None:
                return original(*args, **kwargs)
            started = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                acc[name] = acc.get(name, 0.0) + time.perf_counter() - started
                acc[name + "#"] = acc.get(name + "#", 0) + 1
        setattr(owner, attr, wrapper)

    class TimedJson:
        def __getattr__(self, name):
            return getattr(json, name)

        def loads(self, *args, **kwargs):
            acc = getattr(local, "acc", None)
            started = time.perf_counter()
            try:
                return json.loads(*args, **kwargs)
            finally:
                if acc is not None:
                    acc["store json.loads"] = acc.get("store json.loads", 0.0) + time.perf_counter() - started

    store_.json = TimedJson()
    for owner, attr, name in (
            (store_, "select_foreground", "select_foreground"), (store_, "_rows", "_rows"),
            (store_, "_ancestors", "_ancestors"), (store_, "read_card_windows", "card_windows"),
            (store_, "read_funding", "funding"), (store_, "read_org_inbox_window", "org_inbox"),
            (foreground_api, "_context", "context total"),
            (foreground_context.ForegroundContext, "__init__", "context __init__"),
            (view, "prepare", "prepare (tree_node loop)"), (api, "_annotate_org_view", "annotate"),
            (view, "finish", "finish"), (cache, "_version", "version"), (cache, "_full", "full wire"),
            (cache, "_delta", "delta"), (cache, "_status", "status fast path"),
            (cache, "_changes", "change check"), (foreground_api, "_advance", "advance"),
            (foreground_api, "_reproject", "reproject"),
            (tree_delta, "encode", "tree_delta.encode")):
        timed(owner, attr, name)
    original = cache.read
    stall = install_stall(path.parent) if os.environ.get("ORGTREE_SCALE_FG_STALL") == "1" else None

    def read(*args, **kwargs):
        local.acc = acc = {}
        if stall:
            stall.begin()
        cpu = time.thread_time(), time.process_time()
        started = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            local.acc = None
            seconds = time.perf_counter() - started
            row = dict(at=time.time(), seconds=round(seconds, 4),
                       thread_cpu=round(time.thread_time() - cpu[0], 4),
                       process_cpu=round(time.process_time() - cpu[1], 4),
                       phases={k: (round(v, 4) if isinstance(v, float) else v) for k, v in acc.items()})
            if stall:
                row.update(stall.end(seconds))
            with lock, open(path, "a", encoding="utf-8") as target:
                target.write(json.dumps(row) + "\n")

    cache.read = read


# Stall diagnosis (ORGTREE_SCALE_FG_STALL=1): while a foreground read runs, a
# sampler thread records every other thread's innermost frames every ~2 ms;
# gc.callbacks log every collection's generation and duration; the read row
# gains system-wide CPU busy share and the stacks seen, so a slow read can be
# attributed to another engine thread, a GC pause, or the machine.
STALL_SAMPLE_S = 0.002
STALL_KEEP_S = 0.2


def _frame_key(frame, depth=4):
    parts = []
    while frame is not None and len(parts) < depth:
        code = frame.f_code
        parts.append(f"{os.path.basename(code.co_filename)}:{code.co_name}:{frame.f_lineno}")
        frame = frame.f_back
    return " < ".join(parts)


def install_stall(metrics):
    import gc
    import threading
    import psutil
    gc_path = metrics / "fg-gc.jsonl"
    gc_lock = threading.Lock()
    gc_start = {}

    def on_gc(phase, info):
        if phase == "start":
            gc_start[threading.get_ident()] = time.perf_counter()
            return
        began = gc_start.pop(threading.get_ident(), None)
        if began is None:
            return
        row = dict(at=time.time(), gen=info.get("generation"), seconds=round(time.perf_counter() - began, 5),
                   collected=info.get("collected"), thread=threading.current_thread().name)
        with gc_lock, open(gc_path, "a", encoding="utf-8") as target:
            target.write(json.dumps(row) + "\n")

    gc.callbacks.append(on_gc)

    class Stall:
        def __init__(self):
            self.active = None
            self.guard = threading.Lock()
            threading.Thread(target=self.sample, name="fg-stall-sampler", daemon=True).start()

        def begin(self):
            with self.guard:
                self.active = dict(reader=threading.get_ident(), samples=0, counts={},
                                   cpu=psutil.cpu_times(), gc_at=time.time())

        def end(self, seconds):
            with self.guard:
                active, self.active = self.active, None
            if active is None:
                return {}
            before, after = active["cpu"], psutil.cpu_times()
            total = sum(after) - sum(before)
            idle = after.idle - before.idle
            out = dict(system_busy=round(1 - idle / total, 3) if total > 0 else None, samples=active["samples"])
            if seconds >= STALL_KEEP_S:
                out["stacks"] = sorted(([name, key, n] for (name, key), n in active["counts"].items()),
                                       key=lambda row: -row[2])[:60]
            return out

        def sample(self):
            me = threading.get_ident()
            while True:
                time.sleep(STALL_SAMPLE_S)
                active = self.active
                if active is None:
                    continue
                names = {t.ident: t.name for t in threading.enumerate()}
                frames = sys._current_frames()
                with self.guard:
                    if self.active is not active:
                        continue
                    active["samples"] += 1
                    for ident, frame in frames.items():
                        if ident == me:
                            continue
                        name = "READER" if ident == active["reader"] else names.get(ident, str(ident))
                        key = (name, _frame_key(frame))
                        active["counts"][key] = active["counts"].get(key, 0) + 1

    return Stall()
