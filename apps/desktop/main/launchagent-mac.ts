// launchagent-mac.ts — the macOS per-user LaunchAgent lifecycle for the boot
// engine, replacing the Windows Scheduled Task equivalent
// (tools/register-boot-engine.ps1 / unregister-boot-engine.ps1 /
// boot-engine-task.ps1) with launchd's own primitives (D-01 through D-05,
// .planning/phases/03-launchd-autostart/03-CONTEXT.md).
//
// Zero Electron imports at module scope, matching process-failure.ts's
// zero-import precedent, so this bundles standalone for tests and for the
// real disruptive bootstrap/bootout round-trip in
// tests/disruptive/launchagent-install.test.mjs.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Reverse-DNS Label namespaced under the app's own appId
// (`com.maurdekye.orgtree`, package.json:57), matching Apple's documented
// convention that a launchd property list is named `<Label>.plist`
// [VERIFIED: man launchd.plist(5), local]. Replaces the Windows task name
// `'Orgtree Background Engine'` (tools/boot-engine-task.ps1:3).
export const LABEL = 'com.maurdekye.orgtree.boot-engine'

export type AutostartState = 'ok' | 'not-installed' | 'disabled' | 'unknown'

export interface PlistOptions {
  label: string
  pythonPath: string
  entrypointPath: string
  workingDirectory: string
  stdoutLog: string
  stderrLog: string
}

/** The packaged macOS Python interpreter subpath, isolated to this one
 *  function so a single edit fixes it if the runtime layout ever changes
 *  (Open Question 1, 03-RESEARCH.md).
 *
 *  VERIFIED against apps/desktop/main/engine.ts:77-79's
 *  `resolvePackagedPythonPath`, which Phase 1 packaging already ships for
 *  darwin: `path.join(directory, 'runtime', 'bin', 'python3.13')` — the
 *  python-build-standalone `install_only` layout resolves to a
 *  version-suffixed interpreter, not the earlier-assumed unversioned
 *  `python3`. Kept as a separate function (rather than importing engine.ts)
 *  so this module stays a standalone, Electron-free bundle. */
export function resolveMacEnginePythonPath(directory: string): string {
  return path.join(directory, 'runtime', 'bin', 'python3.13')
}

/** Escape every value interpolated into the plist XML template — labels and
 *  paths originate from app-controlled sources, never external input, but
 *  are still XML content (T-03-01). */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Builds the plist XML matching the verified key set from
 *  03-RESEARCH.md's Pattern 1 (`man launchd.plist(5)`, local). KeepAlive is
 *  always `{SuccessfulExit: false}`, never a bare `true` — required to match
 *  the engine's own shutdown contract: "Requested shutdown exits 0 so
 *  restart-on-failure settings do not resurrect a deliberately stopped
 *  engine; engine failure exits nonzero." (docs/engine-contract.md:16). A
 *  bare `KeepAlive: true` would respawn the engine even after a deliberate,
 *  successful stop. */
export function buildPlist(options: PlistOptions): string {
  const { label, pythonPath, entrypointPath, workingDirectory, stdoutLog, stderrLog } = options
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(pythonPath)}</string>
        <string>${xmlEscape(entrypointPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrLog)}</string>
