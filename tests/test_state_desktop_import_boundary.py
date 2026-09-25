"""P01 F9 legacy boundary contracts for the desktop V1-import routes (desktop-import.*).

A disposable V2 data root and synthetic V1 sources only, all inside this test's temporary root; the app's lifecycle is
not started. The app is the real desktop app (engine/launch.py load_app, the only path that mounts the import router),
behind its TokenGate, with the real recovery hook desktop_recovery.resume_import. Three things are held still:
- an audit hook installed before anything else is imported refuses and records EVERY process launch, and the module
  fails at teardown if anything was refused (a launch the product caught and swallowed fails no case, but it still
  fails the module);
- supervisor.send_message, the recovery's admission of an imported agent's retained turn, is a recorder that accepts
  or holds as each case sets (exactly as tests/test_desktop_import.py's assembled test does), so no agent runs;
- the process's boot build identity is seeded the way an installed runtime reads it (restart_wake's own test helper):
  a source checkout would otherwise resolve it with git against the engine's own folder when the recovery replays a
  turn.
Every ORGTREE_, CLAUDE_ and CODEX_ variable is removed and USERPROFILE points inside the root, so the destination Claude
profile a native import publishes memory into is inside the root; the native cases assert it before they run. Each
case runs on a fresh synthetic V1 source and its own org slug; its observation is normalized (one NORM block) and
compared with docs/state-system/desktop-import-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (desktop-import.*).
"""
from __future__ import annotations

import sys

# ---- the no-process guard, first -----------------------------------------------------------------------------------
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import tempfile  # noqa: E402

_temp = Path(tempfile.mkdtemp(prefix="p01-desktop-import-boundary-")).resolve()
LAUNCH_EVENTS = ("subprocess.Popen", "_winapi.CreateProcess", "os.system", "os.posix_spawn", "os.spawn",
                 "os.startfile", "os.exec")
GUARD = {"on": True}
REFUSED: list = []
CASE_RUNS = {"cases": 0, "jobs": 0, "sends": 0}     # fixtured cases run, jobs that published, admissions recorded


def _guard(event, args):
    if not GUARD["on"] or event not in LAUNCH_EVENTS:
        return
    REFUSED.append((event, repr(args)[:300]))
    raise RuntimeError("process launch refused by the F9 no-process guard: " + event)


sys.addaudithook(_guard)

_data, _home = _temp / "data", _temp / "home"
_data.mkdir()
_home.mkdir()
for _k in [k for k in os.environ if k.startswith(("ORGTREE_", "CLAUDE_", "CODEX_"))]:
    os.environ.pop(_k)      # no profile selector may point a native publication outside the temp root
os.environ.update(ORGTREE_DATA=str(_data), ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="operator",
                  HOME=str(_home), USERPROFILE=str(_home))

import copy  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
import uuid  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import state_operation_contracts as contracts  # noqa: E402
import import_provenance  # noqa: E402,F401  (also drops the running engine's inherited hub address)
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import (agentauth, desktop_import as imp, desktop_import_jobs as jobs, desktop_maintenance,  # noqa: E402
                     ledger, restart_wake, store, supervisor)

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), "this process would have written to the live root"
assert os.environ.get("ORGTREE_DESKTOP_MANAGED") == "1", "the desktop-managed profile is the app under test"
assert REFUSED == [], REFUSED        # imports and the app build launched nothing
# the recovery replays a retained turn with the process's boot build identity: seed it the installed runtime's way
BOOT = {"commit": "0" * 40, "commit_short": "0000000", "branch": None, "dirty": False, "provenance": "packaged",
        "version": "p01-f9-boundary", "backend_pid": 0, "started_at": "2026-09-25T00:00:00+00:00"}
restart_wake._reset_boot_build_info_for_tests(BOOT)
OP = {"X-Orgtree-Desktop-Token": "operator"}
P = "/api/desktop/import-v1"
ACTIVE = {"queued", "planning", "running", "cancelling"}
SEQ = [0]
CUR: dict = {}
CUR_NATIVE: dict = {}
SENDS: list = []
SEND_RESULT = {"value": {"accepted": True, "queued": 0}}
FIELDS = {"schema", "source_contract_sha256", "qualification", "contracts", "cases", "legacy_defects", "scope"}

