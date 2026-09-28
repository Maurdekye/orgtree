"""Independent cold-path observation of the engine's normal background ingester.

Does not invoke capture or advance cursors. Every ACTIVE (non-archived) node's
source records must be present before traffic; archived-history ingest keeps
running in the background during traffic, as after a real restart
(coordinator ruling 2026-09-28 02:21Z). Raw source equality is checked once for
the active sources, after offsets settle, using a separate process and
database connection. The archived sources are returned for the controller's
history-progress sampler.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def wait_ready(root, timeout):
    from orgtree import store, supervisor, transcript_records as records
    from orgtree.chat_window import source_key
    from control import free_commit_gb
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    started = time.monotonic()
    org = store.load_org(desc["org"])
    sources, history = [], []
    for nid in sorted(org.nodes):
        node = org.nodes[nid]
        path = supervisor.transcript_path_for_node(org, nid)
        if not path or not Path(path).is_file():
            raise ValueError(f"declared transcript source missing for {nid}")
        source = source_key(org, nid)
        row = (nid, source, Path(path), Path(path).stat().st_size)
        (history if node.get("state") == "archived" else sources).append(row)
    every = sources + history
    if len(every) != len(org.nodes) or len({s[1] for s in every}) != len(every):
        raise ValueError("source identity coverage is not one-to-one")
    if not sources:
        raise ValueError("no active transcript sources to wait for")
    del org
    deadline = started + timeout
    pending = len(sources)
    while time.monotonic() < deadline:
        if free_commit_gb() < 10:
            raise RuntimeError("readiness free commit floor")
        with records.database() as conn:
            metas = {r[0]: r[1:] for r in conn.execute(
                "SELECT source,lower_byte,upper_byte FROM transcript_sources")}
        pending = sum(metas.get(source) != (0, size) for _, source, _, size in sources)
        if not pending:
            break
        time.sleep(.5)
    if pending:
        raise TimeoutError(f"normal transcript ingestion incomplete: {pending}/{len(sources)} sources")
    report = []
    for nid, source, path, size in sources:
        expected = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        with records.database() as conn:
            actual = [json.loads(row[0]) for row in conn.execute(
                "SELECT body FROM transcript_records WHERE source=? ORDER BY epoch,position", (source,))]
        if actual != expected:
            raise ValueError(f"captured records differ from declared source: {nid}")
        report.append(dict(node=nid, source=source, bytes=size, events=len(expected),
                           event_sha256=hashlib.sha256(canonical(expected)).hexdigest()))
    return dict(verified=True, scope="active", sources=len(report), events=sum(r["events"] for r in report),
                bytes=sum(r["bytes"] for r in report), seconds=time.monotonic()-started,
                method="normal background ingestion; independent raw record comparison (active sources)",
                inventory=report, database=str(Path(store.DATA_ROOT) / records._FILE_NAME),
                history=[dict(node=nid, source=source, bytes=size) for nid, source, _, size in history])


class HistorySampler(threading.Thread):
    """Read-only progress of archived-history ingest while traffic runs.

    Every `every` seconds it reads transcript_sources from the engine's own
    SQLite file (read-only URI; WAL lets the engine keep writing) and appends
    {at, t, phase, done, total, bytes_done, bytes_total} to `out`. `t` is
    seconds since `t0` (the readiness start). It never touches the engine.
    """

    def __init__(self, database, history, out, t0, phase, every=10):
        super().__init__(name="history-ingest-sampler", daemon=True)
        self.database, self.out, self.t0, self.phase, self.every = database, out, t0, phase, every
        self.want = {h["source"]: h["bytes"] for h in history}
        self.stop, self.rows = threading.Event(), []

    def sample(self):
        conn = sqlite3.connect(f"file:{Path(self.database).as_posix()}?mode=ro", uri=True, timeout=30)
        try:
            have = {src: (lo, hi) for src, lo, hi in conn.execute(
                "SELECT source,lower_byte,upper_byte FROM transcript_sources")}
        finally:
            conn.close()
        done = [src for src, size in self.want.items() if have.get(src) == (0, size)]
        got = sum(max(0, have[src][1] - have[src][0]) for src in self.want if src in have)
        row = dict(at=time.time(), t=time.time() - self.t0, phase=self.phase(), done=len(done),
                   total=len(self.want), bytes_done=min(got, sum(self.want.values())),
                   bytes_total=sum(self.want.values()))
        self.rows.append(row)
        with open(self.out, "a", encoding="utf-8") as target:
            target.write(json.dumps(row) + "
")
        return row

    def run(self):
        while not self.stop.is_set():
            try:
                if self.sample()["done"] == len(self.want):
                    return
            except sqlite3.Error as exc:
                with open(self.out, "a", encoding="utf-8") as target:
                    target.write(json.dumps(dict(at=time.time(), error=str(exc))) + "
")
            self.stop.wait(self.every)

    def summary(self, traffic_phase):
        """Stop, take a last sample, and summarise for result.json."""
        self.stop.set()
        self.join(timeout=60)
        if not self.rows or self.rows[-1]["done"] < len(self.want):
            try:
                self.sample()
            except sqlite3.Error:
                pass
        rows = self.rows
        finished = next((r["t"] for r in rows if r["done"] == r["total"]), None)
        return dict(sources=len(self.want), bytes=sum(self.want.values()),
                    at_active_ready=rows[0] if rows else None, last=rows[-1] if rows else None,
                    finished_at_s=finished, samples=len(rows),
                    running_during_traffic=any(r["phase"] == traffic_phase and r["done"] < r["total"]
                                               for r in rows))
