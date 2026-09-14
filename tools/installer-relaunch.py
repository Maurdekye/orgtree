"""Post-Setup relaunch helper for an accepted Upgrade.

WHY THIS FILE IS PYTHON RUN BY pythonw.exe, and why that is not a style
preference.

Two constraints decide the host, and only one of them is obvious.

1. IT MUST BE GUI-SUBSYSTEM. The installer dispatches this helper with
   StdUtils.ExecShellAsUser, which is a ShellExecute, and ShellExecute cannot
   pass CREATE_NO_WINDOW. Windows therefore allocates a console for any
   CONSOLE-SUBSYSTEM target, and on Windows 11 with Windows Terminal as the
   default terminal that console is a visible WindowsTerminal.exe +
   OpenConsole.exe pair. That is the incident this work started from: the
   helper was installer-relaunch.ps1 under powershell.exe, which is
   console-subsystem, so every accepted upgrade flashed up a terminal that then
   sat there orphaned. No hiding flag fixes it — -WindowStyle Hidden was
   already in those arguments — because hiding a console after it exists is the
   defect. pythonw.exe is GUI-subsystem, so no console is ever created.

2. IT MUST NOT DEPEND ON A COMPONENT THAT POLICY CAN SWITCH OFF. The first
   attempt at (1) used JScript under wscript.exe, which is GUI-subsystem and
   ships with Windows — but Windows Script Host is disabled by policy on plenty
   of managed machines, and a disabled WSH cannot run the script that would
   have reported that it could not run. The installer would mark the relaunch
   scheduled, skip the Finish page, and nothing would ever start or be logged.
   pythonw.exe is not that: it is the runtime this application already ships
   and already requires in order to run at all, so it cannot be absent on a
   machine where the relaunch is meaningful, and the installer verifies the
   file exists before it commits to skipping the Finish page.

WHAT THE HOST BUYS BEYOND THE SUBSYSTEM BYTE. ctypes reaches the real Win32
process APIs, so the wait is OpenProcess + WaitForSingleObject on a handle —
the operating system tells us the process ended. The WSH version had no route
to those APIs and asked WMI instead, and a WMI query that FAILED (the service
degraded, impersonation refused) was read as "the process is gone", which
launched the application immediately while the installer was still running and
exited 0 as though it had waited. Nothing here turns an unanswerable question
into an answer: an unreadable state is reported and the launch does NOT happen.

The behaviour contract is otherwise unchanged: run under the original user
token (the installer's job, via ExecShellAsUser), start only after the
installer process has exited, and launch exactly once.

Arguments are positional: <installer-pid> <executable-path> [<ready-marker>].
The ready marker is the installer's acceptance handshake — it is written before
the wait begins, and the installer skips its Finish page only if it appears.

Exit codes, all of them also written to the log:
  0  the installer's exit was observed and the application was launched once
  2  the arguments were unusable
  3  the installer's state could not be read, so nothing was launched
  4  the installer had not exited within the timeout, so nothing was launched
  5  the application could not be started
"""

import ctypes
import os
import shutil
import subprocess
import sys
import time
from ctypes import wintypes

LOG_NAME = "orgtree-installer-relaunch.log"
DEFAULT_TIMEOUT_MS = 120000

SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102
WAIT_FAILED = 0xFFFFFFFF
ERROR_INVALID_PARAMETER = 87

EXIT_OK = 0
EXIT_BAD_ARGUMENTS = 2
EXIT_UNREADABLE = 3
EXIT_STILL_RUNNING = 4
EXIT_LAUNCH_FAILED = 5

# DETACHED_PROCESS, not CREATE_NO_WINDOW: the launched process gets no console
# at all rather than a hidden one, and it does not inherit this helper's.
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def log_path():
    return os.path.join(os.environ.get("ORGTREE_RELAUNCH_LOG_DIR") or _temp_dir(), LOG_NAME)


def _temp_dir():
    for name in ("TEMP", "TMP"):
        value = os.environ.get(name)
        if value:
            return value
    return os.getcwd()


def record(message):
    """Append one diagnostic line.

    Best effort by design: losing a line must never stop the relaunch, which is
    the thing the user is actually waiting for. With no console there is nowhere
    for stderr to go, so this file is the only account of a failure that exists.
    """
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(log_path(), "a", encoding="utf-8") as stream:
            stream.write("[%s] [installer-relaunch] %s\n" % (stamp, message))
    except Exception:
        pass


def announce_ready(marker):
    """Write the installer's acceptance handshake.

    The installer waits a short time for this file before it skips the Finish
    page. Its absence means this helper never ran, which is precisely the
    failure a script host that policy has disabled cannot report about itself.
    """
    if not marker:
        return
    try:
        with open(marker, "w", encoding="utf-8") as stream:
            stream.write("started %d\n" % os.getpid())
    except Exception as error:
        # Not fatal: the relaunch is still correct, the installer simply falls
        # back to showing its Finish page.
        record("could not write the ready marker %s: %s" % (marker, describe(error)))


