import { useEffect, useRef, useState } from 'react'
import { getDocuments } from '../api'
import type { DocRow } from '../api'
import { onLiveBump } from '../livebus'
import { syncDocViewed } from './docviewed'
import { lastReaderItem, readerScope } from './readeropening'

export const DOC_PAGE = 40
/** A close opening is contiguous; a distant target adds only its own page. */
export const DOC_OPEN_PREFIX = 200
type Range = { start: number; size: number }
type Packet = Awaited<ReturnType<typeof getDocuments>>
export interface DocWindow {
  rows: DocRow[] | null; total: number; more: boolean; busy: boolean; error: string
  /** the jump the response answered, as requested; `locatedId` is the id the
   *  list holds it by (an old generic id names the presentation's slug) */
  located: string; locatedId: string; seq: unknown; openingId?: string | null
  grow: () => void; retry: () => void
  gapBefore: string[]; fillGap: (id: string) => void
  newer: boolean; growNewer: () => void
}
function merged(ranges: Range[]): Range[] {
  const out: Range[] = []
  for (const r of ranges) {
    const prev = out.at(-1)
    if (prev && prev.start + prev.size >= r.start) prev.size = Math.max(prev.size, r.start + r.size - prev.start)
    else out.push({ ...r })
  }
  return out
}
const fresh = (): Range[] => [{ start: 0, size: DOC_PAGE }]
const keyOf = (ranges: Range[]) => JSON.stringify(ranges)
type Loaded = { ident: string; rows: DocRow[] | null; total: number; more: boolean;
  error: string; located: string; locatedId: string; seq: unknown; openingId?: string | null; plan: string; gapBefore: string[] }

/** Each HTTP read is <=200 rows, including later growth. No opening reads a
 * history-wide prefix. Sparse gaps remain explicit and fill on scroll/click. */
