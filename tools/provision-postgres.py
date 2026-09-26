"""Assemble the Windows PostgreSQL payload at build time; never start a cluster.

Downloads the pinned vendor archive (or accepts --archive for an offline cache),
extracts only bin/lib/share and redistribution notices, and builds the custodian
from this checkout with Cargo.lock and no qualification feature. No installer,
Windows service, registry or application data is accessed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / "tools/postgres-runtime-pin.json").read_text(encoding="utf-8"))
NOTICES = {"server_license.txt", "commandlinetools_3rd_party_licenses.txt"}
TOOLS = ("postgres.exe", "pg_ctl.exe", "initdb.exe", "psql.exe", "pg_controldata.exe")


def sha256(file: Path) -> str:
    with file.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def regular(path: Path) -> None:
    if not path.is_file() or path.is_symlink() or path.resolve() != path.absolute():
        raise ValueError(f"Expected regular file without links: {path}")


def selected_member(name: str) -> str | None:
    # Validate BEFORE selecting: no drive, UNC, backslash, traversal or ADS.
    parts = PurePosixPath(name).parts
    if "\\" in name or ":" in name or name.startswith("/") or ".." in parts:
        raise ValueError(f"Unsafe archive member: {name}")
    if len(parts) < 2 or parts[0] != "pgsql":
        return None
    relative = "/".join(parts[1:])
    if parts[1] in ("bin", "lib", "share") or relative in NOTICES:
        return relative
    return None


def extract_runtime(archive: Path, destination: Path) -> None:
    seen: set[str] = set()
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            relative = selected_member(entry.filename)
            if relative is None or entry.is_dir():
                continue
            if relative.casefold() in seen or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"Duplicate or linked archive member: {entry.filename}")
            seen.add(relative.casefold())
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as src, target.open("xb") as dst:
                shutil.copyfileobj(src, dst)
    for relative in [*(f"bin/{tool}" for tool in TOOLS), *NOTICES,
                     "share/postgres.bki"]:
        regular(destination / relative)
    if not (destination / "lib").is_dir():
        raise ValueError("PostgreSQL lib directory missing")


def files(directory: Path) -> dict[str, dict[str, object]]:
    result = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or path.resolve() != path.absolute():
            raise ValueError(f"Linked payload entry: {path}")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = {
                "bytes": path.stat().st_size, "sha256": sha256(path)}
    return result


def native_sources(root: Path) -> dict[str, str]:
    names = subprocess.check_output(["git", "ls-files", "--", "engine/native"],
                                    cwd=root, text=True).splitlines()
    return {name: sha256(root / name) for name in names}


def assemble(archive: Path) -> dict[str, object]:
    regular(archive)
    if archive.stat().st_size != PIN["bytes"] or sha256(archive) != PIN["sha256"]:
        raise ValueError("PostgreSQL archive size/SHA-256 differs from the pin")
    engine = ROOT / "engine"
    if engine.resolve() != engine.absolute():
        raise ValueError("Engine directory cannot be behind a link")
    artifacts = ROOT / "artifacts" / "postgres-provision"
    artifacts.mkdir(parents=True, exist_ok=True)
    before = native_sources(ROOT)
    build = artifacts / "cargo"
    subprocess.run(["cargo", "build", "--release", "--locked", "--no-default-features",
                    "--manifest-path", str(engine / "native/pg-custodian/Cargo.toml"),
                    "--target-dir", str(build)], cwd=ROOT, check=True)
    if native_sources(ROOT) != before:
        raise ValueError("Custodian sources changed during compilation")
    custodian = build / "release/pg-custodian.exe"
    regular(custodian)
    with tempfile.TemporaryDirectory(prefix="payload-", dir=artifacts) as temp:
        stage = Path(temp) / "postgresql"
        stage.mkdir()
        extract_runtime(archive, stage)
        pg_files = files(stage)
        destination = engine / "postgresql"
        if destination.exists():
            # Never silently repair or merge a contaminated payload.
            if files(destination) != pg_files:
                raise ValueError(f"Existing payload differs; remove explicitly before reprovisioning: {destination}")
        else:
            stage.rename(destination)
        output = engine / "pg-custodian.exe"
        if output.exists():
            regular(output)
        shutil.copyfile(custodian, engine / "pg-custodian.exe.tmp")
        os.replace(engine / "pg-custodian.exe.tmp", output)
    manifest = {"schema": "orgtree.postgres-runtime/v1", "archive": PIN,
                "custodian": {"features": [], "sources": before},
                "files": {**{f"postgresql/{name}": value for name, value in pg_files.items()},
                          "pg-custodian.exe": {"bytes": output.stat().st_size, "sha256": sha256(output)}}}
    target = engine / "postgres-runtime-manifest.json"
    target.with_suffix(".json.tmp").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(target.with_suffix(".json.tmp"), target)
    return {"files": len(manifest["files"]),
            "bytes": sum(entry["bytes"] for entry in manifest["files"].values()),
            "manifest": str(target)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Existing pinned vendor ZIP; otherwise download at build time")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Windows x64 build host required")
    archive = args.archive
    if archive is None:
        cache = ROOT / ".runtime-cache"
        cache.mkdir(exist_ok=True)
        archive = cache / f"postgresql-{PIN['version']}-windows-x64-binaries.zip"
        if not archive.exists():
            part = archive.with_suffix(".zip.part")
            with urllib.request.urlopen(PIN["url"], timeout=60) as source, part.open("wb") as target:
                shutil.copyfileobj(source, target)
            if part.stat().st_size != PIN["bytes"] or sha256(part) != PIN["sha256"]:
                raise ValueError("Downloaded PostgreSQL archive does not match pin")
            os.replace(part, archive)
    print(json.dumps(assemble(archive.resolve()), indent=2))


if __name__ == "__main__":
    main()
