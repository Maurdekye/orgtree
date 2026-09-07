"""Atomic machine repository registry, independent of SQLite/JSON org storage."""
from __future__ import annotations

from copy import deepcopy
import json
import os
import tempfile
import threading
from typing import Any, Callable

from . import store

LOCK = threading.RLock()


class SettingsError(ValueError):
    pass


def path() -> str:
    return os.path.join(store.DATA_ROOT, "git-workspace.json")


def load() -> dict[str, Any]:
    with LOCK:
        try:
            with open(path(), encoding="utf-8") as f:
                doc = json.load(f)
        except FileNotFoundError:
            return {"version": 1, "revision": 0, "repositories": {}, "links": [], "selected_by_org": {}}
        except (OSError, ValueError) as e:
            raise SettingsError("Git repository settings could not be read; refusing to replace them") from e
        if (not isinstance(doc, dict) or doc.get("version") != 1
                or not isinstance(doc.get("revision"), int)
                or not isinstance(doc.get("repositories"), dict)
                or not isinstance(doc.get("links"), list)
                or not isinstance(doc.get("selected_by_org"), dict)):
            raise SettingsError("Git repository settings have an unsupported or invalid format")
        for key, repo in doc["repositories"].items():
            if (not isinstance(repo, dict) or repo.get("id") != key
                    or any(not isinstance(repo.get(k), str) for k in ("root", "common", "name"))
                    or not isinstance(repo.get("identity"), list) or len(repo["identity"]) != 2
                    or any(not isinstance(n, int) for n in repo["identity"])
                    or not isinstance(repo.get("orgs"), list) or any(not isinstance(s, str) for s in repo["orgs"])
                    or not isinstance(repo.get("auto_fetch"), bool) or not isinstance(repo.get("bare"), bool)
                    or any(repo.get(k) is not None and not isinstance(repo[k], str) for k in ("remote", "trunk"))
                    or not isinstance(repo.get("observations"), dict)
                    or any(not isinstance(o, dict) for o in repo["observations"].values())):
                raise SettingsError("Git repository record is invalid; refusing to replace settings")
        if any(not isinstance(link, dict) or any(not isinstance(link.get(k), str)
               for k in ("repository_id", "branch_ref", "org_slug", "item_slug")) for link in doc["links"]):
            raise SettingsError("Git ticket links are invalid; refusing to replace settings")
        return doc


def change(fn: Callable[[dict[str, Any]], Any], *, revision: int | None = None) -> Any:
    with LOCK:
        doc = load()
        if revision is not None and doc["revision"] != revision:
            raise SettingsError("Git settings changed; refresh before saving")
        result = fn(doc)
        doc["revision"] += 1
        directory = os.path.dirname(path())
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".git-settings-", suffix=".tmp", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                json.dump(doc, f, ensure_ascii=True, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path())
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return deepcopy(result)