# a caller that is a live agent in some org, for the agent-credential refusal
_auth = store.create_org("authority")
_auth.hire(ledger.USER, None, "haiku", 0, "caller")
store.save_org(_auth)
AGENT = {"X-Orgtree-Agent-Token": agentauth.child_env("authority", "caller")["ORGTREE_AGENT_TOKEN"]}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / "docs/state-system/desktop-import-boundary.json")
    registry = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
    if set(d) != FIELDS:
        raise ValueError("boundary fields")
    if d["schema"] != "orgtree.desktop-import-boundary/v1":
        raise ValueError("boundary schema")
    if d["source_contract_sha256"] != contracts.digest(registry):
        raise ValueError("stale boundary binding")
    if set(d["qualification"]) != set(contracts.GATES) or any(v is not False for v in d["qualification"].values()):
        raise ValueError("boundary cannot qualify conversion")
    if set(d["contracts"]) != {k for k in registry["contracts"] if k.startswith("desktop-import.")}:
        raise ValueError("every desktop-import contract is required")
    return d


# ---- NORM (verbatim from the P01 F9 probe's f9/norm.py) ------------------------------------------------------------
DROP = {"started_at", "updated_at", "eta_seconds", "progress_percent", "at"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def norm(c, cur):
    def text(v):
        if not isinstance(v, str):
            return v
        v = re.sub(r"[A-Za-z]:[\\/][^'\"\s)]*", "<path>", v)
        v = re.sub(r"\b[A-Za-z]--[A-Za-z0-9-]+", "<key>", v)      # a Claude project key (an encoded absolute path)
        v = v.replace(cur["rid"], "{rid}")
        v = UUID.sub("<uuid>", v)
        return re.sub(r"(?<![\w-])" + re.escape(cur["slug"]) + r"(?![\w-])", "{slug}", v)

    def n(v):
        if isinstance(v, dict):
            return {text(k): n(x) for k, x in sorted(v.items()) if k not in DROP}
        if isinstance(v, list):
            return [n(x) for x in v]
        return text(v)

    def sends(rows):
        return [{"node": r["node"], "head": text(r["text"].split("\n", 1)[0]), "view": text(r["view"]),
                 "carries_intent": "continue the unfinished work" in r["text"],
                 "carries_import_note": "[V1 COPY IMPORT]" in r["text"]} for r in rows]

    return {
        "status": c["status"],
        "body": n(c["body"]),
        "final": n(c["final"]),
        "first_state": (c["first"] or {}).get("state") if isinstance(c["first"], dict) else None,
        "mid": n(c["mid"]),
        "dest_added": sorted(n(c["dest_added"])),
        "dest_removed": sorted(n(c["dest_removed"])),
        "dest_changed": sorted(n(c["dest_changed"])),
        "home_added": sorted(n(c["home_added"])),
        "source_unchanged": c["source_unchanged"],
        "orgs_added": n(c["orgs_added"]),
        "imported_org": n(c["imported_org"]),
        "sends": sends(c["sends"]),
    }


# ---- harness (verbatim from the P01 F9 probe) ------------------------------------------------------------
def _record_send(slug, nid, text, **kwargs):
    SENDS.append({"slug": slug, "node": nid, "text": str(text), "view": kwargs.get("view")})
    return SEND_RESULT["value"]


supervisor.send_message = _record_send


# ---- the synthetic V1 source ---------------------------------------------------------------------------------------
def v1_org(slug, source):
    org = ledger.Org.create(slug, workspace=str(source / "workspaces" / slug))
    for nid in ("active", "idle"):
        org.hire(ledger.USER, None, "haiku", 0, nid)
    org.nodes["active"]["inflight"] = {"text": "continue the unfinished work", "view": "original visible prompt"}
    org.d["documents"] = [{"id": "report", "node": "active", "title": "Retained report", "body": "kept"}]
    scratch = source / "scratch" / slug / "active"
    scratch.mkdir(parents=True)
    (scratch / "notes.md").write_text("working notes\n", encoding="utf-8")
    (source / "workspaces" / slug).mkdir(parents=True)
    (source / "workspaces" / slug / "shared.md").write_text("shared\n", encoding="utf-8")
    journal = source / "journals" / "projects" / slug
    journal.mkdir(parents=True)
    (journal / (org.nodes["active"]["session_id"] + ".jsonl")).write_text(
        '{"type":"assistant","message":{"role":"assistant","content":"copied history"}}\n', encoding="utf-8")
    return org.d


def fresh(kind="sqlite"):
    SEQ[0] += 1
    n = SEQ[0]
    source = _temp / f"v1-{n}"
    (source / "orgs").mkdir(parents=True)
    slug = f"acme-{n}"
    doc = v1_org(slug, source)
    if kind == "sqlite":
        imp._write_candidate(source / "orgs" / f"{slug}.db", doc)
    elif kind == "json":
        (source / "orgs" / f"{slug}.json").write_text(json.dumps(doc), encoding="utf-8")
    elif kind == "both":
        imp._write_candidate(source / "orgs" / f"{slug}.db", doc)
        (source / "orgs" / f"{slug}.json").write_text(json.dumps(doc), encoding="utf-8")
    elif kind == "mismatch":
        (source / "orgs" / f"{slug}.json").write_text(json.dumps(dict(doc, slug="other")), encoding="utf-8")
    elif kind == "native":
        # a Claude node with a UUID session, its transcript in a configured source profile, and one memory file
        from orgtree import desktop_native_claude_memory as mem  # noqa: PLC0415
        sid = str(uuid.uuid4())
        doc["nodes"]["active"]["session_id"] = sid
        profile = source / "configured-claude-profile"
        cwd = str(source / "scratch" / slug / "active")
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        records = [{"type": "user", "uuid": first, "parentUuid": None, "sessionId": sid,
                    "timestamp": "2026-09-07T20:00:00Z", "cwd": cwd,
                    "message": {"role": "user", "content": "Remember the violet key"}},
                   {"type": "assistant", "uuid": second, "parentUuid": first, "sessionId": sid,
                    "timestamp": "2026-09-07T20:00:01Z",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "I remember violet"}]}}]
        transcript = profile / "projects" / "source-project" / f"{sid}.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text("".join(json.dumps(r) + chr(10) for r in records), encoding="utf-8")
        memory = profile / "projects" / mem.project_key(mem.memory_root(cwd)) / mem.MEMORY_DIR
        memory.mkdir(parents=True)
        (memory / "MEMORY.md").write_text("- the violet key" + chr(10), encoding="utf-8")
        (source / "orgs" / f"{slug}.json").write_text(json.dumps(doc), encoding="utf-8")
        CUR_NATIVE.update(profile=str(profile))
    elif kind == "disk":
        (source / "orgs" / f"{slug}.json").write_text(json.dumps(dict(doc, disk={"path": "D:/x"})),
                                                        encoding="utf-8")
    # a clean import-jobs folder per case: no pointer, no job records, no lock owner
    root = _data / "import-jobs"
    if root.is_dir():
        for p in root.iterdir():
            if p.is_file() and p.name not in ("active.lock", "control.lock"):
                p.unlink()
    del SENDS[:]
    SEND_RESULT["value"] = {"accepted": True, "queued": 0}
    CUR.clear()
    CUR.update(n=n, slug=slug, source=source, rid=str(uuid.uuid4()), **CUR_NATIVE)
    CUR_NATIVE.clear()
    if kind == "native":
        from orgtree.desktop_native_claude_rewind import selected_profile  # noqa: PLC0415
        for base in ("active", "idle"):
            assert selected_profile(slug, base).is_relative_to(_temp), "destination profile outside the temp root"


