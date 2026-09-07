import { draftKey } from '../draftstore'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { MovableSurface, useSurface } from '../popout'
import { isMobile } from '../mobile'
import { OwnedDeskChat } from './desk'
import type { DeskChatProps } from './desk'
import type { CanvasNode } from './shared'

export function deskGeneration(node: Pick<CanvasNode, 'generation'>): number {
  if (typeof node.generation !== 'number' || !Number.isSafeInteger(node.generation) || node.generation < 0) {
    throw new Error('The agent generation is missing; a separate composer cannot be owned safely.')
  }
  return node.generation
}
export const deskIdentity = (slug: string, node: Pick<CanvasNode, 'id' | 'generation'>) =>
  JSON.stringify([slug, node.id, deskGeneration(node)])
interface Slot { id: object; anchor: HTMLElement; props: DeskChatProps }
interface Entry {
  key: string; invalidated?: boolean; pendingRename?: boolean; slots: Map<object, Slot>; last: Slot; detached: boolean
  show?: () => void; redock?: () => void
}
class Desks {
  entries = new Map<string, Entry>()
  version = 0
  nextKey = 0
  renamedAway = new Map<string, string>()
  listeners = new Set<() => void>()
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  snapshot = () => this.version
  change = () => { this.version++; for (const fn of [...this.listeners]) fn() }
  put(key: string, slot: Slot) {
    if (this.renamedAway.has(key)) return
    let e = this.entries.get(key)
    if (!e) { e = { key: `host-${++this.nextKey}`, slots: new Map(), last: slot, detached: false }; this.entries.set(key, e) }
    e.slots.set(slot.id, slot)
    if (!e.detached || e.last.id === slot.id) e.last = slot
    this.change()
  }
  remove(key: string, id: object) {
    const e = [...this.entries.values()].find((entry) => entry.slots.has(id))
    if (!e) return
    e.slots.delete(id)
    // Slot migration can unregister/register in a single React commit. Give
    // that commit a chance to finish before releasing its stable host.
    queueMicrotask(() => {
      if (!e.slots.size && !e.detached) {
        for (const [k, entry] of this.entries) if (entry === e) this.entries.delete(k)
      }
      this.change()
    })
  }
}
const DeskContext = createContext<Desks | null>(null)
const DeskMapReady = createContext(true)

export function DeskHosts({ children, map, slug, treeSlug = slug }: {
  children: ReactNode; map: Map<string, CanvasNode>; slug: string; treeSlug?: string
}) {
  const [desks] = useState(() => new Desks())
  useEffect(() => {
    const rename = (event: Event) => {
      const d = (event as CustomEvent<{ slug: string; from: string; to: string }>).detail
      if (!d || d.slug !== slug) return
      for (const [key, entry] of [...desks.entries]) {
        if (entry.invalidated || entry.last.props.slug !== slug || entry.last.props.node.id !== d.from) continue
        const move = (slot: Slot): Slot => ({ ...slot, props: { ...slot.props, node: { ...slot.props.node, id: d.to } } })
        const next = move(entry.last)
        const target = deskIdentity(slug, next.props.node)
        const destination = desks.entries.get(target)
        if (destination?.detached) continue
        // A full payload can create its new presentation slot before the
        // parent's validated rename notification. Retain the original host
        // and adopt only that new slot; never revive an invalidated host.
        if (destination) {
          for (const [id, slot] of destination.slots) entry.slots.set(id, slot)
          desks.entries.delete(target)
        }
        entry.pendingRename = true
        entry.last = next
        entry.slots = new Map([...entry.slots].map(([id, slot]) => [id, move(slot)]))
        desks.renamedAway.set(key, d.from)
        desks.entries.delete(key); desks.entries.set(target, entry)
      }
      desks.change()
    }
    window.addEventListener('orgtree:desk-rename', rename)
    return () => window.removeEventListener('orgtree:desk-rename', rename)
  }, [desks, slug])
  useEffect(() => {
    if (treeSlug !== slug) return
    // Parent passive effects reconcile payload-only same-session renames.
    // Validate this accepted snapshot after those effects, without clearing
    // an earlier deletion or generation invalidation.
    queueMicrotask(() => {
      let changed = false
      for (const [key, entry] of [...desks.entries]) {
        if (entry.last.props.slug !== slug) continue
        const current = map.get(entry.last.props.node.id)
        if (entry.pendingRename && current?.generation === entry.last.props.node.generation) entry.pendingRename = false
        if (entry.invalidated || entry.pendingRename || (current && current.generation === entry.last.props.node.generation)) continue
        entry.invalidated = true
        desks.entries.delete(key); desks.entries.set(`recovery:${entry.key}`, entry); changed = true
      }
      if (changed) desks.change()
    })
  }, [desks, map, slug, treeSlug])
  useEffect(() => {
    // Once the authoritative tree drops the old name, a later new hire may
    // reuse it. Until then an old presentation must not recreate a writer.
    if (treeSlug !== slug) return
    for (const [key, id] of desks.renamedAway) if (!map.has(id)) desks.renamedAway.delete(key)
  }, [desks, map, slug, treeSlug])
  return <DeskMapReady.Provider value={treeSlug === slug}><DeskContext.Provider value={desks}>{children}<HostList desks={desks} map={map} slug={slug} /></DeskContext.Provider></DeskMapReady.Provider>
}

