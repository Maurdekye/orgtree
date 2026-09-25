<#
.SYNOPSIS
  Fetch, verify and unpack the pinned PostgreSQL engine for P03 (WS1).

.DESCRIPTION
  Downloads the EDB PostgreSQL 18.6-4 Windows x64 binaries zip into the MAIN
  checkout's ignored artifacts\p03-postgresql\ folder, refuses it unless its
  SHA256 and size match the pin (docs/state-system/postgresql-qualification.md),
  then extracts only the runtime closure (bin, lib, share and the two licence
  files; not pgAdmin 4, StackBuilder, doc or include) and writes a per-file
  SHA256 manifest beside it. Re-running verifies instead of re-downloading.
  Nothing here is committed; the redistribution licence gate stays open (P10).
#>
param(
    [string]$RepoHome = ""
)
$ErrorActionPreference = 'Stop'

$PinSha = '1df55002afe95b945d934c078b13e82c1603fa546731e511d068aa983b4ead28'
$PinBytes = 382815572
$Url = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-4-windows-x64-binaries.zip'
$ZipName = 'postgresql-18.6-4-windows-x64-binaries.zip'
$Keep = '^pgsql/(bin|lib|share)/|^pgsql/(server_license|commandlinetools_3rd_party_licenses)\.txt$'

if (-not $RepoHome) {
    $common = (git rev-parse --path-format=absolute --git-common-dir).Trim()
    $RepoHome = Split-Path -Parent $common
}
$Dir = Join-Path $RepoHome 'artifacts\p03-postgresql'
$Zip = Join-Path $Dir $ZipName
$Dest = Join-Path $Dir '18.6-4'
$Manifest = "$Dest.manifest.sha256"
New-Item -ItemType Directory -Force $Dir | Out-Null

function Test-Pin([string]$Path) {
    $len = (Get-Item $Path).Length
    $sha = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower()
    if ($len -ne $PinBytes -or $sha -ne $PinSha) {
        throw "pin mismatch for ${Path}: $len bytes, sha256 $sha (want $PinBytes, $PinSha)"
    }
}

if (Test-Path $Zip) {
    Test-Pin $Zip
    Write-Output "zip present and matches pin: $Zip"
} else {
    $part = "$Zip.part"
    & curl.exe -sS -L --fail -o $part $Url
    if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE)" }
    Test-Pin $part
    Move-Item $part $Zip
    Write-Output "downloaded and verified: $Zip"
}

if (-not (Test-Path (Join-Path $Dest 'bin\postgres.exe'))) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $n = 0
        foreach ($e in $z.Entries) {
            if ($e.FullName -match $Keep -and -not $e.FullName.EndsWith('/')) {
                $p = Join-Path $Dest $e.FullName.Substring(6)
                New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $p, $true)
                $n++
            }
        }
    } finally { $z.Dispose() }
    Write-Output "extracted $n files to $Dest"
    Remove-Item -ErrorAction SilentlyContinue $Manifest
}

$lines = Get-ChildItem $Dest -Recurse -File | Sort-Object FullName | ForEach-Object {
    $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $($_.Length)  $($_.FullName.Substring($Dest.Length + 1).Replace('\', '/'))"
}
$text = ($lines -join "`n") + "`n"
if (Test-Path $Manifest) {
    $old = [IO.File]::ReadAllText($Manifest).Replace("`r`n", "`n")
    if ($old -ne $text) { throw "runtime closure under $Dest no longer matches $Manifest" }
    Write-Output "runtime closure matches manifest ($($lines.Count) files)"
} else {
    [IO.File]::WriteAllText($Manifest, $text)
    Write-Output "wrote manifest ($($lines.Count) files): $Manifest"
}
& (Join-Path $Dest 'bin\postgres.exe') --version