export function useDocWindow(slug: string, node: string, locate = '', seq: unknown = 0,
  team = false, autoOpen = true, hired = false, visible = false, search = ''): DocWindow {
  const ident = `${slug}/${node}${team ? '/team' : ''}${visible ? '/visible/'+hired : ''}${search ? '/search/'+search : ''}`
  const plan = useRef({ ident, ranges: fresh(), opened: false, aim: '', anchor: '' })
  if (plan.current.ident !== ident) plan.current = { ident, ranges: fresh(), opened: false, aim: '', anchor: '' }
  const [attempt, setAttempt] = useState(0)
  const [last, setLast] = useState<Loaded>({ ident: '', rows: null, total: 0, more: false,
    error: '', located: '', locatedId: '', seq: undefined, plan: '', gapBefore: [] })
  useEffect(() => {
    let dead = false, active = false, pending = false
    const tick = async () => {
      if (active) { pending = true; return }
      active = true
      try {
        const state = plan.current
        const aim = locate ? `${locate}/${String(seq)}` : ''
        const jump = !!aim && aim !== state.aim
        const opening = !state.opened && autoOpen && !locate && !search
        let ranges = state.ranges, first: Packet | undefined
        let anchor = state.anchor
        // a presentation's slug, also when the jump named its old generic id
        let target = locate
        if (!state.opened || jump) {
          if (opening) await syncDocViewed(slug)
          if (dead) return
          first = await getDocuments(slug, 0, node, jump ? locate : '', DOC_PAGE, team, opening, hired, opening ? lastReaderItem(readerScope('presented',slug,node,team)) ?? '' : '',visible,search)
          const offset = first.offset ?? 0
          if (jump && first.located_id) target = first.located_id
          if (jump && !first.documents.some(r => r.id === target)) throw Error('that document is too far down the list to open from here')
          ranges = offset + DOC_PAGE <= DOC_OPEN_PREFIX
            ? [{ start: 0, size: offset + DOC_PAGE }]
            : [{ start: 0, size: DOC_PAGE }, { start: offset, size: DOC_PAGE }]
          anchor = ranges.length > 1 ? (jump ? target : first.opening_id ?? '') : ''
        } else if (anchor && ranges.length > 1) {
          // New presentations shift numeric offsets. Re-locate the target
          // page by identity so a boundary target cannot disappear on poll.
          first = await getDocuments(slug, 0, node, anchor, DOC_PAGE, team, false, hired,'',visible,search)
          ranges = merged(ranges.map((r, i) => i === ranges.length - 1 ? { ...r, start: first!.offset ?? r.start } : r))
        }
        const parts = await Promise.all(ranges.map(async range => {
          const packets: Packet[] = []
          for (let at = range.start; at < range.start + range.size; at += DOC_OPEN_PREFIX) {
            const size = Math.min(DOC_OPEN_PREFIX, range.start + range.size - at)
            const packet = first && (first.offset ?? 0) === at && size === DOC_PAGE ? first
              : await getDocuments(slug, at, node, '', size, team, false, hired,'',visible,search)
            if ((packet.offset ?? at) !== at) throw Error('the documents server returned a different page')
            packets.push(packet)
            if (packet.next_offset == null) break
          }
          return packets
        }))
        if (dead) return
        const rows: DocRow[] = [], ids = new Set<string>(), gapBefore: string[] = []
        for (let i = 0; i < parts.length; i++) {
          const items = parts[i]!.flatMap(p => p.documents ?? []).filter(r => !ids.has(r.id))
          if (i > 0 && items.length) gapBefore.push(items[0]!.id)
          for (const r of items) { if (!ids.has(r.id)) { ids.add(r.id); rows.push(r) } }
        }
        const total = parts[0]?.[0]?.total ?? 0
        const tail = parts.at(-1)?.at(-1)
        state.ranges = ranges; state.opened = true; state.anchor = ranges.length > 1 ? anchor : ''; if (jump) state.aim = aim
        setLast(p => ({ ident, rows, total, more: tail?.next_offset != null,
          error: '', located: jump ? first?.located ?? '' : p.ident === ident ? p.located : '',
          locatedId: jump ? (first?.located ? target : '') : p.ident === ident ? p.locatedId : '', seq,
          openingId: opening ? first?.opening_id : p.ident === ident ? p.openingId : undefined,
          plan: keyOf(ranges), gapBefore }))
      } catch (e) {
        if (!dead) setLast(p => ({ ...(p.ident === ident ? p : {
          rows: null, total: 0, more: false, located: '', locatedId: '', plan: '', gapBefore: [], openingId: undefined,
        }), ident, seq, error: String((e as Error)?.message ?? e) }))
      } finally {
        active = false
        if (pending && !dead) { pending = false; void tick() }
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 5000)
    const off = onLiveBump(() => { void tick() })
    return () => { dead = true; clearInterval(timer); off() }
  }, [ident, slug, node, locate, seq, team, autoOpen, hired, search, attempt])
  const busy = !last.error && (last.ident !== ident || last.rows == null || last.plan !== keyOf(plan.current.ranges))
  const fillGap = (id: string) => {
    if (busy || last.error) return
    const gap = last.gapBefore.indexOf(id)
    if (gap < 0) return
    const ranges = plan.current.ranges.map(r => ({ ...r }))
    ranges[gap]!.size += DOC_PAGE
    plan.current.ranges = merged(ranges); setAttempt(n => n + 1)
  }
  return { rows: last.ident === ident ? last.rows : null, total: last.total, more: last.more,
    busy, error: last.error, located: last.located, locatedId: last.locatedId, seq: last.seq,
    openingId: last.ident === ident ? last.openingId : undefined,
    gapBefore: last.gapBefore, fillGap,
    grow: () => {
      if (busy || last.error || !last.more) return
      const ranges = plan.current.ranges.map(r => ({ ...r })); ranges.at(-1)!.size += DOC_PAGE
      plan.current.ranges = ranges; setAttempt(n => n + 1)
    },
    retry: () => { setLast(p => ({ ...p, error: '' })); setAttempt(n => n + 1) },
    newer: false, growNewer: () => { if (last.gapBefore[0]) fillGap(last.gapBefore[0]) },
  }
}
