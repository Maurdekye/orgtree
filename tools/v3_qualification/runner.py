"""Run a bounded synthetic qualification slice and preserve honest coverage."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter

from .evidence import negative_controls
from .adapters import run_migration, run_wire

SCHEMA = "orgtree.v3-qualification/v1"
MISSING = {
    "native-postgresql": "Private PostgreSQL service, transaction conflicts, WAL and projection recovery are not connected.",
    "rust-backend": "The full Rust runtime is not available in this slice.",
    "migration-rollback": "Synthetic preparation can be measured with --migration; native import, cutover and post-acknowledgment rollback remain unexercised.",
    "multi-window": "Native window identity, tray/notification routing and restoration adapter pending.",
    "attention-desk": "Whole-App Attention/Desk retention adapter pending.",
    "full-product": "No installed or packaged desktop, native services or commit-to-paint measurement.",
    "mixed-demand": "Current measured mix is evidence append only; reads/tree/user inbox/answer/settings are not measured.",
    "scale-settle": "Cold start, 10x unrelated history and churn-then-settle are not measured.",
    "unsafe-product-controls": "Observation mutations test checker sensitivity; omitted invariants/global locks/external-effect mutations are not injected into production.",
    "crash-power-loss": "Only clean worker reopen is exercised; no native termination or power-loss claim.",
    "logical-census": "HTTP attempt and logical operation counts are explicit only for this known workload; no all-entry/locality claim.",
    "races-and-torn-state": "No concurrent revoke-versus-dispatch, torn composite, finite funding, topology, or feed commit-order schedule yet.",
}
COMPONENTS = ["tests/test_toolcall_single_load.py", "tests/test_mail_drain.py",
              "tests/test_restart_marker_identity.py", "tests/test_startup_recovery.py"]


def verification_module(repo):
    spec = importlib.util.spec_from_file_location("qualification_verification", repo / "tools/run-python-verification.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def identity(repo):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True, encoding="utf-8").strip()
    # Include untracked source files; exclude ignored generated output/dependencies.
    paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")
    digest = hashlib.sha256()
    for name in sorted(set(paths)):
        if not name:
            continue
        path = repo / name
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"missing")
    return {"commit":git("rev-parse","HEAD"), "tree":git("rev-parse","HEAD^{tree}"),
            "dirty":bool(git("status","--porcelain")),"source_sha256":digest.hexdigest()}


def child_env(root):
    # Clear inherited live deployment/provider selectors before any product import.
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith(
        ("ORGTREE_", "OPENAI_", "ANTHROPIC_", "CLAUDE_", "CODEX_", "GEMINI_", "GOOGLE_API"))}
    env.update(ORGTREE_DATA=str(root/"data"), ORGTREE_STORE="sqlite",
               HOME=str(root/"home"), USERPROFILE=str(root/"home"),
               APPDATA=str(root/"home"), LOCALAPPDATA=str(root/"home"), XDG_CONFIG_HOME=str(root/"home"),
               ORGTREE_V2_TOKEN="qualification-only", PYTHONIOENCODING="utf-8",
               PYTHONDONTWRITEBYTECODE="1", GIT_OPTIONAL_LOCKS="0")
    return env


def forbid_external_process(event, args):
    """Permit read-only Git identity queries; never providers or installed apps."""
    if event == "subprocess.Popen" and len(args) >= 2:
        executable, command = args[:2]
        words = shlex.split(command, posix=False) if isinstance(command, str) else list(command)
        words = [str(word).strip('"') for word in words]
        # No shell, -c configuration, alternate executable, or arbitrary git verb.
        if words and Path(words[0]).name.lower() in {"git", "git.exe"} and (
                executable is None or Path(str(executable)).name.lower() in {"git", "git.exe"}):
            verb_index = 3 if len(words) > 3 and words[1] == "-C" else 1
            if len(words) > verb_index and words[verb_index] in {"rev-parse", "status", "merge-base"}:
                return
    if event in {"subprocess.Popen", "os.system", "os.startfile", "os.posix_spawn", "os.spawn"}:
        raise RuntimeError(f"qualification worker forbids external process: {event}")


def worker(repo, root, phase, nonce, config):
    root = root.resolve()
    marker = json.loads((root/"qualification-root.json").read_text(encoding="utf-8"))
    if marker != {"schema":SCHEMA,"nonce":nonce,"root":str(root)}:
        raise RuntimeError("not a runner-owned synthetic root")
    if Path(os.environ.get("ORGTREE_DATA", "")).resolve() != root/"data":
        raise RuntimeError("worker environment/root mismatch")
    if phase == "exercise" and any((root/"data").iterdir()):
        raise RuntimeError("exercise requires empty synthetic data")
    sys.path[:0] = [str(repo/"engine/backend"),str(repo/"tools"),str(repo)]
    from .backend import Backend
    adapter = Backend(repo, root)
    try:
        if phase == "exercise":
            adapter.fixture(max(config["concurrency"]))
            rows = []
            for concurrency in config["concurrency"]:
                rows.append(adapter.workload("fixed-work",concurrency,config["operations"],config["rate"]))
                for multiplier in config["demand_multipliers"]:
                    rows.append(adapter.workload("fixed-demand",concurrency,config["operations"],config["rate"]*multiplier))
            result = {"workloads":rows,"controls":adapter.controls(),"provenance":list(adapter.provenance)}
        else:
            result = {"recovery":adapter.reopen(),"provenance":list(adapter.provenance)}
        (root/f"{phase}.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    finally:
        adapter.close()


def run_child(repo, root, interpreter, phase, nonce, config, timeout):
    cmd = [interpreter,"-I","-B",str(repo/"tools/qualify-v3.py"),"--worker",phase,
           "--root",str(root),"--nonce",nonce,"--config",json.dumps(config)]
    result = subprocess.run(cmd,cwd=repo,env=child_env(root),capture_output=True,
                            text=True,encoding="utf-8",errors="replace",timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{phase} failed ({result.returncode}): {result.stdout[-1000:]} {result.stderr[-5000:]}")
    return json.loads((root/f"{phase}.json").read_text(encoding="utf-8"))


def component_results(payload, requested):
    """Require exact requested coverage, independent of the producer's summary."""
    errors, rows = [], []
    if payload.get("schema") != "orgtree.python-verification/v1":
        errors.append("unsupported component receipt schema")
    modules = payload.get("modules")
    if not isinstance(modules,list) or any(not isinstance(m,dict) for m in modules):
        return [], [*errors,"component receipt modules must be a list of objects"]
    names = [m.get("module") for m in modules]
    if any(not isinstance(name,str) for name in names):
        return [], [*errors,"component receipt module identity must be a string"]
    actual, expected = Counter(names), Counter(requested)
    if actual != expected:
        errors.append(f"component coverage mismatch: missing={list((expected-actual).elements())}, "
                      f"extra_or_duplicate={list((actual-expected).elements())}")
    for module in modules:
        count = module.get("tests_ran")
        passed = (module.get("phase") == "pass" and type(count) is int and count > 0
                  and module.get("structured_result") is True and module.get("exit_code") == 0
                  and not module.get("failure_id") and module.get("cleanup_errors") == [])
        rows.append({"id":module["module"],"level":"component",
            "classification":"passed" if passed else "failed","receipt":module,
            "limits":["Existing suite boundaries and mocks apply; no desktop/native service qualification"]})
    return rows, errors


