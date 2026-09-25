param([string]$Features = "")
# THROWAWAY WS6 spike: build pg_walstream and sample memory every 2 s.
$ErrorActionPreference = 'Continue'
$env:CARGO_BUILD_JOBS = '4'
$env:CARGO_TARGET_DIR = 'E:\Libraries\Desktop\orgtree\.worktrees\p03-ws6-spike\artifacts\cargo-target'
Set-Location 'E:\Libraries\Desktop\orgtree\.worktrees\p03-ws6-spike\engine\native\ws6-spike'
$args2 = @('build')
if ($Features) { $args2 += @('--no-default-features', '--features', $Features) }
$log = Join-Path $env:CARGO_TARGET_DIR ('build-' + (Get-Date -Format 'HHmmss') + '.log')
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
$p = Start-Process -FilePath cargo -ArgumentList $args2 -NoNewWindow -PassThru -RedirectStandardError $log
$minFree = [double]::MaxValue; $peakWs = 0; $samples = 0
while (-not $p.HasExited) {
  $free = (Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory / 1MB
  if ($free -lt $minFree) { $minFree = $free }
  $ws = (Get-Process -Name rustc, cl, link, cmake, cargo, 'build-script-build', nasm -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
  if ($ws -gt $peakWs) { $peakWs = $ws }
  $samples++
  Start-Sleep -Seconds 2
}
$p.WaitForExit()
"exit={0} samples={1} min_free_commit_gb={2:N2} peak_build_ws_gb={3:N2} log={4}" -f $p.ExitCode, $samples, $minFree, ($peakWs / 1GB), $log
Get-Content $log -Tail 25
exit $p.ExitCode
