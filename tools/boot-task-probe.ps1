# Bounded S4U viability probe — FOR THE COORDINATOR TO RUN, from an ELEVATED
# PowerShell (an S4U "run whether logged on or not" principal requires
# administrator rights to register).
#
# What it does, completely: allocates a UNIQUE task name and evidence
# directory (refusing to proceed if either somehow already exists), writes a
# DPAPI challenge blob from THIS interactive context, registers a TEMPORARY
# no-trigger scheduled task for the CURRENT identity (SID-qualified) with an
# S4U logon, starts it once on demand, reads the JSON evidence the payload
# writes, then stops and unregisters ONLY the task it registered itself —
# never a preexisting one, and nothing at all if registration failed. It
# never touches Orgtree data, never reads credential CONTENTS (readability is
# probed by reading one byte), never performs a provider call (the HTTPS
# probe is unauthenticated; a 4xx status is the expected success signal), and
# never stores any password. Evidence is RETAINED for inspection; nothing
# here deletes it.
#
# Exit codes: 0 = probe ran and evidence was collected; 1 = any failure
# (registration refused, payload never produced results, cleanup could not be
# verified). A registration failure is itself a finding: S4U may simply be
# refused for a Microsoft account.
#
# Interpreting results.json:
#   user/userSid/env — identity and profile variables an S4U logon gets
#   claudeCredReadable/codexAuthReadable — plain-file access under S4U
#   dpapiPriorContextSecretReadable — could the S4U logon UNPROTECT a blob
#       protected earlier in the interactive session? This is the measurement
#       that matters for existing user secrets. Expected FALSE under S4U.
#   dpapiSameContextRoundtrip — Protect+Unprotect wholly inside the S4U
#       context; proves only that the DPAPI service answers there, NOT access
#       to prior user secrets.
#   hkcuReadable — profile hive availability under S4U
#   tcp443/httpsStatus — outbound TLS reachability; any HTTP status (401/403/
#       404) means TLS+HTTP completed WITHOUT Windows network credentials,
#       which is the load-bearing question.

param(
  [string]$TaskName = ('OrgtreeBootProbe-' + [guid]::NewGuid().ToString('N').Substring(0, 12)),
  [string]$OutDir = (Join-Path $env:TEMP ('orgtree-boot-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 12)))
)
$ErrorActionPreference = 'Stop'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powershell)) { Write-Host "missing $powershell"; exit 1 }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$qualifiedUser = $identity.Name
$userSid = $identity.User.Value

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "REFUSED: a task named '$TaskName' already exists; not touching it. Re-run for a fresh name."
  exit 1
}
if (Test-Path $OutDir) {
  Write-Host "REFUSED: evidence directory '$OutDir' already exists; not reusing it. Re-run for a fresh path."
  exit 1
}
New-Item -ItemType Directory $OutDir | Out-Null
$results = Join-Path $OutDir 'results.json'
$payload = Join-Path $OutDir 'payload.ps1'
$challenge = Join-Path $OutDir 'dpapi-challenge.bin'

# Protected NOW, in the interactive session, by the same user's master key:
# whether the S4U logon can unprotect THIS is the real prior-secret question.
Add-Type -AssemblyName System.Security
[System.IO.File]::WriteAllBytes($challenge,
  [Security.Cryptography.ProtectedData]::Protect([byte[]](7, 7, 7), $null, 'CurrentUser'))