def run(repo, args):
    config = {"concurrency":args.concurrency,"operations":args.operations,"rate":args.rate,
              "demand_multipliers":args.demand_multipliers,"components":args.components,
              "wire":getattr(args,"wire",False),"migration":getattr(args,"migration",False)}
    report = {"schema":SCHEMA,"candidate":identity(repo),"config":config,
              "started_unix_s":time.time(),"fixture":"new empty synthetic SQLite; no live attachment",
              "adapters":[],"negative_controls":[],"missing_coverage":[
                  {"id":name,"classification":"not_exercised","reason":reason} for name,reason in MISSING.items()],
              "full_product_qualified":False,"cleanup":{"completed":False},"errors":[]}
    verification = verification_module(repo)
    interpreter = verification.select_interpreter(repo,args.python)
    report["interpreter"] = {"path":interpreter.path,"version":interpreter.version}
    temporary = tempfile.TemporaryDirectory(prefix="orgtree-v3-qualification-")
    root = Path(temporary.name).resolve()
    try:
        (root/"data").mkdir()
        (root/"home").mkdir()
        nonce = uuid.uuid4().hex
        (root/"qualification-root.json").write_text(json.dumps({"schema":SCHEMA,"nonce":nonce,"root":str(root)}),encoding="utf-8")
        exercise = run_child(repo,root,interpreter.path,"exercise",nonce,config,args.timeout)
        report["adapters"].extend(exercise["workloads"])
        report["adapters"].append(exercise["controls"])
        report["import_provenance"] = exercise["provenance"]
        reopen = run_child(repo,root,interpreter.path,"reopen",nonce,config,args.timeout)
        report["adapters"].append(reopen["recovery"])
        report["negative_controls"] = negative_controls(exercise["workloads"][0]["observed"],
            exercise["controls"]["observed"],reopen["recovery"]["observed"])
        if args.components:
            # Reuse the established isolated module runner, never clone its setup or tests.
            receipt = root/"components.json"
            result = subprocess.run([interpreter.path,"-B",str(repo/"tools/run-python-verification.py"),
                "--repo-root",str(repo),"--python",interpreter.path,"--json-output",str(receipt),
                "--timeout",str(args.timeout),*COMPONENTS],cwd=repo,env=child_env(root),
                capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=args.timeout*len(COMPONENTS)+30)
            if not receipt.is_file():
                raise RuntimeError(f"component runner produced no receipt: {result.stderr[-2000:]}")
            payload = json.loads(receipt.read_text(encoding="utf-8"))
            rows, errors = component_results(payload,COMPONENTS)
            report["adapters"].extend(rows)
            report["errors"].extend(errors)
            if result.returncode or payload["summary"]["cleanup_errors"]:
                report["errors"].append("component runner failed or reported cleanup errors")
        else:
            report["missing_coverage"].append({"id":"component-regressions","classification":"not_exercised",
                "reason":"Pass --components to reuse existing mail/restart/tool-call suites."})
        for enabled, name, adapter in (
                (getattr(args,"wire",False), "wire-compatibility", run_wire),
                (getattr(args,"migration",False), "synthetic-migration-preparation", run_migration)):
            if not enabled:
                report["missing_coverage"].append({"id":name,"classification":"not_exercised",
                    "reason":f"Optional {name} adapter was not requested."})
                continue
            try:
                if name == "wire-compatibility":
                    rows, controls, errors = adapter(repo,root,interpreter.path,child_env(root),args.timeout,component_results)
                else:
                    rows, controls, errors = adapter(repo,interpreter.path,child_env(root),args.timeout)
            except Exception as exc:
                errors = [f"{name}: {type(exc).__name__}: {exc}"]
                rows, controls = [{"id":name,"level":"component","classification":"failed",
                    "errors":errors,"limits":["Requested adapter failed before producing a usable receipt"]}], []
            report["adapters"].extend(rows)
            report["negative_controls"].extend(controls)
            report["errors"].extend(errors)
    except Exception as exc:
        report["errors"].append(f"{type(exc).__name__}: {exc}")
    finally:
        try:
            temporary.cleanup()
            report["cleanup"]["completed"] = True
        except OSError as exc:
            report["cleanup"]["error"] = str(exc)
            report["errors"].append("synthetic root cleanup failed")
    after = identity(repo)
    report["candidate_unchanged"] = after == report["candidate"]
    if not report["candidate_unchanged"]:
        report["errors"].append("candidate changed during qualification")
    report["elapsed_s"] = time.time()-report["started_unix_s"]
    report["slice_passed"] = bool(report["adapters"]) and not report["errors"] and all(
        r["classification"] == "passed" for r in report["adapters"]) and bool(report["negative_controls"]) and all(
        r["classification"] == "expected_negative" for r in report["negative_controls"])
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",help="JSON report (prefer ignored artifacts/)")
    parser.add_argument("--python",help="Interpreter selection uses run-python-verification")
    parser.add_argument("--concurrency",type=int,nargs="+",default=[1,4,8,11,16])
    parser.add_argument("--operations",type=int,default=24)
    parser.add_argument("--rate",type=float,default=24)
    parser.add_argument("--demand-multipliers",type=int,nargs="+",default=[1,2,4])
    parser.add_argument("--timeout",type=float,default=180)
    parser.add_argument("--components",action="store_true")
    parser.add_argument("--wire",action="store_true",help="Reuse synthetic TCP HTTP/WS and MCP compatibility suites")
    parser.add_argument("--migration",action="store_true",help="Run six synthetic migration preparation scenarios; no activation")
    parser.add_argument("--require-full-product",action="store_true",help="Exit 3 while full-product coverage is missing")
    parser.add_argument("--worker",choices=["exercise","reopen"],help=argparse.SUPPRESS)
    parser.add_argument("--root",help=argparse.SUPPRESS)
    parser.add_argument("--nonce",help=argparse.SUPPRESS)
    parser.add_argument("--config",help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[2]
    if args.worker:
        worker(repo,Path(args.root),args.worker,args.nonce,json.loads(args.config))
        return 0
    if not 1 <= args.operations <= 40 or len(args.concurrency)>5 or len(set(args.concurrency))!=len(args.concurrency) or any(c not in [1,4,8,11,16] for c in args.concurrency):
        parser.error("operations must be 1..40; unique concurrency values must be in 1/4/8/11/16")
    if not 1 <= args.rate <= 1000 or not 1 <= args.timeout <= 600 or not args.demand_multipliers or len(set(args.demand_multipliers))!=len(args.demand_multipliers) or any(x not in [1,2,4] for x in args.demand_multipliers):
        parser.error("rate must be 1..1000; timeout 1..600; unique demand multipliers in 1/2/4")
    report = run(repo,args)
    encoded = json.dumps(report,indent=2,sort_keys=True)+"\n"
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(encoded,encoding="utf-8")
    print(encoded)
    return 1 if not report["slice_passed"] else 3 if args.require_full_product else 0
