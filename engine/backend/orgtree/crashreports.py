# pyright: strict, reportPrivateUsage=false
"""Server-side crash-report intake for the frontend's crash reporter
(frontend/src/crashReporter.ts).

Two jobs, kept out of api.py's routing noise:

  - resolve_stack(): shells out to a small Node script that maps a minified
    production stack trace back to real source positions, using the HIDDEN
    source maps written beside the build. They are hidden (vite.config.js:
    build.sourcemap = 'hidden') and then physically moved by frontend/scripts/
    postbuild-sourcemaps.mjs to frontend/sourcemaps/ — a SIBLING of dist/, not
    a subdirectory of it. That distinction is load-bearing: api.py's SPA
    catch-all (`@app.get("/{path:path}")`) serves ANY file whose resolved path
    falls under FRONTEND_DIST (= frontend/dist), not just the /assets
    StaticFiles mount — a first version of this that used dist/sourcemaps/
    was measured serving the maps at GET /sourcemaps/<file>.map anyway.
    Landing them outside dist/ entirely is what actually keeps them off the
    public surface; resolving server-side, straight off that directory, keeps
    that privacy while still giving crash reports real file:line:col.

  - save_report()/list_reports(): durable, timestamped JSON files on disk,
    independent of any org or agent — a report must survive even a first-load
    crash, before any org has loaded successfully.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from typing import Any

from . import store
from . import localtime

_HERE = os.path.dirname(__file__)
FRONTEND_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "frontend"))
DIST_DIR = os.path.join(FRONTEND_ROOT, "dist")
MAPS_DIR = os.path.join(FRONTEND_ROOT, "sourcemaps")   # sibling of dist/ — see module docstring
RESOLVER = os.path.join(FRONTEND_ROOT, "scripts", "resolve-stack.mjs")

_RESOLVE_TIMEOUT_S = 5.0


def resolve_stack(raw_stack: str) -> str:
    """Best-effort: on ANY failure (node missing, no maps for this build, a
    malformed frame) the ORIGINAL stack comes back unchanged. An unresolved
    but present stack beats a report that failed to save because resolution
    hiccuped — this must never be the reason a crash report is lost."""
    if not raw_stack or not os.path.isfile(RESOLVER):
        return raw_stack
    try:
        proc = subprocess.run(
            ["node", RESOLVER],
            input=json.dumps({"stack": raw_stack, "mapsDir": MAPS_DIR}),
            capture_output=True, text=True, timeout=_RESOLVE_TIMEOUT_S,
            check=False,
            creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                           if os.name == "nt" else 0),
        )
        if proc.returncode != 0 or not proc.stdout:
            return raw_stack
        out = json.loads(proc.stdout)
        resolved = out.get("stack")
        return resolved if out.get("ok") and resolved else raw_stack
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError):
        return raw_stack


def _reports_dir() -> str:
    return os.path.join(store.DATA_ROOT, "crash_reports")


def save_report(org_slug: str | None, report: dict[str, Any]) -> str:
    """Writes the report as its own file, named so a directory listing sorts
    newest-last with no extra parsing. Atomic (write-then-rename) so a reader
    polling the directory never sees a half-written file."""
    d = _reports_dir()
    os.makedirs(d, exist_ok=True)
    rid = re.sub(r"[^A-Za-z0-9_-]", "_", str(report.get("id") or uuid.uuid4().hex[:12]))
    fname = f"{int(time.time() * 1000)}-{rid}.json"
    path = os.path.join(d, fname)
    payload = {"org": org_slug, "saved_at": time.time(), **report}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)
    return path


def list_reports(limit: int = 50) -> list[dict[str, Any]]:
    """Newest first — "the UI died ten minutes ago, get me that report" reads
    top of this list, not the bottom."""
    d = _reports_dir()
    if not os.path.isdir(d):
        return []
    names = sorted((f for f in os.listdir(d) if f.endswith(".json")), reverse=True)[:limit]
    out: list[dict[str, Any]] = []
    for name in names:
        try:
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                out.append(json.load(fh))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def format_mail_body(report: dict[str, Any]) -> str:
    """Plain text, meant to be read by an agent — not rendered, so no markdown
    formatting assumptions.

    ⚠ AND READ BY THE USER TOO, which is why the stamp is localised
    (assignment 19). This body is mailed to an agent, and an agent's mailbox
    is a screen the user reads. `at` arrives from the browser's crash reporter
    as raw epoch MILLISECONDS — not a UTC string, but not a time anybody can
    read either. It is emitted as a token the browser renders in the user's
    zone, with the raw value kept beside it because a crash report is also
    correlated against server logs.
    """
    lines = [
        f"UI crash report — kind: {report.get('kind', 'unknown')}",
        f"at: {localtime.token(report.get('at'), 'full') or '(unknown)'} "
        f"[raw {report.get('at')}]",
        f"url: {report.get('url')}",
        f"user agent: {report.get('userAgent')}",
        f"message: {report.get('message')}",
        "",
        "stack:",
        report.get("stack") or "(none)",
    ]
    if report.get("componentStack"):
        lines += ["", "React component stack:", report["componentStack"]]
    breadcrumbs = report.get("breadcrumbs") or []
    if breadcrumbs:
        lines += ["", "recent activity leading up to the crash:"]
        for b in breadcrumbs[-15:]:
            lines.append(f"  [{b.get('kind')}] {b.get('detail')}")
    return "\n".join(lines)
