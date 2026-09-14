//
// Post-Setup relaunch helper for an accepted Upgrade.
//
// ⚠ THE HOST IS THE POINT OF THIS FILE. It is JScript run by wscript.exe, and
// that is not a style preference — it is the fix. The installer dispatches this
// helper with StdUtils.ExecShellAsUser, which is a ShellExecute, and
// ShellExecute cannot pass CREATE_NO_WINDOW. Windows therefore allocates a
// console for any CONSOLE-SUBSYSTEM target, and on Windows 11 with Windows
// Terminal as the default terminal that console is hosted by a visible
// WindowsTerminal.exe + OpenConsole.exe pair. This helper used to be
// installer-relaunch.ps1 and powershell.exe is console-subsystem, so every
// accepted upgrade flashed up a terminal that then sat there orphaned.
// wscript.exe is GUI-subsystem, so no console is ever created.
//
// ⚠ -WindowStyle Hidden DID NOT SAVE THE POWERSHELL VERSION AND NO HIDING FLAG
// WILL SAVE THIS ONE. That flag is a PowerShell host preference applied after
// PowerShell has already started, acting on its own console window; under
// Windows Terminal there is no classic window of its own to hide, so the
// terminal appeared anyway. Hiding a console after it exists is the defect.
// The only fix is never to allocate one, which means never dispatching a
// console-subsystem binary here. tests/installer-upgrade.test.mjs reads the PE
// subsystem byte of whatever build/installer.nsh actually names and fails if it
// is console-subsystem; do not "fix" a future regression here by adding flags.
//
// The behaviour contract is otherwise unchanged from the PowerShell helper:
// run under the original user token (the installer's job, via ExecShellAsUser),
// start only after the installer process has exited, and launch exactly once.
//
// Arguments are positional: <installer-pid> <executable-path>.
//
// One deliberate difference from the PowerShell helper. That version reported
// failures on stderr — which was readable only because the console this change
// removes existed. With no console there is nowhere for stderr to go, so
// failures are appended to a log file beside the installer's own log instead.
// Without it this helper would fail completely silently.

var LOG_NAME = 'orgtree-installer-relaunch.log'
var WAIT_TIMEOUT_MS = 120000
var POLL_INTERVAL_MS = 100
var ForAppending = 8

function logPath() {
  var shell = new ActiveXObject('WScript.Shell')
  var temp = shell.ExpandEnvironmentStrings('%TEMP%')
  var fso = new ActiveXObject('Scripting.FileSystemObject')
  return fso.BuildPath(temp, LOG_NAME)
}

// Timestamps are built by hand because the WSH JScript engine is ES3 and has no
// Date.prototype.toISOString. Calling it would throw INSIDE the error reporter,
// which is the one place a failure destroys the evidence of the original
// failure.
function pad(value, width) {
  var text = String(value)
  while (text.length < width) text = '0' + text
  return text
}

function stamp() {
  var now = new Date()
  return now.getFullYear() + '-' + pad(now.getMonth() + 1, 2) + '-' + pad(now.getDate(), 2) +
    'T' + pad(now.getHours(), 2) + ':' + pad(now.getMinutes(), 2) + ':' + pad(now.getSeconds(), 2) +
    '.' + pad(now.getMilliseconds(), 3)
}

// ⚠ A COM error thrown here carries NO TEXT AT ALL. This was measured, not
// assumed: a failed WshShell.Run against a missing executable throws an object
// whose `message` is "", whose `description` is "", and whose String() is the
// useless "[object Error]". The only real signal is `number` — 0x80070002 for
// that case, which is ERROR_FILE_NOT_FOUND.
//
// Reading `message` alone therefore logged a bare "[installer-relaunch] " with
// nothing after it for precisely the two failures this log exists to explain,
// which is a log that reports that something went wrong while destroying what
// it was. Always emit the numeric code, and never let the text fall back to
// something that merely looks like a message.
function describe(error) {
  var text = ''
  try { text = String(error.description || '') } catch (e) { }
  if (text === '') {
    try { text = String(error.message || '') } catch (e) { }
  }
  var code = ''
  try {
    if (error.number !== undefined && error.number !== null) {
      // Win32/HRESULT codes are far easier to look up unsigned.
      code = '0x' + (error.number >>> 0).toString(16)
    }
  } catch (e) { }

  if (text === '' && code === '') return 'an error with no readable detail'
  if (text === '') return 'Windows error ' + code
  if (code === '') return text
  return text + ' (' + code + ')'
}