def body(**extra):
    b = {"source_root": str(CUR["source"]), "organizations": [CUR["slug"]], "acknowledge_duplicate_work": True,
         "request_id": CUR["rid"]}
    b.update(extra)
    return {k: v for k, v in b.items() if v is not None}


def tree(root):
    out = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        # a held lock file cannot be read (msvcrt); the slow-request trace is timing, not the operation
        if p.is_file() and not rel.endswith(".lock") and not rel.startswith("diagnostics/"):
            out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def wait_terminal(c, rid, deadline=30):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        r = c.get(f"{P}/jobs/{rid}", headers=OP)
        if r.status_code != 200:
            return r.json()
        job = r.json()["job"]
        if job["state"] not in ACTIVE:
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish: " + rid)


def import_threads():
    return sorted(t.name for t in threading.enumerate() if t.name.startswith("desktop-import-"))


# ---- setup steps ---------------------------------------------------------------------------------------------------
def started(c):
    r = c.post(f"{P}/jobs", json=body(), headers=OP)
    assert r.status_code == 202, r.text
    CUR["first"] = wait_terminal(c, CUR["rid"])


def dest_has_org(c):
    store.create_org(CUR["slug"])


def interrupted_record(c):
    root = jobs._root()
    job = {"id": CUR["rid"], "state": "running", "phase": "copying", "source_root": str(CUR["source"]),
           "organizations": [CUR["slug"]], "current_org": CUR["slug"], "files_copied": 1, "bytes_copied": 5,
           "started_at": "2026-09-25T00:00:00+00:00", "updated_at": "2026-09-25T00:00:00+00:00", "result": None,
           "error": None, "publications": [], "cancel_requested": False, "total_files": 3, "total_bytes": 20,
           "progress_percent": 40, "eta_seconds": 3, "_fingerprint": "0" * 64}
    jobs._write(root / (CUR["rid"] + ".json"), job)
    jobs._write(root / "current.json", {"id": CUR["rid"]})


