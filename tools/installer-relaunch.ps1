[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$InstallerPid,

  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$exitCode = 0

try {
  if ($InstallerPid -le 0) { throw 'The installer process id is invalid.' }
  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { throw 'The upgraded executable path is empty.' }

  # This detached helper runs as the original user. Starting only after the
  # installer exits covers file, registry, shortcut, and temp-file cleanup.
  $deadline = (Get-Date).AddSeconds(120)
  while ($null -ne (Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -ge $deadline) {
      throw "The installer process $InstallerPid did not exit within 120 seconds."
    }
    Start-Sleep -Milliseconds 100
  }

  Start-Process -FilePath $ExecutablePath -WindowStyle Normal
}
catch {
  [Console]::Error.WriteLine("[installer-relaunch] $($_.Exception.Message)")
  $exitCode = 2
}
finally {
  # The script was copied to a per-installer temporary directory so NSIS can
  # remove its plugin directory as it exits. Best-effort cleanup here removes
  # that detached copy after the one launch attempt.
  try { Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

exit $exitCode
