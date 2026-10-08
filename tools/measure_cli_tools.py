"""Measure which tools a real Claude Code CLI offers an orgtree agent, per
launch environment (docs/rust-engine/cli-environment.md, decision 53).

Each arm starts claude.exe the way the engine does (stream-json both ways, the
host's CLAUDE_CODE_* removed, then the arm's variables), sends one short user
message, reads the `system/init` event, and kills the process tree at once.
The init event lists the session's tools before the model answers, so an arm
costs at most one cut-off request on the signed-in account. Nothing is run by
the model. The mail hub's SessionStart hook is noted per arm: it should stand
down when ORGTREE_NODE is set.

Afterwards, delete what the CLI left: the transcript folders this prints under
~/.claude/projects, ~/.claude/session-env/<session> and the shell snapshots
created during the run.

usage: python tools/measure_cli_tools.py <claude.exe> <out.json> [model]
"""
import json
import os
import pathlib
import subprocess
import sys
import time

ARMS = {
    # what 4.0.0 and 4.0.1 start agents with
    "4.0.1": {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "ORGTREE_AGENT": "measure"},
    # the fixed launch (decision 53)
    "fixed": {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1",
              "CLAUDE_CODE_USE_POWERSHELL_TOOL": "1", "ORGTREE_AGENT": "measure", "ORGTREE_NODE": "measure"},
    # the cached flags alone, without asking for PowerShell
    "cache-only": {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1",
                   "ORGTREE_AGENT": "measure", "ORGTREE_NODE": "measure"},
}


def run(exe: str, model: str, arm: str, extra: dict) -> dict:
    cwd = os.path.join(r"E:\orgtree-rig\tmp", f"cli-tools-{arm}-{int(time.time())}")
    os.makedirs(cwd)
    argv = [exe, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--model", model, "--permission-mode", "default", "--strict-mcp-config"]
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith("CLAUDE_CODE_") and k.upper() not in ("CLAUDECODE", "ORGTREE_NODE", "ORGTREE_AGENT")}
    env.update(extra)
    started = time.time()
    p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         text=True, encoding="utf-8", env=env)
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": "Reply with OK."}}) + "\n")
    p.stdin.flush()
    init, hook, session = None, [], None
    deadline = time.time() + 120
    for line in p.stdout:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "system" and str(ev.get("subtype", "")).startswith("hook"):
            hook.append({"subtype": ev.get("subtype"), "hub": "mailhub" in json.dumps(ev)})
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            init, session = ev, ev.get("session_id")
            break
        if time.time() > deadline:
            break
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
    tools = init.get("tools", []) if init else []
    project = pathlib.Path.home() / ".claude" / "projects" / "".join(c if c.isalnum() else "-" for c in cwd)
    time.sleep(1)
    transcript = project / f"{session}.jsonl"
    hub_in_transcript = transcript.exists() and "mailhub" in transcript.read_text(encoding="utf-8", errors="replace")
    return {"arm": arm, "env": extra, "cwd": cwd, "session": session, "started": started,
            "shells": [t for t in tools if t in ("Bash", "PowerShell")], "tools": len(tools),
            "names": sorted(t for t in tools if not t.startswith("mcp__")), "hooks": hook,
            "hub_hook_in_transcript": hub_in_transcript, "project": str(project)}


def main() -> None:
    exe, out = sys.argv[1], sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "haiku"
    ver = subprocess.run([exe, "--version"], capture_output=True, text=True).stdout.strip()
    runs = [run(exe, model, arm, extra) for arm, extra in ARMS.items()]
    for r in runs:
        print(r["arm"], "shells", r["shells"], "tools", r["tools"], "hub hook events", [h for h in r["hooks"] if h["hub"]],
              "hub text in transcript", r["hub_hook_in_transcript"], flush=True)
    json.dump({"cli": ver, "model": model, "runs": runs}, open(out, "w", encoding="utf-8"), indent=1)
    print("cli", ver)


if __name__ == "__main__":
    main()
