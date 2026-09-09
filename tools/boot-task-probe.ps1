# Bounded S4U viability probe — FOR THE COORDINATOR TO RUN, from an ELEVATED
# PowerShell (task registration for a "run whether logged on or not" principal
# requires administrator rights).
#
# What it does, completely: registers a TEMPORARY no-trigger scheduled task
# running as the CURRENT user with an S4U (no stored password) logon, starts
# it once on demand, reads the JSON evidence it writes, and ALWAYS unregisters
# the task again in a finally block. It never touches Orgtree data, never
# reads credential CONTENTS (readability is probed by reading one byte),
# never performs a provider call (the HTTPS probe is unauthenticated and a
# 4xx status is the expected success signal), and never stores any password.
#
# Rollback if this script dies mid-way:
#   Unregister-ScheduledTask -TaskName OrgtreeBootProbe -Confirm:$false
#   Remove-Item -Recurse -Force "$env:TEMP\orgtree-boot-probe"
#
# Interpreting results.json:
#   user/env      — which identity and profile variables an S4U logon gets
#   claudeCredReadable/codexAuthReadable — plain file access under S4U
#   dpapiWorks    — expected FALSE under S4U (documented restriction)
#   hkcuReadable  — profile hive availability under S4U
#   tcp443/httpsStatus — outbound TLS reachability; an HTTP status (401/403/
#                   404) means TLS+HTTP completed WITHOUT Windows network
#                   credentials, which is the load-bearing question
# If Register-ScheduledTask or Start-ScheduledTask itself fails, that failure
# IS the finding (expected possibility: S4U with a Microsoft account).

param(
  [string]$TaskName = 'OrgtreeBootProbe',
  [string]$OutDir = "$env:TEMP\orgtree-boot-probe"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$results = Join-Path $OutDir 'results.json'
$payload = Join-Path $OutDir 'payload.ps1'
Remove-Item $results -ErrorAction SilentlyContinue

@'
$out = @{}
$out.user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
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
try {
  Add-Type -AssemblyName System.Security
  $blob = [Security.Cryptography.ProtectedData]::Protect([byte[]](1,2,3), $null, 'CurrentUser')
  $back = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
  $out.dpapiWorks = ($back.Length -eq 3)
} catch { $out.dpapiWorks = $false; $out.dpapiError = $_.Exception.Message }
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
$out | ConvertTo-Json | Out-File -Encoding utf8 -FilePath $args[0]
'@ | Out-File -Encoding utf8 -FilePath $payload

try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$payload`" `"$results`""
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "Registered temporary S4U task '$TaskName' for $env:USERNAME."
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Path $results) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host ("LastTaskResult: 0x{0:X} ({0})" -f $info.LastTaskResult)
  if (Test-Path $results) { Write-Host '--- results.json ---'; Get-Content $results | Write-Host }
  else { Write-Host "NO RESULTS after 90s — the S4U run itself failed; LastTaskResult above is the finding." }
} finally {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Rolled back: task '$TaskName' unregistered." }
  catch { Write-Host "ROLLBACK CHECK NEEDED: could not unregister '$TaskName': $($_.Exception.Message)" }
  $gone = -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  Write-Host ("Task absent after rollback: {0}. Evidence retained at {1} (delete with: Remove-Item -Recurse -Force `"{1}`")" -f $gone, $OutDir)
}
