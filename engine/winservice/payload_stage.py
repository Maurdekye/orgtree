"""Stage the service payload into the protected per-machine tree.

Runs ELEVATED (the installer or the desktop's UAC-approved helper). It is the
trust boundary for the Windows service: a payload folder is only published,
and so only ever pointed at by the service, after it has passed
``payload_guard.check_installed_payload``.

Rules:
  * The SOURCE must itself pass the payload guard (owner and DACL admit no
    ordinary user or agent). A per-user install tree fails that check, so its
    bytes are never copied; that is deliberate, not a missing feature.
  * The protected root and every staging folder are created with their
    protected DACL attached AT CREATION, so no copied byte ever sits under a
    looser ACL, and children inherit it.
  * Copies carry bytes only, never the source's ACLs, and refuse links.
  * The copy is verified against a manifest of the source before and after,
    and published by a rename inside the protected root.
  * Payload folders are immutable once published; an upgrade stages a new
    one beside the old and the old is removed only after the switch.

Layout:
  <root>\\payload-<version>-<id8>\\payload-manifest.json
  <root>\\payload-<version>-<id8>\\resources\\{engine,ui,...}
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
from typing import Callable

from . import payload_guard as guard

ROOT_NAME = "Orgtree Engine Service"
PAYLOAD_PREFIX = "payload-"
STAGING_PREFIX = ".staging-"
# Owner Administrators (an elevated administrator may set it without extra
# privileges); SYSTEM, Administrators and TrustedInstaller full control;
# Users read and execute; protected from inheritance; inherited by children.
PROTECTED_SDDL = ("O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
                  f"(A;OICI;FA;;;{guard.SID_TRUSTED_INSTALLER})(A;OICI;0x1200a9;;;BU)")
_VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")


class StagingError(RuntimeError):
    """The payload could not be staged safely; nothing was published."""


@dataclass(frozen=True)
class Staged:
    path: Path
    payload_id: str


def service_root() -> Path:
    """%ProgramFiles%\\Orgtree Engine Service on the native (64-bit) view."""
    base = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles")
    if not base:
        raise StagingError("Program Files location is unknown")
    return Path(base) / ROOT_NAME


def create_protected_dir(path: Path, sddl: str = PROTECTED_SDDL) -> None:
    """CreateDirectoryW with the DACL attached at creation. Refuses an
    existing path: an existing folder may carry any ACL."""
    import ctypes
    from ctypes import wintypes as w
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        w.LPCWSTR, w.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(w.ULONG)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL
    kernel.CreateDirectoryW.argtypes = [w.LPCWSTR, ctypes.c_void_p]
    kernel.CreateDirectoryW.restype = w.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("nLength", w.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p), ("bInheritHandle", w.BOOL)]

    descriptor = ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)


def _copy_tree(source: Path, target: Path) -> None:
    """Bytes only; folders are created plainly so they inherit the protected
    DACL of ``target``'s parent. Links anywhere in the source are refused."""
    target.mkdir()
    for entry in sorted(os.scandir(source), key=lambda e: e.name):
        path = Path(entry.path)
        if guard._is_reparse(path):
            raise StagingError(f"{path}: refusing a symlink or junction in the source")
        if entry.is_dir(follow_symlinks=False):
            _copy_tree(path, target / entry.name)
        elif entry.is_file(follow_symlinks=False):
            shutil.copyfile(path, target / entry.name, follow_symlinks=False)
        else:
            raise StagingError(f"{path}: refusing a special file in the source")


def _source_manifest(source_resources: Path) -> dict:
    files = guard.build_manifest(source_resources)["files"]
    return {"schema": guard.MANIFEST_SCHEMA,
            "files": dict(sorted((f"resources/{name}", digest) for name, digest in files.items()))}


def stage_payload(source_resources: Path, root: Path, version: str, *,
                  read_security: "Callable[[Path], guard.Security] | None" = None,
                  make_dir: Callable[[Path], None] = create_protected_dir) -> Staged:
    """Copy a trusted ``resources`` tree into a new, immutable payload folder
    under the protected ``root`` and return where it is and its PayloadId.
    Raises StagingError, having published nothing, on any failure."""
    source_resources = Path(source_resources)
    root = Path(root)
    if not _VERSION.match(version or ""):
        raise StagingError(f"invalid version label {version!r}")
    if source_resources.name.lower() != "resources" or not (source_resources / "engine").is_dir():
        raise StagingError(f"{source_resources}: not an Orgtree resources folder")
    trusted = guard.validate(source_resources, read_security=read_security)
    if not trusted.ok:
        raise StagingError("the source is not protected against ordinary users, so its bytes cannot be trusted: "
                           + "; ".join(trusted.problems[:5]))
    if not root.exists():
        make_dir(root)
    root_report = guard.validate(root, read_security=read_security)
    if not root_report.ok:
        raise StagingError("the protected service root is not protected: " + "; ".join(root_report.problems[:5]))

    expected = _source_manifest(source_resources)
    payload_id = guard.manifest_id(expected)
    final = root / f"{PAYLOAD_PREFIX}{version}-{payload_id[:8]}"
    if final.exists():
        existing = guard.check_installed_payload(final, payload_id, read_security=read_security)
        if existing.ok:
            return Staged(final, payload_id)  # the same bytes are already published
        raise StagingError(f"{final}: exists but does not verify: " + "; ".join(existing.problems[:5]))

    staging = root / f"{STAGING_PREFIX}{secrets.token_hex(8)}"
    make_dir(staging)
    try:
        _copy_tree(source_resources, staging / "resources")
        differences = guard.verify_manifest(staging, expected)
        if differences:
            raise StagingError("the copy does not match the source: " + "; ".join(differences[:5]))
        (staging / guard.MANIFEST_NAME).write_text(json.dumps(expected, sort_keys=True), encoding="utf-8")
        os.rename(staging, final)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    report = guard.check_installed_payload(final, payload_id, read_security=read_security)
    if not report.ok:
        remove_payload(root, final)
        raise StagingError("the staged payload failed its final check: " + "; ".join(report.problems[:5]))
    return Staged(final, payload_id)


def list_payloads(root: Path) -> list[Path]:
    return sorted(p for p in Path(root).iterdir()
                  if p.name.startswith(PAYLOAD_PREFIX) and p.is_dir() and not guard._is_reparse(p))


def remove_payload(root: Path, payload: Path) -> None:
    """Delete one published payload, and only one of ours: a direct child of
    ``root`` named payload-*, holding a manifest, with no links inside."""
    root, payload = Path(root), Path(payload)
    if payload.parent != root or not payload.name.startswith(PAYLOAD_PREFIX):
        raise StagingError(f"{payload}: not a payload folder of {root}")
    if guard._is_reparse(payload) or not (payload / guard.MANIFEST_NAME).is_file():
        raise StagingError(f"{payload}: not a payload this helper published")
    for path in guard.walk(payload):
        if path != payload and guard._is_reparse(path):
            raise StagingError(f"{path}: refusing to delete through a link")
    shutil.rmtree(payload)
