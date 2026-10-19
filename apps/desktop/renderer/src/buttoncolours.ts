// Per-window focus for ordinary button chrome. No persistence or network reads.
import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { providerOf } from './canvas/shared'

const selected = new Map<string, string>()
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function setButtonAgent(org: string, agent: string | null): void {
  if ((selected.get(org) ?? null) === agent) return
  if (agent) selected.set(org, agent)
  else selected.delete(org)
  for (const listener of [...listeners]) listener()
}

/** the agent whose desk was last focused in this window for `org` (any desk
 *  surface: the canvas desk, a pinned desk window, the Attention panel), or
 *  null once focus left every desk; with `onButtonAgent` to follow it */
export function buttonAgentOf(org: string): string | null { return selected.get(org) ?? null }
export const onButtonAgent = subscribe

/** A project belongs to no provider: its desk keeps the neutral chrome rather
 *  than the claude colour `providerOf` falls back to for an unknown tier. */
export function buttonAccent(tier?: string | null): string {
  return tier && tier !== 'project' ? `var(--prov-${providerOf(tier)})` : 'var(--line-hover)'
}

export function useButtonColours(org: string | null,
  nodes: Map<string, { tier?: string | null }> | null): CSSProperties {
  const id = useSyncExternalStore(subscribe, () => org ? selected.get(org) ?? null : null)
  const tier = id ? nodes?.get(id)?.tier : null
  return { '--button-accent': buttonAccent(tier) } as CSSProperties
}
