// Submitted question cards (user feedback point 31, 2026-09-29): "id rather
// they disappear immediately and queue as the request resolved message
// immediately".
//
// When the user submits a card (answer, skip or dismiss), the card leaves
// EVERY view on that click. The views do not wait for the server or for the
// agent to pick the answer up. The agent's chat shows the answer straight away
// as a queued "Request resolved" entry. That entry is built here from what the
// user chose, in the same answer.batch shape the server will mint. It stays
// until the server's own row for the same ask shows up; the desk retires it at
// that point, so the answer is on screen exactly once. A failed submit brings
// the card back with the error and the user's own choices, and removes the
// queued entry.
//
// This is one module-level store, so every view in this window (desk, inbox,
// Attention, docket) agrees without passing anything down. It is kept in memory
// only: after a reload the tree payload is the truth again.
import { useSyncExternalStore } from 'react'
import type { AnswerAsk, AnswerBatch, AnsweredQ, PublicAnswerAsk, PublicAnswerBatch, Section,
  PublicSection } from './generated/events'
import type { AskInfo, AskQuestion, PendingMail } from './types'

export interface SubmittedAsk {
  slug: string
  nid: string
  askId: string
  /** ISO time of the submit: the queued entry's timestamp */
  at: string
  /** `sent`: in flight or accepted, so the card is hidden. `failed`: the card
   *  is back with `error`. */
  state: 'sent' | 'failed'
  error?: string
  /** the submitting card's drafts, handed back to the card on failure so the
   *  user does not have to answer again */
  drafts?: { signature: string; drafts: unknown[] }
  /** the queued entry of a batch card: its answer.batch sections */
  sections: Section[] | null
  /** the queued entry of a single-question card (the docket, and the inbox
   *  and Attention rows of an agent outside the selected tree): its
   *  answer.ask fields, as ledger.ask_answer / ask_dismiss mint them */
  answer?: { questions: AnsweredQ[]; text: string | null; dismissed: boolean; single: boolean }
  /** the desk has shown the server's own row for this answer */
  seen?: boolean
}

