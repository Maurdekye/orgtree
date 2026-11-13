import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { TAILNET_REMOTE, elevated, psQuote } from './phonefirewall'
import type { PhoneFirewallResult } from './phonefirewall'
import { exeName } from './postgres-runtime'
import { run } from './runasadmin'
import type { Runner } from './runasadmin'

/** Remote access (a desktop lets other computers open some of its
 *  organizations; docs/rust-engine/remote-org.md, "A desktop as host"): the
 *  inbound Windows Firewall rules for the engine's remote door.
 *
 *  One rule lets Tailscale's addresses reach the door's port, for the engine
 *  program only. A second one, only when the owner chose "and this private
 *  network", lets the local subnet reach it on Private networks. Nothing ever
 *  lets a public address in, and nothing is added for every program.
 *
 *  Adding or removing a rule needs administrator rights, so it goes through
 *  ONE UAC prompt here, in the desktop, as the phone door's rule does
 *  (phonefirewall.ts): the engine may run where there is no desktop to show a
 *  prompt on. The engine only reads the rules back
 *  (engine/rs/orgtree-engine/src/remote_access/firewall.rs, which knows them
 *  by these two names). */

export const REMOTE_RULE = 'Orgtree remote access'
export const REMOTE_RULE_LAN = 'Orgtree remote access (private network)'

/** A port the door may have: what the engine takes (`PUT /api/remote-access`). */
export function validDoorPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535
}

/** The engine's program, as main itself finds it (never a path the renderer
 *  sent: it goes into an elevated script). The same finding as the launch's
 *  (index.ts): the rule has to name the program that listens. */
export function engineProgram(): string | undefined {
  const program = process.env.ORGTREE_ENGINE_BIN
    || (app.isPackaged ? path.join(process.resourcesPath, 'engine', exeName('orgtree-engine')) : '')
  return program && path.isAbsolute(program) && fs.existsSync(program) ? program : undefined
}

/** The script the ELEVATED PowerShell runs: replace the rules. */
export function remoteFirewallScript(port: number, lan: boolean, program: string): string {
  if (!validDoorPort(port)) throw new Error('Invalid port')
  const rule = (name: string, description: string, remote: string, profile: string) =>
    `New-NetFirewallRule -DisplayName '${name}' -Description '${description}'`
    + ` -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress ${remote} -Profile ${profile}`
    + ` -Program ${psQuote(program)} | Out-Null`
  return [
    "$ErrorActionPreference = 'Stop'",
    `Remove-NetFirewallRule -DisplayName '${REMOTE_RULE}' -ErrorAction SilentlyContinue`,
    `Remove-NetFirewallRule -DisplayName '${REMOTE_RULE_LAN}' -ErrorAction SilentlyContinue`,
    rule(REMOTE_RULE, 'Lets the computers you added open the organizations you share from this computer, over Tailscale. Added by Remote access.', TAILNET_REMOTE, 'Any'),
    ...(lan ? [rule(REMOTE_RULE_LAN, 'Lets the computers you added open the organizations you share from this computer, on this private network. Added by Remote access.', 'LocalSubnet', 'Private')] : []),
  ].join('\n')
}

/** The script that removes both rules (nothing is shared any more). */
export function remoteFirewallRemoveScript(): string {
  return [
    `Remove-NetFirewallRule -DisplayName '${REMOTE_RULE}' -ErrorAction SilentlyContinue`,
    `Remove-NetFirewallRule -DisplayName '${REMOTE_RULE_LAN}' -ErrorAction SilentlyContinue`,
  ].join('\n')
}

export async function addRemoteFirewallRule(port: number, lan: boolean, runner: Runner = run, program = engineProgram()): Promise<PhoneFirewallResult> {
  if (!validDoorPort(port)) return { ok: false, declined: false, error: 'The port is a number from 1024 to 65535.' }
  // never a rule for every program: without the engine's path, nothing is added
  if (!program) return { ok: false, declined: false, error: "Orgtree's engine program was not found, so the firewall rule was not added." }
  const r = await elevated(remoteFirewallScript(port, lan, program), 'added', runner)
  return !r.ok && r.declined ? { ...r, error: 'Nothing changed: Windows Firewall stays as it was.' } : r
}

export async function removeRemoteFirewallRule(runner: Runner = run): Promise<PhoneFirewallResult> {
  return elevated(remoteFirewallRemoveScript(), 'removed', runner)
}
