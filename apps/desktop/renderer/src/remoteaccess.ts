// remoteaccess.ts — remote access: what this desktop lets other computers open
// (docs/rust-engine/remote-org.md, "A desktop as host").
//
// The overview is a pushed app-feed value (`remote_access`): where the door
// stands, what Windows Firewall says, and per organization the switch and who
// is connected now. Only a desktop's own engine publishes it, so its absence
// is how a window knows there is nothing to offer (a standalone engine, an
// engine from before this). One organization's computers and codes come from
// the owner's routes, which no other computer can reach.
import { req } from './api'
import { useAppValue } from './appfeed'
import { desktop } from './desktop'

export type FirewallState = 'none' | 'unknown' | 'ok' | 'missing'

/** One address the door stands at, as the other computer types it. */
export interface DoorAddress {
  kind: 'tailscale' | 'lan' | 'local' | 'rig'
  ip: string
  port: number
  url: string
  /** true on Tailscale only: plain http on a private network is not encrypted */
  encrypted: boolean
}

export interface DoorView {
  /** closed: nothing is shared · open · waiting: nowhere to stand · blocked: the port is taken */
  state: 'closed' | 'open' | 'waiting' | 'blocked'
  reason: string | null
  addresses: DoorAddress[]
  port: number
  /** where the owner lets it listen; `tailscale` and `local` are absent from an engine before
   *  the three were choices of their own, where Tailscale was always one */
  tailscale?: boolean
  lan: boolean
  local?: boolean
  /** what the engine read of the door's Windows Firewall rules (absent from an engine before it) */
  firewall?: { state: FirewallState; present: boolean }
}

export interface ConnectedView { id: string; label: string; name: string; since: string | null }

export interface SharedOrgView {
  slug: string
  name: string
  on: boolean
  computers: number
  connected: number
  connected_now: ConnectedView[]
}

/** `GET /api/remote-access`, and the app value `remote_access`. */
export interface RemoteAccessView {
  computer: string
  port: number
  default_port: number
  tailscale?: boolean
  lan: boolean
  local?: boolean
  orgs: SharedOrgView[]
  door: DoorView
}

/** A computer that was let in. */
export interface ComputerView {
  id: string
  /** what it calls itself ("Orgtree desktop (<computer>)") */
  name: string
  /** the name others see beside what it does */
  label: string
  /** the organizations it has here, by slug */
  orgs: string[]
  created_at: string
  connected: boolean
  connected_since: string | null
  last_seen_at: string | null
}

export interface OpenCodeView { id: string; created_at: string; expires_at: string }

/** `GET /api/remote-access/orgs/{slug}`. */
export interface OrgAccessView {
  slug: string
  on: boolean
  door: DoorView
  computers: ComputerView[]
  /** computers that have another organization of this computer: they can be given this one without a code */
  known: ComputerView[]
  invitations: OpenCodeView[]
  limits: { computers: number; invitations: number; minutes: number }
  /** with `fresh` only: the sentence turning the switch on would be refused with now, or null */
  refusal?: string | null
}

/** A one-time code. It is in this answer and nowhere else. */
export interface CodeView { id: string; code: string; created_at: string; expires_at: string; minutes: number; door: DoorView }

/** What this desktop shares, or null where there is nothing to offer. */
export const useRemoteAccess = (): RemoteAccessView | null => useAppValue<RemoteAccessView>('remote_access') ?? null

const at = (slug: string) => `/api/remote-access/orgs/${encodeURIComponent(slug)}`
const json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** `fresh`: Windows Firewall is read again first, and the answer waits for it. */
export const getRemoteAccess = (fresh = false): Promise<RemoteAccessView> =>
  req('/api/remote-access' + (fresh ? '?fresh=1' : ''), undefined, 30000, [], false)
export const getOrgAccess = (slug: string, fresh = false): Promise<OrgAccessView> =>
  req(at(slug) + (fresh ? '?fresh=1' : ''), undefined, 30000, [], false)
export const switchOrgAccess = (slug: string, on: boolean): Promise<OrgAccessView> =>
  req(at(slug), json('PUT', { on }), 30000, [], false)
export const makeCode = (slug: string): Promise<CodeView> =>
  req(`${at(slug)}/invitations`, { method: 'POST' }, 30000, [], false)
export const giveComputer = (slug: string, id: string): Promise<OrgAccessView> =>
  req(`${at(slug)}/computers/${encodeURIComponent(id)}`, { method: 'PUT' }, 30000, [], false)