def describe(error):
    text = str(error).strip()
    number = getattr(error, "winerror", None)
    if number is None:
        number = getattr(error, "errno", None)
    if number is None:
        return text or "an error with no readable detail"
    return "%s (Windows error %s)" % (text or "no detail", number)


EXITED = "exited"
STILL_RUNNING = "still-running"
UNREADABLE = "unreadable"


def wait_for_exit(pid, timeout_ms):
    """Answer EXITED, STILL_RUNNING or UNREADABLE.

    THE THREE ANSWERS ARE KEPT APART. A process that ended, a process that is
    still running, and a process whose state could not be read are different
    facts, and only the first one may lead to a launch. Collapsing the third
    into the first is the WMI defect this replaced: it launched early and
    reported success.
    """
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)

    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        error = ctypes.get_last_error()
        if error == ERROR_INVALID_PARAMETER:
            # There is no such process id. The installer exited before this
            # helper got far enough to open a handle on it, which is a race this
            # helper is allowed to win.
            record("installer process %d had already exited" % pid)
            return EXITED
        # Anything else — access denied above all — is NOT evidence of exit.
        record(
            "could not open installer process %d to wait on it: Windows error %d; "
            "not launching, because an unreadable state is not an observed exit" % (pid, error)
        )
        return UNREADABLE

    try:
        result = kernel32.WaitForSingleObject(handle, timeout_ms)
    finally:
        kernel32.CloseHandle(handle)

    if result == WAIT_OBJECT_0:
        return EXITED
    if result == WAIT_TIMEOUT:
        record(
            "installer process %d had not exited after %d ms; not launching, because "
            "starting the application over a live installer is the failure this wait exists to prevent"
            % (pid, timeout_ms)
        )
        return STILL_RUNNING
    error = ctypes.get_last_error()
    record(
        "waiting on installer process %d failed (result 0x%08X, Windows error %d); not launching"
        % (pid, result, error)
    )
    return UNREADABLE


def launch(executable):
    """Start the upgraded application exactly once."""
    directory = os.path.dirname(executable) or None
    subprocess.Popen(
        [executable],
        cwd=directory,
        close_fds=True,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
    )


def clean_up():
    """Remove the detached copy of this helper.

    It was copied to a per-installer temporary directory so NSIS can delete its
    plugin directory as it exits. Best-effort, exactly as the previous helpers
    did: a surviving temp directory is not worth failing an upgrade over.
    """
    try:
        directory = os.path.dirname(os.path.abspath(__file__))
        os.chdir(_temp_dir())
        shutil.rmtree(directory, ignore_errors=True)
    except Exception:
        pass


def main(argv):
    if len(argv) < 2:
        record("expected an installer process id and an executable path")
        return EXIT_BAD_ARGUMENTS

    raw_pid, executable = argv[0], argv[1]
    marker = argv[2] if len(argv) > 2 else ""

    try:
        pid = int(raw_pid)
    except ValueError:
        record("the installer process id %r is not a number" % raw_pid)
        return EXIT_BAD_ARGUMENTS
    if pid <= 0:
        record("the installer process id %r is invalid" % raw_pid)
        return EXIT_BAD_ARGUMENTS
    if not executable:
        record("the upgraded executable path is empty")
        return EXIT_BAD_ARGUMENTS

    try:
        timeout_ms = int(os.environ.get("ORGTREE_RELAUNCH_TIMEOUT_MS") or DEFAULT_TIMEOUT_MS)
    except ValueError:
        timeout_ms = DEFAULT_TIMEOUT_MS

    announce_ready(marker)
    record("waiting for installer process %d before starting %s" % (pid, executable))

    outcome = wait_for_exit(pid, timeout_ms)
    if outcome == STILL_RUNNING:
        return EXIT_STILL_RUNNING
    if outcome != EXITED:
        # UNREADABLE. wait_for_exit has already recorded why. Nothing is
        # launched: "I could not tell" must never become "it had exited".
        return EXIT_UNREADABLE

    try:
        launch(executable)
    except Exception as error:
        # Name the path. "The upgrade did not restart the app" with no path in
        # the log is the report that cannot be acted on.
        record('could not start "%s": %s' % (executable, describe(error)))
        return EXIT_LAUNCH_FAILED

    record("started %s once, after installer process %d exited" % (executable, pid))
    return EXIT_OK


if __name__ == "__main__":
    code = main(sys.argv[1:])
    clean_up()
    sys.exit(code)