def then_cancelled(c):
    interrupted_record(c)
    r = c.post(f"{P}/jobs/{CUR['rid']}/cancel", headers=OP)
    assert r.status_code == 200, r.text


def lease_held(c):
    CUR["lease"] = jobs._lease(jobs._root())
    assert CUR["lease"] is not None


def maintenance_acknowledged(c):
    desktop_maintenance._write({"id": "p01-f9", "state": "acknowledged", "action": "restart"})


def recovery_held(c):
    SEND_RESULT["value"] = {"accepted": False, "deferred": True}


# ---- cases ---------------------------------------------------------------------------------------------------------
def req(method, path, headers=OP, **kw):
    def go(c):
        return c.request(method, P + path.format(rid=CUR["rid"]), headers=headers, **kw)
    return go


def lazy(method, path, fn, headers=OP):
    def go(c):
        return c.request(method, P + path.format(rid=CUR["rid"]), headers=headers, json=fn())
    return go


def start_and_wait(fn):
    def go(c):
        r = c.post(f"{P}/jobs", json=fn(), headers=OP)
        CUR["final"] = wait_terminal(c, CUR["rid"]) if r.status_code == 202 else None
        return r
    return go


def cancel_mid_copy(c):
    entered, release = threading.Event(), threading.Event()
    real_copy = imp._copy_file

    def slow(src, dst, **options):
        if src.name == "notes.md":
            entered.set()
            assert release.wait(10)
        return real_copy(src, dst, **options)
    imp._copy_file = slow
    try:
        r = c.post(f"{P}/jobs", json=body(), headers=OP)
        assert r.status_code == 202, r.text
        assert entered.wait(10)
        CUR["mid"] = c.get(f"{P}/jobs/current", headers=OP).json()
        rc = c.post(f"{P}/jobs/{CUR['rid']}/cancel", headers=OP)
    finally:
        release.set()
        imp._copy_file = real_copy
    CUR["final"] = wait_terminal(c, CUR["rid"])
    return rc


def with_hook_unconfigured(c):
    saved = imp._on_imported
    imp._on_imported = None
    try:
        return c.post(f"{P}/jobs", json=body(), headers=OP)
    finally:
        imp._on_imported = saved


