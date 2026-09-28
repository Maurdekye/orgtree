"""Harness-only lock-wait recorder (n1000-burst-27-of-messages-fail-with-locktimeout).

ORGTREE_SCALE_LOCK_WAITS=1 in serve.py installs it. Two parts:
  * every org_tx lock plan is REGISTERED under its server backend pid, with
    the plan's lock names and the three innermost orgtree frames that opened
    the transaction (the code site), when its lock block is built;
  * a sampler thread polls pg_stat_activity/pg_locks every INTERVAL_S on its
    own connection and writes one row per WAITING engine backend: the lock it
    waits on (advisory keys decoded back to "kind:name" through the waiter's
    own plan; row locks named by relation), how long it has waited, and each
    blocking backend's registered site and plan, transaction age and state.
Rows go to <root>/metrics/lock-waits.jsonl. No payloads are recorded.
"""
import json
import os
import threading
import time
import traceback

INTERVAL_S = float(os.environ.get("ORGTREE_SCALE_LOCK_WAITS_INTERVAL_S", "0.05"))
#: names locked outside the lock block (org/node pseudo-rows, receipts, halt)
_EXTRA = ["org:*", "node:*", "section:mail_transitions", "section:killswitch",
          "section:audiences", "section:notices"]
_registry = {}          # backend pid -> {"t": wall time, "site": [...], "plan": [...], "org_id": int}
_lock = threading.Lock()

_SAMPLE_SQL = """
SELECT w.pid, now() - w.query_start, pg_blocking_pids(w.pid), l.locktype, l.classid, l.objid,
       l.relation::regclass::text, l.mode
FROM pg_stat_activity w
JOIN pg_locks l ON l.pid = w.pid AND NOT l.granted
WHERE w.datname = current_database() AND w.wait_event_type = 'Lock'
"""
_HOLDER_SQL = """
SELECT pid, now() - xact_start, state, left(regexp_replace(query, '\\s+', ' ', 'g'), 160)
FROM pg_stat_activity WHERE pid = ANY(%s)
"""


def decode_key(objid, candidates, cache, hashtext):
    """The "kind:name" whose advisory key is `objid`, or None. pg_locks.objid
    is the key's int4 as an UNSIGNED oid, while hashtext() is signed: compare
    modulo 2**32 (negative hashes never matched before that)."""
    for name in candidates:
        if name not in cache:
            cache[name] = hashtext(name) & 0xFFFFFFFF
        if cache[name] == objid:
            return name
    return None


def _site():
    # no source lines: this runs inside every org_tx, so it must stay cheap
    stack = traceback.StackSummary.extract(traceback.walk_stack(None), lookup_lines=False)
    stack.reverse()
    frames = [f for f in list(stack)[:-3]
              if os.path.basename(os.path.dirname(f.filename)) == "orgtree"
              and os.path.basename(f.filename) not in ("orgtx.py", "halt.py")]
    return [f"{os.path.basename(f.filename)}:{f.lineno}:{f.name}" for f in frames[-3:]][::-1]


def install(orgtx, pgstore, out_path):
    original = orgtx._lock_block

    def lock_block(raw, org_id, entries):
        try:
            pid = raw.info.backend_pid
        except Exception:                                         # noqa: BLE001
            pid = None
        if pid is not None:
            names = [f"org:{orgtx._ORG_KEY}"] + [f"{k}:{n}" for k, n, _x in entries]
            with _lock:
                _registry[pid] = {"t": time.time(), "site": _site(), "org_id": org_id,
                                  "plan": [f"{'X' if x else 'S'} {k}:{n}" for k, n, x in entries],
                                  "names": names}
        return original(raw, org_id, entries)

    orgtx._lock_block = lock_block
    out_path.parent.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    hashes = {}

    def decode(conn, org_id, objid, names):
        with _lock:
            known = {n for r in _registry.values() for n in r.get("names", [])}
        return decode_key(objid, [*names, *sorted(known - set(names)), *_EXTRA], hashes,
                          lambda name: conn.execute("SELECT hashtext(%s)", (name,)).fetchone()[0])

    def sampler():
        conn = None
        with out_path.open("a", encoding="utf-8") as out:
            while not stop.is_set():
                try:
                    if conn is None:
                        conn = pgstore.connect()
                    rows = conn.execute(_SAMPLE_SQL).fetchall()
                    now = time.time()
                    for pid, waited, blockers, locktype, classid, objid, relation, mode in rows:
                        with _lock:
                            mine = dict(_registry.get(pid) or {})
                            theirs = {b: dict(_registry.get(b) or {}) for b in blockers or []}
                        name = None
                        if locktype == "advisory" and mine:
                            name = decode(conn, classid, objid, mine.get("names", []))
                        held = {int(r[0]): r[1:] for r in conn.execute(
                            _HOLDER_SQL, (list(blockers or []),)).fetchall()} if blockers else {}
                        out.write(json.dumps(dict(
                            at=now, pid=pid, waited_s=waited.total_seconds() if waited else None,
                            lock=name or f"{locktype}:{relation or objid}", mode=mode,
                            waiter_site=mine.get("site"), waiter_plan=mine.get("plan"),
                            blockers=[dict(
                                pid=b, site=theirs[b].get("site"), plan=theirs[b].get("plan"),
                                registered_s=round(now - theirs[b]["t"], 3) if theirs[b] else None,
                                xact_s=held[b][0].total_seconds() if b in held and held[b][0] else None,
                                state=held.get(b, (None, None))[1],
                                query=held.get(b, (None, None, None))[2])
                                for b in (blockers or [])])) + "\n")
                    out.flush()
                except Exception as e:                            # noqa: BLE001
                    out.write(json.dumps(dict(at=time.time(), sampler_error=repr(e)[:300])) + "\n")
                    conn = None
                stop.wait(INTERVAL_S)

    threading.Thread(target=sampler, name="scale-lock-waits", daemon=True).start()
    _profile_holders(orgtx, out_path.with_name("tx-profile.json"), stop)
    return stop


