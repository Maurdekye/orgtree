"""Versioned, nonauthoritative import/recovery state machine for synthetic data.

Only the CLI creates its input, in a new temporary directory. This is an
adapter test harness, not a command for opening or upgrading a user data root.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import Protocol

from .fixtures import MARKER
from .legacy import Refused, decode, digest, encode, manifest, plain_tree, read_source

HARNESS_VERSION = 1
CHECKPOINTS = ("planned", "backup-file", "backed-up", "prepared", "staged",
               "published", "complete", "restore-file", "restored")


def same_json(actual, expected):
    """Compare complete JSON control documents without Python numeric aliases.

    Canonical encoding preserves bool/int/float distinctions at every depth,
    while permitting insignificant input whitespace and object-key order.
    Expected documents are derived from the source and fixed protocol schema.
    """
    return encode(actual) == encode(expected)


def atomic_write(path, body):
    temporary = path.with_name(path.name + ".part")
    path.parent.mkdir(parents=True, exist_ok=True)
    with temporary.open("wb") as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    # Windows directory fsync is not offered by Python. Native durability
    # qualification remains a separate gate; this is process-crash evidence.
    if os.name != "nt":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


@contextmanager
def exclusive(root):
    """One process per rehearsal; OS locks release even after abrupt exit."""
    path = root / "run.lock"
    with path.open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise Refused("rehearsal already running") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def serialized(method):
    @wraps(method)
    def call(self, *args, **kwargs):
        self._guard()
        with exclusive(self.root):
            return method(self, *args, **kwargs)
    return call


class Adapter(Protocol):
    identity: str
    version: int

    def build(self, bundle: dict, staging: Path) -> None: ...
    def read(self, target: Path) -> dict: ...


class EnvelopeAdapter:
    """A lossless test representation, expressly NOT the v3 schema."""
    identity = "synthetic-lossless-envelope"
    version = 1

    def build(self, bundle, staging):
        atomic_write(staging / "envelope.json", encode({"adapter": self.identity,
                     "version": self.version, "bundle": bundle}))

    def read(self, target):
        files = plain_tree(target)
        if set(files) != {"envelope.json"}:
            raise Refused("unexpected candidate files")
        value = decode(files["envelope.json"])
        if (not isinstance(value, dict)
                or set(value) != {"adapter", "version", "bundle"}
                or type(value["version"]) is not int
                or not same_json([value["adapter"], value["version"]],
                                 [self.identity, self.version])):
            raise Refused("candidate adapter/version mismatch")
        return value["bundle"]


class Rehearsal:
    def __init__(self, root, adapter=None, checkpoint=None):
        self.root = Path(root).absolute()
        self.adapter = adapter if adapter is not None else EnvelopeAdapter()
        if (type(self.adapter.identity) is not str or not self.adapter.identity
                or type(self.adapter.version) is not int or self.adapter.version < 1):
            raise Refused("adapter needs a nonempty string identity and positive integer version")
        self.checkpoint = checkpoint or (lambda _: None)
        self._guard()

    def _guard(self):
        files = plain_tree(self.root, skip_contents=("run.lock",))
        if files.get("synthetic.json") != encode(MARKER):
            raise Refused("requires a harness-created synthetic fixture")
        allowed = {"run.lock", "synthetic.json", "source", "backup", "stage", "target", "restored",
                   "plan.json", "plan.json.part", "receipt.json", "receipt.json.part",
                   "rollback.json", "rollback.json.part", "acknowledged-writes.json"}
        if any(path.name not in allowed for path in self.root.iterdir()):
            raise Refused("unknown rehearsal state")

    def _prepare(self, operation_key):
        self._guard()
        if not isinstance(operation_key, str) or not operation_key or len(operation_key) > 256:
            raise Refused("invalid operation key")
        bundle = read_source(self.root / "source")
        files = plain_tree(self.root / "source")
        # The raw bundle and the backup MUST refer to the same snapshot.
        import base64
        if {name: base64.b64decode(body) for name, body in bundle["files"].items()} != files:
            raise Refused("source changed before backup")
        plan = self._make_plan(operation_key, bundle, files)
        path = self.root / "plan.json"
        if path.exists():
            if not same_json(decode(path.read_bytes()), plan):
                raise Refused("operation/source/adapter changed since preparation")
        else:
            if any((self.root / name).exists() for name in ("backup", "stage", "target", "receipt.json", "restored", "rollback.json")):
                raise Refused("migration artifacts without original plan")
            atomic_write(path, encode(plan))
        self.checkpoint("planned")
        return plan, bundle, files

    def _make_plan(self, operation_key, bundle, files):
        return {"harness_version": HARNESS_VERSION, "operation_key": operation_key,
                "adapter": {"id": self.adapter.identity, "version": self.adapter.version},
                "source_manifest": manifest(files), "bundle_sha256": digest(encode(bundle)),
                "inventory": bundle["inventory"], "authority": "none",
                "mapping_status": "preserved_unmapped", "activation_allowed": False}

    def _copy_exact(self, destination, files, event):
        destination.mkdir(exist_ok=True)
        actual = plain_tree(destination)
        # Only a known partial atomic-write filename may be left by a crash.
        if set(actual) - set(files) - {name + ".part" for name in files}:
            raise Refused("unexpected recovery files")
        for name, body in files.items():
            path = destination / name
            if path.exists():
                if path.read_bytes() != body:
                    raise Refused("recovery copy digest mismatch")
            else:
                atomic_write(path, body)
            self.checkpoint(event)
        if manifest(plain_tree(destination)) != manifest(files):
            raise Refused("incomplete recovery copy")

    def _backup(self, plan, files):
        if (self.root / "receipt.json").exists():
            if not (self.root / "backup").is_dir() or not same_json(manifest(plain_tree(self.root / "backup")), plan["source_manifest"]):
                raise Refused("previously verified backup missing or changed")
        self._copy_exact(self.root / "backup", files, "backup-file")
        if not same_json(manifest(plain_tree(self.root / "source")), plan["source_manifest"]):
            raise Refused("source changed while backing up")
        self.checkpoint("backed-up")

    def _verify_target(self, bundle):
        target = self.root / "target"
        actual = self.adapter.read(target)
        if encode(actual) != encode(bundle):
            raise Refused("candidate lost/changed source records or identities")
        return manifest(plain_tree(target))

    def _receipt(self, plan, bundle):
        path = self.root / "receipt.json"
        if not path.exists():
            return None
        value = decode(path.read_bytes())
        prepared = {"format": HARNESS_VERSION, "state": "prepared", "plan": plan,
                    "backup_sha256": digest(encode(plan["source_manifest"]))}
        if same_json(value, prepared):
            return value
        if isinstance(value, dict) and value.get("state") == "complete":
            expected = dict(prepared, state="complete", target_manifest=self._verify_target(bundle))
            if same_json(value, expected):
                return value
        raise Refused("receipt does not match operation/backup/candidate")

    @serialized
    def migrate(self, operation_key="synthetic-import-1"):
        if (self.root / "acknowledged-writes.json").exists():
            raise Refused("activated candidates cannot use this rehearsal")
        if (self.root / "rollback.json").exists():
            raise Refused("rehearsal already restored")
        plan, bundle, files = self._prepare(operation_key)
        self._backup(plan, files)
        receipt = self._receipt(plan, bundle)
        if receipt is not None and receipt["state"] == "complete":
            return receipt
        prepared = {"format": HARNESS_VERSION, "state": "prepared", "plan": plan,
                    "backup_sha256": digest(encode(plan["source_manifest"]))}
        if receipt is None:
            atomic_write(self.root / "receipt.json", encode(prepared))
        self.checkpoint("prepared")
        stage, target = self.root / "stage", self.root / "target"
        if not target.exists():
            stage.mkdir(exist_ok=True)
            # Adapter gets its own value: mutating it cannot weaken the oracle.
            self.adapter.build(decode(encode(bundle)), stage)
            if encode(self.adapter.read(stage)) != encode(bundle):
                raise Refused("candidate lost/changed source records or identities")
            self.checkpoint("staged")
            os.replace(stage, target)
        elif stage.exists():
            raise Refused("both staged and published candidates exist")
        self.checkpoint("published")
        target_manifest = self._verify_target(bundle)
        if not same_json(manifest(plain_tree(self.root / "source")), plan["source_manifest"]) or not same_json(manifest(plain_tree(self.root / "backup")), plan["source_manifest"]):
            raise Refused("source/backup changed before receipt")
        receipt = dict(prepared, state="complete", target_manifest=target_manifest)
        atomic_write(self.root / "receipt.json", encode(receipt))
        self.checkpoint("complete")
        return receipt

    @serialized
    def rollback(self, operation_key="synthetic-import-1", *, acknowledged_writes=False):
        """Reconstruct the pre-activation source into a separate directory.

        An activated target is deliberately not supported. We keep source,
        backup and candidate as evidence; no original data is replaced.
        """
        self._guard()
        if acknowledged_writes or (self.root / "acknowledged-writes.json").exists():
            raise Refused("post-activation rollback needs current acknowledged state/effects")
        if not (self.root / "plan.json").exists():
            raise Refused("no prepared operation to restore")
        plan = decode((self.root / "plan.json").read_bytes())
        if (not isinstance(plan, dict)
                or type(plan.get("harness_version")) is not int
                or not same_json([plan.get("harness_version"), plan.get("operation_key"), plan.get("adapter")],
                                 [HARNESS_VERSION, operation_key, {"id": self.adapter.identity, "version": self.adapter.version}])):
            raise Refused("rollback operation/adapter/version mismatch")
        backup_path = self.root / "backup"
        if not backup_path.is_dir() or not same_json(manifest(plain_tree(backup_path)), plan.get("source_manifest")):
            # Interruption during initial backup: finish from the unchanged
            # original. Once a receipt exists, never repair a damaged backup.
            if (self.root / "receipt.json").exists():
                raise Refused("previously verified backup missing or changed")
            plan, bundle, files = self._prepare(operation_key)
            self._backup(plan, files)
        bundle = read_source(backup_path)
        if not same_json(self._make_plan(operation_key, bundle, plain_tree(backup_path)), plan):
            raise Refused("backup logical digest/plan mismatch")
        self._receipt(plan, bundle)
        if (self.root / "target").exists():
            self._verify_target(bundle)
        backup = plain_tree(self.root / "backup")
        self._copy_exact(self.root / "restored", backup, "restore-file")
        if encode(read_source(self.root / "restored")) != encode(bundle):
            raise Refused("restored legacy state is not readable/equivalent")
        receipt = {"format": HARNESS_VERSION, "state": "restored", "authority": "none",
                   "operation_key": operation_key, "source_manifest": plan["source_manifest"],
                   "restored_manifest": manifest(plain_tree(self.root / "restored")),
                   "bundle_sha256": plan["bundle_sha256"], "post_activation": False}
        path = self.root / "rollback.json"
        if path.exists():
            if not same_json(decode(path.read_bytes()), receipt):
                raise Refused("rollback receipt mismatch")
        else:
            atomic_write(path, encode(receipt))
        self.checkpoint("restored")
        return receipt