CASES = [
    # authority: the TokenGate
    ("preview_no_token", "sqlite", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])},
                                              headers={})),
    ("preview_agent_token", "sqlite", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])},
                                                 headers=AGENT)),
    # preview
    ("preview_sqlite", "sqlite", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])})),
    ("preview_json", "json", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])})),
    ("preview_conflict", "sqlite", dest_has_org, lazy("POST", "/preview",
                                                      lambda: {"source_root": str(CUR["source"])})),
    ("preview_relative", "sqlite", None, req("POST", "/preview", json={"source_root": "relative/v1"})),
    ("preview_no_orgs_dir", "sqlite", None, lazy("POST", "/preview", lambda: {"source_root": str(_home)})),
    ("preview_overlap", "sqlite", None, lazy("POST", "/preview", lambda: {"source_root": str(_data)})),
    ("preview_extra_field", "sqlite", None, lazy("POST", "/preview",
                                                 lambda: {"source_root": str(CUR["source"]), "extra": 1})),
    ("preview_mismatch", "mismatch", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])})),
    ("preview_ambiguous", "both", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])})),
    ("preview_disk_org", "disk", None, lazy("POST", "/preview", lambda: {"source_root": str(CUR["source"])})),
    ("preview_native_claude", "native", None, lazy("POST", "/preview", lambda: {
        "source_root": str(CUR["source"]), "native_sources": {"claude_profile": CUR["profile"]}})),
    ("preview_native_bad_key", "sqlite", None, lazy("POST", "/preview", lambda: {
        "source_root": str(CUR["source"]), "native_sources": {"bogus": "x"}})),
    ("preview_native_relative", "sqlite", None, lazy("POST", "/preview", lambda: {
        "source_root": str(CUR["source"]), "native_sources": {"claude_profile": "relative"}})),
    # the retired synchronous import
    ("import_sync_retired", "sqlite", None, lazy("POST", "", lambda: {
        "source_root": str(CUR["source"]), "organizations": [CUR["slug"]], "acknowledge_duplicate_work": True})),
    ("import_sync_invalid_body", "sqlite", None, req("POST", "", json={"source_root": "x"})),
    # start
    ("job_ok", "sqlite", None, start_and_wait(body)),
    ("job_json_source", "json", None, start_and_wait(body)),
    ("job_native_claude", "native", None, start_and_wait(lambda: body(native_sources={"claude_profile": CUR["profile"]}))),
    ("job_same_id_same_payload", "sqlite", started, lazy("POST", "/jobs", body)),
    ("job_same_id_other_payload", "sqlite", started, lazy("POST", "/jobs",
                                                          lambda: body(organizations=[CUR["slug"], "other"]))),
    ("job_no_ack", "sqlite", None, lazy("POST", "/jobs", lambda: body(acknowledge_duplicate_work=False))),
    ("job_duplicate_orgs", "sqlite", None, lazy("POST", "/jobs", lambda: body(organizations=[CUR["slug"]] * 2))),
    ("job_bad_slug", "sqlite", None, lazy("POST", "/jobs", lambda: body(organizations=["Bad Slug"]))),
    ("job_bad_request_id", "sqlite", None, lazy("POST", "/jobs", lambda: body(request_id="nope"))),
    ("job_destination_conflict", "sqlite", dest_has_org, start_and_wait(body)),
    ("job_missing_source_org", "sqlite", None, start_and_wait(lambda: body(organizations=["ghost"]))),
    ("job_lease_held", "sqlite", lease_held, lazy("POST", "/jobs", body)),
    ("job_maintenance_acknowledged", "sqlite", maintenance_acknowledged, lazy("POST", "/jobs", body)),
    ("job_hook_unconfigured", "sqlite", None, with_hook_unconfigured),
    ("job_previous_interrupted", "sqlite", interrupted_record, lazy("POST", "/jobs",
                                                                    lambda: body(request_id=str(uuid.uuid4())))),
    ("job_recovery_held", "sqlite", recovery_held, start_and_wait(body)),
    # current, exact, cancel
    ("current_none", "sqlite", None, req("GET", "/jobs/current")),
    ("current_after_job", "sqlite", started, req("GET", "/jobs/current")),
    ("current_interrupted", "sqlite", interrupted_record, req("GET", "/jobs/current")),
    ("exact_after_job", "sqlite", started, req("GET", "/jobs/{rid}")),
    ("exact_unknown", "sqlite", None, req("GET", "/jobs/{rid}")),
    ("exact_bad_id", "sqlite", None, req("GET", "/jobs/nope")),
    ("exact_interrupted", "sqlite", interrupted_record, req("GET", "/jobs/{rid}")),
    ("cancel_mid_copy", "sqlite", None, cancel_mid_copy),
    ("cancel_after_finish", "sqlite", started, req("POST", "/jobs/{rid}/cancel")),
    ("cancel_unknown", "sqlite", None, req("POST", "/jobs/{rid}/cancel")),
    ("cancel_bad_id", "sqlite", None, req("POST", "/jobs/nope/cancel")),
    ("cancel_interrupted_record", "sqlite", interrupted_record, req("POST", "/jobs/{rid}/cancel")),
    ("cancel_interrupted_then_read", "sqlite", then_cancelled, req("GET", "/jobs/{rid}")),
]


def org_view(slug):
    try:
        store._invalidate_snapshot(slug)
        d = store.load_org(slug).d
    except Exception:  # noqa: BLE001
        return None
    meta = d.get("desktop_import") or {}
    return {"desktop_import_keys": sorted(meta), "recovery_pending": meta.get("recovery_pending"),
            "recovery_phase": meta.get("recovery_phase"), "active_nodes": meta.get("active_nodes"),
            "nodes": {nid: {"continuity": (n.get("desktop_import") or {}).get("continuity"),
                            "inflight": bool(n.get("inflight")), "session_unrun": n.get("session_unrun"),
                            "state": n.get("state")}
                      for nid, n in sorted(d.get("nodes", {}).items())},
            "attempts": {nid: r.get("phase") for nid, r in sorted((meta.get("recovery_attempts") or {}).items())}}


CASES = {n: (k, p, r) for n, k, p, r in CASES}