def _profile_holders(orgtx, out_path, stop):
    """Where do org_tx bodies spend their time? Each thread inside
    PgBackend.transaction_many is marked with its site; a sampler takes that
    thread's stack every PROFILE_INTERVAL_S and counts its innermost orgtree
    frame (and a 4-frame path), split into WAITING for its locks (inside the
    lock statements) and HOLDING them (everything after). Totals per site
    (count, seconds) come from the transaction's own start and end."""
    import collections
    import contextlib
    import sys
    interval = float(os.environ.get("ORGTREE_SCALE_TX_PROFILE_INTERVAL_S", "0.01"))
    inside = {}                                  # thread id -> (site, start)
    durations = collections.defaultdict(list)
    samples = collections.defaultdict(lambda: {"waiting": collections.Counter(),
                                               "holding": collections.Counter(),
                                               "holding_path": collections.Counter()})
    original = orgtx.PgBackend.transaction_many

    @contextlib.contextmanager
    def transaction_many(self, txs, lock_timeout):
        site = " < ".join(_site()[:3]) or "?"
        tid = threading.get_ident()
        inside[tid] = (site, time.time())
        try:
            with original(self, txs, lock_timeout):
                yield
        finally:
            start = inside.pop(tid, (site, time.time()))[1]
            durations[site].append(time.time() - start)

    orgtx.PgBackend.transaction_many = transaction_many

    import inspect
    src, first = inspect.getsourcelines(original.__wrapped__ if hasattr(original, "__wrapped__") else original)
    # the lock statements: the org pseudo-row, the node pseudo-row/bulk and the plan block
    lock_lines = {first + i for i, line in enumerate(src)
                  if "pg_advisory_xact_lock" in line or "raw.execute(block)" in line
                  or "FOR UPDATE\").fetchall()" in line}

    def frames_of(frame):
        st = traceback.StackSummary.extract(traceback.walk_stack(frame), lookup_lines=False)
        st.reverse()
        ours = [f for f in st if os.path.basename(os.path.dirname(f.filename)) == "orgtree"]
        return st, ours

    def sampler():
        last = time.time()
        while not stop.is_set():
            if time.time() - last > 2:           # the server is killed, not stopped
                dump(); last = time.time()
            current = sys._current_frames()
            for tid, (site, _t) in list(inside.items()):
                frame = current.get(tid)
                if frame is None:
                    continue
                st, ours = frames_of(frame)
                locking = any(f.name == "transaction_many" and f.lineno in lock_lines
                              for f in st) or any(f.name == "_lock_block" for f in st)
                inner = [f for f in ours if os.path.basename(f.filename) != "orgtx.py"]
                leaf = f"{os.path.basename(st[-1].filename)}:{st[-1].name}"
                key = (f"{os.path.basename(inner[-1].filename)}:{inner[-1].lineno}:{inner[-1].name}"
                       if inner else leaf)
                bucket = samples[site]
                if locking:
                    bucket["waiting"][key] += 1
                else:
                    bucket["holding"][f"{key} [{leaf}]"] += 1
                    bucket["holding_path"][" > ".join(
                        f"{os.path.basename(f.filename)}:{f.name}" for f in inner[-4:])] += 1
            stop.wait(interval)
        dump()

    def dump():
        try:
            snap = {site: list(v) for site, v in list(durations.items())}
        except RuntimeError:                     # a tx thread added a site mid-copy
            return
        report = {}
        for site in sorted(set(snap) | set(samples), key=lambda s: -sum(snap.get(s, []))):
            d = sorted(snap.get(site, []))
            b = samples.get(site)
            report[site] = dict(
                n=len(d), seconds=round(sum(d), 3),
                p50=round(d[len(d) // 2], 3) if d else None, max=round(d[-1], 3) if d else None,
                waiting=dict(b["waiting"].most_common(8)) if b else {},
                holding=dict(b["holding"].most_common(12)) if b else {},
                holding_path=dict(b["holding_path"].most_common(8)) if b else {})
        out_path.write_text(json.dumps(dict(interval_s=interval, sites=report), indent=1),
                            encoding="utf-8")

    threading.Thread(target=sampler, name="scale-tx-profile", daemon=True).start()
