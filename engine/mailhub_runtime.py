"""Bundled mail-hub hosting — the pinned orgtree-mailhub submodule, run as
the standalone product.

The hub implementation is NOT here: it lives in the `engine/mailhub`
submodule (the authoritative orgtree-mailhub repository) and this adapter
only owns what the ticket allows Orgtree to own — desktop-engine lifecycle,
settings storage, and migration of the superseded V2 hub's data. The child
process is the exact entrypoint the Docker image runs (`python -m
mailhub.serve`), configured through the same environment variables an
operator would use, so the integrated hub and the standalone hub are one
implementation with two launchers.

Storage layout under the V2 data root:
  mailhub-hosting.json   this adapter's settings (config, not hub data)
  mailhub/               HUB_DATA of the integrated hub (hub.sqlite3, blobs/)
  mailhub/hub.log        child stdout/stderr, rotated at engine start
  hub/                   the SUPERSEDED V2 hub's store — never written again,
                         read once as migration input, kept as the rollback
                         boundary

Retention default (user ruling 2026-09-15): the integrated hub keeps
history effectively forever (retention_days=None → HUB_RETENTION_DAYS=36500)
while standalone Docker deployments keep the hub's own 30-day default.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SUBMODULE = Path(__file__).resolve().parent / "mailhub"
PUBLIC_LISTENER_PORT = 7371          # fixed by mailhub.serve (FR-10)
_KEEP_FOREVER_DAYS = 36500           # "keep forever", expressed as config
_LOG_ROTATE_BYTES = 5 * 1024 * 1024


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds") \
        .replace("+00:00", "Z")


def validate_config(raw: Any) -> dict[str, Any]:
    """The hosting settings, on the V1 hub's own configuration model:
    port / bind / name / retention — nothing engine-flavored leaks in."""
    if not isinstance(raw, dict):
        raise ValueError("hub hosting configuration must be an object")
    version = raw.get("version", 2)
    if version != 2:
        raise ValueError("unsupported hub hosting configuration version")
    port = raw.get("port", 7370)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("port must be an integer between 1 and 65535")
    bind = str(raw.get("bind", "127.0.0.1"))
    if bind not in ("127.0.0.1", "0.0.0.0"):
        raise ValueError("bind must be 127.0.0.1 or 0.0.0.0")
    name = str(raw.get("name") or "").strip()
    if any(c in name for c in "\r\n\x00"):
        raise ValueError("name must be a single line")
    retention = raw.get("retention_days", None)
    if retention is not None and (type(retention) is not int
                                  or not 1 <= retention <= _KEEP_FOREVER_DAYS):
        raise ValueError("retention_days must be null (keep forever) or an "
                         "integer number of days")
    org_retention = raw.get("org_retention_days", 45)
    if type(org_retention) is not int or not 1 <= org_retention <= 3650:
        raise ValueError("org_retention_days must be an integer number of "
                         "days")
    public_listener = raw.get("public_listener", False)
    if type(public_listener) is not bool:
        raise ValueError("public_listener must be a boolean")
    config: dict[str, Any] = {
        "version": 2, "port": port, "bind": bind, "name": name,
        "retention_days": retention, "org_retention_days": org_retention,
        "public_listener": public_listener,
    }
    if isinstance(raw.get("migrated"), dict):
        config["migrated"] = raw["migrated"]
    return config


def _config_from_v2(legacy: dict[str, Any]) -> dict[str, Any]:
    """Map the superseded desktop-hub.json onto the V1 model. Only settings
    with a clean equivalent are carried; everything else is REFUSED into a
    safe default and named in the migration notes rather than guessed at
    (spec: no lossy mapping). The legacy file itself is never touched."""
    notes: list[str] = []
    raw_port = legacy.get("port")
    port = raw_port if type(raw_port) is int and 1 <= raw_port <= 65535 \
        else 7370
    if port != raw_port:
        notes.append(
            "the previous dynamic/invalid port setting has no fixed-port "
            "equivalent; the hub now uses the standard port 7370")
    bind = "127.0.0.1"
    if legacy.get("enabled") and legacy.get("bind_host") == "0.0.0.0":
        if legacy.get("tls_certfile") or legacy.get("tls_keyfile"):
            notes.append(
                "the previous hub exposed itself to the network with TLS; "
                "this hub does not terminate TLS (put a reverse proxy in "
                "front if you need it), so network exposure was NOT carried "
                "over — hosting was reset to this computer only. Re-enable "
                "network exposure deliberately in the hub settings")
        else:
            bind = "0.0.0.0"
            notes.append("network exposure carried over (no TLS was "
                         "configured); note the hub's operator page shows "
                         "all mail unauthenticated — see the hosting "
                         "settings")
    adv = str(legacy.get("advertise_host") or "").strip()
    if adv and adv != "127.0.0.1":
        notes.append(f"the previous 'advertised host' ({adv}) has no "
                     f"equivalent here: peers connect to the address they "
                     f"were given; share your reachable address with them "
                     f"directly")
    return validate_config({
        "version": 2, "port": port, "bind": bind, "name": "",
        "retention_days": None,          # user ruling: keep-forever default
        "org_retention_days": 45, "public_listener": False,
        "migrated": {"from": "desktop-hub.json", "at": _now(),
                     "notes": notes},
    })


class MailhubRuntime:
    """Owns the child hub process and its settings. The contract the
    desktop routes rely on: .start(), .stop(), .status(), .configure()."""

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root).resolve(strict=True)
        self.path = self.root / "mailhub-hosting.json"
        self.data_dir = self.root / "mailhub"
        legacy_path = self.root / "desktop-hub.json"
        if self.path.exists():
            self.config = validate_config(json.loads(
                self.path.read_text(encoding="utf-8")))
        elif legacy_path.exists():
            try:
                legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
            except ValueError:
                legacy = {}
            self.config = _config_from_v2(
                legacy if isinstance(legacy, dict) else {})
            self._save(self.config)
        else:
            self.config = validate_config({"retention_days": None})
            self._save(self.config)
        self._child: subprocess.Popen[bytes] | None = None
        self._log_handle: Any = None
        self.last_error: str | None = None

    # ── settings storage ──────────────────────────────────────────────
    def _save(self, config: dict[str, Any]) -> None:
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(config, indent=1) + "\n",
                             encoding="utf-8")
        os.replace(temporary, self.path)

    # ── data migration (V2 store → the hub's own store) ───────────────
    def _migrate_store(self) -> None:
        """One-time, transactional, idempotent copy of the superseded V2
        hub's messages and attachments into a fresh store created by the
        hub's OWN schema code. The V2 store is opened read-only and never
        modified — it is the rollback boundary. Roster rows are NOT copied:
        the V2 hub stored no fingerprints (address-only trust), so its rows
        are unclaimable under owned-address auth; every local org
        re-registers itself with its existing secret and keeps its address,
        and queued mail for a slug delivers as soon as that slug
        re-registers."""
        source = self.root / "hub" / "hub.sqlite3"
        dest_db = self.data_dir / "hub.sqlite3"
        if not source.exists():
            return
        if dest_db.exists():
            with sqlite3.connect(dest_db, timeout=10.0) as check:
                done = check.execute(
                    "SELECT v FROM meta WHERE k='migrated_from_v2'"
                ).fetchone()
            if done:
                return
        self.data_dir.mkdir(parents=True, exist_ok=True)
        # the hub's own code creates the schema — no second copy of the DDL
        creation = subprocess.run(
            [sys.executable, "-c",
             "import mailhub.db as d; d.connect().close()"],
            env={**os.environ, "HUB_DATA": str(self.data_dir),
                 "PYTHONPATH": str(SUBMODULE)},
            capture_output=True, text=True, timeout=120,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if creation.returncode != 0:
            raise RuntimeError("could not initialize the hub store: "
                               + creation.stderr[-500:])
        src = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True,
                              timeout=10.0)
        src.row_factory = sqlite3.Row
        dst = sqlite3.connect(dest_db, timeout=30.0)
        try:
            messages = src.execute("SELECT * FROM messages").fetchall()
            attachments = src.execute("SELECT * FROM attachments").fetchall()
            owned = src.execute(
                "SELECT * FROM orgs WHERE fingerprint != ''").fetchall()
            skipped = [str(r["slug"]) for r in src.execute(
                "SELECT slug FROM orgs WHERE fingerprint = ''").fetchall()]
            dst.execute("BEGIN IMMEDIATE")
            for m in messages:
                dst.execute(
                    "INSERT OR IGNORE INTO messages (id, from_slug, to_slug,"
                    " body, kind, thread_id, sent_at, received_at, state,"
                    " fetched_at, delivered_at, read_at, receipts_pushed,"
                    " attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (m["id"], m["from_slug"], m["to_slug"], m["body"],
                     m["kind"], m["thread_id"], m["sent_at"],
                     m["received_at"], m["state"], m["fetched_at"],
                     m["delivered_at"], m["read_at"], m["receipts_pushed"],
                     m["attachments"]))
            for a in attachments:
                dst.execute(
                    "INSERT OR IGNORE INTO attachments (id, owner_slug, "
                    "name, bytes, created_at, message_id) "
                    "VALUES (?,?,?,?,?,?)",
                    (a["id"], a["owner_slug"], a["name"], a["bytes"],
                     a["created_at"], a["message_id"]))
            for o in owned:
                dst.execute(
                    "INSERT OR IGNORE INTO orgs (slug, fingerprint, "
                    "org_name, username, blurb, registered_at, last_seen, "
                    "kind) VALUES (?,?,?,?,?,?,?,'org')",
                    (o["slug"], o["fingerprint"], o["org_name"],
                     o["username"], o["blurb"], o["registered_at"],
                     o["last_seen"]))
            got_m = dst.execute(
                "SELECT COUNT(*) FROM messages").fetchone()[0]
            got_a = dst.execute(
                "SELECT COUNT(*) FROM attachments").fetchone()[0]
            if got_m < len(messages) or got_a < len(attachments):
                raise RuntimeError(
                    f"migration validation failed: copied {got_m}/"
                    f"{len(messages)} messages, {got_a}/{len(attachments)} "
                    f"attachments — nothing was changed at the source; the "
                    f"partial destination will be rebuilt on the next start")
            report = {
                "from": str(source), "at": _now(),
                "messages": len(messages), "attachments": len(attachments),
                "orgs_copied": len(owned), "orgs_skipped": skipped,
                "note": "roster rows without fingerprints are not "
                        "claimable under owned-address auth; clients "
                        "re-register with their own secrets and keep "
                        "their addresses",
            }
            dst.execute("INSERT OR REPLACE INTO meta (k, v) VALUES "
                        "('migrated_from_v2', ?)", (json.dumps(report),))
            dst.commit()
        except BaseException:
            dst.rollback()
            dst.close()
            src.close()
            try:                       # a half store must not serve
                dest_db.unlink()
            except OSError:
                pass
            raise
        else:
            dst.close()
            src.close()
        # blobs: whatever the V2 hub still holds (it deleted blobs at
        # custody ACK, so only unfetched attachments remain). A missing
        # blob is the hub's own well-defined 410 case.
        src_blobs = self.root / "hub" / "blobs"
        dst_blobs = self.data_dir / "blobs"
        dst_blobs.mkdir(parents=True, exist_ok=True)
        if src_blobs.is_dir():
            for blob in src_blobs.iterdir():
                if blob.is_file() and not (dst_blobs / blob.name).exists():
                    shutil.copyfile(blob, dst_blobs / blob.name)
        (self.data_dir / "migration-report.json").write_text(
            json.dumps(report, indent=1) + "\n", encoding="utf-8")

    # ── child lifecycle ───────────────────────────────────────────────
    def _address(self) -> str:
        return f"http://127.0.0.1:{self.config['port']}"

    def _healthz(self, timeout: float = 3.0) -> dict[str, Any] | None:
        try:
            with urllib.request.urlopen(self._address() + "/healthz",
                                        timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8") or "{}")
                return data if isinstance(data, dict) else None
        except (urllib.error.URLError, OSError, ValueError):
            return None

    def _reclaim_orphan(self) -> None:
        """A previous engine that died hard leaves the child holding the
        port. The pid file names OUR child; anything else on the port is
        not ours to kill and start() will fail loudly instead."""
        pid_path = self.data_dir / "hub.pid"
        try:
            pid = int(pid_path.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            return
        if pid <= 0 or pid == os.getpid():
            return
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                               capture_output=True, timeout=15,
                               creationflags=getattr(
                                   subprocess, "CREATE_NO_WINDOW", 0))
            else:
                os.kill(pid, 15)
        except OSError:
            pass
        try:
            pid_path.unlink()
        except OSError:
            pass

    def _open_log(self) -> Any:
        log = self.data_dir / "hub.log"
        try:
            if log.exists() and log.stat().st_size > _LOG_ROTATE_BYTES:
                os.replace(log, log.with_suffix(".log.1"))
        except OSError:
            pass
        return open(log, "ab")

    def start(self) -> dict[str, Any]:
        if self._child is not None and self._child.poll() is None:
            return self.status()
        self.last_error = None
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self._migrate_store()
        except Exception as exc:                                 # noqa: BLE001
            # the hub must not serve a half-migrated store; the engine
            # still boots and the hosting surface shows exactly why
            self.last_error = f"data migration failed: {exc}"
            return self.status()
        self._reclaim_orphan()
        retention = self.config["retention_days"] or _KEEP_FOREVER_DAYS
        env = {**os.environ,
               "HUB_DATA": str(self.data_dir),
               "HUB_PORT": str(self.config["port"]),
               "HUB_BIND": self.config["bind"],
               "HUB_NAME": self.config["name"],
               "HUB_RETENTION_DAYS": str(retention),
               "HUB_ORG_RETENTION_DAYS":
                   str(self.config["org_retention_days"]),
               "PYTHONPATH": str(SUBMODULE) + (
                   os.pathsep + os.environ["PYTHONPATH"]
                   if os.environ.get("PYTHONPATH") else "")}
        if self.config["public_listener"]:
            env["HUB_PUBLIC"] = "1"
        else:
            env.pop("HUB_PUBLIC", None)
        self._log_handle = self._open_log()
        try:
            self._child = subprocess.Popen(
                [sys.executable, "-m", "mailhub.serve"],
                cwd=str(SUBMODULE), env=env,
                stdout=self._log_handle, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as exc:
            self.last_error = f"could not start the hub process: {exc}"
            return self.status()
        (self.data_dir / "hub.pid").write_text(str(self._child.pid),
                                               encoding="utf-8")
        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            if self._child.poll() is not None:
                self.last_error = (
                    f"the hub process exited at startup (code "
                    f"{self._child.returncode}) — see mailhub/hub.log; "
                    f"another service may already hold port "
                    f"{self.config['port']}")
                self._child = None
                return self.status()
            if self._healthz(timeout=1.0):
                break
            time.sleep(0.25)
        else:
            self.last_error = ("the hub did not answer /healthz within 20s "
                               "— see mailhub/hub.log")
        # the org-side client's local-hub seam: where the bundled hub lives
        os.environ["ORGTREE_LOCAL_HUB_ADDRESS"] = self._address()
        return self.status()

    def stop(self) -> None:
        child, self._child = self._child, None
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None
        try:
            (self.data_dir / "hub.pid").unlink()
        except OSError:
            pass

    # ── the surface the desktop routes serve ──────────────────────────
    def status(self) -> dict[str, Any]:
        health = self._healthz(timeout=2.0) \
            if self._child is not None and self._child.poll() is None \
            else None
        running = self._child is not None and self._child.poll() is None
        out: dict[str, Any] = {
            "version": 2,
            "port": self.config["port"],
            "bind": self.config["bind"],
            "name": self.config["name"],
            "retention_days": self.config["retention_days"],
            "org_retention_days": self.config["org_retention_days"],
            "public_listener": self.config["public_listener"],
            "public_listener_port": PUBLIC_LISTENER_PORT,
            "status": {
                "running": running,
                "healthy": bool(health),
                "address": self._address(),
                "exposed": self.config["bind"] == "0.0.0.0",
                "hub_name": (health or {}).get("name"),
                "orgs": (health or {}).get("orgs"),
                "queued": (health or {}).get("queued"),
            },
        }
        if self.last_error:
            out["error"] = self.last_error
        if isinstance(self.config.get("migrated"), dict):
            out["migrated"] = self.config["migrated"]
        report = self.data_dir / "migration-report.json"
        if report.exists():
            try:
                out["data_migration"] = json.loads(
                    report.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        return out

    def configure(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("hub hosting configuration must be an object")
        merged = {**self.config, **raw}
        merged.pop("status", None)
        merged.pop("error", None)
        merged.pop("data_migration", None)
        merged.pop("public_listener_port", None)
        config = validate_config(merged)
        previous = self.config
        self.stop()
        try:
            self.config = config
            self._save(config)
            self.start()
            if self.last_error:
                raise RuntimeError(self.last_error)
        except Exception:
            self.stop()
            self.config = previous
            self._save(previous)
            self.start()
            raise
        return self.status()
