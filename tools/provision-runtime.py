"""Build-time only: provision an app-local Windows Python directory, never a harness.

The official embedded runtime carries its own interpreter/stdlib/DLLs/licenses.
Backend dependencies are installed into this directory only. No v1 imports/data.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

VERSION = "3.13.15"
URL = f"https://www.python.org/ftp/python/{VERSION}/python-{VERSION}-embed-amd64.zip"
SHA256 = "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf"
ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "engine" / "runtime"
CACHE = ROOT / ".runtime-cache"

def main():
    if sys.platform == "darwin":
        return main_macos()
    if sys.platform != "win32":
        raise SystemExit("Windows runtime provisioning requires a Windows build host")
    CACHE.mkdir(exist_ok=True)
    archive = CACHE / f"python-{VERSION}-embed-amd64.zip"
    if not archive.exists():
        with urllib.request.urlopen(URL, timeout=60) as response:
            archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise SystemExit("Official Python archive checksum mismatch")
    if RUNTIME.is_symlink() or (RUNTIME.exists() and RUNTIME.resolve() != RUNTIME):
        raise SystemExit("Runtime output must not be a link")
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            # Official embedded zip has only top-level files. Refuse traversal.
            if Path(entry.filename).name != entry.filename or ":" in entry.filename:
                raise SystemExit("Unexpected archive layout")
        source.extractall(RUNTIME)
    (RUNTIME / "python313._pth").write_bytes(b"python313.zip\r\n.\r\nLib/site-packages\r\n../backend\r\n../mailhub\r\n../../\r\nimport site\r\n")
    target = RUNTIME / "Lib" / "site-packages"
    report = CACHE / "dependencies.json"
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
        "--platform", "win_amd64", "--python-version", "3.13", "--implementation", "cp", "--abi", "cp313",
        "--target", str(target), "--upgrade", "--no-warn-conflicts", "--report", str(report), "-r", str(ROOT / "tools" / "runtime-requirements.in")], check=True)
    metadata = {"python": VERSION, "url": URL, "sha256": SHA256,
        "dependencies": [{"name": r["metadata"]["name"], "version": r["metadata"]["version"], "download": r["download_info"]}
            for r in json.loads(report.read_text(encoding="utf-8"))["install"]]}
    (RUNTIME / "runtime-manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    # This imports dependencies only, never the engine/store.
    subprocess.run([str(RUNTIME / "python.exe"), "-c", "import sys,sqlite3,ssl,fastapi,uvicorn,websockets,httpx,PIL,psutil; import pathlib,importlib.util; assert pathlib.Path(sys.executable).resolve().parents[2] in map(pathlib.Path, sys.path), sys.path; assert importlib.util.find_spec('engine') is not None; assert importlib.util.find_spec('mailhub') is not None, 'engine/mailhub submodule not checked out'; print(sys.version); print(sys.executable)"], check=True)
    print("App-local runtime ready:", RUNTIME)

DARWIN_RELEASE_TAG = "20260901"
DARWIN_PIP_PLATFORM = {"aarch64": "macosx_11_0_arm64", "x86_64": "macosx_11_0_x86_64"}


def _darwin_arch():
    """Resolve the target macOS arch: ORGTREE_RUNTIME_ARCH env var, else the host's own arch via platform.machine()."""
    arch = os.environ.get("ORGTREE_RUNTIME_ARCH")
    if not arch:
        machine = platform.machine()
        arch = "aarch64" if machine == "arm64" else machine
    if arch not in DARWIN_PIP_PLATFORM:
        raise SystemExit(f"Unsupported macOS arch {arch!r} (expected aarch64 or x86_64)")
    return arch


def _darwin_verified_download(asset):
    """Download `asset` from the pinned python-build-standalone release into .runtime-cache/,
    verifying it against astral-sh's own published SHA256SUMS for that release (never a hardcoded hash)."""
    base = f"https://github.com/astral-sh/python-build-standalone/releases/download/{DARWIN_RELEASE_TAG}"
    archive = CACHE / asset
    if not archive.exists():
        with urllib.request.urlopen(f"{base}/{asset}", timeout=60) as response:
            archive.write_bytes(response.read())
    with urllib.request.urlopen(f"{base}/SHA256SUMS", timeout=60) as response:
        checksums = response.read().decode("ascii")
    published = None
    for line in checksums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == asset:
            published = parts[0].lower()
            break
    if not published:
        raise SystemExit(f"astral-sh SHA256SUMS does not list {asset}")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != published:
        raise SystemExit("python-build-standalone archive checksum mismatch")
    return archive, f"{base}/{asset}"


def main_macos():
    CACHE.mkdir(exist_ok=True)
    arch = _darwin_arch()
    asset = f"cpython-{VERSION}+{DARWIN_RELEASE_TAG}-{arch}-apple-darwin-install_only.tar.gz"
    archive, url = _darwin_verified_download(asset)
    if RUNTIME.is_symlink() or (RUNTIME.exists() and RUNTIME.resolve() != RUNTIME):
        raise SystemExit("Runtime output must not be a link")
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        members = []
        for member in source.getmembers():
            normalized = PurePosixPath(member.name)
            if normalized.is_absolute() or ".." in normalized.parts:
                raise SystemExit("Unexpected archive layout")
            if member.name == "python":
                continue
            if not member.name.startswith("python/"):
                raise SystemExit("Unexpected archive layout")
            member.name = member.name[len("python/"):]
            members.append(member)
        source.extractall(RUNTIME, members=members)
    site_packages = RUNTIME / "lib" / "python3.13" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)
    (site_packages / "orgtree.pth").write_text("../../../../backend\n../../../../mailhub\n../../../../../\n", encoding="utf-8")
    report = CACHE / "dependencies-darwin.json"
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
        "--platform", DARWIN_PIP_PLATFORM[arch], "--python-version", "3.13", "--implementation", "cp", "--abi", "cp313",
        "--target", str(site_packages), "--upgrade", "--no-warn-conflicts", "--report", str(report), "-r", str(ROOT / "tools" / "runtime-requirements.in")], check=True)
    metadata = {"python": VERSION, "url": url, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "dependencies": [{"name": r["metadata"]["name"], "version": r["metadata"]["version"], "download": r["download_info"]}
            for r in json.loads(report.read_text(encoding="utf-8"))["install"]]}
    (RUNTIME / "runtime-manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    # This imports dependencies only, never the engine/store.
    subprocess.run([str(RUNTIME / "bin" / "python3.13"), "-c", "import sys,sqlite3,ssl,fastapi,uvicorn,websockets,httpx,PIL,psutil; import importlib.util; assert importlib.util.find_spec('engine') is not None; assert importlib.util.find_spec('mailhub') is not None, 'engine/mailhub submodule not checked out'; print(sys.version); print(sys.executable)"], check=True)
    print("App-local runtime ready:", RUNTIME)

if __name__ == "__main__":
    main()