export const revokeComputer = (id: string): Promise<{ revoked: string }> =>
  req(`/api/remote-access/computers/${encodeURIComponent(id)}`, { method: 'DELETE' }, 30000, [], false)

/** Where the door listens: each place is chosen by itself. */
export interface ListenPatch { port?: number; tailscale?: boolean; lan?: boolean; local?: boolean }

/** The choices as they stand, with what an older engine leaves unsaid. */
export const listenOf = (view: { tailscale?: boolean; lan: boolean; local?: boolean }): { tailscale: boolean; lan: boolean; local: boolean } =>
  ({ tailscale: view.tailscale ?? true, lan: view.lan, local: view.local ?? false })

export const setListening = (patch: ListenPatch): Promise<RemoteAccessView> =>
  req('/api/remote-access', json('PUT', patch), 30000, [], false)
export const stopAllAccess = (): Promise<RemoteAccessView> =>
  req('/api/remote-access/stop', { method: 'POST' }, 30000, [], false)

type FirewallBridge = Pick<NonNullable<ReturnType<typeof desktop>>, 'addRemoteAccessFirewallRule' | 'removeRemoteAccessFirewallRule'>

/** Does the door need its Windows Firewall rules added before it is used? Only
 *  where there is a desktop to ask Windows (the bridge), and only when the
 *  engine read that they are missing, or could not read them. */
export function wantsFirewallRule(door: DoorView, bridge: FirewallBridge | undefined): boolean {
  const state = door.firewall?.state
  return !!bridge?.addRemoteAccessFirewallRule && (state === 'missing' || state === 'unknown')
}

/** Turn an organization's switch on. The order is the point:
 *  1. ask the engine, with a fresh look at this computer, whether the switch
 *     could be turned on at all (its sentence says why not), so nobody is
 *     shown an administrator prompt for nothing;
 *  2. let the door in at Windows Firewall, behind one prompt. A No leaves the
 *     switch off, as it does for phone access: a door that is bound before its
 *     rule exists makes Windows ask its own question about the whole program;
 *  3. only then the switch.
 *  Answers the new view, or the sentence to show. */
export async function turnOnOrgAccess(slug: string, bridge: FirewallBridge | undefined = desktop()):
Promise<{ view: OrgAccessView } | { refused: string }> {
  const now = await getOrgAccess(slug, true)
  if (now.refusal) return { refused: now.refusal }
  if (wantsFirewallRule(now.door, bridge)) {
    const result = await bridge!.addRemoteAccessFirewallRule!(now.door.port, now.door.lan, listenOf(now.door).tailscale)
    if (!result.ok) return { refused: result.error }
  }
  return { view: await switchOrgAccess(slug, true) }
}

/** "Allow" beside "Windows Firewall is blocking this": add the rules, then ask
 *  the engine what Windows says now. Answers the sentence to show, or null. */
export async function allowDoor(door: DoorView, bridge: FirewallBridge | undefined = desktop()): Promise<string | null> {
  if (!bridge?.addRemoteAccessFirewallRule) return 'Windows Firewall can only be changed from the Orgtree app on this computer.'
  const result = await bridge.addRemoteAccessFirewallRule(door.port, door.lan, listenOf(door).tailscale)
  return result.ok ? null : result.error
}

/** The line under the switch while it is on and the door is not open. */
export function doorTrouble(door: DoorView): string | null {
  switch (door.state) {
    case 'closed': return null
    // one of two addresses could not be bound: the door is open at the other
    case 'open': return door.reason
    case 'blocked': return door.reason ?? 'The port is taken by another program.'
    case 'waiting': return door.reason ?? 'This computer has no address other computers could reach.'
  }
}

/** How the bytes travel to one of the door's addresses, named as the other computer's Connection details names it. */
export const addressNote = (address: Pick<DoorAddress, 'kind'>): string =>
  address.kind === 'tailscale' ? 'Tailscale' : address.kind === 'lan' ? 'Private network, not encrypted (http)'
    : address.kind === 'local' ? 'This computer only: for an SSH tunnel or a local https proxy' : 'This computer'

/** The address to hand to another computer: Tailscale's first, then this
 *  private network's. The door on this computer itself (127.0.0.1) is never
 *  one: only a tunnel or a proxy on this computer connects there, and to the
 *  other computer that address is itself (review M-2, 2026-11-14). */
