# Setup's entry to tools/vc-runtime.ps1. Prints ONE line, "<status>|<detail>", and exits 0 whenever it could
# decide; Setup reads the status (the list is in vc-runtime.ps1) and never stops the installation over it.
param(
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
try {
    . "$PSScriptRoot\vc-runtime.ps1"
    $result=Invoke-VcRuntimeEnsure -WorkDir $WorkDir -CheckOnly:$CheckOnly
    Write-Output ("{0}|{1}" -f $result.Status,(($result.Detail -replace '[\r\n|]+',' ').Trim()))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
