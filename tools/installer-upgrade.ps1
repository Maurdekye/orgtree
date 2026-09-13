[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $InstallDir,

  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,

  [ValidateRange(5, 120)]
  [int] $TimeoutSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CanonicalPath([string] $Value) {
  return [IO.Path]::GetFullPath($Value)
}

try {
  $root = Get-CanonicalPath $InstallDir
  $executable = Get-CanonicalPath $ExecutablePath
  $leaf = [IO.Path]::GetFileName($executable)
  if ([string]::IsNullOrWhiteSpace($leaf)) {
    throw 'The installed application executable path is incomplete.'
  }

  # The installer passes both values from the matching registry record. Keep
  # the executable inside that exact recorded directory; never search by a
  # guessed process name or by a caller-controlled alternate path.
  $expectedExecutable = Get-CanonicalPath ([IO.Path]::Combine($root, $leaf))
  if (-not [string]::Equals($expectedExecutable, $executable, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The application executable is outside the recorded installation directory.'
  }
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "The installed application executable was not found: $executable"
  }

  function Get-InstalledProcesses {
    $records = @(Get-CimInstance -ClassName Win32_Process)
    # ⚠ The installer runs this under Windows PowerShell 5.1
    # ($SYSDIR\WindowsPowerShell\v1.0\powershell.exe), where
    # `New-Object 'System.Collections.Generic.List[object]'` throws "Argument
    # types do not match" before it can inspect anything. That made every
    # invocation of this helper fail, so no installed Orgtree was ever asked to
    # close. Construct through the type itself, which 5.1 accepts.
    # `$matches` is an automatic variable and is deliberately not used as a name.
    $found = [System.Collections.Generic.List[object]]::new()
    foreach ($record in $records) {
      if ([string]::IsNullOrWhiteSpace([string]$record.Name)) { continue }
      if (-not [string]::Equals([string]$record.Name, $leaf, [StringComparison]::OrdinalIgnoreCase)) { continue }
      if ([string]::IsNullOrWhiteSpace([string]$record.ExecutablePath)) {
        throw 'A matching Orgtree process could not be path-verified; the upgrade is left untouched.'
      }
      $processPath = Get-CanonicalPath ([string]$record.ExecutablePath)
      if ([string]::Equals($processPath, $executable, [StringComparison]::OrdinalIgnoreCase)) {
        $found.Add($record)
      }
    }
    return @($found)
  }

  $running = @(Get-InstalledProcesses)
  if ($running.Count -eq 0) {
    Write-Output 'Orgtree is already closed.'
    exit 0
  }

  Write-Output 'Requesting a graceful Orgtree shutdown.'
  $control = Start-Process -FilePath $executable -ArgumentList @('--installer-upgrade') -WindowStyle Hidden -PassThru
  $control.Dispose()

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-InstalledProcesses)
    if ($remaining.Count -eq 0) {
      Write-Output 'Orgtree closed gracefully.'
      exit 0
    }
  }

  throw "Orgtree did not close within $TimeoutSeconds seconds. Retry after closing any unsaved work."
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