def observe(name):
    """Run one fixtured case on a fresh V1 source; return the normalized observation, the body and the raw record."""
    kind, pre, request = CASES[name]
    fresh(kind)
    c = TestClient(app, raise_server_exceptions=False)
    try:
        try:
            if pre:
                pre(c)
            b_dest, b_src = tree(_data), tree(CUR["source"])
            b_orgs, b_home = sorted(p.name for p in (_data / "orgs").iterdir()), tree(_home)
            r = request(c)
            if "final" not in CUR:
                time.sleep(0.05)
        finally:
            if CUR.get("lease") is not None:
                jobs._release(CUR.pop("lease"))
        a_dest, a_src = tree(_data), tree(CUR["source"])
        a_orgs = sorted(p.name for p in (_data / "orgs").iterdir())
        a_home = tree(_home)
    finally:
        # the case's own maintenance reservation, measured above, must not reach the next case
        if name == "job_maintenance_acknowledged" and desktop_maintenance._path().exists():
            desktop_maintenance._path().unlink()
    body = r.json()
    raw = {"status": r.status_code, "body": body, "final": CUR.get("final"), "mid": CUR.get("mid"),
           "first": CUR.get("first"),
           "dest_added": sorted(set(a_dest) - set(b_dest)), "dest_removed": sorted(set(b_dest) - set(a_dest)),
           "dest_changed": sorted(k for k in set(a_dest) & set(b_dest) if a_dest[k] != b_dest[k]),
           "source_unchanged": a_src == b_src, "home_added": sorted(set(a_home) - set(b_home)),
           "orgs_added": sorted(set(a_orgs) - set(b_orgs)),
           "imported_org": org_view(CUR["slug"]) if f"{CUR['slug']}.db" in a_orgs else None, "sends": list(SENDS)}
    return norm(raw, {"slug": CUR["slug"], "rid": CUR["rid"]}), body, raw


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result["valid"], result["errors"])
        self.assertEqual(len(spec["contracts"]), 6)
        self.assertEqual(set(spec["cases"]), set(CASES))
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry["facets"]["desktop-import." + d]["status"],
                             "unresolved" if d in ("conflicts", "wire", "instrumentation") else "specified", d)
        modes = {k.split(".", 1)[1]: c["domain_mode"] for k, c in registry["contracts"].items()
                 if k.startswith("desktop-import.")}
        self.assertEqual(modes, {"preview": "write", "import-retired": "read", "job-start": "write",
                                 "job-current": "conditional_write", "job-status": "conditional_write",
                                 "job-cancel": "conditional_write"})

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d["contracts"].pop("desktop-import.job-start"), lambda d: d.update(covered=True),
                     lambda d: d["qualification"].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256="0" * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_every_entry_selects_its_contract_and_the_store_sites_are_mapped(self):
        registry = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
        source = contracts.inventory.scan(ROOT)
        entries = {r["id"]: r for r in registry["entries"]}
        bound = {}
        for name, c in registry["contracts"].items():
            if name.startswith("desktop-import."):
                for e in c["entry_ids"]:
                    bound.setdefault(e, []).append(name)
                    self.assertEqual(contracts.select(registry, e, {}), [name], name)
        self.assertEqual(len(bound), 6)
        for e, names in bound.items():
            self.assertEqual((entries[e]["disposition"], entries[e]["contracts"]), ("mapped", names))
        # the SQLite sites only these routes reach are mapped (rule 1)
        storage = {r["id"]: r for r in registry["storage"]}
        mapped = sorted((s["source"]["symbol"], tuple(storage[contracts.witness_id("storage", s)]["contracts"]))
                        for s in source["connection_sites"] if s["source"]["path"].endswith("/desktop_import.py"))
        read = ("desktop-import.preview", "desktop-import.job-start")
        self.assertEqual(mapped, [("_read_document", read)] * 3 + [("_write_candidate", ("desktop-import.job-start",))])
        # the worker's thread entry stays pending: no worker entry is bound to a route contract
        [worker] = [s for s in source["registrations"] if s["source"]["path"].endswith("/desktop_import_jobs.py")]
        row = entries[worker["site_id"]]
        self.assertEqual((worker["kind"], row["disposition"]), ("worker", "pending"))
        self.assertIn("desktop-import.job-start", row["reason"])


