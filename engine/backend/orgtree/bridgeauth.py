# pyright: strict
"""Rotatable sandbox-bridge credentials for the frozen deployment profile.

The frozen bridge identity boundary is an ORG, not a node. Sandboxed nodes in
one org share a root-capable container and are therefore mutually trusted:
one sibling can read another process's bearer from ``/proc``. HMAC binding
prevents forgery and cross-org use, but it cannot turn a bearer visible inside
that shared container into per-node isolation.

Existing org documents need no conversion. Standard deployments retain their
persisted sandbox root. Frozen deployments mint an opaque per-org credential
from a host-only install key plus a persisted generation counter. Incrementing
that counter rotates the credential and invalidates the previous generation
immediately, without a credential cache or secret appearing in API output.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
from typing import TYPE_CHECKING, Any

from . import deployment, store
from .ledger import LedgerError, now

if TYPE_CHECKING:
    from .ledger import Org


_PREFIX = "otb1"
_SCHEME = "hmac-sha256-org-v1"
_DOMAIN = b"orgtree-sandbox-bridge-org-v1\0"
_TAG_RE = re.compile(r"^[a-f0-9]{32}$")
_KEY_RE = re.compile(r"^[a-f0-9]{64}$")
_MAX_TOKEN_BYTES = 4096
_KEY_FILE = ".bridge-credentials.key"
_KEY_LOCK = threading.Lock()
_KEY_READY = False


class BridgeCredentialError(RuntimeError):
    """The host-only bridge credential state is unsafe or unavailable."""


def legacy_credentials_allowed() -> bool:
    """The one policy seam for accepting or disclosing old sandbox roots."""

    return deployment.current_policy().allow_legacy_sandbox_credentials


def root_secret(org: Org) -> str:
    """Return the existing persisted sandbox root (standard mode only)."""

    kiosk = org.d.get("kiosk") or {}
    if kiosk.get("sandbox"):
        return str(kiosk.get("sandbox_secret") or "")
    sandbox = org.d.get("sandbox") or {}
    if sandbox.get("enabled"):
        return str(sandbox.get("secret") or "")
    return ""


def _is_sandboxed(org: Org) -> bool:
    kiosk = org.d.get("kiosk") or {}
    sandbox = org.d.get("sandbox") or {}
    return bool(kiosk.get("sandbox") or sandbox.get("enabled"))


def credential_key_path() -> str:
    """The host-only install key path (never mounted into a sandbox)."""

    return os.path.join(store.DATA_ROOT, _KEY_FILE)


def _read_install_key() -> bytes | None:
    path = credential_key_path()
    try:
        with open(path, encoding="ascii") as f:
            raw = f.read().strip()
    except FileNotFoundError:
        return None
    except OSError as e:
        raise BridgeCredentialError(
            f"cannot read sandbox bridge credential key {path!r}: {e}") from e
    if not _KEY_RE.fullmatch(raw):
        raise BridgeCredentialError(
            f"sandbox bridge credential key {path!r} is malformed; expected "
            "exactly 64 lowercase hex characters. Refusing credentials rather "
            "than falling back to the legacy org secret.")
    if os.name != "nt":
        try:
            mode = os.stat(path).st_mode & 0o777
        except OSError as e:
            raise BridgeCredentialError(
                f"cannot inspect sandbox bridge credential key {path!r}: {e}") from e
        if mode & 0o077:
            raise BridgeCredentialError(
                f"sandbox bridge credential key {path!r} has unsafe mode "
                f"{mode:04o}; require owner-only access (0600 or stricter)")
    return bytes.fromhex(raw)


def install_key(create: bool = True) -> bytes | None:
    """Read or atomically mint the host-only bridge signing key.

    The file is separate from every historically shared org root. A malformed
    key or one that disappears after first use fails closed rather than
    silently rotating all live org credentials.
    """

    global _KEY_READY
    with _KEY_LOCK:
        existing = _read_install_key()
        if existing is not None:
            _KEY_READY = True
            return existing
        if _KEY_READY:
            raise BridgeCredentialError(
                f"sandbox bridge credential key {credential_key_path()!r} "
                "disappeared while the backend was running. Refusing to "
                "silently rotate every live org credential; restore the key "
                "or restart deliberately to mint a new generation.")
        if not create:
            return None
        path = credential_key_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        encoded = secrets.token_hex(32).encode("ascii")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raced = _read_install_key()
            if raced is None:
                raise BridgeCredentialError(
                    f"sandbox bridge credential key {path!r} disappeared "
                    "during concurrent creation; refusing to mint a replacement")
            _KEY_READY = True
            return raced
        except OSError as e:
            raise BridgeCredentialError(
                f"cannot create sandbox bridge credential key {path!r}: {e}") from e
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(encoded)
                f.flush()
                os.fsync(f.fileno())
        except OSError as e:
            raise BridgeCredentialError(
                f"could not persist sandbox bridge credential key {path!r}: {e}. "
                "Refusing credentials; inspect or remove the incomplete key "
                "before retrying.") from e
        key = _read_install_key()
        if key is None:
            raise BridgeCredentialError(
                f"sandbox bridge credential key {path!r} disappeared after creation")
        _KEY_READY = True
        return key


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _generation(org: Org) -> int:
    raw = org.d.get("bridge_credential_generation")
    if raw is None:
        return 0
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise BridgeCredentialError(
            f"org {org.d.get('slug')!r} has an invalid bridge credential "
            "generation; require a non-negative integer")
    return raw


def _tag(payload: str, generation: int, key: bytes) -> str:
    material = (_DOMAIN + payload.encode("ascii") + b"\0"
                + str(generation).encode("ascii"))
    return hmac.new(key, material, hashlib.sha256).hexdigest()[:32]


def _credential_for_generation(slug: str, generation: int, key: bytes) -> str:
    payload = _b64(slug.encode("utf-8"))
    return f"{_PREFIX}.{payload}.{_tag(payload, generation, key)}"


def org_credential(org: Org) -> str:
    """Mint this org's deterministic credential for its current generation."""

    if not _is_sandboxed(org):
        raise BridgeCredentialError(
            f"org {org.d.get('slug')!r} is not sandboxed and gets no bridge credential")
    key = install_key()
    if key is None:
        raise BridgeCredentialError("sandbox bridge credential key is unavailable")
    return _credential_for_generation(org.d["slug"], _generation(org), key)