export const addressToShare = (door: Pick<DoorView, 'addresses'>): DoorAddress | undefined =>
  door.addresses.find((a) => a.kind === 'tailscale') ?? door.addresses.find((a) => a.kind !== 'local')

/** Does the door stand on this computer itself and nowhere else? Then the
 *  other computer needs the address of the tunnel or proxy in front of it. */
export const onlyThisComputer = (door: Pick<DoorView, 'addresses'>): boolean =>
  door.addresses.length > 0 && door.addresses.every((a) => a.kind === 'local')

/** When a computer was last here, in words. */
export function computerSeen(computer: Pick<ComputerView, 'connected' | 'connected_since' | 'last_seen_at'>,
  time: (iso: string) => string, day: (iso: string) => string): string {
  if (computer.connected) return computer.connected_since ? `connected since ${time(computer.connected_since)}` : 'connected'
  return computer.last_seen_at ? `last seen ${day(computer.last_seen_at)}` : 'not connected yet'
}

/** The one line that holds both things the other computer needs. */
export const addressAndCode = (url: string, code: string): string => `${url} ${code}`

/** The chip on an organization's status strip while other computers are in it. */
export function connectedChip(org: Pick<SharedOrgView, 'connected' | 'connected_now'> | undefined): { text: string; title: string } | null {
  if (!org || org.connected < 1) return null
  return {
    text: org.connected === 1 ? '1 computer connected' : `${org.connected} computers connected`,
    title: org.connected_now.map((c) => c.label).join(', '),
  }
}

/** Change the door's port or where it listens. While something is shared, the
 *  Windows Firewall rules have to follow, and Windows is asked first: a No
 *  leaves the door where it is, with the rules it has. While nothing is shared
 *  nothing listens, and the rules are asked for when a switch is next turned on. */
export async function changeListening(now: RemoteAccessView, patch: ListenPatch,
  bridge: FirewallBridge | undefined = desktop()): Promise<{ view: RemoteAccessView } | { refused: string }> {
  const state = now.door.firewall?.state
  const current = listenOf(now)
  const next = { ...current, ...(patch.tailscale === undefined ? {} : { tailscale: patch.tailscale }),
    ...(patch.lan === undefined ? {} : { lan: patch.lan }), ...(patch.local === undefined ? {} : { local: patch.local }) }
  if (!next.tailscale && !next.lan && !next.local) return { refused: 'Choose at least one place for remote access to listen.' }
  const port = patch.port ?? now.port
  // The rules are for Tailscale and for the private network, each for the door's port. Windows
  // is asked only when one of those three changes: this computer itself needs no rule, so
  // switching it alone asks nothing (review M-1, 2026-11-14).
  const rulesChange = port !== now.port || next.tailscale !== current.tailscale || next.lan !== current.lan
  if (now.orgs.some((org) => org.on) && rulesChange && bridge && state !== undefined && state !== 'none') {
    if (next.tailscale || next.lan) {
      // the script takes the door's earlier rules out first, so a choice that went leaves no rule
      const result = await bridge.addRemoteAccessFirewallRule?.(port, next.lan, next.tailscale)
      if (result && !result.ok) return { refused: result.error }
    } else if (now.door.firewall?.present) {
      // nothing needs a rule any more: the rules that are there go
      const result = await bridge.removeRemoteAccessFirewallRule?.()
      if (result && !result.ok) return { refused: result.error }
    }
  }
  return { view: await setListening(patch) }
}

/** Take the door's rules out of Windows Firewall, once nothing is shared.
 *  Answers the sentence to show, or null. */
export async function removeDoorRules(bridge: FirewallBridge | undefined = desktop()): Promise<string | null> {
  if (!bridge?.removeRemoteAccessFirewallRule) return 'Windows Firewall can only be changed from the Orgtree app on this computer.'
  const result = await bridge.removeRemoteAccessFirewallRule()
  return result.ok ? null : result.error
}

/** The door's state in a word or two, for the App settings page. */
export function doorWord(door: Pick<DoorView, 'state'>): string {
  switch (door.state) {
    case 'closed': return 'Not listening: nothing is shared'
    case 'open': return 'Listening'
    case 'waiting': return 'Waiting for an address'
    case 'blocked': return 'Cannot listen'
  }
}

/** "2 computers, 1 connected". */
export const computersWord = (org: Pick<SharedOrgView, 'computers' | 'connected'>): string =>
  `${org.computers === 1 ? '1 computer' : `${org.computers} computers`}, ${org.connected} connected`

/** Is this a port the door may have? */
export const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1024 && port <= 65535
