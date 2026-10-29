// canvas/connectionlist.tsx — one hub's connections as a list of rows, in Org
// settings → Connections (each hub this org uses) and App settings → Mail hub
// (this computer's own hub).
//
// USER 2026-10-29: the old list's grey bullets read as "offline" ("thought the
// gray dot meant offline", m4c84e393768e; "that should be communicated more
// clearly", m0537fdb73608). A row is a presence dot that cannot be misread (a
// filled green dot online, a hollow red ring offline, its word as its hover)
// and the connection's chip. The "· Online/Offline" words and the hub's
// description left the row ("also remove the online / independent chat tags",
// mae6a9c785cc0) for the chip's hover ("and just show that text when hovering
// the link", m6f8fcfbd2824; "online status and chat type", m822daec481cc;
// "(org, person, independent chat)", me07459d92f6d): that is the one @net
// hover, netmentions.hubAddressTitle, on every surface.
//
// "also this list should be lazily loading and scrollable past a certain
// length, and be formatted as a list of rows" (mdc7e971eaf19): past
// VISIBLE_ROWS the list scrolls in a window of that height, and only the rows
// in view and a few either side are mounted, so a chip, and the picture it
// asks for, exists only for a row near the view.
//
// "and sorted online first then offline below, and also within those groups
// ordered by most recent correspondence with the org" (m3e3829f0bf18): the
// newest mail either way first; none last, A-Z by the name the chip shows. The
// roster is already on the client (tree.net), so the sort runs here and the
// window pages through the sorted list; the engine supplies only the time of
// each address's newest mail. While the pointer is over the list, a chip in it
// has focus or it is scrolling, the rows keep their places (a dot still
// changes at once); the new order applies when that stops.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NetHub, NetPeer } from '../types'
import { HubContactChip } from './agentmentions'
import { netPresence, useNetMentionState } from './netmentions'
import './connectionlist.css'

/** Rows shown before the list scrolls. */
export const VISIBLE_ROWS = 10
/** A row's height until one is measured (jsdom measures nothing). */
export const ROW_PX = 30
/** Rows mounted beyond each edge of the view. */
const OVERSCAN = 5
/** How long after the last scroll the order stays held. */
const SETTLE_MS = 600

/** The newest mail exchanged with each address (its bare slug, lowercased), in ms. */
export type Recency = ReadonlyMap<string, number>
export const NO_RECENCY: Recency = new Map()

/** The engine's answer (`slug → ISO time`) as a Recency; unreadable times are left out. */
export function toRecency(raw: Record<string, string | null> | null | undefined): Recency {
  const out = new Map<string, number>()
  for (const [slug, at] of Object.entries(raw ?? {})) {
    const t = at ? Date.parse(at) : NaN
    if (Number.isFinite(t)) out.set(slug.toLowerCase(), t)
  }
  return out
}

