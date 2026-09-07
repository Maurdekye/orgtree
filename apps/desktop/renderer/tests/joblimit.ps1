# frontend/tests/joblimit.ps1 - run one command tree under a kernel-enforced
# memory ceiling and a whole-run time limit. Used by run.mjs on Windows; see the
# CONTAINMENT note there for why it exists and where the defaults come from.
#
# ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI, so one UTF-8 dash or glyph mangles into bytes that break the parser. Do
# not add non-ASCII characters to this file.
#
# USAGE (from run.mjs; usable by hand for the same reason):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/joblimit.ps1 `
#       -LimitMB 6144 -TimeoutSec 300 -WorkDir <dir> -Exe <node.exe> -ArgFile <path>
#   ArgFile holds the child's arguments, ONE PER LINE, so a long list of bundle
#   paths never goes through a second layer of shell quoting.
#
# WHAT IT DOES. Creates a Job Object with JOB_OBJECT_LIMIT_JOB_MEMORY (commit
# charge of EVERY process in the job, children included), JOB_OBJECT_LIMIT_
# KILL_ON_JOB_CLOSE, and starts the child inside it. A process in the job that
# tries to commit past the ceiling has that allocation REFUSED by the kernel -
# node then dies with its own allocation error ("Array buffer allocation
# failed" or a V8 fatal OOM) instead of driving the host into swap. Unlike
# --max-old-space-size, this bounds ArrayBuffer / external memory too
# (measured by memory-leak 2026-08-28: 1281 MB external under a 256 MB V8 cap,
# cap never fired; a 512 MB job ceiling reproduced the exact abort).
#
# On -TimeoutSec expiry the WHOLE job is terminated (TerminateJobObject), not
# just the direct child - node --test's parent does not kill its children on
# Windows when it is killed, so a plain kill would orphan the very processes
# that were the problem. Exit code 124 says the limiter, not the tests, ended it.
#
# WHAT IT DOES NOT DO. It never matches on process name: the only processes it
# can ever stop are the ones inside the job it created. It does not redirect
# stdio - the child inherits this process's handles, so node's TAP stream
# reaches tools/run_tests.py untouched; the limiter's own lines go to stderr
# prefixed [joblimit]. -LimitMB 0 means no memory ceiling (the job still exists
# so the timeout can end the tree); -TimeoutSec 0 means no time limit.
#
# KNOWN LIMITATION: the child is assigned to the job right after spawn, not
# created suspended, so there is a sub-millisecond window before the ceiling
# binds. node cannot commit gigabytes in that window; a process that allocated
# everything at startup could.
[CmdletBinding()]
param(
    [int]$LimitMB = 6144,
    [int]$TimeoutSec = 300,
    [string]$WorkDir = $PWD,
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$ArgFile
)
$ErrorActionPreference = 'Stop'

if (-not ('OrgtreeTestJob' -as [type])) {
    Add-Type -Namespace '' -Name 'OrgtreeTestJob' -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern IntPtr CreateJobObject(IntPtr a, string name);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr h);
'@
}

# JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64 = 144 bytes:
#   BASIC_LIMIT_INFORMATION  0..63   (LimitFlags is the DWORD at offset 16)
#   IO_COUNTERS             64..111
#   ProcessMemoryLimit      112
#   JobMemoryLimit          120  <- NOT 112. Writing the limit at 112 with the
#                                   JOB_MEMORY flag set leaves JobMemoryLimit 0,
#                                   which is invalid (error 87). Learned once.
$JOB_MEM    = 0x00000200
$KILL_CLOSE = 0x00002000
$size = 144
$buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
[Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $size), 0, $buf, $size)
$job = [OrgtreeTestJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "[joblimit] CreateJobObject failed" }
$flags = $KILL_CLOSE
if ($LimitMB -gt 0) {
    $flags = $flags -bor $JOB_MEM
    [Runtime.InteropServices.Marshal]::WriteIntPtr($buf, 120, [IntPtr]([int64]$LimitMB * 1MB))
}
[Runtime.InteropServices.Marshal]::WriteInt32($buf, 16, $flags)
if (-not [OrgtreeTestJob]::SetInformationJobObject($job, 9, $buf, $size)) {
    throw "[joblimit] SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$argLines = @(Get-Content -Path $ArgFile -Encoding UTF8 | Where-Object { $_ -ne '' })
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
# PowerShell 5.1 has no $psi.ArgumentList (PS7 only); quote each argument.
$psi.Arguments = (($argLines | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' ')
$psi.WorkingDirectory = $WorkDir
$psi.UseShellExecute = $false
# no redirection: the child writes straight to our inherited stdout/stderr

[Console]::Error.WriteLine("[joblimit] memory ceiling = $(if ($LimitMB -gt 0) { "$LimitMB MB" } else { 'none' }), run limit = $(if ($TimeoutSec -gt 0) { "$TimeoutSec s" } else { 'none' })")
$proc = [Diagnostics.Process]::Start($psi)
if (-not $proc) { throw "[joblimit] failed to start $Exe" }
if (-not [OrgtreeTestJob]::AssignProcessToJobObject($job, $proc.Handle)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    try { $proc.Kill() } catch {}
    throw "[joblimit] AssignProcessToJobObject failed ($err) - child killed rather than left running unlimited. If this machine cannot nest a job (a restrictive outer job), run with ORGTREE_TEST_JOB_MB=0 to skip the launcher."
}

$code = 0
if ($TimeoutSec -gt 0) {
    if ($proc.WaitForExit($TimeoutSec * 1000)) {
        $code = $proc.ExitCode
    } else {
        [Console]::Error.WriteLine("[joblimit] RUN LIMIT: no exit after $TimeoutSec s - terminating the whole test job")
        [void][OrgtreeTestJob]::TerminateJobObject($job, 124)
        $proc.WaitForExit()
        $code = 124
    }
} else {
    $proc.WaitForExit()
    $code = $proc.ExitCode
}
[void][OrgtreeTestJob]::CloseHandle($job)   # KILL_ON_CLOSE: anything still inside dies here
[Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
exit $code
