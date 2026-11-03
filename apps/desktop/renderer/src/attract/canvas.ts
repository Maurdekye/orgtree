/* attract/canvas.ts — attract mode's data and routes, on the canvas that owns
   them. Every target goes through a route that already exists (gap-fill Q2,
   m082646bad468): an agent through go-to-agent (its desk at desk zoom), the
   whole org through Fit, a presentation through the reader opening (which
   marks it viewed), and mail and tickets through the shell's inbox and docket
   jumps, handed up via `onPanel` because App owns those two panels. */
import { useRef } from 'react'
import { getInbox, getWorkItems, markRead } from '../api'
import { markReadNow, readLocally } from '../mailread'
import { docUnread } from '../canvas/docviewed'
import { deskOpenElsewhere } from '../canvas/deskhosts'
import { useAttractCycle } from './attract'
import type { AttractAgent, AttractRoutes, AttractTarget } from './attract'
import { scrollThrough } from './scroll'
import type { Scroll } from './scroll'
import type { CanvasNode } from '../canvas/shared'
import type { TreePayload } from '../types'

/** the shell's two panels attract mode opens; null closes what it opened; 'release' hands
 *  what it opened over to the user (touched, or the run was interrupted): nothing closes it */
export type AttractPanel = { kind: 'inbox'; mail: string } | { kind: 'docket'; item: string } | null | 'release'

export interface CanvasAttractDeps {
  enabled: boolean
  slug: string
  tree: TreePayload
  map: Map<string, CanvasNode>
  /** agents whose desk is pinned to the screen right now */
  pinnedIds: () => ReadonlySet<string>
  goToAgent: (id: string) => void
  fitAll: () => void
  openDoc: (id: string) => void
  /** agent readers open right now, and how to close one */
  readerIds: () => readonly string[]
  closeReader: (id: string) => void
  onPanel?: (panel: AttractPanel) => void
}

const latest = (a?: string | null, b?: string | null): string | null =>
  !a ? (b ?? null) : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b)

/** The canvas's data and routes for the cycle; `get` reads the current deps. */
export function canvasAttractRoutes(get: () => CanvasAttractDeps): AttractRoutes {
  const deps = { get current() { return get() } }
  const scroll: { current: Scroll | null } = { current: null }
  const openedReader: { current: string | null } = { current: null }
  /** the node whose reader the shell opens a presentation on: the first node
   *  listing it, as OrgCanvas's `docOwner` (the reader that opens is that node's) */
  const ownerOf = (id: string): string | null => {
    for (const n of deps.current.map.values()) if (n.documents?.some(d => d.id === id)) return n.id
    return null
  }
  /** what attract opened now belongs to the user: it closes nothing of it later */
  const release = () => { openedReader.current = null; deps.current.onPanel?.('release') }
  const endScroll = () => { scroll.current?.cancel(); scroll.current = null }
  return {
    collect: async () => {
      const { slug, tree, map, pinnedIds } = deps.current
      const pinned = pinnedIds()
      const agents: AttractAgent[] = []
      const docs: { id: string; node: string | null }[] = []
      for (const n of map.values()) {
        for (const doc of n.documents ?? [])
          if (docUnread(slug, doc.id, doc.at) !== null) docs.push({ id: doc.id, node: n.id })
        // a real, live agent seat: no project, draft, pseudo-card or retiree
        if (!n.tier || n.kind === 'project' || n.isBearerOf || n.state === 'archived' || n.state === 'draft') continue
        agents.push({
          id: n.id, busy: !!n.busy,
          activityAt: latest(n.turn_started_at, n.last_status?.at),
          deskTaken: pinned.has(n.id) || deskOpenElsewhere(slug, n),
        })
      }
      const [mail, tickets] = await Promise.all([
        (tree.user_inbox_count ?? 0) > 0
          ? getInbox(slug).then(box => [...box.pending]
            .filter(m => m.id && !readLocally(slug, m.id))
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .map(m => ({ id: m.id, ...(m.urgent ? { urgent: true } : {}) })), () => [])
          : Promise.resolve([]),
        getWorkItems(slug).then(p => p.items.map(it => ({ slug: it.slug, updatedAt: it.updated_at ?? null })), () => []),
      ])
      return { agents, mail, docs, tickets }
    },
    show: async (t: AttractTarget) => {
      const c = deps.current
      switch (t.kind) {
        case 'org': c.fitAll(); return
        case 'agent': c.goToAgent(t.id); return
        case 'mail':
          c.onPanel?.({ kind: 'inbox', mail: t.id })
          // "3 yes": showing it marks it read, through the inbox's own read path
          void markReadNow(c.slug, { id: t.id, urgent: t.urgent }, () => markRead(c.slug, [t.id])).catch(() => {})
          return
        case 'ticket': c.onPanel?.({ kind: 'docket', item: t.slug }); return
        case 'doc': {
          const before = c.readerIds()
          c.openDoc(t.id)   // the reader marks it viewed as it loads
          const owner = ownerOf(t.id) ?? t.node
          openedReader.current = owner && !before.includes(owner) ? owner : null
          endScroll()
          scroll.current = scrollThrough(t.id)
          return scroll.current.length
        }
      }
    },
    hide: (t: AttractTarget) => {
      const c = deps.current
      if (t.kind === 'mail' || t.kind === 'ticket') c.onPanel?.(null)
      if (t.kind === 'doc') {
        endScroll()
        if (openedReader.current) c.closeReader(openedReader.current)
        openedReader.current = null
      }
    },
    // canvas interaction ended the run: the scroll stops where it is and every
    // panel stays on screen - as the user's
    stop: () => { endScroll(); release() },
    release,
  }
}

export function useCanvasAttract(d: CanvasAttractDeps): boolean {
  const deps = useRef(d)
  deps.current = d
  const routes = useRef<AttractRoutes | null>(null)
  routes.current ??= canvasAttractRoutes(() => deps.current)
  return useAttractCycle(d.enabled, routes.current)
}
