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
$script:baseRegister=$script:folder.PSObject.Methods['RegisterTask'].Script
function Reset-Pair {
    $script:folder | Add-Member -Force ScriptMethod RegisterTask $script:baseRegister
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
    Assert (-not $script:task.Enabled -and -not $script:helper.Enabled) 'Deferred Register permits automatic task launches before commit'
    Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Register launched before commit'
    Invoke-BootLifecycle Commit $dir
    Assert ($script:task.Enabled -and $script:helper.Enabled) 'Commit left tasks disabled'
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
Case 'next Prepare replaces a retained snapshot before a later copy failure' {
    Reset-Pair
    $null=Invoke-BootLifecycle Prepare $dir $sid
    # Installer A was killed or could not restore. A subsequent operator
    # repair changes startup and rights without changing the installation Id.
    $script:rollback=ConvertFrom-Json (ConvertTo-Json -InputObject $script:rollback -Depth 8 -Compress)
    $script:record.RunOnStartup=0
    $script:task=New-FakeTask (New-BootTaskXml $script:record $true)
    $script:task.Definition.Principal.RunLevel=1
    $script:task.Sddl="O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;$sid)"
    $script:helper=New-HelperFake (New-HelperTaskXml $script:record $true)
    $script:helper.Enabled=$false
    $script:helper.Sddl="O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GX;;;$sid)"
    $beforeBoot=$script:task.Xml;$beforeHelper=$script:helper.Xml
    $beforeAcl=$script:task.Sddl;$beforeHelperAcl=$script:helper.Sddl
    $script:events.Clear();$script:bootLog.Clear()
    $decision=Invoke-BootLifecycle Prepare $dir $sid
    Assert ($decision -match 'replaced retained rollback snapshot with current verified task state') 'Replacement decision is absent from the captured installer result'
    Assert (@($script:bootLog -like 'prepare: replaced retained rollback snapshot*').Count -eq 1) 'Replacement decision was not logged durably'
    $script:rollback=ConvertFrom-Json (ConvertTo-Json -InputObject $script:rollback -Depth 8 -Compress)
    Assert ($script:rollback.Tasks[0].Xml -ceq $beforeBoot) 'Prepare retained the older transaction baseline'
    # Installer B now fails during copy. It restores B, never A.
    Invoke-BootLifecycle Rollback $dir
    Assert ($script:task.Xml -ceq $beforeBoot -and $script:helper.Xml -ceq $beforeHelper) 'Later failure undid the intervening startup or administrator choice'
    Assert ($script:task.Enabled -and -not $script:helper.Enabled -and $script:task.Sddl -ceq $beforeAcl) 'Later failure lost current enablement or ACL'
    Assert ($script:helper.Sddl -ceq $beforeHelperAcl) 'Later failure lost the current helper ACL'
    Assert ($script:record.RunOnStartup -eq 0) 'Later failure changed the recorded operator choice'
    Assert ($null -eq $script:rollback) 'Successful replacement rollback retained a snapshot'
    Assert (-not @($script:events|Where-Object {$_ -match '^(run|helper-run)$'}).Count) 'Replacement or rollback started a task'
}
Case 'failed fresh baseline persistence never replays the retained snapshot' {
    Reset-Pair
    Invoke-BootLifecycle Prepare $dir $sid
    $retained=$script:rollback
    $script:record.RunOnStartup=0
    $script:task=New-FakeTask (New-BootTaskXml $script:record)
    $script:helper=New-HelperFake (New-HelperTaskXml $script:record)
    $beforeBoot=$script:task.Xml;$beforeHelper=$script:helper.Xml
    $script:events.Clear()
    function Save-BootInstallSnapshot($Snapshot) { throw 'injected snapshot persistence failure' }
    Refuses { Invoke-BootLifecycle Prepare $dir $sid } 'injected snapshot persistence failure'
    Assert ([object]::ReferenceEquals($retained,$script:rollback)) 'Preflight failure discarded the retained snapshot'
    Assert ($script:task.Xml -ceq $beforeBoot -and $script:helper.Xml -ceq $beforeHelper) 'Preflight failure replayed the old snapshot'
    Assert ($script:task.Enabled -and $script:helper.Enabled) 'Preflight failure suspended tasks'
    Assert (-not @($script:events|Where-Object {$_ -match 'stop|register:|^(run|helper-run)$'}).Count) 'Preflight failure mutated current tasks'
}
$results | ConvertTo-Json -Depth 5
if(@($results|Where-Object {-not $_.pass}).Count) { exit 1 }
