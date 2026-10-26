# All task/registry/process boundaries come from the existing in-memory fixture.
# Only its setup is evaluated; its test body is never run here.
$ErrorActionPreference='Stop'
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'boot-installer.test.ps1'))
$prefix=$fixture.Substring(0,$fixture.IndexOf('# Per-user positive path:'))
$lifecycle=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../tools/boot-engine-task.ps1')).Path.Replace("'","''")
$prefix=$prefix.Replace('. "$PSScriptRoot\..\tools\boot-engine-task.ps1"',". '$lifecycle'")
Invoke-Expression $prefix
$paths=Get-BootPaths $dir
[IO.Directory]::CreateDirectory((Split-Path $paths.Python)) | Out-Null
[IO.File]::WriteAllText($paths.Python,'synthetic; never executed')
[IO.File]::WriteAllText($paths.Host,'synthetic; never executed')
[IO.File]::WriteAllText((Get-HelperPath $dir),'synthetic; never executed')
$results=[Collections.Generic.List[object]]::new()
function Case([string]$Name,[scriptblock]$Body) {
    try { & $Body; $results.Add(@{name=$Name;pass=$true}) }
    catch { $results.Add(@{name=$Name;pass=$false;message=$_.Exception.Message}) }
}
# Persistence is a separate protected-registry boundary. The transaction must
# never query/write the real machine from this fixture.
$script:rollback=$null
function Get-BootInstallSnapshot { return $script:rollback }
function Save-BootInstallSnapshot($Snapshot) { $script:rollback=$Snapshot }
function Remove-BootInstallSnapshot { $script:rollback=$null }
function Reset-Pair {
    $script:record=$original.Clone();$script:record.RunOnStartup=1
    $script:task=New-FakeTask ((New-BootTaskXml $script:record).Replace('<BootTrigger><Enabled>true</Enabled>','<BootTrigger><Enabled>false</Enabled>'))
    $script:helper=New-HelperFake (New-HelperTaskXml $script:record)
    $script:signin=$null;$script:interactive=$null;$script:rollback=$null
    $script:events.Clear();$script:processes=@()
}
# Validate restoration of mixed enable/trigger choices, including a task that
# was already disabled before Setup. Register's rollback may restore XML too.
foreach($stage in @('Prepare','Copy','Register')) {
    Case "failure after $stage restores both tasks without starting either" {
        Reset-Pair
        $script:helper.Enabled=$false
        $beforeBoot=$script:task.Xml;$beforeHelper=$script:helper.Xml
        Invoke-BootLifecycle Prepare $dir $sid
        # Prepare and Register are different PowerShell processes in Setup.
        $script:rollback=ConvertFrom-Json (ConvertTo-Json -InputObject $script:rollback -Depth 8 -Compress)
        if($stage -eq 'Register') {
            # Run the real Register path over empty synthetic payload files.
            # NSIS defers the launches until its final commit, so a later
            # copy/registry failure can restore states without any start.
            Invoke-BootLifecycle Register $dir -DeferStart
            Assert (@($script:events|Where-Object {$_ -eq 'register:20'}).Count -eq 1) 'Actual Register did not execute'
            Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Register started tasks before installer commit'
        }
        Invoke-BootLifecycle Rollback $dir $sid
        Assert $script:task.Enabled 'Boot task left disabled after failure'
        Assert (-not $script:helper.Enabled) 'Already-disabled helper was incorrectly enabled'
        Assert ($script:task.Xml -ceq $beforeBoot -and $script:helper.Xml -ceq $beforeHelper) 'Original trigger/definition state was lost'
        Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Rollback started tasks'
    }
}
Case 'Prepare failure restores helper as well as boot task' {
    Reset-Pair
    function Save-BootRecord($Record) { throw 'injected prepare persistence failure' }
    try { Invoke-BootLifecycle Prepare $dir $sid } catch { Assert ($_.Exception.Message -match 'injected prepare') 'Injection did not run' }
    Assert ($script:task.Enabled -and $script:helper.Enabled) 'Prepare failure left a paired task disabled'
}
Case 'Commit alone starts helper then boot once; Register never starts either' {
    Reset-Pair
    Invoke-BootLifecycle Prepare $dir $sid
    Invoke-BootLifecycle Register $dir -DeferStart
    Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Register launched before commit'
    Invoke-BootLifecycle Commit $dir
    $starts=@($script:events|Where-Object {$_ -match '^(run|helper-run)$'})
    Assert ($starts.Count -eq 2 -and $starts[0] -eq 'helper-run' -and $starts[1] -eq 'run') 'Commit did not start helper then boot'
    Invoke-BootLifecycle Commit $dir
    Assert (@($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count -eq 2) 'Repeated Commit started tasks twice'
    Assert ($null -eq $script:rollback) 'Commit retained active snapshot'
}
Case 'actual partial Register failure restores original pair before any task starts' {
    Reset-Pair
    $script:helper.Enabled=$false
    $beforeBoot=$script:task.Xml;$beforeHelper=$script:helper.Xml
    Invoke-BootLifecycle Prepare $dir $sid
    $originalHelperRegister=${function:Register-HelperTask}
    function Register-HelperTask($Folder,[string]$Xml,[int]$Flags,[string]$Sid,[string]$Sddl) {
        if($Flags -eq 20) { throw 'injected Register helper failure' }
        & $originalHelperRegister $Folder $Xml $Flags $Sid $Sddl
    }
    Refuses { Invoke-BootLifecycle Register $dir -DeferStart } 'injected Register helper failure'
    Assert ($script:task.Enabled -and -not $script:helper.Enabled) 'Partial Register lost prior task enablement'
    Assert ($script:task.Xml -ceq $beforeBoot -and $script:helper.Xml -ceq $beforeHelper) 'Partial Register lost original triggers'
    Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Partial Register started a task'
}
Case 'one failed restore still restores the other task and retains the snapshot' {
    Reset-Pair
    Invoke-BootLifecycle Prepare $dir $sid
    $script:folder | Add-Member -Force ScriptMethod RegisterTask { throw 'injected boot restore failure' }
    Refuses { Invoke-BootLifecycle Rollback $dir } 'injected boot restore failure'
    Assert $script:helper.Enabled 'Boot restore failure prevented helper restoration'
    Assert ($null -ne $script:rollback) 'Failed restore discarded its snapshot'
    Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Failed restore started a task'
}
$results | ConvertTo-Json -Depth 5
if(@($results|Where-Object {-not $_.pass}).Count) { exit 1 }