class DesktopImportBoundary(unittest.TestCase):
    def setUp(self):
        self.spec = boundary()

    def check(self, *names):
        out = {}
        for name in names:
            with self.subTest(case=name):
                seen, body, raw = observe(name)
                CASE_RUNS["cases"] += 1
                CASE_RUNS["jobs"] += len(raw["orgs_added"])
                CASE_RUNS["sends"] += len(raw["sends"])
                self.assertEqual(seen, self.spec["cases"][name], name)
                out[name] = (seen, body, raw)
        return out

    def test_only_the_desktop_token_opens_the_routes(self):
        got = self.check("preview_no_token", "preview_agent_token")
        self.assertEqual(got["preview_no_token"][1]["detail"],
                         "missing authentication; provide a desktop or live agent credential")
        # a VALID agent credential is refused with the invalid-credential text: the gate admits agents only elsewhere
        self.assertEqual(got["preview_agent_token"][1]["detail"],
                         "agent credential is invalid or expired; reconnect the agent session")
        self.assertTrue(all(s["dest_added"] == [] for s, _, _ in got.values()))

    def test_preview_copies_privately_and_writes_only_staging(self):
        got = self.check("preview_sqlite", "preview_json", "preview_conflict", "preview_native_claude",
                         "preview_relative", "preview_no_orgs_dir", "preview_overlap", "preview_extra_field",
                         "preview_mismatch", "preview_ambiguous", "preview_disk_org", "preview_native_bad_key",
                         "preview_native_relative")
        for name, (seen, body, raw) in got.items():
            with self.subTest(case=name):
                self.assertTrue(seen["source_unchanged"])            # the V1 folder is never written
                self.assertEqual(seen["orgs_added"], [])             # preview publishes nothing
                self.assertTrue(all(p.startswith(".import-staging/<uuid>/{slug}/") for p in seen["dest_added"]),
                                seen["dest_added"])
        # the SQLite source is read through a private byte copy and a backup of it, both left in staging
        self.assertEqual(got["preview_sqlite"][0]["dest_added"],
                         [".import-staging/<uuid>/{slug}/original.json", ".import-staging/<uuid>/{slug}/snapshot.db",
                          ".import-staging/<uuid>/{slug}/{slug}.db"])
        # a refused preview that read the document keeps its staging too
        self.assertEqual(got["preview_mismatch"][0]["dest_added"], [".import-staging/<uuid>/{slug}/source.json"])
        [row] = got["preview_conflict"][1]["organizations"]
        self.assertTrue(row["conflict"].startswith("Destination already contains"), row["conflict"])
        [row] = got["preview_native_claude"][1]["organizations"]
        self.assertEqual([(n["node"], n["status"]) for n in row["native_context"]],
                         [("active", "available"), ("idle", "held")])
        self.assertEqual([(m["base"], m["status"], m["files"]) for m in row["memory"]],
                         [("active", "ready", 1), ("idle", "none", None)])

    def test_the_synchronous_import_is_retired(self):
        got = self.check("import_sync_retired", "import_sync_invalid_body")
        self.assertEqual(got["import_sync_retired"][0]["status"], 409)
        self.assertTrue(got["import_sync_retired"][1]["detail"].startswith("Use the background import jobs API"))

    def test_a_job_copies_publishes_and_recovers(self):
        got = self.check("job_ok", "job_json_source", "job_native_claude", "job_recovery_held")
        for name, (seen, body, raw) in got.items():
            with self.subTest(case=name):
                self.assertEqual((seen["status"], seen["final"]["state"], seen["orgs_added"]),
                                 (202, "succeeded", ["{slug}.db"]))
                self.assertTrue(seen["source_unchanged"])
                self.assertIn("imports/{slug}/original.json", seen["dest_added"])
                # the recovery hook admitted the imported active node's retained turn, once, in the restart-replay
                # wrapper, carrying the original intent and the import note, with the original prompt as its view
                self.assertEqual([(s["node"], s["view"], s["carries_intent"], s["carries_import_note"])
                                  for s in seen["sends"]], [("active", "original visible prompt", True, True)])
                self.assertTrue(seen["sends"][0]["head"].startswith("[ORGTREE RESTART]"))
        self.assertEqual(got["job_ok"][0]["imported_org"]["recovery_phase"], "resolved")
        # a native Claude import publishes the node's memory into the DESTINATION agent's Claude profile, outside
        # the V2 data root (here the temp root's USERPROFILE)
        self.assertEqual(got["job_native_claude"][0]["home_added"], [".claude/projects/<key>/memory/MEMORY.md"])
        self.assertEqual(got["job_native_claude"][0]["imported_org"]["nodes"]["active"]["continuity"], "native_clone")
        # a held admission leaves the copy committed with recovery pending; the job does not retry it
        held = got["job_recovery_held"][0]
        [row] = held["final"]["result"]["imported"]
        self.assertEqual((row["recovery_pending"], row["warnings"][-1]),
                         (True, "Copy committed; recovery pending (RuntimeError). Do not repeat import."))
        self.assertEqual(held["imported_org"]["recovery_phase"], "held")

    def test_job_start_refusals_and_idempotence(self):
        got = self.check("job_same_id_same_payload", "job_same_id_other_payload", "job_no_ack", "job_duplicate_orgs",
                         "job_bad_slug", "job_bad_request_id", "job_lease_held", "job_maintenance_acknowledged",
                         "job_hook_unconfigured", "job_previous_interrupted", "job_destination_conflict",
                         "job_missing_source_org")
        self.assertEqual((got["job_same_id_same_payload"][0]["status"],
                          got["job_same_id_same_payload"][1]["job"]["state"]), (202, "succeeded"))
        for name in ("job_same_id_other_payload", "job_lease_held", "job_maintenance_acknowledged",
                     "job_previous_interrupted"):
            self.assertEqual(got[name][0]["status"], 409, name)
        # refusing because of a previous job left active rewrites that job as interrupted first
        self.assertEqual(got["job_previous_interrupted"][0]["dest_changed"], ["import-jobs/{rid}.json"])
        # what the worker finds wrong is recorded on the job after the 202
        for name in ("job_destination_conflict", "job_missing_source_org"):
            seen = got[name][0]
            self.assertEqual((seen["status"], seen["final"]["state"], seen["orgs_added"]), (202, "failed", []), name)

    def test_status_reads_and_orphaned_records(self):
        got = self.check("current_none", "current_after_job", "current_interrupted", "exact_after_job",
                         "exact_unknown", "exact_bad_id", "exact_interrupted")
        self.assertEqual(got["current_none"][1], {"job": None})
        # a status read of an active record that no worker owns rewrites it as interrupted, never replaying it
        for name in ("current_interrupted", "exact_interrupted"):
            seen = got[name][0]
            self.assertEqual((seen["body"]["job"]["state"], seen["dest_changed"]),
                             ("interrupted", ["import-jobs/{rid}.json"]), name)
        self.assertEqual(got["exact_after_job"][0]["dest_changed"], [])     # an owned or finished record is read only

    def test_cancel(self):
        got = self.check("cancel_mid_copy", "cancel_after_finish", "cancel_unknown", "cancel_bad_id")
        mid = got["cancel_mid_copy"][0]
        self.assertEqual((mid["body"]["job"]["state"], mid["final"]["state"], mid["orgs_added"], mid["sends"]),
                         ("cancelling", "cancelled", [], []))
        self.assertEqual(got["cancel_after_finish"][1]["job"]["state"], "succeeded")      # returned unchanged

    def test_the_orphaned_cancel_legacy_defect(self):
        # recorded legacy defect (docket cancelling-an-orphaned-desktop-import-job-leaves): a cancel of an active
        # record that no worker owns is accepted and writes a marker nothing consumes
        got = self.check("cancel_interrupted_record", "cancel_interrupted_then_read")
        first = got["cancel_interrupted_record"][0]
        self.assertEqual((first["body"]["job"]["state"], first["dest_added"]),
                         ("cancelling", ["import-jobs/{rid}.cancel"]))
        read = got["cancel_interrupted_then_read"][0]
        self.assertEqual((read["body"]["job"]["state"], read["body"]["job"]["cancel_requested"]), ("interrupted", True))
        self.assertTrue((_data / "import-jobs" / (got["cancel_interrupted_then_read"][2]["body"]["job"]["id"]
                                                  + ".cancel")).exists())


