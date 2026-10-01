"""Prepare a freshly seeded disposable root for completed no-LLM turns.

Run before serve.py --env ORGTREE_SCALE_SIMULATED_PROVIDER=1. This normalizes
live nodes to the Codex dispatch lane and copies their synthetic transcript
history to that lane's journal. It does not change production code or gates.
"""
import datetime
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from seed import child_env
from control import guarded_wait


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--seconds", type=float, default=.25)
    parser.add_argument("--output-bytes", type=int, default=256)
    parser.add_argument("--child", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    if Path(desc["root"]).resolve() != root or Path(desc["data_root"]).resolve() != root / "data":
        raise RuntimeError("descriptor does not own the selected root")
    if (desc.get("serve") or {}).get("state") in ("ready", "starting"):
        raise RuntimeError("prepare a stopped fresh fixture only")
    if (root / "simulated-provider.json").exists():
        raise RuntimeError("fixture has already been converted")
    if not args.child:
        proc = subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).resolve()),
            "--root", str(root), "--seconds", str(args.seconds),
            "--output-bytes", str(args.output_bytes), "--child"],
            cwd=REPO, env=child_env(root, desc["pg_url"]))
        return guarded_wait(proc, report=root / "steady-prepare-guard.json")
    sys.path.insert(0, str(REPO / "tools"))
    from assert_repo_import import assert_repo_import
    provenance = assert_repo_import(str(REPO))
    from launch_guard import LaunchAudit, pin_git
    git = shutil.which("git")
    subprocess.Popen = pin_git(subprocess.Popen, git)
    sys.addaudithook(LaunchAudit(root, git=git, providers=[]))
    from orgtree import appsettings, store, supervisor
    org = store.load_org(desc["org"])
    sources = []
    keepalive_until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).isoformat()
    for nid in desc["live_agents"]:
        node = org.node(nid)
        if node.get("halt") or node.get("frozen") or node.get("inflight"):
            raise RuntimeError("steady fixture must be freshly seeded and runnable")
        path = supervisor.transcript_path_for_node(org, nid)
        sid = str(node["session_id"])
        if path:
            sources.append((Path(path), sid))
        node["cache_keepalive_at"] = keepalive_until
        node["model"] = "luna"
        node["account"] = ""
        node["codex_thread"] = sid
    # Keep timed demand controlled. Ordinary engine recovery, queueing, capture,
    # storage, websocket and watchdog paths remain production implementations.
    appsettings.set_working_checkups_enabled(False)
    appsettings.set_idle_docket_reminders_enabled(False)
    appsettings.set_blocked_docket_reminders_enabled(False)
    org._work_archive_eligible()
    store.save_org(org)
    target = Path(supervisor.journal_store()) / "projects" / desc["org"]
    target.mkdir(parents=True, exist_ok=True)
    copied = 0
    for source, sid in sources:
        shutil.copyfile(source, target / (sid + ".jsonl"))
        copied += source.stat().st_size
    manifest = dict(schema="scale-simulated-provider-v1", org=desc["org"],
                    nodes=desc["live_agents"], seconds=args.seconds, output_bytes=args.output_bytes,
                    cache_keepalive_suppressed_until=keepalive_until,
                    transcript_sources=len(sources), transcript_bytes=copied,
                    limitation="Codex provider dispatch with assumed service time; no CLI, inference or provider memory",
                    provenance=provenance.receipt())
    (root / "simulated-provider.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({k: manifest[k] for k in ("schema", "seconds", "output_bytes", "transcript_sources")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
