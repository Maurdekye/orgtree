param([ValidateSet('base','tip')][string]$Arm='tip', [switch]$SkipPython)
$ErrorActionPreference = 'Stop'
$repo = 'E:\Libraries\Desktop\orgtree\.worktrees\scale-ui-astra'
$checkout = if ($Arm -eq 'base') { 'E:\Libraries\Desktop\orgtree\.worktrees\scale-ui-tree-base' } else { $repo }
$python = 'E:\Libraries\Desktop\orgtree\engine\runtime\python.exe'
$out = Join-Path $repo '.scale-results'
$modules = @('tests/test_latency_tier1.py','tests/test_archived_summary.py','tests/test_pgfeed.py','tests/test_scale_ui_mix.py')
$renderer = @('treecache','treesync','treestatus','archivedsummary')
if ($Arm -eq 'tip') {
    $modules += @('tests/test_tree_delta.py','tests/test_tree_ui.py')
    $renderer += 'treedelta'
}
Push-Location $checkout
try {
    # Windows PowerShell treats native stderr as ErrorRecord under Stop, even
    # when the runner emits an informational memory-limit line and exits zero.
    $ErrorActionPreference = 'Continue'
    if (-not $SkipPython) {
    & $python tools/run-python-verification.py --pycache-dir off @modules --json-output (Join-Path $out "tree-python-$Arm.json") *> (Join-Path $out "tree-python-$Arm.log")
    if ($LASTEXITCODE -ne 0) { throw "Python $Arm failed; inspect receipt" }
    }
    & node apps/desktop/renderer/tests/run.mjs @renderer *> (Join-Path $out "tree-renderer-$Arm.log")
    if ($LASTEXITCODE -ne 0) { throw "Renderer $Arm failed; inspect log" }
    & node E:/Libraries/Desktop/orgtree/node_modules/typescript/bin/tsc --noEmit *> (Join-Path $out "tree-types-$Arm.log")
    if ($LASTEXITCODE -ne 0) { throw "TypeScript $Arm failed; inspect log" }
} finally { Pop-Location }
