import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { POWERSHELL, UAC_CANCELLED, run } from './runasadmin'
import type { Runner } from './runasadmin'

/** "Chat from your phone" › Turn on phone access: one inbound Windows
 *  Firewall rule for the mail hub's relay-only door (port 7371), for the hub
 *  program only, limited to Tailscale's addresses, or to the local subnet on
 *  Private networks for "Use my home Wi-Fi instead". Adding or removing it
 *  needs administrator rights, so it goes through ONE UAC prompt here, in
 *  the desktop: the engine may run under the boot task's S4U logon, which
 *  has no desktop to show a prompt on. The engine only reads the rule back
 *  (engine/rs/orgtree-engine/src/phone.rs). */

export const PHONE_RULE = 'Orgtree phone access'
export const PHONE_DOOR_PORT = 7371
/** Tailscale's address ranges: its CGNAT IPv4 block and its ULA IPv6 prefix. */
export const TAILNET_REMOTE = '100.64.0.0/10,fd7a:115c:a1e0::/48'
export type PhoneScope = 'tailnet' | 'lan'

export function phoneRemote(scope: PhoneScope): string {
  return scope === 'tailnet' ? TAILNET_REMOTE : 'LocalSubnet'
}

/** A PowerShell single-quoted literal. PowerShell takes ' and the typographic
 *  single quotes (U+2018, U+2019, U+201A, U+201B) alike as its quote, and
 *  each is escaped by doubling it. */
export function psQuote(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, q => q + q)}'`
}

/** The mail hub's program, as main itself finds it (never a path the
 *  renderer sent: it goes into an elevated script). */
export function phoneHubProgram(): string | undefined {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'engine', 'orgtree-mailhub.exe') : '',
    process.env.ORGTREE_HUB_BIN ?? '',
  ]
  return candidates.find(p => p && path.isAbsolute(p) && fs.existsSync(p))
}

/** The script the ELEVATED PowerShell runs: replace the rule. */
export function phoneFirewallScript(scope: PhoneScope, program: string): string {
  const profile = scope === 'lan' ? 'Private' : 'Any'
  return [
    "$ErrorActionPreference = 'Stop'",
    `Remove-NetFirewallRule -DisplayName '${PHONE_RULE}' -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName '${PHONE_RULE}' -Description 'Lets Hubchat on your phone reach the Orgtree mail hub (its relay-only door). Added by Connect your phone.'`
      + ` -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PHONE_DOOR_PORT} -RemoteAddress ${phoneRemote(scope)} -Profile ${profile}`
      + ` -Program ${psQuote(program)} | Out-Null`,
  ].join('\n')
}

/** The script that removes the rule (phone access turned off). */
export function phoneFirewallRemoveScript(): string {
  return `Remove-NetFirewallRule -DisplayName '${PHONE_RULE}' -ErrorAction SilentlyContinue`
}

/** The NON-elevated command that asks Windows (UAC) to run `script`
 *  elevated and returns its exit code; a declined prompt exits UAC_CANCELLED. */
export function elevatedArgs(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const launcher = [
    'try {',
    `  $p = Start-Process -FilePath '${POWERSHELL}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e -and -not ($e -is [ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    `  if ($e -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }`,
    '  exit 2',
    '}',
  ].join('\n')
  return ['-NoProfile', '-NonInteractive', '-Command', launcher]
}

export function phoneFirewallArgs(scope: PhoneScope, program: string): string[] {
  return elevatedArgs(phoneFirewallScript(scope, program))
}

/** What the prompt came to: `declined` is the user's No (nothing changed). */
export type PhoneFirewallResult = { ok: true } | { ok: false; declined: boolean; error: string }

async function elevated(script: string, what: string, runner: Runner): Promise<PhoneFirewallResult> {
  if (process.platform !== 'win32') return { ok: false, declined: false, error: 'Only Windows has this firewall.' }
  // the user may take a while at the UAC prompt
  const result = await runner(POWERSHELL, elevatedArgs(script), 5 * 60_000)
  if (result.code === UAC_CANCELLED) return { ok: false, declined: true, error: 'Nothing changed: the firewall stays as it was.' }
  if (result.code !== 0) return { ok: false, declined: false, error: `The firewall rule could not be ${what} (exit code ${result.code}).` }
  return { ok: true }
}

export async function addPhoneFirewallRule(scope: PhoneScope, runner: Runner = run, program = phoneHubProgram()): Promise<PhoneFirewallResult> {
  // never a rule for every program: without the hub's path, nothing is added
  if (!program) return { ok: false, declined: false, error: "Orgtree's mail hub program was not found, so the firewall rule was not added." }
  const r = await elevated(phoneFirewallScript(scope, program), 'added', runner)
  // the panel's own words for a declined "Turn on phone access"
  return !r.ok && r.declined ? { ...r, error: 'Nothing changed: phone access stays as it was.' } : r
}

export async function removePhoneFirewallRule(runner: Runner = run): Promise<PhoneFirewallResult> {
  return elevated(phoneFirewallRemoveScript(), 'removed', runner)
}
