"""Test double for `claude auth login`, used only by test_claude_login.py.

Speaks the same stdout-prompt / stdin-code contract as the real CLI (a
verification-code prompt with NO trailing newline, waited for on stdin) so
claude_login.py's process/handshake logic can be exercised without ever
starting a real login, opening a real browser or touching a real account.

Mode is read from $FIXTURE_MODE:
  success       — prompts for a code, then (whatever was typed) writes a
                  fake oauthAccount block to $FIXTURE_CONFIG_PATH and exits 0
                  — exactly what a real successful `claude auth login` does
                  to `~/.claude.json`.
  invalid_code  — prompts for a code, then exits 1 without writing anything
                  (a rejected code).
  no_write      — prompts for a code, then exits 0 WITHOUT writing anything
                  — the positive control for "exit code alone is not proof".
  crash         — exits 2 immediately, before ever asking for a code.
"""
import json
import os
import sys

PROMPT = "Paste code here if prompted > "
mode = os.environ.get("FIXTURE_MODE", "success")
if os.environ.get("FIXTURE_PROFILE_PROBE"):
    with open(os.environ["FIXTURE_PROFILE_PROBE"], "w", encoding="utf-8") as probe:
        json.dump({key: os.environ.get(key) for key in ("CLAUDE_CONFIG_DIR", "CODEX_HOME")}, probe)

if mode == "crash":
    sys.stderr.write("fixture: simulated CLI crash before any prompt\n")
    sys.exit(2)

sys.stdout.write(f"pid:{os.getpid()}\n")
sys.stdout.write("Visit https://example.invalid/authorize?state=fixture "
                  "in your browser to continue.\n")
sys.stdout.write(PROMPT)
sys.stdout.flush()
sys.stdin.readline()   # the code itself is deliberately never echoed back

if mode == "invalid_code":
    sys.stdout.write("\nAuthentication failed: Invalid authorization code\n")
    sys.exit(1)

if mode == "no_write":
    sys.exit(0)

config_path = os.environ["FIXTURE_CONFIG_PATH"]
os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, "w", encoding="utf-8") as f:
    json.dump({"oauthAccount": {"accountUuid": "fixture-uuid-1",
                                 "emailAddress": "fixture@example.invalid"}}, f)
sys.stdout.write("\nSign-in complete.\n")
sys.exit(0)
