# Prepare before uninstall/copy; Register after copy. SID comes from the original
# installer's actual token. Updates retain the machine-owned operator binding.
param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [ValidateSet('Prepare','Register')][string]$Action='Register',
    [string]$OperatorSid,
    [string]$InstallMode='all'
)
$ErrorActionPreference='Stop'
try {
    . "$PSScriptRoot\boot-engine-task.ps1"
    Invoke-BootLifecycle -Action $Action -InstallDir $InstallDir -OperatorSid $OperatorSid -InstallMode $InstallMode
    Write-Output "Boot engine $Action completed."
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
