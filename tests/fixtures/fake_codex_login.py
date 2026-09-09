"""Test double for `codex login`, used only by test_codex_login.py.

Unlike Claude's CLI, the real `codex login` takes NO stdin input at all —
it waits for its own local redirect server, then exits on its own. This
double mirrors exactly that: it never reads stdin, only prints a couple of
lines and exits according to $FIXTURE_MODE.

  success   — prints the CLI's own "Starting local login server"/"Open this
              link" lines, writes a fake auth.json to $FIXTURE_CODEX_HOME
              (mirroring providers._codex_account's `tokens` shape), exits 0.
  no_write  — exits 0 WITHOUT writing anything — the positive control for
              "exit code alone is not proof".
  crash     — exits 2 immediately.
"""
import json
import os
import sys
import time

mode = os.environ.get("FIXTURE_MODE", "success")
if os.environ.get("FIXTURE_PROFILE_PROBE"):
    with open(os.environ["FIXTURE_PROFILE_PROBE"], "w", encoding="utf-8") as probe:
        json.dump({key: os.environ.get(key) for key in ("CLAUDE_CONFIG_DIR", "CODEX_HOME")}, probe)

if mode == "crash":
    sys.stderr.write("fixture: simulated codex login crash\n")
    sys.exit(2)

sys.stdout.write("Starting local login server on http://127.0.0.1:1/\n")
sys.stdout.write("1. Open this link in your browser and sign in to your account\n")
sys.stdout.flush()

if mode == "hang":
    # simulates "still waiting for the browser redirect" — never exits on
    # its own, so tests can exercise cancel/timeout/repeated-start dedup
    time.sleep(3600)
    sys.exit(0)

if mode == "no_write":
    sys.exit(0)

home = os.environ["FIXTURE_CODEX_HOME"]
os.makedirs(home, exist_ok=True)
with open(os.path.join(home, "auth.json"), "w", encoding="utf-8") as f:
    json.dump({"tokens": {"id_token": "a.b.c"}}, f)
sys.stdout.write("Successfully logged in.\n")
sys.exit(0)
