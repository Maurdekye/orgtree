"""Measure live effort on a Claude Code build: re-run this before moving
clipin.PIN, then set supervisor.LIVE_EFFORT_MEASURED_CLI (test_live_effort
holds the two equal). First used on 2.1.284, item
sonnet-5-5-support-in-a-2-1-13-build-and-v3. Spends a few real turns on the
signed-in Claude account; touches no Orgtree data.

Imports no orgtree code, so the repo-import guard does not apply: it drives a
bare claude.exe in a throwaway cwd and reads the CLI's own session transcript.

For each model it runs one turn that must make several model calls (four
Bash calls, one at a time). Arm "switch": after the first tool_use arrives it
writes the same stream-json control_request orgtree sends
(apply_flag_settings {effortLevel}) and records the reply. Arm "control": the
same turn with no request. The verdict reads the `effort` field of every
assistant line in ~/.claude/projects/<cwd>/<session>.jsonl.

usage: python tools/measure_live_effort.py <claude.exe> <out.json> [model ...]
"""
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

PROMPT = ("Run these shell commands with the Bash tool, ONE per tool call, waiting for "
          "each result before the next: `echo one`, then `echo two`, then `echo three`, "
          "then `echo four`. After the last one, reply with just DONE.")


def project_dir(cwd: str) -> pathlib.Path:
    slug = "".join(c if c.isalnum() else "-" for c in cwd)
    return pathlib.Path.home() / ".claude" / "projects" / slug


def run(exe: str, model: str, arm: str, start: str, to: str) -> dict:
    cwd = os.path.join(r"C:\Temp", f"le-measure-{model}-{arm}-{int(time.time())}")
    os.makedirs(cwd)
    argv = [exe, "-p", "--output-format", "stream-json", "--input-format", "stream-json",
            "--verbose", "--model", model, "--effort", start,
            "--permission-mode", "bypassPermissions", "--strict-mcp-config"]
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CODE_") and k != "CLAUDECODE"}
    p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env)
    err = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": PROMPT}}) + "\n")
    p.stdin.flush()
    sent = None
    reply = None
    session = None
    tool_uses = 0
    result = None
    deadline = time.time() + 600
    for line in p.stdout:
        if time.time() > deadline:
            break
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            session = ev.get("session_id")
        if ev.get("type") == "assistant":
            for c in ev.get("message", {}).get("content", []) or []:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    tool_uses += 1
                    if arm == "switch" and sent is None:
                        sent = {"after_tool_use": tool_uses, "at": time.time()}
                        p.stdin.write(json.dumps({
                            "type": "control_request", "request_id": "effort-measure",
                            "request": {"subtype": "apply_flag_settings",
                                        "settings": {"effortLevel": to}}}) + "\n")
                        p.stdin.flush()
        if ev.get("type") == "control_response":
            reply = ev
        if ev.get("type") == "result":
            result = {k: ev.get(k) for k in ("subtype", "is_error", "num_turns", "result")}
            break
    try:
        p.stdin.close()
    except OSError:
        pass
    try:
        p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        p.kill()
    rows = []
    tx = project_dir(cwd) / f"{session}.jsonl"
    if session and tx.exists():
        for ln in tx.read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            if d.get("type") == "assistant":
                m = d.get("message", {})
                kinds = [c.get("type") for c in m.get("content", []) if isinstance(c, dict)]
                rows.append({"msg_id": m.get("id"), "model": m.get("model"),
                             "effort": d.get("effort"), "content": kinds})
    return {"model": model, "arm": arm, "start": start, "to": to if arm == "switch" else None,
            "cwd": cwd, "session": session, "transcript": str(tx), "tool_uses": tool_uses,
            "sent": sent, "control_response": reply, "result": result,
            "assistant_rows": rows, "exit": p.returncode, "stderr_tail": "".join(err)[-1500:]}


def main() -> None:
    exe, out = sys.argv[1], sys.argv[2]
    models = sys.argv[3:] or ["claude-opus-5-5", "claude-sonnet-5"]
    ver = subprocess.run([exe, "--version"], capture_output=True, text=True).stdout.strip()
    runs = []
    for model in models:
        for arm in ("switch", "control"):
            r = run(exe, model, arm, "low", "high")
            runs.append(r)
            print(model, arm, "tool_uses", r["tool_uses"], "efforts",
                  [x["effort"] for x in r["assistant_rows"]], flush=True)
    json.dump({"cli": ver, "exe": exe, "runs": runs}, open(out, "w", encoding="utf-8"), indent=1)
    print("cli", ver)


if __name__ == "__main__":
    main()
