# Remove the Orgtree background engine boot task — FOR THE OPERATOR/
# COORDINATOR TO RUN from an ELEVATED PowerShell. Stops the running host
# first (the guardian then terminates the engine tree and releases the data
# root lock) and verifies the task is gone. Orgtree data is not touched.

param([string]$TaskName = 'Orgtree Background Engine')
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "Task '$TaskName' is not registered."; exit 0 }
if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw "task '$TaskName' still present after unregister" }
Write-Host "Unregistered '$TaskName'. The engine tree was terminated by its guardian; the attach descriptor left in the data root will be rejected by the desktop's identity check and replaced on the next boot-host start."
