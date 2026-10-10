import type { AskInfo } from '../types'
import type { AnsweredQ, AnswerAsk, AnswerBatch, AskOption, BatchQ, Section, SectionCredit, SectionScope } from '../generated/events'

/** One question as the mini card draws it: every option the card offered with
 *  the chosen ones marked, or the typed answer when it offered none. */
export interface MiniQuestion {
  label: string | null; question: string; options: AskOption[]; multi: boolean
  selected: string[]; typed: string | null
}

const dash = ' · '
export function miniFromAsk(q: AnsweredQ, text: string | null, only: boolean): MiniQuestion {
  const options = q.options ?? []
  return { label: q.label, question: q.question, options, multi: q.multi ?? false,
    selected: q.selected, typed: only && text && options.length === 0 && q.selected.length === 0 ? text : null }
}
export function miniFromBatch(q: BatchQ): MiniQuestion {
  const options = q.options ?? []
  const selected = q.selected ?? (q.answer === null ? [] : options.length
    ? options.map(o => o.label).filter(l => (dash + q.answer + dash).includes(dash + l + dash)) : [])
  const typed = q.answer !== null && options.length === 0 && !q.selected ? q.answer : null
  return { label: q.label, question: q.question, options, multi: q.multi ?? false, selected, typed }
}

function Question({ q, dismissed }: { q: MiniQuestion; dismissed: boolean }) {
  const known = new Set(q.options.map(o => o.label))
  // a pick that is not one of the offered options (typed "other") still shows as chosen
  const extra = q.selected.filter(s => !known.has(s))
  const mark = (on: boolean) => q.multi ? (on ? '☑' : '☐') : (on ? '●' : '○')
  const row = (label: string, description: string | undefined, on: boolean) =>
    <li key={label} className={'answered-opt' + (on ? ' chosen' : '')} data-chosen={on ? 'true' : 'false'}>
      <span className="answered-mark" aria-hidden="true">{mark(on)}</span>
      <span><span className="answered-opt-label">{label}</span>
        {description && <span className="answered-opt-desc">{description}</span>}</span>
    </li>
  const skipped = !dismissed && q.selected.length === 0 && q.typed === null
  return <div className="answered-q" data-multi={q.multi ? 'true' : 'false'}>
    <div className="answered-qtext">{q.label && <span className="answered-chip">{q.label}</span>}{q.question}</div>
    {(q.options.length > 0 || extra.length > 0) && <ul className="answered-opts">
      {q.options.map(o => row(o.label, o.description, q.selected.includes(o.label)))}
      {extra.map(s => row(s, undefined, true))}
    </ul>}
    {q.typed !== null && <div className="answered-typed">{q.typed}</div>}
    {skipped && q.options.length === 0 && <div className="answered-skipped dim">Skipped</div>}
  </div>
}

export function AnsweredCard({ questions, dismissed, note }: { questions: MiniQuestion[]; dismissed: boolean; note?: string | null }) {
  const n = questions.length
  const head = (dismissed ? 'Dismissed' : 'Answered') + ' · ' + n + ' question' + (n === 1 ? '' : 's')
  return <details className="answered-card" open={n <= 2} data-dismissed={dismissed ? 'true' : 'false'}>
    <summary>{head}</summary>
    {questions.map((q, i) => <Question key={i} q={q} dismissed={dismissed} />)}
    {note && <div className="answered-note"><span className="dim">Note: </span>{note}</div>}
  </details>
}

export function AnsweredAsk({ event }: { event: AnswerAsk }) {
  const only = event.questions.length === 1
  return <AnsweredCard dismissed={event.dismissed}
    questions={event.questions.map(q => miniFromAsk(q, event.text, only))}
    note={event.text && !(only && (event.questions[0].options ?? []).length === 0 && event.questions[0].selected.length === 0) ? event.text : null} />
}

/** Ask sections of a resolved request become the same card; credit, scope and
 *  skipped sections stay with the generic renderer. */
export function batchAskQuestions(event: AnswerBatch): MiniQuestion[] {
  return event.sections.filter((s): s is Extract<Section, { kind: 'ask' }> => s.kind === 'ask')
    .flatMap(s => s.questions.map(miniFromBatch))
}

const DECISION: Record<string, { mark: string; word: string; tone: 'ok' | 'no' | 'part' | 'skip' }> = {
  approve: { mark: '✓', word: 'Granted', tone: 'ok' },
  'approve (partial)': { mark: '✓', word: 'Granted in part', tone: 'part' },
  'approve (clamped — not in effect)': { mark: '!', word: 'Approved, but not in effect', tone: 'part' },
  deny: { mark: '✕', word: 'Denied', tone: 'no' },
  skip: { mark: '–', word: 'Undecided — may be asked again', tone: 'skip' },
}
const CREDIT: Record<string, { word: string; tone: 'ok' | 'no' | 'part' | 'skip' }> = {
  approved: { word: 'Approved', tone: 'ok' },
  counter: { word: 'Counter-offer granted', tone: 'part' },
  reduced: { word: 'Granted, reduced', tone: 'part' },
  declined: { word: 'Declined', tone: 'no' },
  denied: { word: 'Denied', tone: 'no' },
  skipped: { word: 'Undecided', tone: 'skip' },
}