@'
param([string]$ResultsPath, [string]$ChallengePath)
$out = @{}
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$out.user = $id.Name
$out.userSid = $id.User.Value
$out.logonTime = (Get-Date).ToString('o')
$out.env = @{}
foreach ($name in 'USERPROFILE','APPDATA','LOCALAPPDATA','HOME','TEMP') { $out.env[$name] = [Environment]::GetEnvironmentVariable($name) }
function Probe-Read($path) {
  try {
    $s = [System.IO.File]::OpenRead($path)
    try { $b = New-Object byte[] 1; [void]$s.Read($b, 0, 1); return $true } finally { $s.Dispose() }
  } catch { return $false }
}
$profileDir = $out.env['USERPROFILE']
$out.claudeCredReadable = Probe-Read (Join-Path $profileDir '.claude\.credentials.json')
$out.codexAuthReadable = Probe-Read (Join-Path $profileDir '.codex\auth.json')
Add-Type -AssemblyName System.Security
try {
  $blob = [System.IO.File]::ReadAllBytes($ChallengePath)
  $back = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
  $out.dpapiPriorContextSecretReadable = ($back.Length -eq 3)
} catch { $out.dpapiPriorContextSecretReadable = $false; $out.dpapiPriorContextError = $_.Exception.Message }
try {
  $mine = [Security.Cryptography.ProtectedData]::Protect([byte[]](1,2,3), $null, 'CurrentUser')
  $back2 = [Security.Cryptography.ProtectedData]::Unprotect($mine, $null, 'CurrentUser')
  $out.dpapiSameContextRoundtrip = ($back2.Length -eq 3)
} catch { $out.dpapiSameContextRoundtrip = $false; $out.dpapiSameContextError = $_.Exception.Message }
try { $null = Get-ItemProperty 'HKCU:\Environment'; $out.hkcuReadable = $true } catch { $out.hkcuReadable = $false }
try {
  $client = New-Object Net.Sockets.TcpClient
  $ok = $client.ConnectAsync('api.anthropic.com', 443).Wait(7000)
  $out.tcp443 = [bool]($ok -and $client.Connected); $client.Close()
} catch { $out.tcp443 = $false; $out.tcpError = $_.Exception.Message }
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $response = Invoke-WebRequest -Uri 'https://api.anthropic.com/v1/models' -UseBasicParsing -TimeoutSec 15
  $out.httpsStatus = [int]$response.StatusCode
} catch [System.Net.WebException] {
  if ($_.Exception.Response) { $out.httpsStatus = [int]$_.Exception.Response.StatusCode } else { $out.httpsStatus = $null; $out.httpsError = $_.Exception.Message }
} catch { $out.httpsStatus = $null; $out.httpsError = $_.Exception.Message }
$out | ConvertTo-Json | Out-File -Encoding utf8 -FilePath $ResultsPath
'@ | Out-File -Encoding utf8 -FilePath $payload

$registered = $false
$failed = $false
try {
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$payload`" `"$results`" `"$challenge`""
  $principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
  $registered = $true
  Write-Host "Registered temporary S4U task '$TaskName' for $qualifiedUser ($userSid)."
  Write-Host "Manual rollback if this window dies: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Path $results) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host ("LastTaskResult: 0x{0:X} ({0})" -f $info.LastTaskResult)
  if (Test-Path $results) {
    Write-Host '--- results.json ---'
    Get-Content $results | Write-Host
  } else {
    Write-Host 'NO RESULTS after 90s - the S4U run itself failed; LastTaskResult above is the finding.'
    $failed = $true
  }
} catch {
  Write-Host "PROBE FAILED: $($_.Exception.Message)"
  if (-not $registered) { Write-Host 'Registration itself was refused - that IS a finding for the S4U question.' }
  $failed = $true
} finally {
  if ($registered) {
    try {
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        $stopDeadline = (Get-Date).AddSeconds(10)
        while ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $stopDeadline) { Start-Sleep -Milliseconds 250 }
      }
      if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
        Write-Host "CLEANUP INCOMPLETE: '$TaskName' still reports Running; unregistering anyway."
        $failed = $true
      }
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    } catch {
      Write-Host "CLEANUP FAILED for '$TaskName': $($_.Exception.Message)"
      $failed = $true
    }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Write-Host "ROLLBACK CHECK NEEDED: task '$TaskName' is still registered."
      $failed = $true
    } else {
      Write-Host "Rolled back: task '$TaskName' unregistered and verified absent."
    }
  } else {
    Write-Host 'Nothing was registered; no task cleanup to do.'
  }
  Write-Host "Evidence retained at $OutDir (results.json, payload.ps1, dpapi-challenge.bin) - inspect before removing anything."
}
if ($failed) { exit 1 }
exit 0
