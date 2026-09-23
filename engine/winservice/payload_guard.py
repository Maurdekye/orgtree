"""Is a service payload safe for LocalSystem to run?

The Windows service executes ``python.exe``, its DLLs and every imported
module from one per-machine payload folder. If an ordinary user or an agent
could change any of those bytes, it could run code as SYSTEM on the next
start. This module answers one question about a folder tree, fail closed:
can anyone outside SYSTEM, Administrators and TrustedInstaller change it?

It checks, for every file and folder in the payload:
  * the owner is trusted;
  * no allow entry gives an untrusted principal a right that changes bytes,
    names, attributes, the DACL or the owner;
  * it is not a reparse point (symlink or junction);
and, for every ancestor up to the drive root, that no untrusted principal can
delete, rename, re-ACL or take it over. (Creating NEW entries in an ancestor
is tolerated: Windows lets users create folders at C:\\ by default, and that
cannot replace an existing path.) It also builds and verifies a sha256
manifest of the payload.

Where it runs: the elevated helper calls it BEFORE it configures, starts,
upgrades or repairs the service; that is the trust boundary. The service may
call it again at start as defence in depth only: by then the SCM has already
loaded the runtime from the payload, so a tampered payload could also have
tampered with this check.

Standard library and ctypes only (the packaged runtime has no pywin32).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Callable, Iterable

SID_SYSTEM = "S-1-5-18"
SID_ADMINISTRATORS = "S-1-5-32-544"
SID_TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
TRUSTED_SIDS = frozenset({SID_SYSTEM, SID_ADMINISTRATORS, SID_TRUSTED_INSTALLER})

# Access-mask bits (winnt.h). The same bit means "add file" on a folder and
# "write data" on a file, and so on; both readings are covered.
FILE_WRITE_DATA = 0x0002          # ADD_FILE on a folder
FILE_APPEND_DATA = 0x0004         # ADD_SUBDIRECTORY on a folder
FILE_WRITE_EA = 0x0010
FILE_DELETE_CHILD = 0x0040
FILE_WRITE_ATTRIBUTES = 0x0100
DELETE = 0x00010000
WRITE_DAC = 0x00040000
WRITE_OWNER = 0x00080000
ACCESS_SYSTEM_SECURITY = 0x01000000
GENERIC_ALL = 0x10000000
GENERIC_WRITE = 0x40000000

# Inside the payload: anything that changes the object or its protection.
PAYLOAD_WRITE_MASK = (FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_DELETE_CHILD
                      | FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER
                      | ACCESS_SYSTEM_SECURITY | GENERIC_ALL | GENERIC_WRITE)
# On an ancestor: anything that could remove, rename or re-protect it, or
# remove or rename something inside it. Adding new entries is allowed.
ANCESTOR_WRITE_MASK = (FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER
                       | ACCESS_SYSTEM_SECURITY | GENERIC_ALL)

ACCESS_ALLOWED_ACE_TYPE = 0x0
ACCESS_DENIED_ACE_TYPE = 0x1
ACCESS_ALLOWED_CALLBACK_ACE_TYPE = 0x9
ACCESS_DENIED_CALLBACK_ACE_TYPE = 0xA
ALLOW_TYPES = frozenset({ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_CALLBACK_ACE_TYPE})
DENY_TYPES = frozenset({ACCESS_DENIED_ACE_TYPE, ACCESS_DENIED_CALLBACK_ACE_TYPE})
INHERIT_ONLY_ACE = 0x08

FILE_ATTRIBUTE_REPARSE_POINT = 0x400

MANIFEST_NAME = "payload-manifest.json"
MANIFEST_SCHEMA = "orgtree.service-payload/v1"


@dataclass(frozen=True)
class Ace:
    ace_type: int
    flags: int
    mask: int
    sid: str


@dataclass(frozen=True)
class Security:
    owner: str | None
    dacl_present: bool
    aces: tuple[Ace, ...]


@dataclass
class Report:
    problems: list[str] = field(default_factory=list)
    checked: int = 0

    @property
    def ok(self) -> bool:
        return not self.problems


def judge(path: str, security: Security, write_mask: int) -> list[str]:
    """Problems with one object's owner and DACL; empty means safe."""
    problems: list[str] = []
    if security.owner not in TRUSTED_SIDS:
        problems.append(f"{path}: owner {security.owner or 'unreadable'} is not SYSTEM, Administrators or TrustedInstaller")
    if not security.dacl_present:
        problems.append(f"{path}: has no DACL, so everyone has full access")
        return problems
    for ace in security.aces:
        if ace.ace_type in DENY_TYPES:
            continue  # deny entries only narrow access
        if ace.ace_type not in ALLOW_TYPES:
            # Object and other entry types can still grant access on a file;
            # this module does not model them, so it refuses them (fail closed).
            problems.append(f"{path}: has an entry of unrecognised type 0x{ace.ace_type:02x}")
            continue
        if ace.flags & INHERIT_ONLY_ACE:
            continue  # applies only to children, which are checked themselves
        if ace.sid in TRUSTED_SIDS:
            continue
        if ace.mask & write_mask:
            problems.append(f"{path}: {ace.sid} holds write-type access 0x{ace.mask & write_mask:08x}")
    return problems