export function ScopeCard({ section }: { section: SectionScope }) {
  const n = section.decisions.length
  return <details className="answered-card resolved-card" open data-kind="scope">
    <summary>Scope request · {n} item{n === 1 ? '' : 's'}</summary>
    <ul className="resolved-rows">
      {section.decisions.map((d, i) => {
        const v = DECISION[d.decision] ?? { mark: '?', word: d.decision, tone: 'skip' as const }
        return <li key={i} className={'resolved-row tone-' + v.tone} data-decision={d.decision}>
          <span className="resolved-mark" aria-hidden="true">{v.mark}</span>
          <span className="resolved-label">{d.label}</span>
          <span className="resolved-verdict">{v.word}</span>
        </li>
      })}
    </ul>
  </details>
}

export function CreditCard({ section }: { section: SectionCredit }) {
  const v = CREDIT[section.outcome] ?? { word: section.outcome, tone: 'skip' as const }
  return <details className="answered-card resolved-card" open data-kind="credit">
    <summary>Credit request</summary>
    <ul className="resolved-rows">
      <li className={'resolved-row tone-' + v.tone} data-outcome={section.outcome}>
        <span className="resolved-mark" aria-hidden="true">{v.tone === 'ok' || v.tone === 'part' ? '✓' : v.tone === 'no' ? '✕' : '–'}</span>
        <span className="resolved-label">
          {section.old} → {section.asked} credits asked
          {section.granted !== null && section.granted !== section.asked ? `, ${section.granted} granted` : ''}
        </span>
        <span className="resolved-verdict">{v.word}</span>
      </li>
    </ul>
    {section.now !== null && <div className="answered-note"><span className="dim">Grant now: </span>{section.now}</div>}
  </details>
}

/** The credit and scope parts of a resolved request, in the same card
 *  language as the answered questions (no field dump, no bracket text). */
export function ResolvedSections({ event }: { event: AnswerBatch }) {
  return <>{event.sections.map((s, i) =>
    s.kind === 'scope' ? <ScopeCard key={i} section={s} />
    : s.kind === 'credit' ? <CreditCard key={i} section={s} />
    : s.kind === 'skipped' ? <details key={i} className="answered-card resolved-card" open>
        <summary>Skipped question</summary><div className="answered-q"><div className="answered-qtext">{s.question}</div></div></details>
    : null)}</>
}

/** every section kind the mini cards draw, so the generic field is empty */
export const resolvedSectionKinds = ['ask', 'scope', 'credit', 'skipped']

/** The inbox's nulled question card (an AskInfo) as mini questions, so the
 *  inbox draws the same card as the transcript. The answer can sit in three
 *  places depending on how it was submitted: the card's own `answer`
 *  ({selected, text}, the question route), or each tab's `answer` (the batch
 *  route, which leaves the card's own `answer` empty). */
const flat = (v: unknown): string[] => Array.isArray(v) ? v.flatMap(flat) : v == null || v === '' ? [] : [String(v)]
export function miniFromAskInfo(ask: AskInfo): { questions: MiniQuestion[]; note: string | null } {
  const tabs = ask.questions?.length ? ask.questions
    : [{ question: ask.question ?? '', header: ask.header, options: ask.options, multi: ask.multi,
         answer: undefined as string | string[] | undefined }]
  const own = ask.answer
  const ownSel = flat(own?.selected)
  const ownText = own?.text?.trim() || null
  let used = false
  const questions = tabs.map((t) => {
    const options = (t.options ?? []).map(o => typeof o === 'string' ? { label: o } : o)
    let selected = flat(t.answer)
    if (selected.length === 0 && tabs.length === 1) selected = ownSel
    // a "typed" reply: the pick is not among the offered options, or none were offered
    let typed: string | null = null
    if (options.length === 0) typed = selected.join(' · ') || (tabs.length === 1 ? ownText : null)
    else if (selected.length === 0 && tabs.length === 1 && ownText) typed = ownText
    if (options.length === 0) selected = []
    used = used || !!typed
    return { label: t.header ?? null, question: t.question, options, multi: t.multi ?? false, selected, typed }
  })
  const note = tabs.length === 1 && ownText && !used && questions[0].selected.length > 0 ? ownText : null
  return { questions, note }
}
