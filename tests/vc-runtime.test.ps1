# Isolated tests of Setup's Visual C++ runtime check: every function that reads the system folder, downloads or
# starts a process is replaced before use. Nothing is downloaded, installed or run, and no system file is written.
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\tools\vc-runtime.ps1"
$script:checks=0
function Assert($Value,[string]$Message) { if (-not $Value) { throw $Message }; $script:checks++ }
$root=Join-Path ([IO.Path]::GetTempPath()) ('orgtree-vc-fixture-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    # the minimum is the toolset that built the pinned PostgreSQL, and the files are the three it imports
    Assert ($script:VcRuntimeMinimum -eq [version]'14.44.0.0') 'minimum is 14.44'
    Assert (($script:VcRuntimeFiles -join ',') -ceq 'vcruntime140.dll,vcruntime140_1.dll,msvcp140.dll') 'the three imported runtime files'
    Assert ($script:VcRuntimeUrl -ceq 'https://aka.ms/vs/17/release/vc_redist.x64.exe') "Microsoft's permanent link"

    # --- state: versions come from the files in the system folder
    $script:versions=@{}
    function Get-VcSystemDirectory { return $root }
    function Get-VcFileVersion([string]$Path) { return $script:versions[[IO.Path]::GetFileName($Path)] }
    function Set-Versions($a,$b,$c) { $script:versions=@{'vcruntime140.dll'=$a; 'vcruntime140_1.dll'=$b; 'msvcp140.dll'=$c} }
    Set-Versions ([version]'14.44.35211.0') ([version]'14.51.36247.0') ([version]'14.44.35211.0')
    $state=Get-VcRuntimeState
    Assert ($state.Ok -and $state.Detail -ceq 'version 14.44.35211.0') "recent enough: $($state.Detail)"
    Set-Versions ([version]'14.44.35211.0') ([version]'14.44.35211.0') ([version]'14.38.33135.0')
    $state=Get-VcRuntimeState
    Assert (-not $state.Ok -and $state.Detail -ceq 'too old: msvcp140.dll 14.38.33135.0') "one old file is enough: $($state.Detail)"
    # a Visual Studio 2015/2017 runtime has no vcruntime140_1.dll at all
    Set-Versions ([version]'14.16.27033.0') $null ([version]'14.16.27033.0')
    $state=Get-VcRuntimeState
    Assert (-not $state.Ok -and $state.Detail -ceq 'missing: vcruntime140_1.dll') "a missing file: $($state.Detail)"
    Set-Versions $null $null $null
    Assert ((Get-VcRuntimeState).Detail -ceq 'missing: vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll') 'no runtime at all'

    # --- signature: only a valid Microsoft Corporation signature under a Microsoft root runs
    $ms='CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
    $msRoot='CN=Microsoft Root Certificate Authority 2011, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
    $script:signature=$null
    function Get-VcSignature([string]$Path) { return $script:signature }
    $script:signature=[pscustomobject]@{Status='Valid'; Subject=$ms; Root=$msRoot}
    Assert ((Test-VcRedistSignature 'x') -ceq '') "Microsoft's own file is accepted"
    $script:signature=[pscustomobject]@{Status='NotSigned'; Subject=''; Root=''}
    Assert ((Test-VcRedistSignature 'x') -match 'not valid \(NotSigned\)') 'an unsigned file is refused'
    $script:signature=[pscustomobject]@{Status='HashMismatch'; Subject=$ms; Root=$msRoot}
    Assert ((Test-VcRedistSignature 'x') -match 'not valid \(HashMismatch\)') 'a changed file is refused'
    $script:signature=[pscustomobject]@{Status='Valid'; Subject='CN=Example Software Ltd, O=Example Software Ltd, C=US'; Root='CN=Some Trusted Root'}
    Assert ((Test-VcRedistSignature 'x') -match 'someone other than Microsoft Corporation') 'a valid signature by someone else is refused'
    $script:signature=[pscustomobject]@{Status='Valid'; Subject=$ms; Root='CN=Some Trusted Root, O=Other, C=US'}
    Assert ((Test-VcRedistSignature 'x') -match 'does not lead to a Microsoft root') 'the Microsoft name under another root is refused'

    # --- the whole decision, with the download and the run replaced
    $script:events=[Collections.Generic.List[string]]::new()
    $script:download={ param($d) [IO.File]::WriteAllText($d,'fixture') }
    $script:runCode=0; $script:afterRun=$null
    function Save-VcRedist([string]$Destination) { $script:events.Add('download'); & $script:download $Destination }
    function Start-VcRedist([string]$Path) { $script:events.Add('run'); if ($script:afterRun) { & $script:afterRun }; return $script:runCode }
    $file=Join-Path $root 'vc_redist.x64.exe'
    $good=[pscustomobject]@{Status='Valid'; Subject=$ms; Root=$msRoot}
    function Reset { $script:events.Clear(); $script:signature=$good; $script:runCode=0; $script:afterRun=$null
        $script:download={ param($d) [IO.File]::WriteAllText($d,'fixture') }; Set-Versions ([version]'14.29.30139.0') ([version]'14.29.30139.0') ([version]'14.29.30139.0') }

    Reset; Set-Versions ([version]'14.51.0.0') ([version]'14.51.0.0') ([version]'14.51.0.0')
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'ok' -and $script:events.Count -eq 0) "a recent runtime downloads and runs nothing: $($r.Status) $($script:events -join ',')"

    Reset
    $r=Invoke-VcRuntimeEnsure -WorkDir $root -CheckOnly
    Assert ($r.Status -ceq 'needs-runtime' -and $r.Detail -match '^too old: vcruntime140\.dll 14\.29' -and $script:events.Count -eq 0) "a silent run only reports: $($r.Status) $($r.Detail)"

    Reset; $script:afterRun={ Set-Versions ([version]'14.51.0.0') ([version]'14.51.0.0') ([version]'14.51.0.0') }
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'installed' -and ($script:events -join ',') -ceq 'download,run') "an old runtime is downloaded, run and measured again: $($r.Status) $($script:events -join ',')"
    Assert ($r.Detail -ceq 'version 14.51.0.0 (was too old: vcruntime140.dll 14.29.30139.0, vcruntime140_1.dll 14.29.30139.0, msvcp140.dll 14.29.30139.0)') "says what changed: $($r.Detail)"
    Assert (-not (Test-Path -LiteralPath $file)) 'the downloaded file is removed afterwards'

    Reset; $script:download={ param($d) throw 'The remote name could not be resolved' }
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'download-failed' -and $r.Detail -match 'could not be resolved' -and ($script:events -join ',') -ceq 'download') "offline: nothing runs: $($r.Status) $($script:events -join ',')"

    Reset; $script:download={ param($d) }
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'download-failed' -and $r.Detail -match 'left no file') "a download that leaves nothing: $($r.Status)"

    Reset; $script:signature=[pscustomobject]@{Status='Valid'; Subject='CN=Example Software Ltd'; Root='CN=Some Trusted Root'}
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'signature-refused' -and ($script:events -join ',') -ceq 'download') "a file that is not Microsoft's is NEVER run: $($r.Status) $($script:events -join ',')"
    Assert (-not (Test-Path -LiteralPath $file)) 'the refused file is removed'

    Reset; $script:runCode=1603
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'install-failed' -and $r.Detail -match 'ended with code 1603$') "the runtime is measured again, not trusted: $($r.Status) $($r.Detail)"

    # exit code 0 with the files still old is not success
    Reset
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'install-failed' -and $r.Detail -match 'ended with code 0$') "a clean exit that changed nothing is a failure: $($r.Status)"

    Reset; $script:runCode=3010
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'restart-required') "files still old after 3010: $($r.Status)"
    Reset; $script:runCode=3010; $script:afterRun={ Set-Versions ([version]'14.51.0.0') ([version]'14.51.0.0') ([version]'14.51.0.0') }
    Assert ((Invoke-VcRuntimeEnsure -WorkDir $root).Status -ceq 'installed') '3010 with the new files in place is installed'

    Reset; $script:afterRun={ throw 'The operation was canceled by the user' }
    $r=Invoke-VcRuntimeEnsure -WorkDir $root
    Assert ($r.Status -ceq 'install-failed' -and $r.Detail -match 'could not be started: The operation was canceled') "a declined approval: $($r.Status) $($r.Detail)"
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output "vc-runtime: $script:checks checks passed"
