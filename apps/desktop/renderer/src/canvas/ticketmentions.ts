// canvas/ticketmentions.ts — docket tickets for the composer's @-completion
// (docket mention-entry-on-ticket-cards-in-transcripts-ins; USER 2026-10-22
// 18:16:44Z: "also mention tickets through the mention tab completion list
// along with agents/projects").
//
// THE RENDERER HOLDS NO ORG-WIDE TICKET LIST: the record feed carries only the
// docket's summary, and the docket itself reads bounded pages. So completion
// asks the docket's own paged search for the text being typed, in the CURRENT
// and BACKLOGGED groups: the tickets a reader mentions. The archive is never
// read, as retired agents are never offered.
//
// ONE READ PER ORG AT A TIME. A query typed while one is out waits for it and
// runs next (only the latest), so typing never stacks requests. Answers are
// kept briefly per org and query; while the exact one is on its way, the
// nearest shorter query's answer stands in, and the list's own match
// (`filterMentionCandidates`) narrows it.

import { useEffect, useState } from 'react'
import { getWorkPage } from '../api'
import type { WorkPage } from '../workpages'
import type { MentionCandidate } from './agentmentions'

/** an answer this young is not asked again (the docket polls every 5 s too) */
const FRESH_MS = 5_000
/** queries kept per org */
const PER_ORG = 24
const GROUPS = ['items', 'backlogged'] as const
const EMPTY: MentionCandidate[] = []

type Answer = { at: number; rows: MentionCandidate[] }
const answers = new Map<string, Map<string, Answer>>()
const running = new Map<string, string>()
const waiting = new Map<string, string>()
const listeners = new Set<() => void>()

function store(org: string, query: string, rows: MentionCandidate[]): void {
  let byQuery = answers.get(org)
  if (!byQuery) answers.set(org, byQuery = new Map())
  byQuery.delete(query)
  byQuery.set(query, { at: Date.now(), rows })
  while (byQuery.size > PER_ORG) byQuery.delete(byQuery.keys().next().value!)
  for (const fn of listeners) fn()
}

/** One group's first page. A page assembled across a docket write answers
 *  `reset`; it is asked once more, and a second reset is no answer. */
async function page(org: string, group: typeof GROUPS[number], query: string): Promise<WorkPage> {
  const first = await getWorkPage(org, group, { query })
  const answer = first?.reset ? await getWorkPage(org, group, { query }) : first
  if (!answer || answer.reset || !Array.isArray(answer.rows)) throw new Error('no docket page')
  return answer
}

async function read(org: string, query: string): Promise<MentionCandidate[]> {
  const pages = await Promise.all(GROUPS.map(group => page(org, group, query)))
  const seen = new Set<string>()
  const out: MentionCandidate[] = []
  for (const { rows } of pages) for (const row of rows) {
    if (!row?.slug || row.archived || seen.has(row.slug)) continue
    seen.add(row.slug)
    out.push({ id: row.slug, kind: 'ticket', tier: 'ticket', org, title: row.title })
  }
  return out
}

function request(org: string, query: string): void {
  const held = answers.get(org)?.get(query)
  if (held && Date.now() - held.at < FRESH_MS) return
  if (running.has(org)) {
    if (running.get(org) !== query) waiting.set(org, query)
    return
  }
  running.set(org, query)
  // a failed read is not an empty docket: nothing is kept, and the next query asks again
  void read(org, query).then(rows => store(org, query, rows), () => {}).finally(() => {
    running.delete(org)
    const next = waiting.get(org)
    waiting.delete(org)
    if (next !== undefined) request(org, next)
  })
}

/** The exact answer, else the nearest shorter query's (a superset the list narrows). */
function answerFor(org: string, query: string): MentionCandidate[] {
  const byQuery = answers.get(org)
  if (!byQuery) return EMPTY
  const exact = byQuery.get(query)
  if (exact) return exact.rows
  let best: Answer | undefined, length = -1
  for (const [q, answer] of byQuery) {
    if (q.length > length && query.startsWith(q)) { best = answer; length = q.length }
  }
  return best?.rows ?? EMPTY
}

/** The tickets to offer while `query` (the text after `@`) is being completed,
 *  or none when nothing is. Org-scoped: each ticket inserts its own reference. */
export function useTicketMentionCandidates(org: string | null | undefined, query: string | null): MentionCandidate[] {
  const [, bump] = useState(0)
  const active = !!org && query !== null
  useEffect(() => {
    if (!active) return
    const fn = () => bump(n => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [active])
  useEffect(() => { if (org && query !== null) request(org, query) }, [org, query])
  return active ? answerFor(org!, query!) : EMPTY
}

export function resetTicketMentionsForTests(): void {
  answers.clear()
  running.clear()
  waiting.clear()
}