export function DeskSlot(props: DeskChatProps) {
  const desks = useContext(DeskContext)
  const mapReady = useContext(DeskMapReady)
  if (!mapReady) return <div className="popout-placeholder">Loading organization...</div>
  if (!desks || isMobile || typeof props.node.generation !== 'number'
    || !Number.isSafeInteger(props.node.generation) || props.node.generation < 0) return <OwnedDeskChat {...props} />
  return <RegisteredSlot desks={desks} props={props} />
}
function RegisteredSlot({ desks, props }: { desks: Desks; props: DeskChatProps }) {
  const id = useRef({}).current
  const anchor = useRef<HTMLDivElement>(null)
  const key = deskIdentity(props.slug, props.node)
  useSyncExternalStore(desks.subscribe, desks.snapshot)
  useLayoutEffect(() => {
    if (anchor.current) desks.put(key, { id, anchor: anchor.current, props })
  }, [desks, key, id, props])
  useLayoutEffect(() => () => desks.remove(key, id), [desks, key, id])
  const e = desks.entries.get(key)
  const elsewhere = e?.detached || (e && e.last.id !== id)
  return <div className="desk-slot" ref={anchor} data-desk-slot={key}>
    {elsewhere && <div className="popout-placeholder">
      <span>{props.node.id}'s desk is open elsewhere.</span>
      <button onClick={() => e.show?.()}>Show desk</button>
      {e.detached && <button onClick={() => e.redock?.()}>Return here</button>}
    </div>}
  </div>
}
function HostList({ desks, map, slug }: { desks: Desks; map: Map<string, CanvasNode>; slug: string }) {
  useSyncExternalStore(desks.subscribe, desks.snapshot)
  return <>{[...desks.entries.values()].filter((e) => e.last.props.slug === slug).map((e) =>
    <DeskHost key={e.key} desks={desks} entry={e} map={map} />)}</>
}
function DeskHost({ desks, entry, map }: { desks: Desks; entry: Entry; map: Map<string, CanvasNode> }) {
  const current = map.get(entry.last.props.node.id)
  const changedGeneration = !!entry.invalidated || !current || current.generation !== entry.last.props.node.generation
  const slot = entry.slots.get(entry.last.id) ?? [...entry.slots.values()][0]
  if (slot && !entry.detached) entry.last = slot
  const props = entry.last.props
  return <MovableSurface kind={`desk:${entry.key}`} title={`${props.node.id} · desk`}
    org={props.slug} anchor={slot?.anchor ?? null}
    onDetached={(v) => {
      entry.detached = v
      if (!v && !entry.slots.size) props.onJump?.(props.node.id)
      desks.change()
    }}>
    <DeskOwnerControls entry={entry} stale={changedGeneration} dismiss={() => {
      entry.redock?.(); for (const [key, e] of desks.entries) if (e === entry) desks.entries.delete(key); desks.change()
    }} />
    {changedGeneration && <div className="popout-error" role="status">
      This agent's identity changed. This draft belongs to generation {props.node.generation}.
      Copy your draft before returning; it will not be sent to the new generation.
    </div>}
    <OwnedDeskChat {...props} node={changedGeneration ? props.node : current}
      map={map} staleIdentity={changedGeneration} />
  </MovableSurface>
}
function DeskOwnerControls({ entry, stale, dismiss }: { entry: Entry; stale: boolean; dismiss: () => void }) {
  const surface = useSurface()
  useLayoutEffect(() => {
    entry.show = () => {
      if (surface?.detached) surface.open()
      else { entry.last.anchor.scrollIntoView({ block: 'nearest' }); entry.last.props.onJump?.(entry.last.props.node.id) }
    }
    entry.redock = () => surface?.redock()
  }, [entry, surface])
  const p = entry.last.props
  return <DraftRecovery stale={stale} dismiss={dismiss} keyName={draftKey(p.slug, p.node.id, deskGeneration(p.node))} />
}
function DraftRecovery({ keyName, stale, dismiss }: { keyName: string; stale: boolean; dismiss: () => void }) {
  const surface = useSurface()
  const [copied, setCopied] = useState(false)
  // Host-level notice handles stale generations; this local recovery action
  // is also useful when a retired desk no longer has a send affordance.
  if (!surface || (!surface.detached && !stale)) return null
  return <div className="popout-draft-recovery"><button className="popout-copy-draft" onClick={() => {
    let text = ''
    try { text = localStorage.getItem(keyName) || localStorage.getItem(keyName.replace('orgtree-draft-v2-', 'orgtree-draft-recovery-')) || '' } catch { /* unavailable */ }
    surface.document.defaultView?.navigator.clipboard?.writeText(text)
      .then(() => setCopied(true)).catch(() => setCopied(false))
  }}>{copied ? 'Draft copied' : 'Copy unsent draft'}</button>
    {stale && <button onClick={dismiss}>Close old desk</button>}
  </div>
}
