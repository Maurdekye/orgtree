"""Build-time only: provision an app-local Windows Python directory, never a harness.

The official embedded runtime carries its own interpreter/stdlib/DLLs/licenses.
Backend dependencies are installed into this directory only. No v1 imports/data.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

VERSION = "3.13.15"
URL = f"https://www.python.org/ftp/python/{VERSION}/python-{VERSION}-embed-amd64.zip"
SHA256 = "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf"
ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "engine" / "runtime"
CACHE = ROOT / ".runtime-cache"

def main():
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
    (RUNTIME / "python313._pth").write_bytes(b"python313.zip\r\n.\r\nLib/site-packages\r\n../backend\r\n../../\r\nimport site\r\n")
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
    subprocess.run([str(RUNTIME / "python.exe"), "-c", "import sys,sqlite3,ssl,fastapi,uvicorn,websockets,httpx,PIL,psutil; import pathlib,importlib.util; assert pathlib.Path(sys.executable).resolve().parents[2] in map(pathlib.Path, sys.path), sys.path; assert importlib.util.find_spec('engine') is not None; print(sys.version); print(sys.executable)"], check=True)
    print("App-local runtime ready:", RUNTIME)

if __name__ == "__main__":
    main()
