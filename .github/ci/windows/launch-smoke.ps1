# Launch smoke for the built Orgtree installer. RUNS ONLY ON A THROWAWAY CI RUNNER:
# it installs the app per-user, creates a local standard user, and starts the
# packaged engine and the desktop app as that user. Never run this on a machine
# anyone uses.
#
# Why a second user: GitHub's Windows runner runs jobs as an ELEVATED
# administrator, and postgres.exe refuses to start under an administrative token
# (run 37926248008). On a user's PC, UAC hands Orgtree a filtered (standard)
# token, which is what this reproduces.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'launch-smoke.ps1 runs only on a GitHub Actions runner' }
New-Item -ItemType Directory -Force $WorkDir | Out-Null

# Logs from C: (the smoke user's profile and C:\otsmoke) are copied under $WorkDir
# (runner.temp, on D:) so ONE upload root holds every diagnostic.
function Save-Diagnostics {
  $dest = Join-Path $WorkDir 'diagnostics'
  foreach ($src in @('C:\otsmoke\engine-data', 'C:\Users\otsmoke\AppData\Roaming\Orgtree v2')) {
    if (-not (Test-Path $src)) { continue }
    Get-ChildItem $src -Recurse -Force -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\(diagnostics\logs|pg\cluster\log)\' } | ForEach-Object {
        $rel = $_.FullName.Substring(3) -replace '[:]', '_'
        $target = Join-Path $dest $rel
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $_.FullName $target -Force -ErrorAction SilentlyContinue
      }
  }
}

try {

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

Write-Host '=== Throwaway standard user'
$user = 'otsmoke'
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$plain = 'Aa1!' + [Convert]::ToBase64String($bytes)
Write-Host "::add-mask::$plain"
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
New-LocalUser -Name $user -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
Add-LocalGroupMember -Group 'Users' -Member $user
$smokeRoot = 'C:\otsmoke'
New-Item -ItemType Directory -Force $smokeRoot | Out-Null
icacls $smokeRoot /grant "${user}:(OI)(CI)F" | Out-Null
icacls $installDir /grant "${user}:(OI)(CI)RX" /T /Q | Out-Null
$admin = (whoami /groups | Select-String 'S-1-16-12288') -ne $null
Write-Host "job token elevated: $admin; smoke user: $user (member of Users only)"

function Start-AsSmokeUser([string]$File, [string]$Arguments, [hashtable]$Environment) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.UserName = $user
  $psi.Password = $secure
  $psi.LoadUserProfile = $true
  $psi.WorkingDirectory = $smokeRoot
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # .NET hands the child a copy of THIS process's environment, so the profile
  # variables would still point into runneradmin's profile, which the smoke user
  # cannot write. Point them at the smoke user's own profile.
  $profileDir = "C:\Users\$user"
  $tmp = Join-Path $smokeRoot 'tmp'
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $base = @{ USERNAME = $user; USERPROFILE = $profileDir; HOMEDRIVE = 'C:'; HOMEPATH = "\Users\$user"
    APPDATA = "$profileDir\AppData\Roaming"; LOCALAPPDATA = "$profileDir\AppData\Local"; TEMP = $tmp; TMP = $tmp }
  foreach ($k in $base.Keys) { $psi.Environment[$k] = $base[$k] }
  foreach ($k in $Environment.Keys) { $psi.Environment[$k] = $Environment[$k] }
  $proc = [System.Diagnostics.Process]::Start($psi)
  return @{ proc = $proc; out = $proc.StandardOutput.ReadToEndAsync(); err = $proc.StandardError.ReadToEndAsync() }
}

