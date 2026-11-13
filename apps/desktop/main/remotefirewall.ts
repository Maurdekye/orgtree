import type { PhoneFirewallResult } from './phonefirewall'
import type { Runner } from './runasadmin'

/** Remote access: the Windows Firewall rules for the engine's remote door.
 *  Not built yet: this is the shape the test is written against. */

export const REMOTE_RULE = ''
export const REMOTE_RULE_LAN = ''

export function validDoorPort(port: unknown): port is number {
  return false
}

export function engineProgram(): string | undefined {
  return undefined
}

export function remoteFirewallScript(_port: number, _lan: boolean, _program: string): string {
  return ''
}

export function remoteFirewallRemoveScript(): string {
  return ''
}

export async function addRemoteFirewallRule(_port: number, _lan: boolean, _runner?: Runner, _program?: string): Promise<PhoneFirewallResult> {
  return { ok: false, declined: false, error: 'not built' }
}

export async function removeRemoteFirewallRule(_runner?: Runner): Promise<PhoneFirewallResult> {
  return { ok: false, declined: false, error: 'not built' }
}
