"""Reuse the reviewed whole-App probe; never promote it to full-product proof."""
from __future__ import annotations

from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

BASELINE = tuple("""cold-held cold-visible-exact cold-renderer-errors
homepage-ignores-saved-org homepage-bound-same-document homepage-visible-exact homepage-existing-org
wide-header narrow-header narrow-header-armed narrow-header-halted shell-menu-keyboard
settings-local-open settings-concurrent settings-a-to-b settings-b-to-a settings-local-close
create-blank-separate create-dirty-published create-cancel-registry create-failure-preserves create-success-binds
guard-other-window guard-stale-document guard-current-visible guard-outside-path
reload-provisional reload-visible-exact retry-held-on-failure retry-visible-exact
truncated-committed truncated-holding truncated-visible-exact
AT1 AT2 AT3 AQ1 AQ2 AQ3 AQ4 AQ5 AT4 AT5 AT6 AT7 AT8 AT9 TD1 TD2 TD4 TD3 AT10
MW1 MW2 MW3 MW4 MW5""".split())
ROSTERS = {
    "baseline": BASELINE,
    "no-bus": ("cold-held", "cold-visible-exact", "cold-renderer-errors"),
    "no-readiness": ("cold-held", "cold-visible-exact", "cold-renderer-errors", "control-readiness-exercised"),
    "no-lifecycle": ("reload-provisional", "reload-visible-exact"),
    "no-compact-header": BASELINE,
}
FAILURES = {
    "baseline": set(), "no-bus": {"cold-visible-exact"}, "no-readiness": {"cold-visible-exact"},
    "no-lifecycle": {"reload-visible-exact"},
    "no-compact-header": {"narrow-header", "narrow-header-armed", "narrow-header-halted"},
}
PROBE_LIMITS = [
    "main/index.ts startup/IPC glue is not executed; fixture-owned bindings are described in source header",
    "canned loopback HTTP and synthetic WebSocket frames; no real engine, OS notification service, install or updater",
    "main BrowserWindows are offscreen; screenshots and DOM geometry assert rendered visibility",
    "Create close cancellation is a native registry decision; no OS confirmation dialog is shown",
    "App, preload, Preferences, held-event registration, registry/outbox and lifecycle modules are production code; controls explicitly remove the named mechanism",
]
LIMITS = [*PROBE_LIMITS,
    "Production React build only; no development StrictMode qualification",
    "Total probe duration includes builds, fixtures and deliberate waits; no commit-to-paint latency claim",
    "Receipt details and artifact hashes retained; temporary screenshots/builds are removed after measurement",
]
# The worker cannot launch anything until the parent owns its Windows Job.
LAUNCHER = """import json,subprocess,sys
command=json.loads(sys.argv[1])
if sys.stdin.readline().strip() != 'owned': raise SystemExit(70)
raise SystemExit(subprocess.call(command))
"""


def run_owned(repo, interpreter, command, env, directory, timeout):
    """Own a waiting launcher before allowing Node/Electron to create children."""
    if os.name != "nt":
        raise RuntimeError("UI process-tree ownership requires Windows")
    spec = importlib.util.spec_from_file_location("qualification_lifetime", repo/"engine/process_lifetime.py")
    lifetime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lifetime)
    receipt = {"tree_cleanup_completed": False, "timed_out": False, "exit_code": None, "errors": []}
    tree = process = None
    started = time.monotonic()
    with (directory/"launcher.stdout.log").open("wb") as out, (directory/"launcher.stderr.log").open("wb") as err:
        try:
            process = subprocess.Popen([interpreter,"-I","-B","-c",LAUNCHER,json.dumps(command)],
                cwd=repo,env=env,stdin=subprocess.PIPE,stdout=out,stderr=err,
                creationflags=subprocess.CREATE_NO_WINDOW)
            receipt["launcher_pid"] = process.pid
            tree = lifetime.WindowsTree(process.pid, 0)
            tree.arm()
            process.stdin.write(b"owned\n")
            process.stdin.flush()
            process.stdin.close()
            receipt["exit_code"] = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            receipt["timed_out"] = True
            receipt["errors"].append("UI probe exceeded its process deadline")
        except Exception as exc:
            receipt["errors"].append(f"{type(exc).__name__}: {exc}")
        finally:
            try:
                if tree is not None and tree.armed:
                    # Production primitive waits for zero active Job processes.
                    tree.terminate()
                elif process is not None and process.poll() is None:
                    # No ownership handshake was sent, so no child could start.
                    process.kill()
                if process is not None:
                    process.wait(timeout=10)
                receipt["tree_cleanup_completed"] = True
            except Exception as exc:
                receipt["errors"].append(f"process-tree cleanup: {type(exc).__name__}: {exc}")
            finally:
                if tree is not None:
                    tree.close()
                if process is not None and process.stdin is not None:
                    process.stdin.close()
    receipt["elapsed_s"] = time.monotonic()-started
    return receipt