class NoProcess(unittest.TestCase):
    def refused(self, fn):
        before = len(REFUSED)
        with self.assertRaises(RuntimeError):
            fn()
        got = REFUSED[before:]
        del REFUSED[before:]
        return got

    def test_a_process_launch_is_refused(self):
        got = self.refused(lambda: subprocess.run([sys.executable, "-c", "0"], cwd=str(_temp)))
        self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    def test_a_git_launch_is_refused_too(self):
        got = self.refused(lambda: subprocess.run(["git", "--version"], cwd=str(_temp)))
        self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    @unittest.skipUnless(os.name == "nt", "the Windows launch path")
    def test_a_multiprocessing_spawn_is_refused(self):
        import multiprocessing
        got = self.refused(lambda: multiprocessing.get_context("spawn").Process(target=os.getpid).start())
        self.assertEqual([e for e, _ in got], ["_winapi.CreateProcess"])


def tearDownModule():
    # the module-wide check, after every case. A refused launch the product caught and swallowed fails no case; it
    # still fails the module. If jobs published, the recorder must have seen their admissions, and the boot identity
    # must still be the seeded one (nothing resolved it with git). The hook cannot be removed, so it is switched off.
    try:
        assert REFUSED == [], REFUSED
        assert not CASE_RUNS["jobs"] or CASE_RUNS["sends"] > 0, CASE_RUNS
        assert restart_wake.get_boot_build_info()["version"] == BOOT["version"]
    finally:
        GUARD["on"] = False


if __name__ == "__main__":
    unittest.main()
