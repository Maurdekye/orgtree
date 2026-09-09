param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [ValidateSet('Remove','Stop')][string]$Action='Remove',
    [string]$InstallMode='all'
)
$ErrorActionPreference='Stop'
try {
    . "$PSScriptRoot\boot-engine-task.ps1"
    Invoke-BootLifecycle -Action $Action -InstallDir $InstallDir -InstallMode $InstallMode
    Write-Output "Boot engine $Action completed."
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