/** The name the chip shows: the roster's, else the address. */
export const connectionName = (p: NetPeer): string => (p.org_name || p.username || '').trim() || p.slug

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** The presence a row shows: the one the hubs list for its address (the
 *  chip's hover says the same), else the row's own. */
export const rowPresence = (p: NetPeer): boolean => netPresence('@net:' + p.slug) ?? !!p.online

/** Online first, then offline; within each, the newest mail first; an
 *  address with none goes last, A-Z by the name its chip shows, then by
 *  address, so equal times and names still keep one order. */
export function sortConnections(rows: readonly NetPeer[], recent: Recency,
  online: (p: NetPeer) => boolean = p => !!p.online): NetPeer[] {
  return rows.map(p => ({ p, on: online(p), at: recent.get(p.slug.toLowerCase()) ?? null, name: connectionName(p) }))
    .sort((a, b) => Number(b.on) - Number(a.on)
      || (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : b.at - a.at)
      || collator.compare(a.name, b.name)
      || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
    .map(k => k.p)
}

/** A hub's own dot (connected or not, beside its status words), in words: its hover. */
export const hubDotTitle = (h: NetHub): string => h.connected ? 'Connected' : 'Not connected'

/** The presence dot: its shape and colour carry the state, its hover the word. */
export function PresenceDot({ online }: { online: boolean }) {
  const word = online ? 'Online' : 'Offline'
  return <span className={'presence-dot ' + (online ? 'online' : 'offline')} role="img" aria-label={word} title={word} />
}

/** One hub's connections: rows, sorted, scrolling past VISIBLE_ROWS, with
 *  only the rows near the view mounted. Renders nothing for an empty list. */
export function ConnectionList({ rows, recent, label }: { rows: readonly NetPeer[]; recent: Recency; label: string }) {
  const tick = useNetMentionState()   // presence the hubs list moves rows
  const sorted = useMemo(() => sortConnections(rows, recent, rowPresence), [rows, recent, tick])   // eslint-disable-line react-hooks/exhaustive-deps

  // Held while the user works in the list: rows keep their places, rows that
  // left drop out and new ones join at the end, until the user stops.
  const [held, setHeld] = useState(false)
  const hovered = useRef(false)
  const focused = useRef(false)
  const scrolling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recheck = () => setHeld(hovered.current || focused.current || scrolling.current !== null)
  useEffect(() => () => { if (scrolling.current) clearTimeout(scrolling.current) }, [])
  const shown = useRef<string[]>([])
  const order = useMemo(() => {
    if (!held) return sorted
    const bySlug = new Map(sorted.map(p => [p.slug, p]))
    const kept = shown.current.filter(s => bySlug.has(s))
    const keep = new Set(kept)
    return [...kept.map(s => bySlug.get(s)!), ...sorted.filter(p => !keep.has(p.slug))]
  }, [held, sorted])
  useLayoutEffect(() => { shown.current = order.map(p => p.slug) }, [order])

  // The window. Rows have one height (CSS, in em); it is measured from a
  // mounted row so the spacers stay exact at any text size.
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [rowPx, setRowPx] = useState(ROW_PX)
  const scrolls = order.length > VISIBLE_ROWS
  useLayoutEffect(() => {
    const h = box.current?.querySelector<HTMLElement>('.conn-row')?.getBoundingClientRect().height
    if (h && Math.abs(h - rowPx) > 0.25) setRowPx(h)
  })
  const viewPx = VISIBLE_ROWS * rowPx
  const first = scrolls ? Math.max(0, Math.min(Math.floor(top / rowPx), order.length - VISIBLE_ROWS) - OVERSCAN) : 0
  const last = scrolls ? Math.min(order.length, Math.ceil((top + viewPx) / rowPx) + OVERSCAN) : order.length

  if (!order.length) return null
  return <div ref={box} className={'conn-rows' + (scrolls ? ' scrolls' : '')} role="list" aria-label={label}
    style={scrolls ? { height: viewPx } : undefined}
    onPointerEnter={() => { hovered.current = true; recheck() }}
    onPointerLeave={() => { hovered.current = false; recheck() }}
    onFocus={() => { focused.current = true; recheck() }}
    onBlur={e => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      focused.current = false; recheck()
    }}
    onScroll={e => {
      setTop(e.currentTarget.scrollTop)
      if (scrolling.current) clearTimeout(scrolling.current)
      scrolling.current = setTimeout(() => { scrolling.current = null; recheck() }, SETTLE_MS)
      recheck()
    }}>
    {first > 0 && <div className="conn-gap" aria-hidden="true" style={{ height: first * rowPx }} />}
    {order.slice(first, last).map((p, i) =>
      <div key={p.slug} className="conn-row" role="listitem" aria-posinset={first + i + 1} aria-setsize={order.length}>
        <PresenceDot online={rowPresence(p)} />
        <HubContactChip address={'@net:' + p.slug} />
      </div>)}
    {last < order.length && <div className="conn-gap" aria-hidden="true" style={{ height: (order.length - last) * rowPx }} />}
  </div>
}
