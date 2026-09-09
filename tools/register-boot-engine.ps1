# Register the Orgtree background engine as a boot-time scheduled task —
# FOR THE OPERATOR/COORDINATOR TO RUN from an ELEVATED PowerShell. Nothing in
# the application registers this itself.
#
# Runs as the CURRENT user with an S4U logon: no password is stored anywhere.
# Trigger is "at system startup", so the engine serves before any interactive
# logon and returns after unattended restarts. The desktop app attaches to it
# through the verified engine-attach.json descriptor.
#
# Prerequisite: the boot-task-probe.ps1 evidence shows S4U works for this
# account (profile file readability + outbound HTTPS). If the probe failed,
# do not register this task — the identity question goes back to the user.
#
# Stop without unregistering (until next boot):  Stop-ScheduledTask -TaskName 'Orgtree Background Engine'
#   (the guardian terminates the engine tree when the host dies; the desktop
#    can also stop it gracefully via its authenticated shutdown route)
# Rollback: tools\unregister-boot-engine.ps1  (or Unregister-ScheduledTask)

param(
  # For a packaged install pass "<InstallDir>\resources"; for a development
  # checkout the repo root works when engine/runtime has been provisioned.
  [Parameter(Mandatory = $true)][string]$ResourcesDir,
  [string]$TaskName = 'Orgtree Background Engine'
)
$ErrorActionPreference = 'Stop'
$python = Join-Path $ResourcesDir 'engine\runtime\python.exe'
$host_ = Join-Path $ResourcesDir 'engine\service_host.py'
if (-not (Test-Path $python)) { throw "missing packaged runtime: $python" }
if (-not (Test-Path $host_)) { throw "missing service host: $host_" }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$action = New-ScheduledTaskAction -Execute $python -Argument "`"$host_`"" -WorkingDirectory (Split-Path $host_)
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
# -Force is intentional here and here only: this is OUR fixed production task
# name, and re-running the script after an update must refresh its paths.
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Registered '$TaskName' (S4U, at startup) for $($identity.Name) running $python"
Write-Host "Start now without rebooting:  Start-ScheduledTask -TaskName '$TaskName'"
