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

Arguments are positional:
    <installer-pid> <executable-path> [<ready-marker> [<launch-claim>]]

THE ORDER OF THE FIRST THREE STEPS IS THE PROTOCOL, and each one is a promise
this helper must already be able to keep before it makes it.

1. ACQUIRE the installer's process handle. Without it there is no wait to offer.
2. CLAIM the launch, atomically, against the same file the installer's Finish
   page Run action claims. Exactly one party may start the application; the
   loser of that claim must not start anything.
3. ACKNOWLEDGE, by writing the ready marker. The installer reads that marker as
   permission to close its own Finish page — the user's only other way to start
   the application — so it is published only once this helper holds both the
   handle and the ownership. Anything else gives away the fallback on a promise
   that may not be keepable.

Exit codes, all of them also written to the log:
  0  the installer's exit was observed and the application was launched once
  2  the arguments were unusable
  3  the installer's state could not be read, so nothing was launched
  4  the installer had not exited within the timeout, so nothing was launched
  5  the application could not be started
  6  another party already owned the launch, so nothing was started here
  7  launch ownership could not be established at all, so nothing was started
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
EXIT_OWNED_ELSEWHERE = 6
EXIT_UNCLAIMABLE = 7

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


def claim_launch(claim):
    """Take exclusive ownership of the launch, or answer who has it.

    ⚠ THIS IS AN ATOMIC CLAIM, NOT A CHECK-THEN-ACT. Two parties can start this
    application after an upgrade — this helper and the installer's own Finish
    page Run action — and exactly one of them may. Reading a file to see whether
    the other one has launched is a race with a window between the read and the
    launch; creating a file that cannot be created twice has no window. The
    kernel decides, once, and the loser knows it lost.

    O_CREAT | O_EXCL is that primitive on the Python side; the installer uses
    CreateFileW with CREATE_NEW, which is the same NTFS operation. Whoever
    creates the file owns the launch.

    Three answers, and only the first one may launch:
      OWNED        this process created the claim
      OWNED_ELSEWHERE  it already existed, so the other party owns the launch
      UNCLAIMABLE  ownership could not be established at all

    UNCLAIMABLE IS A FAILURE, NOT A PERMISSION. An earlier version treated an
    unreadable withdrawal as licence to launch anyway and leaned on the
    application's single-instance lock to collapse a double start. That is a
    false success: it reports a clean relaunch while having no idea whether it
    caused a second one, and it makes correctness depend on a lock in another
    program. Not knowing means not launching, and saying so.
    """
    if not claim:
        record("no launch-ownership path was supplied; not launching, because ownership cannot be established")
        return UNCLAIMABLE
    try:
        descriptor = os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        record("the launch is already owned by another party (%s exists); not launching" % claim)
        return OWNED_ELSEWHERE
    except OSError as error:
        record(
            "could not establish launch ownership at %s: %s; not launching, because "
            "an unestablished claim is not permission to start a second copy" % (claim, describe(error))
        )
        return UNCLAIMABLE
    try:
        os.write(descriptor, b"helper %d\r\n" % os.getpid())
    except OSError:
        # The claim is taken either way — the create is what owns it, and the
        # note inside is only for a person reading the temp directory later.
        pass
    finally:
        os.close(descriptor)
    return OWNED


def describe(error):
    text = str(error).strip()
    number = getattr(error, "winerror", None)
    if number is None:
        number = getattr(error, "errno", None)
    if number is None:
        return text or "an error with no readable detail"
    return "%s (Windows error %s)" % (text or "no detail", number)


ACQUIRED = "acquired"
OWNED = "owned"
OWNED_ELSEWHERE = "owned-elsewhere"
UNCLAIMABLE = "unclaimable"
EXITED = "exited"
STILL_RUNNING = "still-running"
UNREADABLE = "unreadable"


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    return kernel32


def acquire(pid):
    """Take the handle this helper will wait on, and answer what it holds.

    ⚠ THIS RUNS BEFORE THE ACKNOWLEDGEMENT, AND THAT ORDER IS THE POINT. The
    installer treats the ready marker as permission to close its own Finish page,
    so publishing it before knowing whether this helper can wait at all gives
    away the user's fallback on a promise that may not be keepable: OpenProcess
    can still be refused, and a marker already read cannot be taken back by
    deleting the file. Nothing is acknowledged until the handle is in hand.

    Returns (handle, status). A handle is returned only with ACQUIRED; EXITED
    means the process id is already gone, which is a race this helper may win.
    """
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if handle:
        return handle, ACQUIRED

    error = ctypes.get_last_error()
    if error == ERROR_INVALID_PARAMETER:
        # There is no such process id. The installer exited before this helper
        # got far enough to open a handle on it.
        record("installer process %d had already exited" % pid)
        return None, EXITED
    # Anything else — access denied above all — is NOT evidence of exit.
    record(
        "could not open installer process %d to wait on it: Windows error %d; "
        "not launching and NOT acknowledging, because an unreadable state is "
        "neither an observed exit nor a wait this helper can promise to keep" % (pid, error)
    )
    return None, UNREADABLE


def wait_on(handle, pid, timeout_ms):
    """Answer EXITED, STILL_RUNNING or UNREADABLE for an ACQUIRED handle.

    THE THREE ANSWERS ARE KEPT APART. A process that ended, a process that is
    still running, and a process whose state could not be read are different
    facts, and only the first one may lead to a launch. Collapsing the third
    into the first is the WMI defect this replaced: it launched early and
    reported success.
    """
    kernel32 = _kernel32()
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
    claim = argv[3] if len(argv) > 3 else ""

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

    # HANDLE, THEN OWNERSHIP, THEN ACKNOWLEDGEMENT. Each step is a promise this
    # helper must be able to keep before it is made; see acquire() and
    # claim_launch(). Nothing below this point is reached without both.
    handle, status = acquire(pid)
    if status == UNREADABLE:
        # acquire() has already recorded why. No marker is written, so the
        # installer keeps its Finish page and the user keeps a way to start the
        # application — which is the whole reason this ordering matters.
        return EXIT_UNREADABLE

    ownership = claim_launch(claim)
    if ownership != OWNED:
        # claim_launch() has recorded which it was. Either way this helper does
        # not launch and does not acknowledge, so the installer keeps its page:
        # losing the claim means the other party launches, and failing to make
        # one means nobody may.
        if handle:
            _kernel32().CloseHandle(handle)
        return EXIT_OWNED_ELSEWHERE if ownership == OWNED_ELSEWHERE else EXIT_UNCLAIMABLE

    announce_ready(marker)

    if status == ACQUIRED:
        record("waiting for installer process %d before starting %s" % (pid, executable))
        outcome = wait_on(handle, pid, timeout_ms)
        if outcome == STILL_RUNNING:
            return EXIT_STILL_RUNNING
        if outcome != EXITED:
            # UNREADABLE. wait_on has already recorded why. Nothing is launched:
            # "I could not tell" must never become "it had exited".
            return EXIT_UNREADABLE

    # No second check before launching, and that is deliberate: ownership was
    # settled atomically before this helper acknowledged, so there is nothing
    # left to re-read. A check here would be exactly the check-then-act race the
    # claim exists to remove.
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
