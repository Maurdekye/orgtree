/* attract/canvas.ts — attract mode's data and routes, on the canvas that owns
   them. Every target goes through a route that already exists (gap-fill Q2,
   m082646bad468): an agent through go-to-agent (its desk at desk zoom), the
   whole org through Fit, a presentation through the reader opening (which
   marks it viewed), and mail and tickets through the shell's inbox and docket
   jumps, handed up via `onPanel` because App owns those two panels. */
import { useEffect, useRef } from 'react'
import { getInbox, getWorkItem, getWorkItems, markRead } from '../api'
import { attentionNodes, buildAttentionRows } from '../attention/feed'
import type { AttentionRow } from '../attention/feed'
import { markReadNow, readLocally } from '../mailread'
import { docUnread } from '../canvas/docviewed'
import { deskOpenElsewhere, deskShownAnywhere } from '../canvas/deskhosts'
import { attentionLayout, orgView } from '../attention/mode'
import { setAttractQuiet } from '../composerfocus'
import { useAttractCycle } from './attract'
import type { AttentionTarget, AttractAgent, AttractRoutes, AttractTarget } from './attract'
import { scrollThrough } from './scroll'
import type { Scroll } from './scroll'
import { locateChange, recordTicketSnapshot, ticketSnapshot } from './ticketsnap'
import { showTicketChange } from './ticketdom'
import type { TicketShow } from './ticketdom'
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
  const release = () => { openedReader.current = null; ticket.current?.release(); ticket.current = null; deps.current.onPanel?.('release') }
  const endScroll = () => { scroll.current?.cancel(); scroll.current = null }
  /** the changed ticket the docket pane is being driven to, and the window's last input (what "new" is measured from) */
  const ticket: { current: TicketShow | null } = { current: null }
  let since = 0
  // ---- things needing attention (USER 2026-11-03 m0962694602bd): the Attention view's own rows, watched for arrivals
  let listener: ((items: AttentionTarget[]) => void) | null = null
  let known: Set<string> | null = null
  let polling = false, dirty = false
  const asTarget = (r: AttentionRow): AttentionTarget => r.kind === 'ticket'
    ? { kind: 'attention', key: r.key, what: 'ticket', agent: r.agent, id: r.item!.slug }
    : r.kind === 'mail'
      ? { kind: 'attention', key: r.key, what: 'mail', agent: r.agent, id: r.mail!.id, ...(r.mail!.urgent ? { urgent: true } : {}) }
      : r.kind === 'question'
        ? { kind: 'attention', key: r.key, what: 'question', agent: r.agent, id: r.ask!.id }
        : { kind: 'attention', key: r.key, what: 'mention', agent: r.agent, id: r.mention!.id }
  const poll = async (): Promise<void> => {
    if (!listener) return
    if (polling) { dirty = true; return }
    polling = true
    try {
      do {
        dirty = false
        const { slug, tree } = deps.current
        const [box, work] = await Promise.all([
          getInbox(slug).catch(() => null), getWorkItems(slug).catch(() => null),
        ])
        if (!listener) return
        const rows = buildAttentionRows({
          items: work?.items, archived: (work as { archived?: never[] } | null)?.archived,
          backlogged: (work as { backlogged?: never[] } | null)?.backlogged,
          pending: box?.pending, nodes: attentionNodes(tree), asks: tree.asks, slug,
        })
        const now = new Set(rows.map(r => r.key))
        // the first look is the baseline: what was already waiting when the run began is not an arrival
        const arrived = known ? rows.filter(r => !known!.has(r.key)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : []
        known = now
        if (arrived.length) listener(arrived.map(asTarget))
      } while (dirty && listener)
    } finally { polling = false }
  }
  /** this agent's desk is visible ANYWHERE (a pin, a window of its own, the Attention view's agent desk, a zoomed card, any other
   *  host), checked when the step RUNS: one opened after the candidates were collected is just as taken (USER 2026-11-03
   *  m7efd38ca3400). Attract then skips the agent ENTIRELY: no focus, no pan, no fit, no reader, no desk change
   *  (USER 2026-11-04 m1869e398fdea; replaces the earlier "fit the org with the node in view"). */
  const taken = (id: string | null | undefined): boolean => {
    if (!id) return false
    const c = deps.current
    const node = c.map.get(id)
    return c.pinnedIds().has(id) || deskOpenElsewhere(c.slug, node) || deskShownAnywhere(c.slug, node)
      || (orgView(c.slug) === 'attention' && attentionLayout(c.slug).agent === id)
  }
  /** attention shown through the route its kind already has; a desk that is pinned or open elsewhere gets the whole
   *  org instead (the node is in view), never a window moved */
  const underlying = (t: AttentionTarget): AttractTarget | null =>
    t.what === 'ticket' ? { kind: 'ticket', slug: t.id, mark: '' }
      : t.what === 'mail' ? { kind: 'mail', id: t.id, ...(t.urgent ? { urgent: true } : {}) } : null
  return {
    watch: (cb) => { listener = cb; known = null; return () => { listener = null; known = null } },
    poll,
    collect: async (from) => {
      since = from
      const { slug, tree, map } = deps.current
      const agents: AttractAgent[] = []
      const docs: { id: string; node: string | null }[] = []
      for (const n of map.values()) {
        for (const doc of n.documents ?? [])
          if (docUnread(slug, doc.id, doc.at) !== null && !taken(n.id)) docs.push({ id: doc.id, node: n.id })
        // a real, live agent seat: no project, draft, pseudo-card or retiree
        if (!n.tier || n.kind === 'project' || n.isBearerOf || n.state === 'archived' || n.state === 'draft') continue
        agents.push({
          id: n.id, busy: !!n.busy,
          activityAt: latest(n.turn_started_at, n.last_status?.at),
          deskTaken: taken(n.id),
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
    show: async function show(t: AttractTarget): Promise<number | void> {
      const c = deps.current
      // attract mode moves the view only: a desk it brings up does not take the caret from a field the user is typing in
      setAttractQuiet(true)
      switch (t.kind) {
        case 'attention': {
          const next = underlying(t)
          if (next) return show(next)
          if (!t.agent) c.fitAll()
          else if (!taken(t.agent)) c.goToAgent(t.agent)
          return
        }
        case 'org': c.fitAll(); return
        case 'agent': if (!taken(t.id)) c.goToAgent(t.id); return
        case 'mail':
          c.onPanel?.({ kind: 'inbox', mail: t.id })
          // "3 yes": showing it marks it read, through the inbox's own read path
          void markReadNow(c.slug, { id: t.id, urgent: t.urgent }, () => markRead(c.slug, [t.id])).catch(() => {})
          return
        case 'ticket': {
          // USER 2026-11-03 m73037cb0a404: a changed ticket opens at its first change. The diff is taken
          // BEFORE the docket opens (the pane records what it shows, which would hide the change)
          let change = null
          try {
            const { item } = await getWorkItem(c.slug, t.slug)
            change = locateChange(ticketSnapshot(c.slug, t.slug), item, since)
            recordTicketSnapshot(c.slug, item)
          } catch { /* unreadable: the top, as before */ }
          ticket.current?.restore()
          c.onPanel?.({ kind: 'docket', item: t.slug })
          ticket.current = showTicketChange(change)
          return ticket.current.length
        }
        case 'doc': {
          // a presentation opens in its agent's reader: not on a desk that is already open elsewhere
          if (taken(ownerOf(t.id) ?? t.node)) return
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
    hide: function hide(t: AttractTarget): void {
      const c = deps.current
      setAttractQuiet(false)
      if (t.kind === 'attention') {
        const next = underlying(t)
        if (next) hide(next)
        return
      }
      if (t.kind === 'ticket') { ticket.current?.restore(); ticket.current = null }
      if (t.kind === 'mail' || t.kind === 'ticket') c.onPanel?.(null)
      if (t.kind === 'doc') {
        endScroll()
        if (openedReader.current) c.closeReader(openedReader.current)
        openedReader.current = null
      }
    },
    // canvas interaction ended the run: the scroll stops where it is and every
    // panel stays on screen - as the user's
    stop: () => { setAttractQuiet(false); endScroll(); release() },
    release,
  }
}

export function useCanvasAttract(d: CanvasAttractDeps): boolean {
  const deps = useRef(d)
  deps.current = d
  const routes = useRef<AttractRoutes | null>(null)
  routes.current ??= canvasAttractRoutes(() => deps.current)
  // the tree is polled by the app: every new one is a chance for something needing attention to have appeared
  useEffect(() => { void routes.current?.poll?.() }, [d.tree])
  return useAttractCycle(d.enabled, routes.current)
}