</dict>
</plist>
`
}

/** launchd only auto-rescans `~/Library/LaunchAgents` (and the other paths
 *  in `man launchd.plist(5)`'s FILES section) at next login — bootstrapping
 *  a plist from anywhere else only starts it for the current session and
 *  will not survive a reboot (Pitfall 2). `install()` below always writes
 *  here before ever calling `bootstrap`. */
export function plistPath(label: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** Writes the plist to the canonical LaunchAgents path, lints it (D-03 —
 *  `plutil -lint` throws on a nonzero exit, which IS the lint gate, no
 *  separate check needed), then bootstraps it into the user's GUI domain.
 *  Never `launchctl load` (D-02) — `bootstrap`/`bootout` only. */
export function install(options: PlistOptions & { uid?: number }): void {
  const uid = options.uid ?? process.getuid!()
  const target = plistPath(options.label)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buildPlist(options))
  execFileSync('plutil', ['-lint', target])
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, target])
}

/** Removes the LaunchAgent via `bootout` (never `unload`, D-02) and deletes
 *  its plist. Bootout on an already-removed job is not a failure this
 *  function needs to surface — the goal state (not installed) is already
 *  reached. */
export function uninstall(label: string, uid?: number): void {
  const resolvedUid = uid ?? process.getuid!()
  try {
    execFileSync('launchctl', ['bootout', `gui/${resolvedUid}/${label}`])
  } catch {
    // already removed, or never installed — nothing left to surface
  }
  fs.rmSync(plistPath(label), { force: true })
}

/** Best-effort: does a `sfltool dumpbtm` block for this label carry a
 *  `Disposition:` that includes `disallowed`? `sfltool` is undocumented and
 *  private (Pitfall 4) — this is enrichment only, never the sole signal,
 *  and callers must treat any error here as "no match", not "disabled". */
function btmDisallowsLabel(dumpbtmOutput: string, label: string): boolean {
  return dumpbtmOutput
    .split(/\n\s*\n/)
    .some(block => block.includes(label) && /Disposition:.*disallowed/i.test(block))
}

/** Three-layer, exit-code-first classification (Pattern 3, corrected from
 *  D-04). `launchctl print`'s exit code is the primary, stable signal
 *  (Pitfall 4 — its stdout text is explicitly disclaimed as unstable by
 *  Apple and must never be parsed as a contract). `print-disabled` is the
 *  secondary signal for launchd's own persistent, re-enableable disable.
 *  `sfltool dumpbtm`'s BTM disable is the tertiary, best-effort signal for
 *  the case with no programmatic re-enable (D-04's real match). Never
 *  throws. */
export function detectState(
  label: string,
  deps: { execFileSyncImpl?: typeof execFileSync; uid?: number } = {},
): AutostartState {
  const uid = deps.uid ?? process.getuid!()
  const exec = deps.execFileSyncImpl ?? execFileSync

  try {
    exec('launchctl', ['print', `gui/${uid}/${label}`])
  } catch {
    return 'not-installed'
  }

  let printDisabledOutput: string
  try {
    printDisabledOutput = exec('launchctl', ['print-disabled', `gui/${uid}`]).toString()
  } catch {
    // print-disabled succeeding is what makes 'ok' trustworthy below — a
    // failed call here must not fall through to 'ok'.
    return 'unknown'
  }
  if (printDisabledOutput.includes(label)) return 'disabled'

  try {
    const dumpbtmOutput = exec('sfltool', ['dumpbtm']).toString()
    if (btmDisallowsLabel(dumpbtmOutput, label)) return 'disabled'
  } catch {
    // sfltool absent or unparsable — never propagates or downgrades the
    // result; falls through to 'ok'.
  }

  return 'ok'
}

/** Where a user goes to fix either state below. */
export const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

/** Content for the remediation dialog, mirroring process-failure.ts's
 *  `crashReportDialog` pure-function shape exactly so a caller (Plan 02)
 *  wires it through `dialog.showMessageBox(...)` the same way index.ts
 *  already wires `showCrashReports` (index.ts:142-151). */
export function autostartRemediationDialog(
  state: 'not-installed' | 'disabled',
): { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number } {
  return {
    message: state === 'disabled'
      ? "macOS has turned off Orgtree's automatic startup at login."
      : 'Orgtree could not confirm its automatic startup at login is installed.',
    detail: 'Open System Settings → Login Items & Extensions and allow Orgtree in the background to restore automatic startup.',
    buttons: ['Open Login Items Settings', 'Close'],
    defaultId: 0,
    cancelId: 1,
  }
}
