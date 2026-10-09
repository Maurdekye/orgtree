# Launch smoke for the built Orgtree installer. RUNS ONLY ON A THROWAWAY CI RUNNER:
# it installs the app per-user, starts the packaged engine on a scratch data root
# and starts the desktop app. Never run this on a machine anyone uses.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'launch-smoke.ps1 runs only on a GitHub Actions runner' }
New-Item -ItemType Directory -Force $WorkDir | Out-Null

Write-Host "=== Silent per-user install: $Installer"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Orgtree'
$app = Join-Path $installDir 'Orgtree.exe'
$engine = Join-Path $installDir 'resources\engine\orgtree-engine.exe'
foreach ($f in @($app, $engine)) { if (-not (Test-Path $f)) { throw "Not installed: $f" } }
Get-ChildItem $installDir | Format-Table Name, Length | Out-String | Write-Host

Write-Host '=== Engine --version'
$v = (& $engine --version).Trim()
Write-Host $v
if ($v -ne "orgtree-engine $Version") { throw "Unexpected engine version: '$v' (want 'orgtree-engine $Version')" }

Write-Host '=== Engine start on a scratch data root'
$data = Join-Path $WorkDir 'engine-data'
New-Item -ItemType Directory -Force $data | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $engine
$psi.Arguments = 'serve'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.Environment['ORGTREE_DATA'] = $data
# First start on an empty data root: allow the engine to create its PostgreSQL
# cluster, as the desktop does (apps/desktop/main/engine.ts bootstrapPostgres).
$psi.Environment['ORGTREE_PG_BOOTSTRAP'] = '1'
$proc = [System.Diagnostics.Process]::Start($psi)
$stdout = $proc.StandardOutput.ReadToEndAsync()
$stderr = $proc.StandardError.ReadToEndAsync()
$deadline = (Get-Date).AddSeconds(180)
$alive = $null
while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
  $portFile = Join-Path $data '.port'
  if (Test-Path $portFile) {
    $port = (Get-Content $portFile -Raw).Trim()
    try {
      $alive = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/desktop/alive" -TimeoutSec 5
      if ($alive.alive -eq $true) { break }
    } catch { Write-Host "not answering yet: $($_.Exception.Message)" }
  }
  Start-Sleep -Seconds 2
}
$exited = $proc.HasExited
if (-not $exited) { $proc.Kill($true) }
$proc.WaitForExit(30000) | Out-Null
Write-Host "--- engine stdout"; Write-Host $stdout.Result
Write-Host "--- engine stderr"; Write-Host $stderr.Result
if ($exited) { throw "Engine exited early with code $($proc.ExitCode)" }
if (-not $alive -or $alive.alive -ne $true) { throw 'Engine did not answer /api/desktop/alive within 180 s' }
Write-Host "Engine answered on port ${port}: $($alive | ConvertTo-Json -Compress)"

Write-Host '=== Desktop app stays up for 30 s'
$desk = Start-Process -FilePath $app -PassThru
Start-Sleep -Seconds 30
$desk.Refresh()
$up = -not $desk.HasExited
$code = if ($up) { $null } else { $desk.ExitCode }
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
  Format-Table Id, ProcessName, Path | Out-String | Write-Host
# Stop everything the install started (app, its engine, PostgreSQL).
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force -ErrorAction SilentlyContinue
if (-not $up) { throw "Orgtree.exe exited within 30 s (code $code)" }
Write-Host 'Launch smoke passed'