def ancestors(root: Path) -> list[Path]:
    """Every folder above ``root``, nearest first, up to the drive root."""
    return list(Path(root).parents)


def _is_reparse(path: Path) -> bool:
    info = os.lstat(path)
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT) or stat.S_ISLNK(info.st_mode)


def walk(root: Path) -> Iterable[Path]:
    """The root and everything below it, without following any link."""
    yield root
    stack = [root]
    while stack:
        folder = stack.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                path = Path(entry.path)
                yield path
                if entry.is_dir(follow_symlinks=False) and not _is_reparse(path):
                    stack.append(path)


def validate(root: Path, *, read_security: "Callable[[Path], Security] | None" = None,
             check_ancestors: bool = True) -> Report:
    """Check the whole payload tree and its ancestors; fail closed on any
    error, including an object whose security cannot be read."""
    read = read_security or read_file_security
    report = Report()
    root = Path(root)
    if not root.is_absolute():
        report.problems.append(f"{root}: payload root must be an absolute path")
        return report
    try:
        objects = list(walk(root))
    except OSError as exc:
        report.problems.append(f"{root}: cannot list the payload: {exc}")
        return report
    for path in objects:
        report.checked += 1
        try:
            if _is_reparse(path):
                report.problems.append(f"{path}: is a symlink or junction")
                continue
            report.problems.extend(judge(str(path), read(path), PAYLOAD_WRITE_MASK))
        except OSError as exc:
            report.problems.append(f"{path}: cannot read its security: {exc}")
    if check_ancestors:
        validate_ancestors(root, read, report)
    return report


def validate_ancestors(root: Path, read: "Callable[[Path], Security]", report: Report | None = None) -> Report:
    """Every folder above ``root`` must be safe from deletion, renaming,
    re-ACL and takeover by untrusted principals, and must not be a link."""
    report = report or Report()
    for path in ancestors(root):
        report.checked += 1
        try:
            if _is_reparse(path):
                report.problems.append(f"{path}: an ancestor is a symlink or junction")
                continue
            report.problems.extend(judge(str(path), read(path), ANCESTOR_WRITE_MASK))
        except OSError as exc:
            report.problems.append(f"{path}: cannot read its security: {exc}")
    return report


def check_installed_payload(install_root: Path, payload_id: str, *,
                            read_security: "Callable[[Path], Security] | None" = None,
                            verify_hashes: bool = True) -> Report:
    """THE entry point for the service and the elevated helper.

    ``install_root`` is the boot record's InstallDir (the payload folder);
    ``payload_id`` is the record's PayloadId. Passes only if the tree and its
    ancestors are protected (``validate``), the payload manifest sits at the
    root, its identity equals ``payload_id``, and (unless ``verify_hashes`` is
    off) every file matches it with nothing missing or extra. Never raises
    for a bad payload or bad arguments: every problem is in the report."""
    report = Report()
    root = Path(install_root)
    if not isinstance(payload_id, str) or len(payload_id) != 64 or any(c not in "0123456789abcdef" for c in payload_id):
        report.problems.append("payload id is not a lowercase sha256")
        return report
    report = validate(root, read_security=read_security)
    if not report.ok:
        return report  # never read bytes that might be attacker-controlled
    manifest_path = root / MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        report.problems.append(f"{manifest_path}: unreadable manifest: {exc}")
        return report
    if not isinstance(manifest, dict) or manifest_id(manifest) != payload_id:
        report.problems.append(f"{manifest_path}: manifest identity does not match the recorded payload id")
        return report
    if verify_hashes:
        report.problems.extend(verify_manifest(root, manifest))
    return report


