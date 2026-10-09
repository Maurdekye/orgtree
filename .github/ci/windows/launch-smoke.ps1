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
  # Never allowed to mask the smoke's own result.
  try {
  $dest = Join-Path $WorkDir 'diagnostics'
  foreach ($src in @('C:\otsmoke\engine-data', 'C:\Users\otsmoke\AppData\Roaming\Orgtree v2')) {
    if (-not (Test-Path $src)) { continue }
    Get-ChildItem $src -Recurse -Force -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '[\\/](diagnostics[\\/]logs|pg[\\/]cluster[\\/]log)[\\/]' } | ForEach-Object {
        $rel = $_.FullName.Substring(3) -replace '[:]', '_'
        $target = Join-Path $dest $rel
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $_.FullName $target -Force -ErrorAction SilentlyContinue
      }
  }
  } catch { Write-Host "Save-Diagnostics failed (ignored): $($_.Exception.Message)" }
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

function Wait-Alive([string]$PortFile, [scriptblock]$IsUp, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline -and (& $IsUp)) {
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
$ok = Wait-Alive (Join-Path $data '.port') { -not $e.proc.HasExited } 180
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

function Get-InstalledProcesses {
  Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }
}
function Stop-Installed { Get-InstalledProcesses | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }

# Pass bar (ci-opus ruling): the desktop starts under a NON-ADMIN token, stays up
# 30 s, and its own engine answers /alive. Returns $true/$false; never throws.
function Test-Desktop([string]$Label, [scriptblock]$IsUp, [string]$AppData) {
  Write-Host "=== Desktop: $Label"
  $deskOk = $null
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline -and (& $IsUp) -and -not $deskOk) {
    $portFile = Get-ChildItem $AppData -Recurse -Force -Filter '.port' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($portFile) { $deskOk = Wait-Alive $portFile.FullName $IsUp 20 }
    if (-not $deskOk) { Start-Sleep -Seconds 3 }
  }
  if (& $IsUp) { Start-Sleep -Seconds 30 }
  $up = [bool](& $IsUp)
  Get-InstalledProcesses | Format-Table Id, ProcessName, Path | Out-String | Write-Host
  Write-Host "$Label -> stayed up: $up; engine answered: $([bool]$deskOk)$(if ($deskOk) { " on port $($deskOk.port)" })"
  if (-not ($up -and $deskOk)) { Show-PostgresLogs $AppData }
  return [bool]($up -and $deskOk)
}

# Attempt A: the throwaway standard user.
$d = Start-AsSmokeUser $app '--enable-logging=stderr --v=1' @{ ELECTRON_ENABLE_LOGGING = '1' }
$passA = Test-Desktop "Orgtree.exe as standard user $user" { -not $d.proc.HasExited } "C:\Users\$user\AppData\Roaming\Orgtree v2"
if ($d.proc.HasExited) { Write-Host "standard-user Orgtree.exe exit code: $($d.proc.ExitCode)" }
Stop-Installed
Write-Host '--- desktop (A) stdout'; Write-Host $d.out.Result
Write-Host '--- desktop (A) stderr'; Write-Host $d.err.Result
Set-Content -Path (Join-Path $WorkDir 'desktop-A.err.txt') -Value $d.err.Result
if (-not $passA) {
  Write-Host "--- files under C:\Users\$user\AppData (depth 4)"
  Get-ChildItem "C:\Users\$user\AppData" -Recurse -Depth 4 -Force -ErrorAction SilentlyContinue |
    Select-Object -First 200 | ForEach-Object { Write-Host "$($_.Length)`t$($_.FullName)" }
}

# Attempt B: the job user itself with a SAFER "basic user" token (Administrators
# deny-only), close to the filtered token UAC gives a real user. runas returns at
# once, so the app is found by its install path.
$runasLog = Join-Path $env:TEMP 'orgtree-desktop-runas.log'
Remove-Item $runasLog -ErrorAction SilentlyContinue
& runas.exe /trustlevel:0x20000 "$app --enable-logging --v=1 --log-file=$runasLog"
Write-Host "runas exit code: $LASTEXITCODE"
Start-Sleep -Seconds 5
$passB = Test-Desktop 'Orgtree.exe as the job user with a basic-user (non-admin) token' { [bool](Get-InstalledProcesses | Where-Object ProcessName -eq 'Orgtree') } (Join-Path $env:APPDATA 'Orgtree v2')
Stop-Installed
if (Test-Path $runasLog) {
  Copy-Item $runasLog (Join-Path $WorkDir 'desktop-B.log')
  Write-Host '--- desktop (B) log tail'; Get-Content $runasLog -Tail 60 | Write-Host
}

if (-not ($passA -or $passB)) {
  # Information only: the same app started by the elevated job user. Tells a
  # token problem (this one stays up) from an app problem (this one exits too).
  Write-Host '--- comparison: Orgtree.exe as the elevated job user (information only)'
  $adminOut = Join-Path $WorkDir 'admin-desktop.out.txt'; $adminErr = Join-Path $WorkDir 'admin-desktop.err.txt'
  $a = Start-Process -FilePath $app -ArgumentList '--enable-logging=stderr', '--v=1' -PassThru `
    -RedirectStandardOutput $adminOut -RedirectStandardError $adminErr
  Start-Sleep -Seconds 20
  $a.Refresh()
  Write-Host "elevated Orgtree.exe after 20 s: $(if ($a.HasExited) { "exited with $($a.ExitCode)" } else { 'still running' })"
  Stop-Installed
  Get-Content $adminErr -Tail 60 -ErrorAction SilentlyContinue | Write-Host
  throw 'The desktop app did not stay up with a working engine under any non-admin token'
}
Write-Host "Desktop passed: standard user=$passA, basic-user token=$passB"
Write-Host 'Launch smoke passed'
} finally {
  Save-Diagnostics
}
