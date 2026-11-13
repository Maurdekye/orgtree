# Microsoft Visual C++ runtime check for Setup (user 2026-11-12: on a PC with an outdated runtime, Setup
# succeeded and the bundled PostgreSQL then failed at every start).
#
# WHAT THE DATABASE NEEDS, measured on the pinned archive (tools/postgres-runtime-pin.json, 18.6-4): the payload
# ships no runtime DLL of its own; postgres.exe, initdb.exe and pg_ctl.exe import vcruntime140.dll, and through
# the ICU libraries they load, msvcp140.dll and vcruntime140_1.dll. Every MSVC binary in it is linked by toolset
# 14.44, and Microsoft supports a runtime only when it is at least as new as the toolset that built the program.
# The package gate (tools/postgres-layout.mjs, assertVcRuntimeMinimum) fails a package whose payload was built by
# a newer toolset than $VcRuntimeMinimum, so this number cannot fall behind the pin unnoticed.
#
# Nothing is bundled: the redistributable is downloaded from Microsoft's permanent link only when the runtime is
# missing or too old, its signature is checked before it runs, and the runtime is measured again afterwards.
# Library only: dot-sourced by ensure-vc-runtime.ps1 and by tests/vc-runtime.test.ps1, which replaces every
# function that reads the system, downloads or starts a process.
$script:VcRuntimeMinimum=[version]'14.44.0.0'
$script:VcRuntimeUrl='https://aka.ms/vs/17/release/vc_redist.x64.exe'
$script:VcRuntimeFiles=@('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll')
$script:VcRedistSigner='CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'

# Setup is a 32-bit program: its System32 is the 32-bit folder. The x64 runtime sits in the real one.
function Get-VcSystemDirectory {
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { return (Join-Path $env:windir 'Sysnative') }
    return (Join-Path $env:windir 'System32')
}
function Get-VcFileVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    return [version]::new($info.FileMajorPart,$info.FileMinorPart,$info.FileBuildPart,$info.FilePrivatePart)
}
# The files themselves are the evidence, not the registry record, which survives a broken or partial install.
function Get-VcRuntimeState {
    $directory=Get-VcSystemDirectory
    $missing=@(); $old=@(); $lowest=$null
    foreach ($file in $script:VcRuntimeFiles) {
        $version=Get-VcFileVersion (Join-Path $directory $file)
        if ($null -eq $version) { $missing+=$file; continue }
        if ($version -lt $script:VcRuntimeMinimum) { $old+="$file $version" }
        if ($null -eq $lowest -or $version -lt $lowest) { $lowest=$version }
    }
    $detail=if ($missing.Count) { 'missing: '+($missing -join ', ') } elseif ($old.Count) { 'too old: '+($old -join ', ') } else { "version $lowest" }
    return [pscustomobject]@{Ok=($missing.Count -eq 0 -and $old.Count -eq 0); Lowest=$lowest; Detail=$detail}
}
function Get-VcSignature([string]$Path) {
    $signature=Get-AuthenticodeSignature -LiteralPath $Path
    $root=''
    if ($signature.SignerCertificate) {
        $chain=[Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.RevocationMode='NoCheck'
        [void]$chain.Build($signature.SignerCertificate)
        if ($chain.ChainElements.Count) { $root=$chain.ChainElements[$chain.ChainElements.Count-1].Certificate.Subject }
    }
    return [pscustomobject]@{Status=[string]$signature.Status; Subject=[string]$signature.SignerCertificate.Subject; Root=$root}
}
# '' when the file is Microsoft's own, otherwise the reason it is refused. A valid signature by anyone else, or a
# "Microsoft Corporation" name that does not chain to a Microsoft root, is refused.
function Test-VcRedistSignature([string]$Path) {
    $signature=Get-VcSignature $Path
    if ($signature.Status -cne 'Valid') { return "its signature is not valid ($($signature.Status))" }
    if ($signature.Subject -cne $script:VcRedistSigner) { return "it is signed by someone other than Microsoft Corporation ($($signature.Subject))" }
    if ($signature.Root -notmatch '^CN=Microsoft Root Certificate Authority( \d{4})?, O=Microsoft Corporation, ') { return "its signature does not lead to a Microsoft root certificate ($($signature.Root))" }
    return ''
}
function Save-VcRedist([string]$Destination) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference='SilentlyContinue'
    Invoke-WebRequest -Uri $script:VcRuntimeUrl -OutFile $Destination -UseBasicParsing -TimeoutSec 120
}
function Start-VcRedist([string]$Path) {
    $process=Start-Process -FilePath $Path -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
    return $process.ExitCode
}
function New-VcResult([string]$Status,[string]$Detail) { return [pscustomobject]@{Status=$Status; Detail=$Detail} }

# Status is one of:
#   ok                the runtime is recent enough; nothing was done
#   installed         it was missing or too old; Microsoft's redistributable was installed and it is recent enough now
#   needs-runtime     it is missing or too old and -CheckOnly forbade changing it (a silent run)
#   restart-required  the redistributable installed but Windows must restart before the new files are in place
#   download-failed | signature-refused | install-failed
# Every status but ok and installed means Orgtree's database may not start; Setup says so.
function Invoke-VcRuntimeEnsure([string]$WorkDir,[switch]$CheckOnly) {
    $before=Get-VcRuntimeState
    if ($before.Ok) { return New-VcResult 'ok' $before.Detail }
    if ($CheckOnly) { return New-VcResult 'needs-runtime' $before.Detail }
    $file=Join-Path $WorkDir 'vc_redist.x64.exe'
    try {
        try { Save-VcRedist $file } catch { return New-VcResult 'download-failed' "$($before.Detail); the download failed: $($_.Exception.Message)" }
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return New-VcResult 'download-failed' "$($before.Detail); the download left no file" }
        $refused=Test-VcRedistSignature $file
        if ($refused) { return New-VcResult 'signature-refused' "$($before.Detail); the downloaded file was not run: $refused" }
        # 0 = installed, 3010 = installed and a restart is needed, 1638 = a newer one is already there
        try { $code=Start-VcRedist $file } catch { return New-VcResult 'install-failed' "$($before.Detail); the installer could not be started: $($_.Exception.Message)" }
        $after=Get-VcRuntimeState
        if ($after.Ok) { return New-VcResult 'installed' "$($after.Detail) (was $($before.Detail))" }
        if ($code -eq 3010) { return New-VcResult 'restart-required' "$($after.Detail); the runtime installer asks for a restart of Windows" }
        return New-VcResult 'install-failed' "$($after.Detail); the runtime installer ended with code $code"
    } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
