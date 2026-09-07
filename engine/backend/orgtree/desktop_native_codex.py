"""Fork a private Codex rollout without a model turn or signed-in profile.

The native app-server owns the fork format. Its temporary home is empty,
authentication environment is blank, and its only provider points at closed
loopback. Only initialize + thread/fork are sent; never compact/start or a turn.
The resulting rollout is copied into V2 and later resumed by explicit path
using the application's existing configured connection.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

from .desktop_native import NativeHeld, UUID


def validate(records: list[dict], sid: str) -> str:
    first = records[0] if records else {}
    meta = first.get("payload") or {}
    if (first.get("type") != "session_meta" or not isinstance(meta, dict)
            or (meta.get("session_id") or meta.get("id")) != sid):
        raise NativeHeld("Rollout is not the selected Codex native session")
    if not any(r.get("type") == "response_item" for r in records):
        raise NativeHeld("Codex rollout has no native conversation context")
    provider = meta.get("model_provider") or "openai"
    if not isinstance(provider, str) or not provider.strip():
        raise NativeHeld("Codex native model provider is invalid")
    def check(value: Any):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"image_url", "file_url"} and isinstance(child, str) and child.startswith("file:"):
                    raise NativeHeld("Codex native context references an uncopied local attachment")
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)
    check(records)
    return provider


def fork_snapshot(records: list[dict], sid: str, folder: Path, destination_cwd: str,
                  *, argv_head: list[str] | None = None, client_factory=None) -> tuple[str, bytes]:
    from . import codexrun, providers
    from .desktop_import import _plain
    from .desktop_native import _read_native
    provider = validate(records, sid)
    if argv_head is None:
        # Path detection only: codex_status also probes authentication, which
        # this local file operation must never do.
        exe, _ = providers.codex_path()
        if not exe:
            raise NativeHeld("Codex is not installed; native fork remains held")
        argv_head = providers.codex_argv(exe)
    profile = folder / "fork-profile"
    _plain(profile)
    profile.mkdir()
    working = profile / "working"
    working.mkdir()
    # The native loader sees only this private snapshot, never a source file.
    staged = profile / "input.jsonl"
    prepared = copy.deepcopy(records)
    for row in prepared:
        if row.get("type") in {"session_meta", "turn_context"} and isinstance(row.get("payload"), dict):
            row["payload"]["cwd"] = str(working)
    staged.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in prepared), encoding="utf-8")
    allow = {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMSPEC", "PROCESSOR_ARCHITECTURE"}
    env = {key: "" for key in os.environ if key.upper() not in allow}
    env.update({key: str(profile) for key in ("HOME", "USERPROFILE", "CODEX_HOME", "ORGTREE_DATA")})
    local_config = [
        '-c', 'model_provider="import-local"', '-c', 'model="import-local"',
        '-c', 'model_providers.import-local.name="Offline import"',
        '-c', 'model_providers.import-local.base_url="http://127.0.0.1:9/v1"',
        '-c', 'model_providers.import-local.wire_api="responses"',
        '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
        '-c', 'feedback.enabled=false',
    ]
    client = (client_factory or codexrun.AppServerClient)(
        argv_head, codex_home=str(profile), cwd=str(working),
        env_extra=env, config_overrides=local_config)
    try:
        client.initialize(timeout=10)
        result = client.request("thread/fork", {
            "threadId": sid, "path": str(staged), "cwd": str(working),
            "model": "import-local", "modelProvider": "import-local",
            "deferGoalContinuation": True, "excludeTurns": True,
        }, timeout=20)
        thread = result.get("thread") if isinstance(result, dict) else None
        if not isinstance(thread, dict):
            raise NativeHeld("Native fork did not return a thread record")
        new_sid = thread.get("id")
        if not isinstance(new_sid, str) or not UUID.fullmatch(new_sid) or new_sid == sid:
            raise NativeHeld("Native fork did not return an independent Codex session ID")
        output = Path(thread.get("path") or "")
        _plain(output)
        if not output.is_absolute() or not output.resolve().is_relative_to(profile.resolve()):
            raise NativeHeld("Native fork returned a path outside its private profile")
        if any(row.get("method") in {"turn/started", "turn/completed"} for row in client.notifications):
            raise NativeHeld("Native fork unexpectedly started a turn; copy remains held")
    except codexrun.CodexServerError as exc:
        raise NativeHeld(f"Local Codex native fork failed ({type(exc).__name__}); no resumption was admitted") from exc
    finally:
        client.close()
    # Closing the local loader flushes/releases its writer before byte capture.
    rows, _ = _read_native(output)
    validate(rows, new_sid)
    for row in rows:
        if row.get("type") in {"session_meta", "turn_context"} and isinstance(row.get("payload"), dict):
            payload = row["payload"]
            payload["cwd"] = destination_cwd
            if row["type"] == "session_meta":
                payload["model_provider"] = provider
    # The offline model/provider is only the local loader's configuration. The
    # durable native context retains its source provider; the normal resumed
    # turn applies the application's current model/instructions/permissions.
    return new_sid, "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows).encode("utf-8")
