// remoteaccess.ts — remote access: what this desktop lets other computers open
// (docs/rust-engine/remote-org.md, "A desktop as host").
// Not built yet: this is the shape the test is written against.

export type FirewallState = 'none' | 'unknown' | 'ok' | 'missing'
export interface DoorAddress { kind: 'tailscale' | 'lan' | 'rig'; ip: string; port: number; url: string; encrypted: boolean }
export interface DoorView {
  state: 'closed' | 'open' | 'waiting' | 'blocked'
  reason: string | null
  addresses: DoorAddress[]
  port: number
  lan: boolean
  firewall?: { state: FirewallState; present: boolean }
}
export interface ConnectedView { id: string; label: string; name: string; since: string | null }
export interface SharedOrgView { slug: string; name: string; on: boolean; computers: number; connected: number; connected_now: ConnectedView[] }
export interface RemoteAccessView { computer: string; port: number; default_port: number; lan: boolean; orgs: SharedOrgView[]; door: DoorView }
export interface ComputerView {
  id: string; name: string; label: string; orgs: string[]; created_at: string
  connected: boolean; connected_since: string | null; last_seen_at: string | null
}
export interface OpenCodeView { id: string; created_at: string; expires_at: string }
export interface OrgAccessView {
  slug: string; on: boolean; door: DoorView; computers: ComputerView[]; known: ComputerView[]; invitations: OpenCodeView[]
  limits: { computers: number; invitations: number; minutes: number }
  refusal?: string | null
}
type Bridge = unknown

export const wantsFirewallRule = (_door: DoorView, _bridge: Bridge): boolean => false
export const turnOnOrgAccess = async (_slug: string, _bridge?: Bridge): Promise<{ view: OrgAccessView } | { refused: string }> => ({ refused: '' })
export const allowDoor = async (_door: DoorView, _bridge?: Bridge): Promise<string | null> => ''
export const doorTrouble = (_door: DoorView): string | null => ''
export const addressNote = (_address: Pick<DoorAddress, 'kind'>): string => ''
export const computerSeen = (_computer: unknown, _time: (iso: string) => string, _day: (iso: string) => string): string => ''
export const addressAndCode = (_url: string, _code: string): string => ''
export const connectedChip = (_org: unknown): { text: string; title: string } | null => null
export const changeListening = async (_now: RemoteAccessView, _patch: unknown, _bridge?: Bridge): Promise<{ view: RemoteAccessView } | { refused: string }> => ({ refused: '' })
export const removeDoorRules = async (_bridge?: Bridge): Promise<string | null> => ''
export const doorWord = (_door: Pick<DoorView, 'state'>): string => ''
export const computersWord = (_org: unknown): string => ''
export const validPort = (_port: number): boolean => false