function record(message) {
  // Best effort by design: losing a diagnostic line must never stop the
  // relaunch, which is the thing the user is actually waiting for.
  try {
    var fso = new ActiveXObject('Scripting.FileSystemObject')
    var stream = fso.OpenTextFile(logPath(), ForAppending, true)
    stream.WriteLine('[' + stamp() + '] [installer-relaunch] ' + message)
    stream.Close()
  } catch (e) { }
}

// Liveness is asked through WMI because JScript under WSH has no route to the
// Win32 process APIs.
//
// An unreadable query counts as NOT ALIVE, which deliberately mirrors the
// PowerShell helper's `Get-Process -ErrorAction SilentlyContinue`: there, an
// error also produced $null and ended the wait. The failure that choice admits
// is launching early; the alternative — treating an unanswerable query as
// "still running" — spends the whole 120s budget and then exits WITHOUT
// launching, turning a degraded WMI into no relaunch at all. Early is
// recoverable, never is not. It is logged either way.
function isRunning(pid) {
  try {
    var wmi = GetObject('winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2')
    var rows = wmi.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE ProcessId = ' + pid)
    return rows.Count > 0
  } catch (error) {
    record('could not query process ' + pid + ': ' + describe(error) + '; treating it as exited')
    return false
  }
}

function waitForExit(pid) {
  var deadline = new Date().getTime() + WAIT_TIMEOUT_MS
  while (isRunning(pid)) {
    if (new Date().getTime() >= deadline) {
      throw new Error('The installer process ' + pid + ' did not exit within 120 seconds.')
    }
    WScript.Sleep(POLL_INTERVAL_MS)
  }
}

function launch(executablePath) {
  // Quoted because the installed location routinely contains spaces
  // ("C:\Program Files\Orgtree"). Window style 1 is a normal window and false
  // does not wait — this helper's own exit must not be tied to the
  // application's. The application is GUI-subsystem, so starting it allocates
  // no console either.
  var shell = new ActiveXObject('WScript.Shell')
  try {
    shell.Run('"' + executablePath + '"', 1, false)
  } catch (error) {
    // Name the path. The raw COM error does not, and "the upgrade did not
    // restart the app" with no path in the log is the report that cannot be
    // acted on.
    throw new Error('Could not start "' + executablePath + '": ' + describe(error))
  }
}

function cleanUp() {
  // The script was copied to a per-installer temporary directory so NSIS can
  // remove its plugin directory as it exits. Best-effort removal of that
  // detached copy after the one launch attempt, exactly as the PowerShell
  // helper did; the host may still hold this file open, and a surviving temp
  // directory is not worth failing the upgrade over.
  try {
    var fso = new ActiveXObject('Scripting.FileSystemObject')
    fso.DeleteFolder(fso.GetParentFolderName(WScript.ScriptFullName), true)
  } catch (e) { }
}

function main() {
  var args = WScript.Arguments.Unnamed
  if (args.length < 2) {
    throw new Error('Expected an installer process id and an executable path.')
  }

  var pid = parseInt(args(0), 10)
  var executablePath = args(1)
  if (isNaN(pid) || pid <= 0) throw new Error('The installer process id is invalid.')
  if (executablePath === null || executablePath === '') throw new Error('The upgraded executable path is empty.')

  waitForExit(pid)
  launch(executablePath)
}

var exitCode = 0
try {
  main()
} catch (error) {
  record(describe(error))
  exitCode = 2
}
cleanUp()
WScript.Quit(exitCode)