def credential_for_org(org: Org) -> str:
    """Credential sandbox processes in this org receive under live policy."""

    if legacy_credentials_allowed():
        return root_secret(org)
    return org_credential(org)


def parse_org_credential(secret: str) -> str | None:
    """Read the org locator from a syntactically canonical credential."""

    try:
        encoded = secret.encode("ascii")
    except UnicodeEncodeError:
        return None
    if not encoded or len(encoded) > _MAX_TOKEN_BYTES:
        return None
    parts = secret.split(".")
    if len(parts) != 3 or parts[0] != _PREFIX or not _TAG_RE.fullmatch(parts[2]):
        return None
    payload = parts[1]
    if not payload:
        return None
    try:
        padded = payload + "=" * (-len(payload) % 4)
        raw = base64.b64decode(padded.encode("ascii"), altchars=b"-_",
                               validate=True)
        if _b64(raw) != payload:
            return None
        slug = raw.decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    if not slug or "\0" in slug:
        return None
    return slug


def resolve_org_credential(secret: str) -> str | None:
    """Validate against the current persisted org generation, without a cache."""

    slug = parse_org_credential(secret)
    if slug is None:
        return None
    try:
        org = store.load_org(slug)
    except LedgerError:
        return None
    if not _is_sandboxed(org):
        return None
    key = install_key(create=not legacy_credentials_allowed())
    if key is None:
        return None
    expected = _credential_for_generation(slug, _generation(org), key)
    return slug if hmac.compare_digest(secret, expected) else None


def accepted_credentials(org: Org) -> tuple[str, ...]:
    """Every bridge credential currently accepted for this org."""

    out: list[str] = []
    if legacy_credentials_allowed():
        if root := root_secret(org):
            out.append(root)
    key = install_key(create=not legacy_credentials_allowed())
    if key is not None and _is_sandboxed(org):
        out.append(_credential_for_generation(
            org.d["slug"], _generation(org), key))
    return tuple(out)


def _fingerprint(secret: str) -> str:
    return "sha256:" + hashlib.sha256(secret.encode("ascii")).hexdigest()


def credential_attestation(org: Org) -> dict[str, Any]:
    """Return secret-free, machine-verifiable state for a frozen org.

    Once at least one rotation has occurred, the helper also plants the exact
    previous-generation credential internally and proves the resolver rejects
    it. The credential itself is never returned or logged.
    """

    if legacy_credentials_allowed():
        raise deployment.DeploymentConfigError(
            "bridge credential attestation is available only in frozen mode")
    current = org_credential(org)
    generation = _generation(org)
    previous_rejected: bool | None = None
    if generation > 0:
        key = install_key()
        if key is None:
            raise BridgeCredentialError("sandbox bridge credential key is unavailable")
        planted = _credential_for_generation(org.d["slug"], generation - 1, key)
        previous_rejected = resolve_org_credential(planted) is None
    return {
        "scheme": _SCHEME,
        "scope": "org",
        "org": org.d["slug"],
        "generation": generation,
        "fingerprint": _fingerprint(current),
        "rotated_at": org.d.get("bridge_credential_rotated_at"),
        "legacy_credentials_accepted": False,
        "same_org_nodes_mutually_trusted": True,
        "previous_generation_rejected": previous_rejected,
    }


def rotate_org_credential(slug: str) -> dict[str, Any]:
    """Atomically rotate one frozen org and return a secret-free receipt."""

    if legacy_credentials_allowed():
        raise deployment.DeploymentConfigError(
            "bridge credential rotation is available only in frozen mode")
    with store.DOC_LOCK:
        org = store.load_org(slug)
        old = org_credential(org)
        previous_generation = _generation(org)
        previous_fingerprint = _fingerprint(old)
        org.d["bridge_credential_generation"] = previous_generation + 1
        org.d["bridge_credential_rotated_at"] = now()
        store.save_org(org)

        # Plant the actual credential that was accepted immediately before
        # this write and verify the live resolver now rejects it. Keep the
        # bearer local; only its one-way fingerprint enters the receipt.
        old_rejected = resolve_org_credential(old) is None
        if not old_rejected:
            raise BridgeCredentialError(
                "bridge rotation verification failed: the previous credential "
                "is still accepted")
        receipt = credential_attestation(org)
        if receipt["previous_generation_rejected"] is not True:
            raise BridgeCredentialError(
                "bridge rotation verification failed: planted previous "
                "generation was not rejected")
        return {
            **receipt,
            "previous_generation": previous_generation,
            "previous_fingerprint": previous_fingerprint,
            "old_credential_rejected": True,
        }
