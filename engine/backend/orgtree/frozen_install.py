# pyright: strict
"""Approved-configuration attestation for the frozen deployment profile.

The policy selector lives only in :mod:`orgtree.deployment`.  This module
consumes the resulting immutable policy and verifies that the installation
matches the repository's approved manifest; it never interprets the selector
environment variable itself.

The trust chain is deliberately short and inspectable:

* this module pins the approved manifest's SHA-256;
* the manifest pins the exact lock and frozen-container definition hashes;
* runtime checks compare installed Python/UI/provider state and container
  labels with that approved document.

Standard deployments never call the enforcement entry point.  The standalone
verifier rejects a standard profile so its success can only mean "the active
frozen installation matches", never merely "these files look plausible".
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from typing import Any, Mapping, Sequence

from . import deployment


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_REL = Path("frozen") / "approved-install.json"

# Updated only alongside an intentional approved-manifest change.  A manifest
# and all of its referenced files cannot be silently edited into a new
# approval: this independently committed value must move too.
APPROVED_MANIFEST_SHA256 = \
    "49c5bf5f8f4872b1142b0f91382588f9f88b69fdaca4bb9e796c27f0359c1165"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_EXACT_REQUIREMENT = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.+!-]*)$")
_REQUIREMENT_HASH = re.compile(r"^--hash=sha256:[0-9a-f]{64}$")

# Set only by the supported ``python -m orgtree.api`` entry point.  A direct
# ``uvicorn orgtree.api:app --host ...`` import reaches ASGI startup without
# this plan and is refused: FastAPI cannot observe which host Uvicorn selected.
_official_launch_plan: dict[str, Any] | None = None


@dataclass(frozen=True)
class AttestationCheck:
    code: str
    subject: str
    ok: bool
    expected: str
    actual: str
    detail: str = ""


@dataclass(frozen=True)
class AttestationReport:
    profile: str
    configuration_sha256: str
    checks: tuple[AttestationCheck, ...]

    @property
    def ok(self) -> bool:
        return bool(self.checks) and all(c.ok for c in self.checks)

    @property
    def failures(self) -> tuple[AttestationCheck, ...]:
        return tuple(c for c in self.checks if not c.ok)

    def as_dict(self) -> dict[str, Any]:
        return {
            "profile": self.profile,
            "configuration_sha256": self.configuration_sha256,
            "ok": self.ok,
            "checks": [asdict(c) for c in self.checks],
            "failures": [asdict(c) for c in self.failures],
        }


class _Recorder:
    def __init__(self) -> None:
        self.checks: list[AttestationCheck] = []

    def add(self, code: str, subject: str, ok: bool, expected: object,
            actual: object, detail: str = "") -> bool:
        self.checks.append(AttestationCheck(
            code=code, subject=subject, ok=ok,
            expected=str(expected), actual=str(actual), detail=detail))
        return ok


def _canonical_package(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _safe_repo_path(root: Path, rel: str) -> Path:
    raw = Path(rel)
    if raw.is_absolute():
        raise ValueError("path is absolute")
    root_resolved = root.resolve()
    out = (root_resolved / raw).resolve()
    try:
        out.relative_to(root_resolved)
    except ValueError as e:
        raise ValueError("path escapes the repository root") from e
    return out


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_manifest(root: Path, expected_sha256: str,
                   rec: _Recorder) -> tuple[dict[str, Any] | None, str]:
    path = root / MANIFEST_REL
    if not path.is_file():
        rec.add("MANIFEST_MISSING", str(MANIFEST_REL), False,
                expected_sha256, "missing",
                "the approved manifest is required in frozen mode")
        return None, ""
    actual_sha256 = _file_sha256(path)
    if not rec.add(
            "MANIFEST_DIGEST", str(MANIFEST_REL),
            _SHA256.fullmatch(expected_sha256) is not None
            and actual_sha256 == expected_sha256,
            expected_sha256, actual_sha256,
            "the manifest digest is pinned independently in frozen_install.py"):
        # Never use an unapproved document to decide what else is approved.
        return None, actual_sha256
    try:
        raw = _read_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError) as e:
        rec.add("MANIFEST_INVALID", str(MANIFEST_REL), False, "valid JSON",
                type(e).__name__, str(e))
        return None, actual_sha256
    if not isinstance(raw, dict):
        rec.add("MANIFEST_INVALID", str(MANIFEST_REL), False, "JSON object",
                type(raw).__name__)
        return None, actual_sha256
    schema_ok = raw.get("schema") == 1 and raw.get("profile") == "frozen"
    rec.add("MANIFEST_SCHEMA", str(MANIFEST_REL), schema_ok,
            "schema=1, profile=frozen",
            f"schema={raw.get('schema')!r}, profile={raw.get('profile')!r}")
    return raw, actual_sha256


def _verify_source_files(root: Path, manifest: Mapping[str, Any],
                         rec: _Recorder) -> None:
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        rec.add("MANIFEST_FILES_INVALID", "files", False,
                "non-empty path-to-SHA256 object", repr(files))
        return
    for rel, expected in sorted(files.items()):
        if not isinstance(rel, str) or not isinstance(expected, str) \
                or _SHA256.fullmatch(expected) is None:
            rec.add("SOURCE_PIN_INVALID", str(rel), False,
                    "relative path and lowercase SHA-256", repr(expected))
            continue
        try:
            path = _safe_repo_path(root, rel)
        except ValueError as e:
            rec.add("SOURCE_PATH_INVALID", rel, False,
                    "path inside repository", "unsafe", str(e))
            continue
        if not path.is_file():
            rec.add("SOURCE_FILE_MISSING", rel, False, expected, "missing")
            continue
        actual = _file_sha256(path)
        rec.add("SOURCE_FILE_DIGEST", rel, actual == expected,
                expected, actual,
                _digest_mismatch_detail(path, rel, expected, actual))


def _digest_mismatch_detail(path: Path, rel: str, expected: str,
                            actual: str) -> str:
    """Explain a pin mismatch that no diff can show.

    ⚠ THE LINE-ENDING TRAP. These pins hash WORKING-TREE bytes, and
    ``.gitattributes`` pins them to ``eol=lf`` — but an attribute only takes
    effect on CHECKOUT. A worktree that existed before that rule keeps its CRLF
    bytes forever: ``git status`` reports the tree clean, ``git diff`` shows
    nothing, and ``git add --renormalize`` stages nothing (the blobs in git were
    always LF). The file is genuinely correct by every git measure and still
    hashes differently.

    Reporting only "expected X, actual Y" sends the reader hunting for a
    content change that does not exist, so when the ONLY difference is line
    endings, say so and give the exact command that fixes it.
    """

    if actual == expected:
        return "approved source/lock content"
    try:
        raw = path.read_bytes()
    except OSError:
        return "approved source/lock content"
    if b"\r\n" not in raw:
        return "approved source/lock content"
    normalised = hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()
    if normalised != expected:
        return "approved source/lock content"
    return (
        "LINE ENDINGS ONLY — the content is correct. This file is CRLF in "
        "the working tree; the approved pin is the LF form, and .gitattributes "
        "pins it to eol=lf. Attributes apply on CHECKOUT, so a worktree older "
        "than that rule keeps CRLF while `git status` stays clean and "
        "`git add --renormalize` stages nothing. Fix this checkout with: "
        f"git rm --cached -q \"{rel}\" && git checkout -- \"{rel}\" "
        "(or, for the whole tree, `git rm --cached -r -q . && git reset --hard`). "
        "Do NOT edit the file.")


def _parse_requirements(path: Path) -> dict[str, str]:
    packages: dict[str, str] = {}
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        match = _EXACT_REQUIREMENT.fullmatch(fields[0])
        if match is None:
            raise ValueError(
                f"line {lineno} is not one exact name==version pin: {line!r}")
        hashes = fields[1:]
        if not hashes or any(_REQUIREMENT_HASH.fullmatch(v) is None
                             for v in hashes):
            raise ValueError(
                f"line {lineno} must authenticate every allowed artifact "
                f"with --hash=sha256:<64 lowercase hex>: {line!r}")
        name = _canonical_package(match.group(1))
        if name in packages:
            raise ValueError(f"line {lineno} duplicates package {name!r}")
        packages[name] = match.group(2)
    if not packages:
        raise ValueError("requirements file contains no package pins")
    return packages


def _installed_python_packages() -> dict[str, str]:
    out: dict[str, str] = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata.get("Name")
        if name:
            out[_canonical_package(str(name))] = dist.version
    return out


def _verify_python(root: Path, manifest: Mapping[str, Any], rec: _Recorder,
                   inventory: Mapping[str, str] | None) -> None:
    spec = manifest.get("python")
    if not isinstance(spec, dict) or not isinstance(spec.get("requirements"), str):
        rec.add("PYTHON_SPEC_INVALID", "python", False,
                "requirements path", repr(spec))
        return
    runtime_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    approved_versions = spec.get("versions")
    runtime_ok = (
        isinstance(approved_versions, list)
        and runtime_version in approved_versions
        and platform.python_implementation() == spec.get("implementation")
        and platform.system() == spec.get("platform_system")
        and platform.machine().lower()
        == str(spec.get("platform_machine") or "").lower()
    )
    expected_runtime = (
        f"{spec.get('implementation')} "
        f"{','.join(str(v) for v in approved_versions)} "
        f"on {spec.get('platform_system')}/{spec.get('platform_machine')}"
        if isinstance(approved_versions, list)
        else "explicit approved Python runtime"
    )
    actual_runtime = (
        f"{platform.python_implementation()} {runtime_version} on "
        f"{platform.system()}/{platform.machine()}"
    )
    rec.add("PYTHON_RUNTIME", "backend interpreter", runtime_ok,
            expected_runtime, actual_runtime,
            "the wheel hashes in the approved lock are platform-specific")
    try:
        req_path = _safe_repo_path(root, str(spec["requirements"]))
        expected = _parse_requirements(req_path)
    except (OSError, UnicodeError, ValueError) as e:
        rec.add("PYTHON_LOCK_INVALID", str(spec.get("requirements")), False,
                "complete exact requirements lock", type(e).__name__, str(e))
        return
    actual = ({_canonical_package(k): str(v) for k, v in inventory.items()}
              if inventory is not None else _installed_python_packages())
    for name, version in sorted(expected.items()):
        got = actual.get(name)
        rec.add("PYTHON_PACKAGE_VERSION", name, got == version,
                version, got if got is not None else "missing")
    allowed_raw = spec.get("allowed_bootstrap_packages") or []
    allowed = {_canonical_package(str(v)) for v in allowed_raw}
    extras = sorted(set(actual) - set(expected) - allowed)
    rec.add("PYTHON_PACKAGE_SET", "installed Python distributions",
            not extras, "no packages outside the approved lock",
            ", ".join(extras) if extras else "exact approved set",
            "unexpected packages expand the frozen runtime's executable code")


def _package_entries(doc: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(doc, dict) or not isinstance(doc.get("packages"), dict):
        raise ValueError("lockfile has no packages object")
    return {str(k): v for k, v in doc["packages"].items()
            if isinstance(v, dict)}


def _verify_frontend(root: Path, manifest: Mapping[str, Any], rec: _Recorder,
                     inventory: Mapping[str, Mapping[str, Any]] | None) -> None:
    spec = manifest.get("frontend")
    if not isinstance(spec, dict):
        rec.add("FRONTEND_SPEC_INVALID", "frontend", False,
                "lockfile specification", repr(spec))
        return
    try:
        lock_path = _safe_repo_path(root, str(spec["lockfile"]))
        expected = _package_entries(_read_json(lock_path))
    except (KeyError, OSError, UnicodeError, json.JSONDecodeError, ValueError) as e:
        rec.add("FRONTEND_LOCK_INVALID", str(spec.get("lockfile")), False,
                "npm lockfileVersion 3 packages", type(e).__name__, str(e))
        return
    if inventory is None:
        try:
            installed_path = _safe_repo_path(root, str(spec["installed_lockfile"]))
            actual = _package_entries(_read_json(installed_path))
        except (KeyError, OSError, UnicodeError, json.JSONDecodeError,
                ValueError) as e:
            rec.add("FRONTEND_INSTALL_MISSING",
                    str(spec.get("installed_lockfile")), False,
                    "npm ci hidden lockfile", type(e).__name__, str(e))
            return
    else:
        actual = {str(k): dict(v) for k, v in inventory.items()}

    expected.pop("", None)
    actual.pop("", None)
    required = {k for k, v in expected.items() if not v.get("optional")}
    missing = sorted(required - set(actual))
    extras = sorted(set(actual) - set(expected))
    mismatched: list[str] = []
    for path in sorted(set(actual) & set(expected)):
        exp, got = expected[path], actual[path]
        if got.get("version") != exp.get("version") \
                or (exp.get("integrity") is not None
                    and got.get("integrity") != exp.get("integrity")):
            mismatched.append(path)
    detail_parts = []
    if missing:
        detail_parts.append("missing=" + ", ".join(missing[:8]))
    if extras:
        detail_parts.append("extra=" + ", ".join(extras[:8]))
    if mismatched:
        detail_parts.append("version/integrity=" + ", ".join(mismatched[:8]))
    rec.add("FRONTEND_PACKAGE_TREE", "frontend/node_modules",
            not (missing or extras or mismatched),
            f"{len(required)} required packages at lockfile versions/integrities",
            f"{len(actual)} installed packages",
            "; ".join(detail_parts))


def _provider_package_path(prefix: Path, package: str) -> Path:
    return prefix / "node_modules" / Path(*package.split("/"))


def _provider_inventory(specs: Sequence[Mapping[str, Any]]) \
        -> dict[str, dict[str, Any]]:
    # Local imports avoid adding provider/supervisor startup work to a standard
    # process that never invokes frozen attestation.
    from . import providers, supervisor

    data_root = Path(os.path.expanduser(
        os.environ.get("ORGTREE_DATA", "~/orgtree")))
    statuses: dict[str, Mapping[str, Any]] = {
        "claude": supervisor.claude_install_state(force=True),
        "openai": providers.codex_status(force=True),
        "google": providers.antigravity_status(force=True),
    }
    out: dict[str, dict[str, Any]] = {}
    for spec in specs:
        pid = str(spec.get("id"))
        if str(spec.get("kind") or "") == "binary":
            # a provider that is ONE native binary with its own installer
            # (the Antigravity CLI): no npm prefix, no package-lock. The
            # attested facts are the binary's version and its sha256, from
            # the installer's own location.
            status = statuses.get(pid) or {}
            path = status.get("path")
            digest: str | None = None
            if isinstance(path, str) and path and Path(path).is_file():
                try:
                    digest = "sha256:" + _file_sha256(Path(path))
                except OSError:
                    digest = None
            out[pid] = {
                "installed": bool(status.get("installed")),
                "source": str(status.get("source") or ""),
                "private_present": bool(status.get("installed"))
                and str(status.get("source") or "") == "install",
                "version": status.get("version"),
                "integrity": digest,
                "path": path,
            }
            continue
        prefix = data_root / str(spec.get("prefix"))
        package = str(spec.get("package"))
        package_json = _provider_package_path(prefix, package) / "package.json"
        version: str | None = None
        private_present = package_json.is_file()
        if private_present:
            try:
                doc = _read_json(package_json)
                version = str(doc.get("version")) if isinstance(doc, dict) else None
            except (OSError, UnicodeError, json.JSONDecodeError):
                version = None
        integrity: str | None = None
        lock_path = prefix / "package-lock.json"
        if lock_path.is_file():
            try:
                lock = _package_entries(_read_json(lock_path))
                row = lock.get("node_modules/" + package) or {}
                raw_integrity = row.get("integrity")
                if isinstance(raw_integrity, str):
                    integrity = raw_integrity
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                pass
        status = statuses.get(pid) or {}
        out[pid] = {
            "installed": bool(status.get("installed")),
            "source": str(status.get("source") or ""),
            "private_present": private_present,
            "version": version or status.get("version"),
            "integrity": integrity,
            "path": status.get("path"),
        }
    return out


def _verify_providers(manifest: Mapping[str, Any], rec: _Recorder,
                      inventory: Mapping[str, Mapping[str, Any]] | None) -> None:
    raw_specs = manifest.get("providers")
    if not isinstance(raw_specs, list) or not raw_specs:
        rec.add("PROVIDER_SPEC_INVALID", "providers", False,
                "non-empty provider list", repr(raw_specs))
        return
    specs = [v for v in raw_specs if isinstance(v, dict)]
    if len(specs) != len(raw_specs):
        rec.add("PROVIDER_SPEC_INVALID", "providers", False,
                "provider objects only", "non-object entry")
        return
    observed = ({str(k): dict(v) for k, v in inventory.items()}
                if inventory is not None else _provider_inventory(specs))
    for spec in specs:
        pid = str(spec.get("id"))
        obs = observed.get(pid, {})
        required = spec.get("required") is True
        installed = obs.get("installed") is True
        private_present = obs.get("private_present") is True
        source = str(obs.get("source") or "")
        if not installed and not private_present and not required and not source:
            rec.add("PROVIDER_OPTIONAL_ABSENT", pid, True,
                    "absent or approved private pin", "absent")
            continue
        binary = str(spec.get("kind") or "") == "binary"
        want_source = "install" if binary else "pin"
        rec.add("PROVIDER_PRESENT", pid, installed and private_present,
                "installed at its installer's own location" if binary
                else "installed from the orgtree private prefix",
                f"installed={installed}, private_present={private_present}")
        rec.add("PROVIDER_SOURCE", pid, source == want_source, want_source,
                source or "none",
                "environment/PATH overrides are not approved in frozen mode")
        rec.add("PROVIDER_VERSION", pid,
                str(obs.get("version")) == str(spec.get("version")),
                spec.get("version"), obs.get("version") or "missing")
        rec.add("PROVIDER_INTEGRITY", pid,
                str(obs.get("integrity")) == str(spec.get("integrity")),
                spec.get("integrity"), obs.get("integrity") or "missing",
                "the binary's own sha256" if binary
                else "the prefix package-lock records npm's registry integrity")


def _bridge_inventory(*, create_key: bool = False) -> dict[str, Any]:
    """Observe the live per-org bridge credential state.

    ``bridgeauth.install_key()`` MINTS a key when none exists.  The standalone
    verifier must never do that: a machine with no key is a finding, not
    something to quietly fix, so its reads go through ``create=False``.

    Frozen STARTUP passes ``create_key=True``.  The backend legitimately owns
    that file, and minting it once at startup — rather than lazily, inside
    whichever turn first touches a sandbox — is what lets the very first
    frozen boot attest its own bridge instead of deadlocking on a key that
    only exists after the check it is blocking.
    """

    # Local imports keep provider/store startup work out of a standard process
    # that never invokes frozen attestation.
    from . import bridgeauth, sandbox, store
    from .ledger import LedgerError

    out: dict[str, Any] = {
        "key_path": bridgeauth.credential_key_path(),
        "key_present": False,
        "orgs": {},
        "sandboxed_orgs": [],
        "error": "",
    }
    try:
        out["key_present"] = bridgeauth.install_key(
            create=create_key) is not None
    except bridgeauth.BridgeCredentialError as e:
        out["error"] = str(e)
        return out
    if not out["key_present"]:
        out["error"] = ("no host-only bridge credential key; frozen orgs have "
                        "no rotatable credential to attest")
        return out
    records: dict[str, Any] = {}
    sandboxed: list[str] = []
    for row in store.list_orgs():
        slug = str(row.get("slug") or "")
        if not slug:
            continue
        try:
            org = store.load_org(slug)
        except (LedgerError, OSError) as e:
            records[slug] = {"error": f"could not load org: {e}"}
            sandboxed.append(slug)
            continue
        if not sandbox.is_sandboxed(org):
            # Frozen mode already refuses unsandboxed orgs in preflight; this
            # module does not duplicate that refusal, it only attests bridges.
            continue
        sandboxed.append(slug)
        try:
            records[slug] = bridgeauth.credential_attestation(org)
        except (bridgeauth.BridgeCredentialError,
                deployment.DeploymentConfigError) as e:
            records[slug] = {"error": f"{type(e).__name__}: {e}"}
    out["orgs"] = records
    out["sandboxed_orgs"] = sandboxed
    return out


def _org_key_inventory() -> dict[str, Any]:
    """Which sandboxed orgs have the explicit provider key frozen mode needs.

    Records only presence — never the key, and never a digest of it, because
    an attestation report is written to logs and read over shoulders.
    """

    from . import sandbox, store
    from .ledger import LedgerError

    rows: dict[str, Any] = {}
    for row in store.list_orgs():
        slug = str(row.get("slug") or "")
        if not slug:
            continue
        try:
            org = store.load_org(slug)
        except (LedgerError, OSError) as e:
            rows[slug] = {"error": f"could not load org: {e}"}
            continue
        if not sandbox.is_sandboxed(org):
            continue
        try:
            # Exactly the value api.anthropic_proxy would attach as x-api-key.
            # Checking the real thing, not a stand-in for it: reading
            # org.d["api_key"] alone would miss the kiosk-level key and the
            # install default, and would pass an org that the proxy will
            # nonetheless send to the subscription branch.
            rows[slug] = {"present": bool(
                sandbox.anthropic_proxy_api_key(org).strip())}
        except deployment.DeploymentConfigError as e:
            rows[slug] = {"error": str(e)}
    return {"orgs": rows}


def _verify_org_provider_keys(rec: _Recorder,
                              inventory: Mapping[str, Any] | None) -> None:
    """Frozen orgs must carry their own provider key (user ruling 2026-08-31).

    ⚠ THIS IS A CAPACITY CONTRACT, NOT A PREFERENCE. A sandboxed org's traffic
    leaves through ``api.anthropic_proxy``, which authenticates with an
    explicit per-org key or else falls back to the host subscription read from
    a fixed path. The multi-account pool that gives host-mode turns their
    capacity failover is unreachable from that handler — an account-pool
    credential is an OAuth token needing ``Authorization: Bearer`` and cannot
    be attached through the ``x-api-key`` branch at all.

    The ruling resolves that by requiring the key. The subscription branch is
    not a supported frozen configuration, so an org without a key is refused
    HERE, by name, rather than discovered as a 403 in the middle of an agent's
    turn — which is how it was actually found.
    """

    obs = dict(inventory) if inventory is not None else _org_key_inventory()
    raw = obs.get("orgs")
    rows = raw if isinstance(raw, dict) else {}
    if not rows:
        # No sandboxed orgs is a legitimate state: a fresh frozen install has
        # none yet, and org creation enforces sandboxing separately.
        rec.add("ORG_PROVIDER_KEY", "sandboxed orgs", True,
                "every sandboxed org carries its own provider key",
                "no sandboxed orgs yet")
        return
    for slug in sorted(rows):
        row = rows[slug] if isinstance(rows[slug], dict) else {}
        if row.get("error"):
            rec.add("ORG_PROVIDER_KEY_UNAVAILABLE", slug, False,
                    "a resolvable provider key", "error", str(row["error"]))
            continue
        rec.add("ORG_PROVIDER_KEY", slug, row.get("present") is True,
                "an explicit per-org API key", "missing"
                if not row.get("present") else "present",
                "frozen mode requires every org to carry its own provider "
                "key; the host subscription is not a supported frozen "
                "credential and there is no account pool behind it. Set this "
                "org's api_key (org, kiosk, or install default) before "
                "starting a frozen install.")


def _verify_bridge(manifest: Mapping[str, Any], rec: _Recorder,
                   inventory: Mapping[str, Any] | None) -> None:
    """Attest the rotatable per-org sandbox bridge credential state.

    ⚠ The approved claim is a ROTATABLE PER-ORG credential.  Sandboxed nodes
    inside one org share a root-capable container and can read each other's
    bearer from ``/proc``; they are mutually trusted at this boundary.  These
    checks deliberately assert that the attestation record SAYS SO, and would
    fail an attestation that quietly claimed per-node isolation instead.
    """

    spec = manifest.get("bridge")
    if not isinstance(spec, dict):
        rec.add("BRIDGE_SPEC_INVALID", "bridge", False,
                "approved bridge credential specification", repr(spec))
        return
    approved_scheme = str(spec.get("scheme") or "")
    approved_scope = str(spec.get("scope") or "")
    approved_mutual = spec.get("same_org_nodes_mutually_trusted")
    if not approved_scheme or approved_scope != "org" or approved_mutual is not True:
        rec.add("BRIDGE_SPEC_INVALID", "bridge", False,
                "scheme, scope='org', same_org_nodes_mutually_trusted=true",
                json.dumps(spec, sort_keys=True),
                "the approved boundary is per-org rotation, not per-node "
                "isolation; the manifest must state that literally")
        return

    obs = dict(inventory) if inventory is not None else _bridge_inventory()
    if not rec.add("BRIDGE_KEY_PRESENT", "host-only bridge credential key",
                   obs.get("key_present") is True,
                   "a 64-hex owner-only install key",
                   "present" if obs.get("key_present") else "missing",
                   str(obs.get("error") or "")):
        return

    # The signing key must never be reachable from inside a sandbox. Every
    # sandbox bind is rooted under the data root's ``sandboxes`` directory.
    key_path = str(obs.get("key_path") or "")
    try:
        resolved = Path(key_path).resolve()
        from . import sandbox as _sandbox
        inside = any(
            resolved == p or p in resolved.parents
            for p in (Path(_sandbox.sandbox_root(str(slug))).resolve()
                      for slug in (obs.get("sandboxed_orgs") or [])))
    except (OSError, ValueError) as e:
        inside, resolved = True, key_path
        rec.add("BRIDGE_KEY_PATH_UNREADABLE", key_path, False,
                "resolvable host path", type(e).__name__, str(e))
    rec.add("BRIDGE_KEY_HOST_ONLY", key_path, not inside,
            "outside every sandbox bind root", str(resolved),
            "a key visible inside a container is not a host-only key")

    raw_records = obs.get("orgs")
    records = raw_records if isinstance(raw_records, dict) else {}
    sandboxed = [str(v) for v in (obs.get("sandboxed_orgs") or [])]
    uncovered = sorted(set(sandboxed) - set(records))
    rec.add("BRIDGE_ORGS_COVERED", "sandboxed orgs", not uncovered,
            f"{len(sandboxed)} sandboxed orgs attested",
            ", ".join(uncovered) if uncovered else f"{len(records)} attested",
            "every sandboxed org must produce a bridge attestation record")

    for slug in sorted(records):
        raw = records[slug]
        row = raw if isinstance(raw, dict) else {}
        if row.get("error"):
            rec.add("BRIDGE_ATTESTATION_UNAVAILABLE", slug, False,
                    "secret-free bridge attestation", "error",
                    str(row.get("error")))
            continue
        rec.add("BRIDGE_SCHEME", slug, row.get("scheme") == approved_scheme,
                approved_scheme, row.get("scheme") or "missing")
        rec.add("BRIDGE_SCOPE", slug, row.get("scope") == "org", "org",
                row.get("scope") or "missing",
                "the approved identity boundary is the org")
        rec.add("BRIDGE_TRUST_BOUNDARY_DECLARED", slug,
                row.get("same_org_nodes_mutually_trusted") is True,
                "true", row.get("same_org_nodes_mutually_trusted"),
                "same-org root-capable nodes ARE mutually trusted here; an "
                "attestation that denied it would be claiming isolation this "
                "deployment does not provide")
        rec.add("BRIDGE_LEGACY_CREDENTIALS_REFUSED", slug,
                row.get("legacy_credentials_accepted") is False,
                "false", row.get("legacy_credentials_accepted"),
                "the shared persisted org root is not accepted in frozen mode")
        generation = row.get("generation")
        rec.add("BRIDGE_GENERATION", slug,
                isinstance(generation, int) and not isinstance(generation, bool)
                and generation >= 0,
                "non-negative integer generation", generation)
        fingerprint = str(row.get("fingerprint") or "")
        rec.add("BRIDGE_FINGERPRINT", slug,
                fingerprint.startswith("sha256:")
                and _SHA256.fullmatch(fingerprint[7:]) is not None,
                "sha256:<64 hex> one-way fingerprint",
                fingerprint or "missing",
                "the attestation must carry no recoverable bearer")
        previous = row.get("previous_generation_rejected")
        # ``None`` means this org has never rotated, so there is no previous
        # generation to reject. ``False`` means a rotation happened and the
        # superseded credential is STILL accepted — that is a real finding.
        rec.add("BRIDGE_PREVIOUS_GENERATION_REJECTED", slug,
                previous is not False,
                "true (or not-yet-rotated)", previous,
                "a rotation that leaves the old credential valid has not "
                "rotated anything")


def container_tag(repository: str, configuration_sha256: str) -> str:
    return f"{repository}:frozen-{configuration_sha256[:16]}"


def _inspect_container(tag: str) -> dict[str, Any]:
    # Go through sandbox._docker rather than shelling out here. It is the
    # install's single Docker seam: the runtime path that actually launches
    # containers already uses it, so a second private subprocess call would
    # be a second thing to trust and a path no sandbox test could observe.
    from . import sandbox
    try:
        result = sandbox._docker("image", "inspect", tag, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"exists": False, "error": f"{type(e).__name__}: {e}"}
    if result.returncode != 0:
        return {"exists": False,
                "error": (result.stderr or result.stdout).strip()[-500:]}
    try:
        docs = json.loads(result.stdout)
        doc = docs[0]
        return {"exists": True, "image_id": doc.get("Id"),
                "labels": ((doc.get("Config") or {}).get("Labels") or {})}
    except (IndexError, TypeError, json.JSONDecodeError) as e:
        return {"exists": False, "error": f"invalid docker inspect: {e}"}


def _verify_containers(manifest: Mapping[str, Any], config_sha256: str,
                       rec: _Recorder,
                       inventory: Mapping[str, Mapping[str, Any]] | None) -> None:
    raw_specs = manifest.get("containers")
    if not isinstance(raw_specs, list) or not raw_specs:
        rec.add("CONTAINER_SPEC_INVALID", "containers", False,
                "non-empty container list", repr(raw_specs))
        return
    provided = ({str(k): dict(v) for k, v in inventory.items()}
                if inventory is not None else None)
    for raw in raw_specs:
        if not isinstance(raw, dict):
            rec.add("CONTAINER_SPEC_INVALID", "containers", False,
                    "container object", repr(raw))
            continue
        cid = str(raw.get("id"))
        repository = str(raw.get("repository"))
        tag = container_tag(repository, config_sha256)
        obs = provided.get(cid, {}) if provided is not None else _inspect_container(tag)
        exists = obs.get("exists") is True
        if not exists and raw.get("required") is not True:
            rec.add("CONTAINER_OPTIONAL_ABSENT", cid, True,
                    f"absent or {tag}", "absent")
            continue
        rec.add("CONTAINER_IMAGE_PRESENT", cid, exists, tag,
                obs.get("image_id") or "missing", str(obs.get("error") or ""))
        if not exists:
            continue
        labels = obs.get("labels") if isinstance(obs.get("labels"), dict) else {}
        expected_labels = (dict(raw.get("labels"))
                           if isinstance(raw.get("labels"), dict) else {})
        expected_labels["io.orgtree.frozen.config"] = config_sha256
        wrong = [f"{key}={labels.get(key)!r}"
                 for key, value in expected_labels.items()
                 if labels.get(key) != value]
        rec.add("CONTAINER_IMAGE_LABELS", cid, not wrong,
                json.dumps(expected_labels, sort_keys=True),
                json.dumps(labels, sort_keys=True), "; ".join(wrong))


def register_official_launch(*, admin_host: str,
                             public_port: int | str | None,
                             expose_admin: str | None,
                             admin_port: int | None = None,
                             bridge_port: int | None = None) -> None:
    """Record the listener plan owned by ``orgtree.api.main``.

    This is evidence for the pre-bind startup check, not a public launcher API.
    The same ``admin_host`` value must be handed to Uvicorn after preflight.

    Pre-bind evidence is deliberately incomplete: no listener exists yet, so
    the kernel table cannot be read.  The plan carries the ports this process
    intends to open so the standalone verifier's live check has something
    exact to compare against.
    """

    global _official_launch_plan
    _official_launch_plan = {
        "mode": "planned",
        "supported": True,
        "command": "python -m orgtree.api",
        "deployment_profile": "frozen",
        "admin_hosts": [admin_host],
        "public_port": public_port,
        "expose_admin": expose_admin,
        "admin_port": admin_port,
        "bridge_port": bridge_port,
        "listeners": None,        # not observable before uvicorn binds
    }


def _admin_port() -> int:
    data_root = Path(os.path.expanduser(
        os.environ.get("ORGTREE_DATA", "~/orgtree")))
    try:
        value = int((data_root / ".port").read_text(encoding="utf-8").strip())
        if 0 < value < 65536:
            return value
    except (OSError, UnicodeError, ValueError):
        pass
    try:
        value = int(os.environ.get("ORGTREE_PORT", "7360"))
        return value if 0 < value < 65536 else 7360
    except ValueError:
        return 7360


def _live_launch_inventory() -> dict[str, Any]:
    """Observe the running backend process and its real admin listener.

    The standalone attestation cannot trust launch environment alone: a direct
    Uvicorn command may bind the ASGI app publicly even though app preflight
    passed.  psutil is an approved direct backend dependency and supplies both
    the process argv and kernel listener table.
    """

    try:
        import psutil
    except ImportError as e:
        return {"mode": "live", "supported": False, "admin_hosts": [],
                "public_port": None, "expose_admin": None,
                "error": f"psutil unavailable: {e}"}
    port = _admin_port()
    candidates: dict[int, dict[str, Any]] = {}
    try:
        processes = psutil.process_iter(["pid", "cmdline"])
        for process in processes:
            try:
                cmd = [str(v) for v in (process.info.get("cmdline") or [])]
            except (psutil.AccessDenied, psutil.NoSuchProcess):
                continue
            official = any(cmd[i] == "-m" and cmd[i + 1] == "orgtree.api"
                           for i in range(len(cmd) - 1))
            direct = any(v == "orgtree.api:app" for v in cmd)
            if official or direct:
                candidates[int(process.info["pid"])] = {
                    "official": official, "cmd": cmd, "process": process}
        # Every listening socket of each candidate, not only the admin port.
        # Since the frozen network work landed, the backend opens a SECOND
        # listener (the sandbox bridge) whose approved bind address is not
        # loopback on Linux, and a third (public kiosk) that frozen mode must
        # never open at all.  Checking one port could not see either.
        all_listeners: dict[int, list[tuple[str, int]]] = {}
        listeners: dict[int, list[str]] = {}
        for conn in psutil.net_connections(kind="tcp"):
            if conn.pid not in candidates or conn.status != psutil.CONN_LISTEN:
                continue
            if not conn.laddr:
                continue
            pid = int(conn.pid)
            ip, lport = str(conn.laddr.ip), int(conn.laddr.port)
            all_listeners.setdefault(pid, []).append((ip, lport))
            if lport == port:
                listeners.setdefault(pid, []).append(ip)
    except (psutil.AccessDenied, OSError) as e:
        return {"mode": "live", "supported": False, "admin_hosts": [],
                "public_port": None, "expose_admin": None,
                "error": f"could not inspect listener table: {e}"}

    active = [(pid, row, listeners[pid]) for pid, row in candidates.items()
              if pid in listeners]
    if len(active) != 1:
        return {"mode": "live", "supported": False, "admin_hosts": [],
                "public_port": None, "expose_admin": None,
                "error": f"expected one orgtree backend listening on :{port}; "
                         f"observed {len(active)}"}
    pid, row, hosts = active[0]
    observed_listeners = [{"ip": ip, "port": lport} for ip, lport
                          in sorted(set(all_listeners.get(pid, [])))]
    env: Mapping[str, str] = {}
    try:
        env = row["process"].environ()
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
        # Environment is part of the exact launch contract. Inability to read
        # it means the verifier cannot prove PUBLIC_PORT=0 / exposure unset.
        pass
    raw_public = env.get("ORGTREE_PUBLIC_PORT")
    # The supported frozen launch contract is intentionally exact: the
    # variable must be present with value ``0``. Unset/blank is unsafe for the
    # update scripts because they otherwise supply their standard-mode 7361.
    public_port: int | str | None = 0 if raw_public == "0" else raw_public
    # Read the bridge port from the OBSERVED process, not from this verifier's
    # own environment: they are different processes and only the backend's
    # value describes the listener actually open.
    try:
        bridge_port = int(env.get("ORGTREE_BRIDGE_PORT", "7362") or 0)
    except ValueError:
        bridge_port = -1
    return {
        "mode": "live",
        "supported": bool(row["official"]),
        "command": " ".join(row["cmd"]),
        "deployment_profile": env.get(deployment.PROFILE_ENV),
        "admin_hosts": hosts,
        "public_port": public_port,
        "expose_admin": env.get("ORGTREE_EXPOSE_ADMIN"),
        "admin_port": port,
        "bridge_port": bridge_port,
        "listeners": observed_listeners,
        "expected_bridge_hosts": _approved_bridge_hosts(),
        "error": "" if env else "could not read backend process environment",
    }


def _approved_bridge_hosts() -> list[str]:
    """Bind addresses the sandbox bridge listener is allowed to hold.

    Frozen containers have no route off their private network, so the bridge
    is reached through the per-org relay.  On Windows and macOS that resolves
    to loopback; on native Linux the relay reaches the host through Docker's
    host-side bridge gateway, which is host-only but is NOT loopback.  Asking
    for loopback everywhere would be a wrong assertion, not a strict one.
    """

    try:
        from . import sandbox
        return [sandbox.bridge_bind_host()]
    except Exception:                       # docker/policy unavailable here
        return []


def _is_wildcard(ip: str) -> bool:
    return ip in ("0.0.0.0", "::", "*", "")


def _verify_launch(rec: _Recorder,
                   inventory: Mapping[str, Any] | None) -> None:
    obs = dict(inventory) if inventory is not None else _live_launch_inventory()
    mode = str(obs.get("mode") or "unknown")
    rec.add("LAUNCH_PATH_SUPPORTED", "backend launch command",
            obs.get("supported") is True, "python -m orgtree.api",
            obs.get("command") or "unobserved", str(obs.get("error") or ""))
    rec.add("LAUNCH_PROFILE_ACTIVE", deployment.PROFILE_ENV,
            obs.get("deployment_profile") == "frozen", "frozen",
            obs.get("deployment_profile") or "unset",
            "the verifier inspects the backend process environment, not its "
            "own selector alone")
    raw_hosts = obs.get("admin_hosts")
    hosts = [str(v) for v in raw_hosts] if isinstance(raw_hosts, list) else []
    loopback = {"127.0.0.1", "::1"}
    rec.add("ADMIN_LISTENER_LOOPBACK", "admin listener",
            bool(hosts) and all(v in loopback for v in hosts),
            "127.0.0.1 or ::1 only", ", ".join(hosts) if hosts else "unobserved",
            f"{mode} evidence; ASGI preflight alone cannot observe Uvicorn --host")
    rec.add("PUBLIC_LISTENER_DISABLED", "ORGTREE_PUBLIC_PORT",
            obs.get("public_port") == 0, "0", obs.get("public_port"),
            "frozen startup requires an explicit 0 because update scripts "
            "otherwise default this listener to 7361")
    expose = obs.get("expose_admin")
    rec.add("ADMIN_EXPOSURE_UNSET", "ORGTREE_EXPOSE_ADMIN",
            expose is None, "unset", expose,
            "blank is not the supported contract; remove the variable")
    _verify_listener_table(rec, obs, mode)


def _verify_listener_table(rec: _Recorder, obs: Mapping[str, Any],
                           mode: str) -> None:
    """Assert the WHOLE listener table of the running backend.

    Before the frozen network landed there was effectively one listener worth
    checking.  There are now up to three trust levels in one process — admin,
    public kiosk, sandbox bridge — so "the admin port is loopback" no longer
    describes a correct install.  A frozen backend must hold exactly the admin
    listener plus the bridge listener, and no wildcard bind anywhere.
    """

    raw = obs.get("listeners")
    if raw is None:
        # Startup evidence is legitimately pre-bind: no listener exists yet.
        # LIVE evidence with no table is a different thing entirely — it means
        # the verifier could not read what it claims to prove, so it fails
        # rather than reporting an unperformed check as a pass.
        rec.add("LISTENER_TABLE_OBSERVED", "backend listener table",
                mode == "planned",
                "live kernel listener table, or an acknowledged pre-bind plan",
                f"{mode}: not observed",
                "startup runs before uvicorn binds; `python "
                "tools/verify_frozen_install.py` proves the live table")
        return
    rows = [v for v in raw if isinstance(v, dict)]
    admin_port = obs.get("admin_port")
    bridge_port = obs.get("bridge_port")
    approved_ports = {int(v) for v in (admin_port, bridge_port)
                      if isinstance(v, int) and v > 0}

    wildcard = sorted(f"{r.get('ip')}:{r.get('port')}" for r in rows
                      if _is_wildcard(str(r.get("ip") or "")))
    rec.add("NO_WILDCARD_LISTENER", "backend listener table", not wildcard,
            "no 0.0.0.0/:: bind on any port",
            ", ".join(wildcard) if wildcard else "no wildcard binds",
            "a wildcard bind reaches the LAN regardless of which port it is")

    observed_ports = {int(r["port"]) for r in rows
                      if isinstance(r.get("port"), int)}
    unexpected = sorted(observed_ports - approved_ports)
    rec.add("LISTENER_PORT_SET", "backend listening ports", not unexpected,
            ", ".join(str(v) for v in sorted(approved_ports)) or "unknown",
            ", ".join(str(v) for v in sorted(observed_ports)) or "none",
            ("unapproved listeners: "
             + ", ".join(str(v) for v in unexpected)) if unexpected else
            "admin and sandbox bridge only; the public kiosk listener must "
            "not be open in frozen mode")

    if isinstance(bridge_port, int) and bridge_port > 0:
        bridge_hosts = sorted({str(r.get("ip")) for r in rows
                               if r.get("port") == bridge_port})
        raw_expected = obs.get("expected_bridge_hosts")
        expected = sorted({str(v) for v in raw_expected}) \
            if isinstance(raw_expected, list) and raw_expected else []
        if not expected:
            rec.add("BRIDGE_LISTENER_HOST_ONLY", "sandbox bridge listener",
                    False, "the policy-selected host-only bind address",
                    ", ".join(bridge_hosts) or "unobserved",
                    "could not resolve the approved bridge bind address; "
                    "cannot prove the bridge is host-only")
        else:
            rec.add("BRIDGE_LISTENER_HOST_ONLY", "sandbox bridge listener",
                    bool(bridge_hosts) and set(bridge_hosts) <= set(expected),
                    ", ".join(expected),
                    ", ".join(bridge_hosts) or "unobserved",
                    "the frozen bridge is reached through the per-org relay, "
                    "never from the LAN")
    else:
        rec.add("BRIDGE_LISTENER_HOST_ONLY", "sandbox bridge listener", False,
                "an enabled ORGTREE_BRIDGE_PORT from 1 through 65535",
                bridge_port,
                "frozen sandboxes have no other service path to the backend")


def verify_approved_install(
        *, root: Path | None = None,
        policy: deployment.DeploymentPolicy | None = None,
        expected_manifest_sha256: str = APPROVED_MANIFEST_SHA256,
        python_inventory: Mapping[str, str] | None = None,
        frontend_inventory: Mapping[str, Mapping[str, Any]] | None = None,
        provider_inventory: Mapping[str, Mapping[str, Any]] | None = None,
        container_inventory: Mapping[str, Mapping[str, Any]] | None = None,
        launch_inventory: Mapping[str, Any] | None = None,
        bridge_inventory: Mapping[str, Any] | None = None,
        org_key_inventory: Mapping[str, Any] | None = None,
        include_containers: bool = True) -> AttestationReport:
    """Return every approved-configuration check without mutating the host."""

    rec = _Recorder()
    selected = policy or deployment.current_policy()
    rec.add("DEPLOYMENT_PROFILE", "deployment.current_policy().name",
            selected.name == "frozen", "frozen", selected.name,
            "a successful attestation proves the active frozen profile")
    if selected.name != "frozen":
        return AttestationReport(selected.name, "", tuple(rec.checks))

    repo = (root or REPO_ROOT).resolve()
    manifest, config_sha256 = _load_manifest(
        repo, expected_manifest_sha256, rec)
    if manifest is None:
        return AttestationReport(selected.name, config_sha256, tuple(rec.checks))

    _verify_source_files(repo, manifest, rec)
    _verify_python(repo, manifest, rec, python_inventory)
    _verify_frontend(repo, manifest, rec, frontend_inventory)
    _verify_providers(manifest, rec, provider_inventory)
    if include_containers:
        _verify_containers(manifest, config_sha256, rec, container_inventory)
    _verify_bridge(manifest, rec, bridge_inventory)
    _verify_org_provider_keys(rec, org_key_inventory)
    _verify_launch(rec, launch_inventory)
    return AttestationReport(selected.name, config_sha256, tuple(rec.checks))


def format_report(report: AttestationReport, *, verbose: bool = False) -> str:
    heading = ("FROZEN INSTALLATION VERIFIED" if report.ok
               else "FROZEN INSTALLATION REFUSED")
    lines = [heading,
             f"profile: {report.profile}",
             f"approved configuration: {report.configuration_sha256 or 'unavailable'}",
             f"checks: {sum(c.ok for c in report.checks)}/{len(report.checks)} passed"]
    shown = report.checks if verbose else report.failures
    for check in shown:
        state = "PASS" if check.ok else "FAIL"
        lines.append(f"[{state} {check.code}] {check.subject}: "
                     f"expected {check.expected}; actual {check.actual}")
        if check.detail:
            lines.append(f"  {check.detail}")
    if not report.ok:
        lines.append("Nothing was approved. Fix every FAIL above and rerun the check.")
    return "\n".join(lines)


def require_approved_install(*, policy: deployment.DeploymentPolicy) -> None:
    """Frozen startup gate; standard mode is intentionally a no-op."""

    if policy.name != "frozen":
        return
    launch = _official_launch_plan or {
        "mode": "planned", "supported": False, "command": "direct ASGI/unknown",
        "admin_hosts": [], "public_port": None, "expose_admin": None,
        "error": "frozen ASGI startup was not entered through orgtree.api.main",
    }
    report = verify_approved_install(
        policy=policy, include_containers=True, launch_inventory=launch,
        bridge_inventory=_bridge_inventory(create_key=True),
        org_key_inventory=_org_key_inventory())
    if not report.ok:
        first = report.failures[0]
        raise deployment.DeploymentConfigError(
            "frozen approved-configuration check failed "
            f"[{first.code}] {first.subject}: expected {first.expected}; "
            f"actual {first.actual}. Run `python "
            "tools/verify_frozen_install.py --verbose` for every mismatch. "
            "Nothing was started.")
    print("frozen-install: approved configuration "
          f"{report.configuration_sha256} verified "
          f"({len(report.checks)} checks)", flush=True)


def _approved_manifest(root: Path | None = None) -> tuple[dict[str, Any], str]:
    rec = _Recorder()
    manifest, digest = _load_manifest(
        (root or REPO_ROOT).resolve(), APPROVED_MANIFEST_SHA256, rec)
    if manifest is None:
        failure = next(c for c in rec.checks if not c.ok)
        raise deployment.DeploymentConfigError(
            f"frozen manifest unavailable [{failure.code}]: {failure.detail or failure.actual}")
    return manifest, digest


def required_sandbox_image_tag(root: Path | None = None) -> str:
    """The one sandbox image a frozen runtime may execute."""

    manifest, digest = _approved_manifest(root)
    for raw in manifest.get("containers") or []:
        if isinstance(raw, dict) and raw.get("id") == "sandbox":
            return container_tag(str(raw["repository"]), digest)
    raise deployment.DeploymentConfigError(
        "approved frozen manifest has no sandbox container")


def require_approved_sandbox_image(root: Path | None = None) -> str:
    """Return the approved sandbox tag, or fail before Docker can run it."""

    manifest, digest = _approved_manifest(root)
    for raw in manifest.get("containers") or []:
        if not isinstance(raw, dict) or raw.get("id") != "sandbox":
            continue
        tag = container_tag(str(raw["repository"]), digest)
        observed = _inspect_container(tag)
        if observed.get("exists") is not True:
            raise deployment.DeploymentConfigError(
                f"frozen deployment requires prebuilt approved sandbox image "
                f"{tag!r}; Docker reported {observed.get('error') or 'missing'}. "
                "Run `ORGTREE_DEPLOYMENT_PROFILE=frozen python "
                "tools/verify_frozen_install.py --build-commands`, execute the "
                "printed sandbox build, and rerun the verifier.")
        labels = (observed.get("labels")
                  if isinstance(observed.get("labels"), dict) else {})
        expected = (dict(raw.get("labels"))
                    if isinstance(raw.get("labels"), dict) else {})
        expected["io.orgtree.frozen.config"] = digest
        wrong = [key for key, value in expected.items()
                 if labels.get(key) != value]
        if wrong:
            raise deployment.DeploymentConfigError(
                f"frozen sandbox image {tag!r} has unapproved labels: "
                f"{', '.join(wrong)}. Rebuild it from the exact command "
                "printed by `python tools/verify_frozen_install.py "
                "--build-commands`.")
        return tag
    raise deployment.DeploymentConfigError(
        "approved frozen manifest has no sandbox container")


def build_commands(root: Path | None = None) -> list[str]:
    """Exact, copy/pasteable builds for the manifest-tagged frozen images."""

    manifest, digest = _approved_manifest(root)
    commands: list[str] = []
    for raw in manifest.get("containers") or []:
        if not isinstance(raw, dict):
            continue
        tag = container_tag(str(raw["repository"]), digest)
        platform = str(raw.get("platform") or "")
        commands.append(
            "docker build"
            + (" --platform " + platform if platform else "")
            + " --file " + str(raw["dockerfile"])
            + " --build-arg ORGTREE_FROZEN_CONFIG=" + digest
            + " --tag " + tag + " .")
    return commands