const entries = new Map<string, SubmittedAsk>()
const listeners = new Set<() => void>()
let version = 0
const key = (slug: string, askId: string) => JSON.stringify([slug, askId])
function emit() {
  version += 1
  for (const l of [...listeners]) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Re-render on any change to the store. Returns a change counter. */
export function useSubmittedAsks(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** The card is gone from every view while its submit is in flight or
 *  accepted. */
export function askHidden(slug: string, askId: string | null | undefined): boolean {
  return askId != null && entries.get(key(slug, String(askId)))?.state === 'sent'
}

/** `askHidden` for a caller that has no org at hand: ask ids are random
 *  per record, so the id alone names one ask. */
export function askSubmitted(askId: string | null | undefined): boolean {
  if (askId == null) return false
  for (const e of entries.values()) if (e.askId === String(askId) && e.state === 'sent') return true
  return false
}

/** The failed submit of this card, if its last one failed. */
export function askFailure(slug: string, askId: string): SubmittedAsk | undefined {
  const e = entries.get(key(slug, askId))
  return e?.state === 'failed' ? e : undefined
}

/** Submit a card: hide it at once, then send. On failure the card comes back
 *  (with `error` and the drafts), the queued entry goes, and the promise
 *  rejects so the caller can still toast. */
export function submitAsk(entry: Omit<SubmittedAsk, 'state' | 'at' | 'error' | 'seen'>,
  send: () => Promise<unknown>): Promise<void> {
  const k = key(entry.slug, entry.askId)
  const mine: SubmittedAsk = { ...entry, state: 'sent', at: new Date().toISOString() }
  entries.set(k, mine)
  emit()
  return send().then(() => undefined, (e: unknown) => {
    // a later submit of the same card owns the entry now
    if (entries.get(k) === mine) {
      entries.set(k, { ...mine, state: 'failed',
        error: e instanceof Error ? e.message : String(e) })
      emit()
    }
    throw e
  })
}

/** Forget a failed submit once the card has shown its error and taken back
 *  its drafts (the user is editing again). */
export function clearAskFailure(slug: string, askId: string) {
  const k = key(slug, askId)
  if (entries.get(k)?.state === 'failed') { entries.delete(k); emit() }
}

/** The answers this node has submitted whose server row the desk has not
 *  shown yet: the queued "Request resolved" entries. */
export function queuedAnswers(slug: string, nid: string): SubmittedAsk[] {
  return [...entries.values()].filter(e => e.slug === slug && e.nid === nid
    && e.state === 'sent' && !e.seen && (e.sections || e.answer))
}

/** The desk has drawn the server's own row for this answer. The entry keeps
 *  hiding the card until `settleSubmitted` sees the tree agree. */
export function markAnswerSeen(slug: string, askId: string) {
  const e = entries.get(key(slug, askId))
  if (e && !e.seen) { e.seen = true; emit() }
}

/** How long an accepted submit is kept once the tree no longer lists the ask
 *  as open, for a desk that is not mounted to retire it. */
export const SETTLE_MS = 10 * 60 * 1000

/** Drop accepted submits the tree has caught up with: the ask is no longer
 *  open, and the desk has shown the server's row (or it has been
 *  SETTLE_MS). `stillOpen(slug, askId)` is the tree's own answer. */
export function settleSubmitted(stillOpen: (slug: string, askId: string) => boolean,
  now = Date.now()) {
  let changed = false
  for (const [k, e] of entries) {
    if (stillOpen(e.slug, e.askId)) continue
    // a failed submit's card is gone anyway once the ask is no longer open
    if (e.state === 'failed' || e.seen || now - Date.parse(e.at) >= SETTLE_MS) {
      entries.delete(k); changed = true
    }
  }
  if (changed) emit()
}

/** `settleSubmitted` against one org's tree payload: an ask is still open
 *  while a node in the payload carries it open, or the payload's `asks`
 *  list does. Entries of other orgs are left alone. */
export function settleFromTree(slug: string, tree: { roots?: unknown[]; asks?: unknown[] },
  now = Date.now()) {
  if (!entries.size) return
  const open = new Set<string>()
  const live = (a: unknown): a is { id: unknown } => !!a && typeof a === 'object'
    && ((a as { status?: unknown }).status === 'open' || (a as { status?: unknown }).status === 'pending')
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const node = n as { ask?: unknown; children?: unknown[] }
    if (live(node.ask)) open.add(String(node.ask.id))
    for (const c of node.children ?? []) walk(c)
  }
  for (const r of tree.roots ?? []) walk(r)
  for (const a of tree.asks ?? []) if (live(a)) open.add(String(a.id))
  settleSubmitted((s, id) => s !== slug || open.has(id), now)
}

/** A submitted card AS THE RESOLVED CARD IT IS ABOUT TO BECOME, for a list
 *  that keeps its entry (docket v3-an-answered-question-vanishes-from-the-
 *  inbox, user 2026-09-30): point 31 closes the card on the click, but the
 *  inbox ROW stays where it was, marked answered with the user's answer,
 *  instead of vanishing until the tree lists the resolved ask. Built from
 *  what the user chose (the same sections/answer the queued entry carries).
 *  `null` unless this card's submit is in flight or accepted. */
export function answeredAsk(slug: string, ask: AskInfo): AskInfo | null {
  const e = entries.get(key(slug, String(ask.id)))
  if (!e || e.state !== 'sent') return null
  const qs: AskQuestion[] = []
  for (const s of e.sections ?? []) {
    if (s.kind === 'ask') {
      for (const q of s.questions) {
        qs.push({ question: q.question, ...(q.label ? { header: q.label } : {}),
          ...(q.answer != null ? { answer: q.answer } : {}) })
      }
    } else if (s.kind === 'skipped') {
      qs.push({ question: s.question, answer: 'skipped' })
    }
  }
  for (const q of e.answer?.questions ?? []) {
    qs.push({ question: q.question, ...(q.label ? { header: q.label } : {}),
      ...(q.selected.length ? { answer: q.selected.join(' · ') } : {}) })
  }
  const text = e.answer?.text || ''
  const status = e.answer?.dismissed ? 'dismissed' : 'answered'
  // a resolved card is filed by what it asked, like the tree's own resolved
  // rows: a composed batch with a question reads as that question, never as
  // "N request(s) awaiting one submit"
  const kind = qs.length ? 'question' : ask.kind
  if (qs.length > 1) return { ...ask, kind, status, resolved_at: e.at, questions: qs, question: qs[0]!.question }
  const one = qs[0]
  const shown = [one?.answer, text].filter((x) => x && String(x).trim()).join(' · ')
  return {
    ...ask, kind, status, resolved_at: e.at,
    ...(one ? { question: one.question, questions: qs } : {}),
    ...(shown ? { answer: { text: shown } } : {}),
  }
}

/** Test hook: empty the store. */
export function resetSubmittedAsks() {
  entries.clear()
  emit()
}

/** The queued entry as a pending-mail row, carrying the event the server
 *  will mint for this submit, so it renders through the ordinary queued-mail
 *  row: answer.batch ("Request resolved", ledger.resolve_batch) for a batch
 *  card, answer.ask (ledger.ask_answer / ask_dismiss) for a single-question
 *  card. It has no mail id: nothing is filed yet, so there is nothing to
 *  retract. */
export function queuedAnswerRow(e: SubmittedAsk, publicProfile: boolean): PendingMail {
  const actor = { kind: 'user' as const, id: '@user' }
  if (e.answer) {
    const row: PendingMail = { id: null, from: '@user', kind: 'message', body: '', at: e.at }
    const fields = { questions: e.answer.questions, text: e.answer.text,
      dismissed: e.answer.dismissed, single: e.answer.single }
    if (!publicProfile) {
      const ev: AnswerAsk = { v: 1, variant: 'answer.ask', actor, engine_authored: false,
        object: { kind: 'ask', org: e.slug, id: e.askId, node: e.nid }, ...fields }
      return { ...row, ev }
    }
    const pub: PublicAnswerAsk = { v: 1, variant: 'answer.ask', projection: 'public', actor,
      object: { kind: 'ask', id: e.askId, node: e.nid }, ...fields }
    return { ...row, ev_public: pub }
  }
  const sections = e.sections ?? []
  const ev: AnswerBatch = { v: 1, variant: 'answer.batch', actor, engine_authored: false,
    object: { kind: 'batch', org: e.slug, id: e.askId, node: e.nid }, sections }
  const row: PendingMail = { id: null, from: '@user', kind: 'message', body: '', at: e.at }
  if (!publicProfile) return { ...row, ev }
  const pub: PublicAnswerBatch = { v: 1, variant: 'answer.batch', projection: 'public',
    actor, object: { kind: 'batch', id: e.askId, node: e.nid },
    sections: sections.map((s): PublicSection =>
      s.kind === 'ask' ? { kind: 'ask', questions: s.questions }
        : s.kind === 'skipped' ? { kind: 'skipped', question: s.question }
        : s.kind === 'scope' ? { kind: 'scope', lines: s.lines,
            decisions: s.decisions.map(d => ({ decision: d.decision })) }
        : s) }
  return { ...row, ev_public: pub }
}
