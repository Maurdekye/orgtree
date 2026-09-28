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
import sys
import time

import httpx

SIZES = (10, 100)
KIND = "fg-probe"


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
            "--env", "ORGTREE_SCALE_SQL_COUNTS=1", "--env", "ORGTREE_SCALE_SQL_LABELS=1",
            "--env", "ORGTREE_SCALE_FG_WHY=1"], name + "-serve")
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
        for line in (root / "metrics/sql-counts.jsonl").read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row["kind"].startswith(KIND + ":"):
                label = row["kind"][len(KIND) + 1:]
                if label in server_rows:
                    raise RuntimeError(f"{name}: two server rows for {label}")
                server_rows[label] = row
        for row in client_rows:
            if row["label"] not in server_rows:
                raise RuntimeError(f"{name}: no server row for {row['label']}")
            row["server"] = server_rows[row["label"]]
        why = root / "metrics/fg-why.jsonl"
        result = dict(n=n, calls=client_rows, node_val=node_keys(desc["pg_url"], desc["org"]),
                      why=[json.loads(line) for line in why.read_text(encoding="utf-8").splitlines()]
                          if why.exists() else None)
        write(ctrl.root / "receipts" / f"{name}.json", result)
        return result
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))


def probe(ctrl, admin):
    results = {n: arm(ctrl, admin, n) for n in SIZES}
    summary = {}
    for n, result in results.items():
        summary[n] = dict(node_val_bytes=result["node_val"]["val_bytes"],
                          live_nodes=result["node_val"]["live_nodes"],
                          calls=[dict(label=c["label"], status=c["status"], kind=c.get("answer_kind"),
                                      wire=c.get("wire_bytes"), body=c.get("body_bytes"),
                                      statements=c["server"]["statements"], rows=c["server"]["rows"],
                                      value_bytes=c["server"]["value_bytes"],
                                      seconds=round(c["server"]["seconds"], 4))
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

    original_status = cache._status

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

    cache._status = status
    foreground_store.select_foreground = select
