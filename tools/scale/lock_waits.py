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
    frames = [f for f in traceback.extract_stack()[:-3]
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
    return stop