# ── Manifest ───────────────────────────────────────────────────────────────

def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def build_manifest(root: Path) -> dict:
    """sha256 of every regular file under ``root`` (the manifest itself
    excluded), keyed by forward-slash relative path."""
    root = Path(root)
    files: dict[str, str] = {}
    for path in walk(root):
        if path == root or path.name == MANIFEST_NAME and path.parent == root:
            continue
        if _is_reparse(path):
            raise OSError(f"{path}: refusing a symlink or junction in the payload")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = _sha256(path)
    return {"schema": MANIFEST_SCHEMA, "files": dict(sorted(files.items()))}


def manifest_id(manifest: dict) -> str:
    """The identity recorded for the payload: sha256 of the canonical JSON."""
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def verify_manifest(root: Path, manifest: dict) -> list[str]:
    """Differences between the tree and its manifest: changed, missing or
    extra files. Empty means the bytes are exactly the staged ones."""
    if manifest.get("schema") != MANIFEST_SCHEMA or not isinstance(manifest.get("files"), dict):
        return ["manifest has an unknown schema"]
    try:
        actual = build_manifest(root)["files"]
    except OSError as exc:
        return [str(exc)]
    expected: dict = manifest["files"]
    problems = [f"{name}: changed" for name in expected if name in actual and actual[name] != expected[name]]
    problems += [f"{name}: missing" for name in expected if name not in actual]
    problems += [f"{name}: not in the manifest" for name in actual if name not in expected]
    return sorted(problems)


# ── Windows security reading ───────────────────────────────────────────────

def read_file_security(path: Path) -> Security:
    """Owner and DACL entries of a file or folder, through
    GetNamedSecurityInfoW. Raises OSError when they cannot be read."""
    import ctypes
    from ctypes import wintypes as w

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.GetNamedSecurityInfoW.argtypes = [w.LPCWSTR, ctypes.c_int, w.DWORD,
                                             ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                                             ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                                             ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetNamedSecurityInfoW.restype = w.DWORD
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = w.BOOL
    advapi.GetAce.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetAce.restype = w.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p

    class AclHeader(ctypes.Structure):
        _fields_ = [("AclRevision", ctypes.c_ubyte), ("Sbz1", ctypes.c_ubyte), ("AclSize", w.WORD),
                    ("AceCount", w.WORD), ("Sbz2", w.WORD)]

    class AceHeader(ctypes.Structure):
        _fields_ = [("AceType", ctypes.c_ubyte), ("AceFlags", ctypes.c_ubyte), ("AceSize", w.WORD)]

    class AllowAce(ctypes.Structure):  # ACCESS_ALLOWED_ACE / _CALLBACK_ACE share this prefix
        _fields_ = [("Header", AceHeader), ("Mask", w.DWORD), ("SidStart", w.DWORD)]

    def sid_text(sid: int) -> str:
        text = w.LPWSTR()
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value or ""
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    descriptor = ctypes.c_void_p()
    SE_FILE_OBJECT = 1
    OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION = 0x1, 0x4
    error = advapi.GetNamedSecurityInfoW(str(path), SE_FILE_OBJECT,
                                         OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                         ctypes.byref(owner), None, ctypes.byref(dacl), None,
                                         ctypes.byref(descriptor))
    if error:
        raise ctypes.WinError(error)
    try:
        owner_sid = sid_text(owner.value) if owner.value else None
        if not dacl.value:
            return Security(owner_sid, False, ())
        header = AclHeader.from_address(dacl.value)
        aces: list[Ace] = []
        for index in range(header.AceCount):
            pointer = ctypes.c_void_p()
            if not advapi.GetAce(dacl.value, index, ctypes.byref(pointer)):
                raise ctypes.WinError(ctypes.get_last_error())
            ace_header = AceHeader.from_address(pointer.value)
            if ace_header.AceType in ALLOW_TYPES or ace_header.AceType in DENY_TYPES:
                body = AllowAce.from_address(pointer.value)
                sid = sid_text(pointer.value + AllowAce.SidStart.offset)
                aces.append(Ace(ace_header.AceType, ace_header.AceFlags, body.Mask, sid))
            else:
                # Any other type (object, compound, ...) is kept with its type
                # so judge() refuses it: never silently skipped.
                aces.append(Ace(ace_header.AceType, ace_header.AceFlags, 0, "unknown"))
        return Security(owner_sid, True, tuple(aces))
    finally:
        kernel.LocalFree(descriptor)
