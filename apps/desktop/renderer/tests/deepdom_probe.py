#!/usr/bin/env python3
"""deepdom_probe.py — count, at RUNTIME, every deep-equality assertion in the
frontend suite whose operands are DOM nodes.

WHY THIS EXISTS SEPARATELY FROM deepdom.test.tsx §5. That guard is a source
regex, it runs on every commit, and it cannot see a bare variable
(`assert.deepEqual(row, other)` where `row` was assigned an element earlier).
Whether an operand is a DOM node is a RUNTIME fact. This drives the whole
suite with `node:assert` patched, so it answers the question exactly instead
of approximately — at the cost of a full suite run.

⚠ IT PROVES ITSELF FIRST (D-158/D-168). A probe that silently failed to attach
would report ZERO violations, and zero is exactly what a clean suite reports —
abstention would be indistinguishable from success, and it would be the
reassuring one. So before measuring anything this plants a CANARY suite
containing a real violation, runs it, and aborts as BROKEN unless the probe
saw it. Only then does the real count mean anything.

Run:  cd frontend && python tests/deepdom_probe.py
"""
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
FE = HERE.parent
HOOK = HERE / "deepdom_probe.mjs"
LOG = FE / "node_modules" / ".deepdom-probe.log"
CANARY = HERE / "zzcanary.test.tsx"

# ⚠ two SAME-TAG elements with different content. The point of the canary is
# that this assertion PASSES — it is the defect itself — while the probe must
# still record that it happened.
CANARY_SRC = """// zzcanary.test.tsx — TEMPORARY, written and deleted by deepdom_probe.py.
// If you are reading this in a commit, the probe crashed mid-run; delete it.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'

test('canary: a DOM deep-equality that cannot fail', () => {
  const a = document.createElement('p'); a.textContent = 'one'
  const b = document.createElement('p'); b.textContent = 'two'
  // PASSES. That is the defect, and the probe must see the call.
  assert.deepEqual(a, b)
})
"""


def run(filt: str) -> tuple[bool, str]:
    """run the suite (optionally filtered) with the probe attached."""
    if LOG.exists():
        LOG.unlink()
    LOG.write_text("", encoding="utf-8")
    env = dict(os.environ)
    env["ORGTREE_DEEPPROBE_LOG"] = str(LOG)
    # --enable-source-maps so a hit names the .tsx line, not the esbuild
    # bundle offset; the bundles carry inline sourcemaps already
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "")
                           + f" --import {HOOK.as_uri()} --enable-source-maps").strip()
    cmd = ["node", "tests/run.mjs"] + ([filt] if filt else [])
    # ⚠ env=env is load-bearing. It was omitted once: the environment was
    # built correctly and then not passed, so the child ran WITHOUT the hook
    # and reported zero violations — the reassuring answer, arrived at by not
    # measuring. The canary below is the only reason that was caught.
    p = subprocess.run(cmd, cwd=FE, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    ran = "tests " in out and ("pass " in out or "fail " in out)
    return ran, out


def hits() -> list[dict]:
    if not LOG.exists():
        return []
    rows = []
    for line in LOG.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def main() -> int:
    try:
        # ── 1. PROVE THE PROBE ATTACHES ────────────────────────────────────
        CANARY.write_text(CANARY_SRC, encoding="utf-8")
        ran, out = run("zzcanary")
        if not ran:
            print("BROKEN: the canary suite did not run at all")
            print(out[-2000:])
            return 1
        seen = hits()
        if not seen:
            print("BROKEN: the probe did NOT record the canary's DOM "
                  "deep-equality.\n  It is not attached, so a zero from it "
                  "would mean nothing. Check that run.mjs still forwards "
                  "NODE_OPTIONS to the test child.")
            return 1
        print(f"probe VALIDATED — it saw the canary ({len(seen)} call(s): "
              f"{seen[0].get('a')} vs {seen[0].get('b')})\n")
    finally:
        if CANARY.exists():
            CANARY.unlink()

    # ── 2. MEASURE THE REAL SUITE ──────────────────────────────────────────
    ran, out = run("")
    if not ran:
        print("BROKEN: the full suite did not run")
        print(out[-2000:])
        return 1
    tally = [ln for ln in out.splitlines()
             if ln.strip().startswith(("ℹ tests", "ℹ pass", "ℹ fail"))]
    for ln in tally:
        print(ln.strip())
    # deepdom.test.tsx PERFORMS these comparisons deliberately, inside a
    # `threw()` wrapper, to prove the defect exists. Counting its own
    # demonstration as a violation would make the guard unrunnable.
    found = [h for h in hits() if 'deepdom.test' not in (h.get('at') or '')]
    demo = len(hits()) - len(found)
    if demo:
        print(f"({demo} call(s) in deepdom.test.tsx are the deliberate "
              f"demonstration of the defect — not counted)")
    print(f"\nDOM deep-equality assertions in the suite: {len(found)}")
    for h in found:
        print(f"  {h.get('fn')}({h.get('a')}, {h.get('b')})  at {h.get('at')}")
    if found:
        print("\nEach of those can NEVER fail if the two operands share a tag "
              "(deepdom.test.tsx §1). Replace with identity / textContent / "
              "outerHTML and prove the replacement goes red.")
        return 1
    print("none — every deep-equality in the suite compares values, not nodes")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
