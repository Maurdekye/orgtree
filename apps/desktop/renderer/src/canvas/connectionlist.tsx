// canvas/connectionlist.tsx — one hub's connections as a list of rows, in Org
// settings → Connections (each hub this org uses) and App settings → Mail hub
// (this computer's own hub).
//
// USER 2026-10-29: the old list's grey bullets read as "offline" ("thought the
// gray dot meant offline", m4c84e393768e; "that should be communicated more
// clearly", m0537fdb73608). A row is a presence dot that cannot be misread (a
// filled green dot online, a hollow grey ring offline as in Hubchat ("A5 use
// the grey ring for offline both places", m019c9500d23a), its word as its hover)
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
//
// ONE LIST FOR EVERY HUB (USER 2026-11-25 21:49:37Z m8ee22829e340 "use the same
// list for each hub, and add a small red cancel button by each entry";
// 21:50:37Z m706c3054c21d "integrate it into the ux and style of the general
// list component"): the org mailbox's mailservers tab, Org settings ›
// Connections and the lockdown list all use this list. A caller may give a
// row its own status (a blocked or lockdown badge in place of the dot), a
// trailing control and the list's small red × at the row's end (block, or
// take off the lockdown list): `RowControls`.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NetHub, NetPeer } from '../types'
import { HubContactChip } from './agentmentions'
import { NET_PRESENCE_WORD, PRESENCE_RANK, netPresence, peerPresence, useNetMentionState, type NetPresence } from './netmentions'
import { BlockIcon, CheckIcon } from '../icons'
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
export const rowPresence = (p: NetPeer): NetPresence => netPresence('@net:' + p.slug) ?? peerPresence(p)

/** Online first, then busy, then Do not disturb, then offline; within each,
 *  the newest mail first; an address with none goes last, A-Z by the name its
 *  chip shows, then by address, so equal times and names still keep one
 *  order. */
export function sortConnections(rows: readonly NetPeer[], recent: Recency,
  presence: (p: NetPeer) => NetPresence = peerPresence): NetPeer[] {
  return rows.map(p => ({ p, rank: PRESENCE_RANK[presence(p)], at: recent.get(p.slug.toLowerCase()) ?? null, name: connectionName(p) }))
    .sort((a, b) => a.rank - b.rank
      || (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : b.at - a.at)
      || collator.compare(a.name, b.name)
      || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
    .map(k => k.p)
}

/** A hub's own dot (connected or not, beside its status words), in words: its hover. */
export const hubDotTitle = (h: NetHub): string => h.connected ? 'Connected' : 'Not connected'

/** The presence dot: its shape and colour carry the state (busy: filled
 *  with the one --busy token, Do not disturb with --dnd), its hover the
 *  word. */
export function PresenceDot({ state }: { state: NetPresence }) {
  const word = NET_PRESENCE_WORD[state]
  return <span className={'presence-dot ' + state} role="img" aria-label={word} title={word} />
}

/** The blocked sign: the red Material Block ring a blocked contact's status shows. The block button wears this
 *  same element (USER alpha.8 via @coordinator-opus m2d6e12a94c56 "it should look like the red cancel symbol shown
 *  for agent statuses when theyve blocked you"), so glyph, colour and size can't drift apart. Without `label` it is
 *  decorative (inside a button that names itself). */
export function BlockedSign({ label, title }: { label?: string; title?: string }) {
  return label
    ? <BlockIcon className="oi-blocked" fontSize="inherit" role="img" aria-label={label} titleAccess={title} />
    : <BlockIcon className="oi-blocked" fontSize="inherit" aria-hidden="true" />
}

/** The green checkmark that unblocks a contact (USER 2026-11-26 19:13:26Z mc519405980c8, in a blocked row's
 *  block-button place; 19:24:40Z m3d87ef9439ae, also in the blocked contacts list): one button for both. */
export function UnblockCheck({ title, onClick }: { title: string; onClick: () => void }) {
  return <button type="button" className="conn-x unblock" title={title} aria-label={title} onClick={onClick}>
    <CheckIcon fontSize="inherit" aria-hidden="true" /></button>
}

/** What a caller adds to each row: its status (default: the presence dot), a
 *  control after the chip, and the small red control at the end (null: none):
 *  `block` draws the blocked sign (BlockedSign; USER mdd0522f95fb0, corrected on
 *  alpha.8 m2d6e12a94c56), `unblock` a checkmark in the same place (USER
 *  mc519405980c8), anything else (taking an address off the lockdown list) the
 *  plain ×. */
export interface RowControls {
  status?: (p: NetPeer) => ReactNode
  trail?: (p: NetPeer) => ReactNode
  x?: (p: NetPeer) => { title: string; onClick: () => void; block?: boolean; unblock?: boolean } | null
}

/** One hub's connections: rows, sorted, scrolling past VISIBLE_ROWS, with
 *  only the rows near the view mounted. Renders nothing for an empty list. */
export function ConnectionList({ rows, recent, label, status, trail, x }: { rows: readonly NetPeer[]; recent: Recency; label: string } & RowControls) {
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
        {status ? status(p) : <PresenceDot state={rowPresence(p)} />}
        <HubContactChip address={'@net:' + p.slug} />
        {trail?.(p)}
        {(() => {
          const act = x?.(p)
          if (act?.unblock) return <UnblockCheck title={act.title} onClick={act.onClick} />
          return act && <button type="button" className={'conn-x' + (act.block ? ' block' : '')}
            title={act.title} aria-label={act.title} onClick={act.onClick}>{act.block ? <BlockedSign /> : '×'}</button>
        })()}
      </div>)}
    {last < order.length && <div className="conn-gap" aria-hidden="true" style={{ height: (order.length - last) * rowPx }} />}
  </div>
}
