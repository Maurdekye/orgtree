// canvas/mentionsearch.ts — tickets, presentations, apps and panels for the
// composer's @ list, from the engine's one bounded read (GET
// mention-candidates). USER 2026-10-27: m042c82fb0228 "and i should be able to
// mention apps, panels, and presentations from my @ mention menu";
// mdb3b4aef1062 and m35d9b7cf74f6, a kind prefix lists all of that kind;
// m79e889ce1609, newest first by the latest of mentioned, operated on or
// presented. Live things only (tickets outside the docket's archive,
// presentations not dismissed), ranked by the engine, a page at a time.
//
// THE RENDERER HOLDS NO ORG-WIDE LIST OF THESE: the record feed carries
// summaries, and the docket and the gallery read bounded pages. So the list
// asks the engine for the text being typed, and for a further page only when
// the reader reaches the end of the rows it has.
//
// ONE READ PER ORG AT A TIME: a query typed while one is out waits for it and
// runs next (only the latest). Answers are kept briefly per org and query
// with the pages loaded so far; while the exact one is on its way, the nearest
// shorter query's answer for the same kinds stands in, and the list's own
// match narrows it.

import { useEffect, useState } from 'react'
import { getMentionCandidates } from '../api'
import type { MentionPage, MentionRow } from '../api'

export type SearchKind = MentionRow['kind']
export const SEARCH_KINDS: readonly SearchKind[] = ['item', 'doc', 'app', 'panel']
/** rows one read asks for */
export const SEARCH_PAGE = 20
/** an answer this young is not asked again */
const FRESH_MS = 5_000
/** queries kept per org */
const PER_ORG = 24

export interface SearchAnswer {
  rows: MentionRow[]
  /** a further page waits on the engine */
  more: boolean
  /** node name -> newest mention in mail (ms), from the first page */
  nodes: ReadonlyMap<string, number>
}
type Held = SearchAnswer & { at: number; next: string | null }
type Job = { key: string; kinds: readonly SearchKind[]; text: string; after: string | null }

const EMPTY: SearchAnswer = { rows: [], more: false, nodes: new Map() }
const answers = new Map<string, Map<string, Held>>()
const running = new Map<string, Job>()
const waiting = new Map<string, Job>()
const listeners = new Set<() => void>()

const kindsKey = (kinds: readonly SearchKind[]) => [...kinds].sort().join(',')
const keyOf = (kinds: readonly SearchKind[], text: string) => `${kindsKey(kinds)}|${text}`

function store(org: string, job: Job, page: MentionPage): void {
  let byKey = answers.get(org)
  if (!byKey) answers.set(org, byKey = new Map())
  const prior = byKey.get(job.key)
  // a further page extends the answer it continued; anything else starts afresh
  const continued = !!job.after && !!prior && prior.next === job.after
  const rows = continued ? [...prior!.rows, ...page.items] : page.items
  const nodes = page.nodes ? new Map(page.nodes.map(n => [n.name, Date.parse(n.at) || 0])) : prior?.nodes ?? new Map<string, number>()
  byKey.delete(job.key)
  byKey.set(job.key, { rows, nodes, next: page.next_cursor, more: !!page.next_cursor, at: continued ? prior!.at : Date.now() })
  while (byKey.size > PER_ORG) byKey.delete(byKey.keys().next().value!)
  for (const fn of listeners) fn()
}

function run(org: string, job: Job): void {
  if (running.has(org)) {
    waiting.set(org, job)
    return
  }
  running.set(org, job)
  // a failed read keeps nothing: the next query or scroll asks again
  void getMentionCandidates(org, job.kinds, job.text, job.after, SEARCH_PAGE).then(page => store(org, job, page), () => {}).finally(() => {
    running.delete(org)
    const next = waiting.get(org)
    waiting.delete(org)
    if (next) run(org, next)
  })
}

/** This query's first page, unless a fresh answer is held. */
function request(org: string, kinds: readonly SearchKind[], text: string): void {
  const key = keyOf(kinds, text)
  const held = answers.get(org)?.get(key)
  if (held && Date.now() - held.at < FRESH_MS) return
  run(org, { key, kinds, text, after: null })
}

/** The page after the rows held for this query, once. */
export function loadMoreMentions(org: string, kinds: readonly SearchKind[], text: string): void {
  const key = keyOf(kinds, text)
  const held = answers.get(org)?.get(key)
  if (!held?.next) return
  const same = (job?: Job) => !!job && job.key === key && job.after === held.next
  if (same(running.get(org)) || same(waiting.get(org))) return
  run(org, { key, kinds, text, after: held.next })
}

/** The exact answer, else the nearest shorter query's for the same kinds (a
 *  superset the list narrows; it pages nothing until the exact one is in). */
function answerFor(org: string, kinds: readonly SearchKind[], text: string): SearchAnswer {
  const byKey = answers.get(org)
  if (!byKey) return EMPTY
  const exact = byKey.get(keyOf(kinds, text))
  if (exact) return exact
  const prefix = `${kindsKey(kinds)}|`
  let best: Held | undefined, length = -1
  for (const [key, answer] of byKey) {
    if (!key.startsWith(prefix)) continue
    const q = key.slice(prefix.length)
    if (q.length > length && text.startsWith(q)) { best = answer; length = q.length }
  }
  return best ? { rows: best.rows, nodes: best.nodes, more: false } : EMPTY
}

/** What the engine offers while `text` (after `@` and any kind prefix) is
 *  completed in `org`, for these kinds; none when nothing is. */
export function useMentionSearch(org: string | null | undefined, kinds: readonly SearchKind[] | null, text: string | null): SearchAnswer {
  const [, bump] = useState(0)
  const active = !!org && !!kinds?.length && text !== null
  useEffect(() => {
    if (!active) return
    const fn = () => bump(n => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [active])
  const asked = kinds ? kindsKey(kinds) : ''
  useEffect(() => {
    if (active) request(org!, kinds!, text!)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `asked` stands for the kinds
  }, [org, asked, text, active])
  return active ? answerFor(org!, kinds!, text!) : EMPTY
}

export function resetMentionSearchForTests(): void {
  answers.clear()
  running.clear()
  waiting.clear()
}
