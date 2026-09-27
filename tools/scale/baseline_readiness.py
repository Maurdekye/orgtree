"""Independent cold-path observation of the engine's normal background ingester.

Does not invoke capture or advance cursors. All resolved current/retired source
records must be present before traffic. Raw source equality is checked once,
after offsets settle, using a separate process and database connection.
"""
import hashlib
import json
from pathlib import Path
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
    sources = []
    for nid in sorted(org.nodes):
        node = org.nodes[nid]
        path = supervisor.transcript_path_for_node(org, nid)
        if not path or not Path(path).is_file():
            raise ValueError(f"declared transcript source missing for {nid}")
        source = source_key(org, nid)
        sources.append((nid, source, Path(path), Path(path).stat().st_size))
    if len(sources) != len(org.nodes) or len({s[1] for s in sources}) != len(sources):
        raise ValueError("source identity coverage is not one-to-one")
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
    return dict(verified=True, sources=len(report), events=sum(r["events"] for r in report),
                bytes=sum(r["bytes"] for r in report), seconds=time.monotonic()-started,
                method="normal background ingestion; independent raw record comparison",
                inventory=report)
