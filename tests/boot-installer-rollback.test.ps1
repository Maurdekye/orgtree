# All task/registry/process boundaries come from the existing in-memory fixture.
# Only its setup is evaluated; its test body is never run here.
$ErrorActionPreference='Stop'
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'boot-installer.test.ps1'))
$prefix=$fixture.Substring(0,$fixture.IndexOf('# Per-user positive path:'))
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
$results | ConvertTo-Json -Depth 5
if(@($results|Where-Object {-not $_.pass}).Count) { exit 1 }
