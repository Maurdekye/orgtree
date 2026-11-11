// remotes.ts — remote engines: the connections this desktop keeps to standalone
// (headless) engines elsewhere, whose organizations open here like local ones
// (docs/rust-engine/remote-org.md).
//
// The list is a pushed app-feed value (`remotes`), so every window sees a
// state change at once and nothing polls. The local engine is the relay: this
// module never sees a remote's token, and a window never talks to a remote
// engine itself.
import { req } from './api'
import { appValueNow, useAppValue } from './appfeed'
import type { RemoteMark } from '../../../../packages/contracts/app-feed'

export type { RemoteMark }

export type RemoteState = 'connecting' | 'connected' | 'offline' | 'auth_failed' | 'refused' | 'paused'
export type RemoteTransport = 'https' | 'tailscale' | 'private-http' | 'loopback'

export interface RemoteOrgView {
  /** the slug this desktop uses for it (its window identity) */
  alias: string
  /** its slug on the remote engine */
  remote_slug: string
  name: string
  local_id: number
  /** the remote no longer lists it; its alias stays reserved */
  gone: boolean
}

/** One connection as `GET /api/remotes` and the `remotes` value give it. */
export interface RemoteView {
  id: string
  name: string
  tag: string
  url: string
  enabled: boolean
  state: RemoteState
  since: string
  next_attempt_at: string | null
  /** the remote engine's version, and this app's */
  version: string | null
  app_version: string
  version_differs: boolean
  transport: RemoteTransport | null
  /** the client token this desktop made there ("Orgtree desktop (<computer>)") */
  client_name: string | null
  own_token: boolean
  last_error: string | null
  error_code: string | null
  /** the sentence a change gets while this engine is not connected; null
   *  while it is (absent from an engine that does not say) */
  refusal?: string | null
  last_connected_at: string | null
  orgs: RemoteOrgView[]
}

const NONE: RemoteView[] = []

/** Every remote engine of this desktop, in the order they were added. */
export const useRemotes = (): RemoteView[] => useAppValue<RemoteView[]>('remotes') ?? NONE

/** The remote engine the organization `slug` (an alias) lives on, or null for
 *  a local organization. */
export function remoteOfOrg(remotes: readonly RemoteView[], slug: string | null | undefined): RemoteView | null {
  if (!slug) return null
  return remotes.find((r) => r.orgs.some((o) => o.alias === slug)) ?? null
}

/** What a change in the organization `slug` would be answered with right now,
 *  asked outside React by the handler that is about to make it: the engine's
 *  own sentence while the organization's remote engine is not connected, else
 *  null (a local organization, a connected engine, or a window that keeps no
 *  connection list). The engine refuses such a change anyway; asking first
 *  lets a composer keep its text instead of handing it to a send that cannot
 *  happen. */
export function remoteRefusalNow(slug: string | null | undefined): string | null {
  return remoteOfOrg(appValueNow<RemoteView[]>('remotes') ?? NONE, slug)?.refusal ?? null
}

const json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Add a remote engine. The engine checks everything before it saves, makes
 *  this desktop's own token there and keeps only that. A refusal's message is
 *  the sentence to show. */
export const addRemote = (url: string, token: string, name: string): Promise<RemoteView> =>
  req('/api/remotes', json('POST', { url, token, ...(name.trim() ? { name: name.trim() } : {}) }), 60000, [], false)

export const patchRemote = (id: string, patch: { name?: string; enabled?: boolean; token?: string; url?: string }): Promise<RemoteView> =>
  req(`/api/remotes/${encodeURIComponent(id)}`, json('PATCH', patch), 60000, [], false)

export const removeRemote = (id: string): Promise<{ removed: string; revoked: boolean }> =>
  req(`/api/remotes/${encodeURIComponent(id)}`, { method: 'DELETE' }, 30000, [], false)

export const retryRemote = (id: string): Promise<RemoteView> =>
  req(`/api/remotes/${encodeURIComponent(id)}/retry`, { method: 'POST' }, 30000, [], false)

/** The word a list heading and a chip add when a connection is not connected. */
export function stateWord(state: RemoteState): string | null {
  switch (state) {
    case 'connected': return null
    case 'connecting': return 'connecting'
    case 'offline': return 'offline'
    case 'auth_failed': return 'sign-in needed'
    case 'refused': return 'can’t connect'
    case 'paused': return 'paused'
  }
}

/** How the bytes travel, named honestly. */
export function transportLabel(transport: RemoteTransport | null): string {
  switch (transport) {
    case 'https': return 'Encrypted (https)'
    case 'tailscale': return 'Tailscale'
    case 'private-http': return 'Private network, not encrypted (http)'
    case 'loopback': return 'This computer (forwarded port)'
    default: return 'Not connected'
  }
}

export type BannerAction = 'retry' | 'token' | 'details' | 'connect'

/** The banner an organization window shows while its remote engine is not
 *  connected: the sentence and the one thing to do about it. `null` while
 *  connected. `now` is injected so the countdown can be tested. */
export function remoteBanner(remote: RemoteView, now: number, clock: (iso: string) => string):
  { text: string; action: BannerAction | null; label: string | null } | null {
  switch (remote.state) {
    case 'connected': return null
    case 'connecting': return { text: `Connecting to ${remote.name}...`, action: null, label: null }
    case 'offline': {
      const next = remote.next_attempt_at ? Date.parse(remote.next_attempt_at) : NaN
      const seconds = Number.isFinite(next) ? Math.max(0, Math.ceil((next - now) / 1000)) : null
      return {
        text: `${remote.name} is offline since ${clock(remote.since)}. Showing the last known state; nothing can be changed.`
          + (seconds === null ? '' : seconds > 0 ? ` Reconnecting in ${seconds} s.` : ' Reconnecting now.'),
        action: 'retry', label: 'Retry now',
      }
    }
    case 'auth_failed':
      return { text: `${remote.name} no longer accepts this computer's token.`, action: 'token', label: 'Enter a new token' }
    case 'refused':
      return { text: remote.last_error || `Can't connect to ${remote.name}.`, action: 'details', label: 'Connection details' }
    case 'paused':
      return { text: `Disconnected from ${remote.name}.`, action: 'connect', label: 'Connect' }
  }
}

/** The tooltip of a remote organization's row and of the window's chip. */
export function remoteTitle(remote: Pick<RemoteView, 'name' | 'url'>, mark?: Pick<RemoteMark, 'slug'> | null, alias?: string): string {
  const there = mark && alias && mark.slug !== alias ? ` · named ${mark.slug} there` : ''
  return `On ${remote.name} (remote engine) · ${remote.url}${there}`
}