function Wait-Alive([string]$PortFile, $Proc, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline -and -not $Proc.HasExited) {
    $file = Get-Item $PortFile -ErrorAction SilentlyContinue
    if ($file) {
      $port = (Get-Content $file.FullName -Raw).Trim()
      try {
        $alive = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/desktop/alive" -TimeoutSec 5
        if ($alive.alive -eq $true) { return @{ port = $port; alive = $alive } }
      } catch { Write-Host "not answering yet: $($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Show-PostgresLogs([string]$Root) {
  Get-ChildItem $Root -Recurse -Filter postgres.log -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- $($_.FullName)"; Get-Content $_.FullName -Tail 40 | Write-Host
  }
}

Write-Host '=== Engine start on a scratch data root (as the standard user)'
$data = Join-Path $smokeRoot 'engine-data'
# First start on an empty data root: allow the engine to create its PostgreSQL
# cluster, as the desktop does (apps/desktop/main/engine.ts bootstrapPostgres).
$e = Start-AsSmokeUser $engine 'serve' @{ ORGTREE_DATA = $data; ORGTREE_PG_BOOTSTRAP = '1' }
$ok = Wait-Alive (Join-Path $data '.port') $e.proc 180
$exited = $e.proc.HasExited
if (-not $exited) { $e.proc.Kill($true) }
$e.proc.WaitForExit(30000) | Out-Null
Write-Host '--- engine stdout'; Write-Host $e.out.Result
Write-Host '--- engine stderr'; Write-Host $e.err.Result
if (-not $ok) {
  Show-PostgresLogs $data
  if ($exited) { throw "Engine exited early with code $($e.proc.ExitCode)" }
  throw 'Engine did not answer /api/desktop/alive within 180 s'
}
Write-Host "Engine answered on port $($ok.port): $($ok.alive | ConvertTo-Json -Compress)"

Write-Host '=== Desktop app as the standard user: stays up, and its engine answers'
$d = Start-AsSmokeUser $app '--enable-logging=stderr --v=1' @{ ELECTRON_ENABLE_LOGGING = '1' }
$appData = "C:\Users\$user\AppData\Roaming\Orgtree v2"
$deskOk = $null
$deadline = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline -and -not $d.proc.HasExited -and -not $deskOk) {
  $portFile = Get-ChildItem $appData -Recurse -Force -Filter '.port' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($portFile) { $deskOk = Wait-Alive $portFile.FullName $d.proc 20 }
  if (-not $deskOk) { Start-Sleep -Seconds 3 }
}
if (-not $d.proc.HasExited) { Start-Sleep -Seconds 30 }
$up = -not $d.proc.HasExited
$code = if ($up) { $null } else { $d.proc.ExitCode }
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
  Format-Table Id, ProcessName, Path | Out-String | Write-Host
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host '--- desktop stdout'; Write-Host $d.out.Result
Write-Host '--- desktop stderr'; Write-Host $d.err.Result
Set-Content -Path (Join-Path $WorkDir 'desktop.err.txt') -Value $d.err.Result
if (-not $up) {
  Show-PostgresLogs $appData
  Write-Host "--- files under C:\Users\$user\AppData (depth 4)"
  Get-ChildItem "C:\Users\$user\AppData" -Recurse -Depth 4 -Force -ErrorAction SilentlyContinue |
    Select-Object -First 200 | ForEach-Object { Write-Host "$($_.Length)`t$($_.FullName)" }
  # Informational only: the same app started by the elevated job user. Tells a
  # user-switch problem (this one stays up) from an app problem (this one exits too).
  Write-Host '--- comparison: Orgtree.exe as the elevated job user (information only)'
  $adminOut = Join-Path $WorkDir 'admin-desktop.out.txt'; $adminErr = Join-Path $WorkDir 'admin-desktop.err.txt'
  $a = Start-Process -FilePath $app -ArgumentList '--enable-logging=stderr', '--v=1' -PassThru `
    -RedirectStandardOutput $adminOut -RedirectStandardError $adminErr
  Start-Sleep -Seconds 20
  $a.Refresh()
  Write-Host "elevated Orgtree.exe after 20 s: $(if ($a.HasExited) { "exited with $($a.ExitCode)" } else { 'still running' })"
  Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Content $adminErr -Tail 60 -ErrorAction SilentlyContinue | Write-Host
  throw "Orgtree.exe exited during the smoke (code $code)"
}
if (-not $deskOk) { Show-PostgresLogs $appData; throw 'The desktop app stayed up, but its engine never answered /api/desktop/alive within 150 s' }
Write-Host "Desktop engine answered on port $($deskOk.port)"
Write-Host 'Launch smoke passed'
} finally {
  Save-Diagnostics
}
