"""ONE real Codex Luna turn. Requires explicit coordinator authorization to run.

Use --authorize-one-codex-turn only after the independent MCP controls pass.
This program retains its isolated organization, reports and provider transcript.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--authorize-one-codex-turn", action="store_true")
args = parser.parse_args()
if not args.authorize_one_codex_turn:
    print(json.dumps({"status": "INERT", "reason": "Explicit one-turn authorization required"}))
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[2]
RUN = Path(tempfile.mkdtemp(prefix="orgtree-v2-provider-")).resolve()
DATA = RUN / "data"
PROJECT = RUN / "project"
DATA.mkdir(); PROJECT.mkdir()
forbidden = (Path.home() / "orgtree").resolve()
assert forbidden not in DATA.parents and DATA != forbidden
token = secrets.token_hex(32)
env = dict(os.environ)
for key in ("ORGTREE_PORT", "ORGTREE_BASE", "ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT", "ORGTREE_AGENT_TOKEN", "ORGTREE_V2_HUB_TOKEN"):
    env.pop(key, None)
env.update(ORGTREE_DATA=str(DATA), ORGTREE_V2_TOKEN=token,
           ORGTREE_V2_UI_DIR=str(ROOT / "dist" / "renderer"),
           ORGTREE_V2_PARENT_PID=str(os.getpid()))
sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
report = {"status": "FAIL", "evidence": "real-engine-and-real-codex-provider", "root": str(RUN),
          "requestedTier": "luna", "preferReserve": True,
          "sourceCommit": sha, "python": sys.executable,
          "launcherSha256": hashlib.sha256((ROOT / "engine" / "launch.py").read_bytes()).hexdigest(),
          "oneTurnRequested": False, "chartObserved": False, "arithmeticObserved": False}
lines = queue.Queue()
log = (RUN / "engine-stderr.log").open("w", encoding="utf-8")
child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("provider_engine.py"))],
                         cwd=ROOT / "engine", env=env, stdout=subprocess.PIPE, stderr=log,
                         text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
report["enginePid"] = child.pid


def consume():
    for line in child.stdout:
        try:
            row = json.loads(line)
            if row.get("type") == "ready":
                lines.put(row)
        except (ValueError, AttributeError):
            pass
    lines.put(None)


threading.Thread(target=consume, daemon=True).start()
port = None
created = False


def request(route, body=None):
    assert port and port != 7360
    req = urllib.request.Request(f"http://127.0.0.1:{port}{route}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"X-Orgtree-Desktop-Token": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


try:
    ready = lines.get(timeout=75)
    assert ready and ready["protocol"] == 1 and ready["pid"] == child.pid
    assert Path(ready["dataRootId"]).resolve() == DATA
    port = ready["port"]
    assert 0 < port < 65536 and port != 7360
    report["port"] = port
    assert request("/api/orgs") == []
    org = request("/api/orgs", {"name": "v2-codex-acceptance", "dirs": [str(PROJECT)], "permission_mode": "plan", "net_autoconnect": False})
    assert org["slug"] == "v2-codex-acceptance"
    created = True
    hired = request("/api/orgs/v2-codex-acceptance/ops", {
        "op": "hire", "name": "probe", "tier": "luna", "grant": 0,
        "charter": "You are a bounded acceptance test. Perform only the requested arithmetic and one read-only orgtree_chart call. Never call status, send mail, modify files, hire agents, or perform any other tool action. Return the requested result and stop.",
        "add_dirs": [{"path": str(PROJECT), "mode": "ro"}],
        "tools": {"bash": False, "edit": False, "web": False, "subagents": False, "mcp": []},
        "org_visibility": "full", "effort": "low", "prefer_reserve": True,
    })
    assert hired["node"] == "probe"
    request("/api/orgs/v2-codex-acceptance/nodes/probe/message", {"text":
        "This is the entire one-turn acceptance task. Compute 6 times 7 mentally. Call orgtree_chart exactly once, read-only, and confirm the returned chart contains your own probe node in v2-codex-acceptance. Then return one final line starting V2_ACCEPTANCE_RESULT with the arithmetic answer and the observed organization/node names. No other tool calls, status reports, file changes, mail or actions are authorized. Stop after the final line."})
    report["oneTurnRequested"] = True
    start = time.monotonic()
    while time.monotonic() - start < 240:
        chat = request("/api/orgs/v2-codex-acceptance/nodes/probe/chat?last=80")
        assistant = [row.get("text", "") for row in chat.get("messages", []) if row.get("role") == "assistant"]
        result_text = next((text for text in assistant if "V2_ACCEPTANCE_RESULT" in text and "42" in text and "v2-codex-acceptance" in text and "probe" in text), None)
        observations = RUN / "tool-observations.jsonl"
        calls = [json.loads(line) for line in observations.read_text(encoding="utf-8").splitlines()] if observations.exists() else []
        report["chartObserved"] = any(row["httpStatus"] == 200 and row["port"] == port for row in calls)
        report["arithmeticObserved"] = result_text is not None
        if result_text and report["chartObserved"]:
            report["assistantResult"] = result_text
            report["mcpTarget"] = json.loads((RUN / "mcp-target.json").read_text(encoding="utf-8"))
            report["status"] = "PASS"
            break
        if int(time.monotonic() - start) % 20 < 2:
            print(json.dumps({"progress": "waiting-for-real-agent", "elapsedSeconds": int(time.monotonic() - start), "chartObserved": report["chartObserved"], "root": str(RUN)}), flush=True)
        time.sleep(2)
    if report["status"] != "PASS":
        report["reason"] = "No matching assistant result and actual chart request within the bounded run"
except Exception as error:
    report["reason"] = "Acceptance operation failed: " + type(error).__name__
    if isinstance(error, urllib.error.HTTPError):
        report["httpStatus"] = error.code
finally:
    if port and child.poll() is None:
        if created:
            try: request("/api/orgs/v2-codex-acceptance/killswitch", {})
            except Exception: pass
        try: request("/api/desktop/shutdown", {})
        except Exception: pass
    try:
        child.wait(timeout=20)
    except subprocess.TimeoutExpired:
        child.terminate()
        child.wait(timeout=10)
        report["status"] = "FAIL"
        report["shutdownFallback"] = True
    report["engineExitCode"] = child.returncode
    if child.returncode != 0:
        report["status"] = "FAIL"
    observations = RUN / "tool-observations.jsonl"
    report["chartCallCount"] = len(observations.read_text(encoding="utf-8").splitlines()) if observations.exists() else 0
    if report["chartCallCount"] != 1:
        report["status"] = "FAIL"
    log.close()
    (RUN / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)
raise SystemExit(0 if report["status"] == "PASS" else 1)
