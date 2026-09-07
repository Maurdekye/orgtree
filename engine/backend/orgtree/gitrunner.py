"""Bounded Git process transport for the operator's repository workspace.

Command construction/authorization lives in gitworkspace. Hooks and normal
Git validation remain enabled. This does not change docket SHA verification.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
import re
import signal
import subprocess
import tempfile
import time


@dataclass(frozen=True)
class Result:
    code: int | None
    out: bytes = b""
    err: str = ""
    failure: str | None = None

    def text(self) -> str:
        return self.out.decode("utf-8", "replace").strip()


def redact(value: str) -> str:
    # Do not reflect credential-bearing URLs from Git, remote helpers or hooks.
    value = re.sub(r"(?i)(https?://)[^\s/'\"]+@", r"\1[redacted]@", value)
    value = re.sub(r"(?i)(https?://[^\s?'\"]+)\?[^\s'\"]+", r"\1?[redacted]", value)
    value = re.sub(r"(?i)((?:token|password|authorization)\s*[:=]\s*)\S+", r"\1[redacted]", value)
    return value[:4000]


def _stop(proc: subprocess.Popen[bytes]) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=5)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if proc.poll() is None:
        proc.kill()
    proc.wait(timeout=5)


def run(cwd: str, args: list[str], *, timeout: float = 12,
        max_bytes: int = 8 * 1024 * 1024, read: bool = True) -> Result:
    env = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                 "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                 "GIT_NAMESPACE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
                 "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS"):
        env.pop(name, None)
    env.update(GIT_TERMINAL_PROMPT="0", GIT_PAGER="cat", GIT_ALLOW_PROTOCOL="file:ssh:https:http",
               GIT_SSH_COMMAND="ssh -oBatchMode=yes", LC_ALL="C")
    if read:
        env["GIT_OPTIONAL_LOCKS"] = "0"
    else:
        env.pop("GIT_OPTIONAL_LOCKS", None)
    argv = ["git", "--no-pager", "-c", "color.ui=false", "-c", "core.quotepath=false",
            "-c", "diff.external=", *args]
    try:
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(argv, cwd=cwd, env=env, shell=False,
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                    start_new_session=os.name != "nt")
            deadline = time.monotonic() + timeout
            failure = None
            while proc.poll() is None:
                if os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > max_bytes:
                    failure = "output_limit"
                    break
                if time.monotonic() >= deadline:
                    failure = "timeout"
                    break
                time.sleep(.02)
            if failure:
                _stop(proc)
            out.seek(0)
            err.seek(0)
            stdout = out.read(max_bytes + 1)
            stderr = err.read(max_bytes + 1)
            if len(stdout) + len(stderr) > max_bytes:
                failure = "output_limit"
            if failure:
                return Result(None, b"", f"Git {failure.replace('_', ' ')}; refresh to check the outcome", failure)
            return Result(proc.returncode, stdout, redact(stderr.decode("utf-8", "replace")))
    except FileNotFoundError:
        return Result(None, err="Git is not installed or the repository directory is unavailable", failure="unavailable")
    except (OSError, subprocess.SubprocessError) as e:
        return Result(None, err=redact(str(e)), failure="process_error")
