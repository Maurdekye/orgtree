// canvas/presentationmentions.ts — presentations for the composer's
// @-completion (USER 2026-10-27 mb21c096e5dc4: "and theynshould appear in the
// mention menu"), beside agents, projects and tickets.
//
// THE RENDERER HOLDS NO ORG-WIDE PRESENTATION LIST: the record feed carries
// each agent's newest cards only, and the gallery reads bounded pages. So
// completion asks the engine's bounded search for the text being typed: the
// org's gallery presentations (dismissed ones are not offered) whose title or
// slug holds every word, newest first, at most 20.
//
// ONE READ PER ORG AT A TIME, as for tickets (ticketmentions.ts): a query typed
// while one is out waits for it and runs next (only the latest). Answers are
// kept briefly per org and query; while the exact one is on its way, the
// nearest shorter query's answer stands in, and the list's own match
// (`filterMentionCandidates`) narrows it.

import { useEffect, useState } from 'react'
import { searchDocuments } from '../api'
import type { MentionCandidate } from './agentmentions'

/** an answer this young is not asked again */
const FRESH_MS = 5_000
/** queries kept per org */
const PER_ORG = 24
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

async function read(org: string, query: string): Promise<MentionCandidate[]> {
  // the typed text's words; `@` completion has no spaces, so a slug's dashes split it
  const hits = await searchDocuments(org, query.replace(/[-_.]+/g, ' '))
  return hits.filter(h => h?.id).map(h => ({ id: h.id, kind: 'presentation' as const, tier: 'presentation', org, title: h.title }))
}

function request(org: string, query: string): void {
  const held = answers.get(org)?.get(query)
  if (held && Date.now() - held.at < FRESH_MS) return
  if (running.has(org)) {
    if (running.get(org) !== query) waiting.set(org, query)
    return
  }
  running.set(org, query)
  // a failed read is not an empty gallery: nothing is kept, and the next query asks again
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

/** The presentations to offer while `query` (the text after `@`) is being
 *  completed, or none when nothing is. Org-scoped: each inserts its own reference. */
export function usePresentationMentionCandidates(org: string | null | undefined, query: string | null): MentionCandidate[] {
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

export function resetPresentationMentionsForTests(): void {
  answers.clear()
  running.clear()
  waiting.clear()
}