def probe_errors(payload, source, http, mode, exit_code, expected_source, electron):
    """Require every named assertion, exact intended failures and source identity."""
    errors = []
    if not isinstance(payload, dict) or payload.get("mode") != mode:
        return ["UI probe report mode/object mismatch"]
    checks = payload.get("checks")
    if (not isinstance(checks, list) or any(not isinstance(c, dict) or not isinstance(c.get("id"), str)
            or type(c.get("ok")) is not bool for c in checks)):
        return ["UI checks must be named objects with boolean outcomes"]
    if Counter(c["id"] for c in checks) != Counter(ROSTERS[mode]):
        errors.append("UI assertion coverage mismatch (missing, duplicate or unknown assertion)")
    failing = {c["id"] for c in checks if not c["ok"]}
    if failing != FAILURES[mode]:
        errors.append(f"UI failures mismatch: expected {sorted(FAILURES[mode])}, got {sorted(failing)}")
    summary = payload.get("summary")
    if (not isinstance(summary, dict) or type(summary.get("assertions")) is not int
            or type(summary.get("failing")) is not int or summary["assertions"] != len(checks)
            or summary["failing"] != sum(not c["ok"] for c in checks)):
        errors.append("UI summary disagrees with assertion outcomes")
    if payload.get("limits") != PROBE_LIMITS:
        errors.append("UI probe evidence boundaries changed")
    if type(exit_code) is not int or exit_code != (0 if mode == "baseline" else 1):
        errors.append("UI probe did not exit with its expected result")
    if (not isinstance(electron, dict) or electron.get("schema") != "orgtree.app-composition-process/v1"
            or type(electron.get("status")) is not int or electron["status"] != (0 if mode == "baseline" else 1)
            or "signal" not in electron or electron["signal"] is not None
            or "error" not in electron or electron["error"] is not None):
        errors.append("Electron child did not exit normally with its expected result")
    if source != {**expected_source, "mode":mode, "entry":"apps/desktop/renderer/src/main.tsx"}:
        errors.append("UI probe source identity mismatch")
    if (not isinstance(http, dict) or http.get("unexpected") != [] or not isinstance(http.get("requests"), list)
            or not http["requests"] or any(not isinstance(r, str) for r in http["requests"])):
        errors.append("UI HTTP fixture receipt missing or contains unexpected requests")
    return errors


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 2_000_000:
        raise ValueError(f"missing, linked or oversized UI receipt: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def evidence_files(directory):
    """Bounded hashes preserve attribution without embedding builds or images."""
    paths = sorted(p for p in directory.iterdir() if p.suffix in {".png", ".log", ".json"})
    if len(paths) > 100:
        raise ValueError("UI evidence file count exceeded bound")
    result = []
    for path in paths:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 16_000_000:
            raise ValueError("linked or oversized UI evidence file")
        data = path.read_bytes()
        result.append({"name":path.name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    return result


def run_ui(repo, root, interpreter, env, timeout):
    rows, controls, errors = [], [], []
    node = shutil.which("node", path=env.get("PATH"))
    if os.name != "nt" or node is None:
        reason = "UI adapter requires Windows process ownership and a Node executable"
        return [{"id":"ui.baseline","level":"composed","classification":"environment_limited",
                 "errors":[reason],"limits":LIMITS}], [], [reason]
    def git(*args):
        return subprocess.check_output(["git",*args],cwd=repo,env=env,text=True,encoding="utf-8")
    expected_source = {"head":git("rev-parse","HEAD").strip(),"status":git("status","--short")}
    for mode in ROSTERS:
        directory = root/("ui-"+mode)
        directory.mkdir()
        output = directory/"probe"
        row = {"id":"ui."+mode,"level":"composed","limits":LIMITS,"errors":[],
               "boundary":"shipping App/preload/native helpers; fixture main, canned HTTP/WS, offscreen Electron"}
        try:
            row["process"] = run_owned(repo,interpreter,[node,str(repo/"tools/run-app-composition-probe.mjs"),
                str(output),mode],env,directory,timeout)
            row["errors"].extend(row["process"]["errors"])
            if row["process"]["tree_cleanup_completed"] is not True:
                row["errors"].append("UI process-tree cleanup was not proven")
            children = list(output.iterdir()) if output.is_dir() else []
            if len(children) != 1 or children[0].is_symlink() or not children[0].is_dir() or not children[0].name.startswith(mode+"-"):
                raise ValueError("UI probe did not produce exactly one owned run directory")
            run = children[0]
            payload, source, http, electron = (read_json(run/name) for name in (
                "result.json","source.json","http.json","electron-outcome.json"))
            row.update(receipt=payload,source=source,http=http,electron=electron,artifacts=evidence_files(run))
            row["errors"].extend(probe_errors(payload,source,http,mode,row["process"]["exit_code"],expected_source,electron))
        except Exception as exc:
            row["errors"].append(f"{type(exc).__name__}: {exc}")
        for name in ("launcher.stdout.log", "launcher.stderr.log"):
            path = directory/name
            if path.is_file():
                with path.open("rb") as stream:
                    stream.seek(max(0,path.stat().st_size-2000))
                    row[name+"_tail"] = stream.read(2000).decode("utf-8",errors="replace")
        if mode == "baseline":
            row["classification"] = "failed" if row["errors"] else "passed"
            rows.append(row)
        else:
            row.update(baseline_passed=rows[0]["classification"] == "passed",
                       detected=not row["errors"],mechanism="reviewed probe removes named production mechanism")
            row["classification"] = "expected_negative" if row["baseline_passed"] and not row["errors"] else "failed"
            controls.append(row)
        errors.extend(f"{row['id']}: {error}" for error in row["errors"])
    return rows, controls, errors
