import type { AskInfo } from '../types'
import type { AnsweredQ, AnswerAsk, AnswerBatch, AskOption, BatchQ, Section, SectionCredit, SectionScope } from '../generated/events'
import { RefMdBody } from '../canvas/refmd'
import { RefChip, resolveRef } from '../canvas/reflinks'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import { inlineMd, md, singleParagraph } from '../canvas/shared'

/** The showing surface's reference wiring, as an event card's content has it.
 *  The card draws a question's text and option descriptions as the open card
 *  does (USER 2026-10-28 m5952056229d3: Markdown, LaTeX and mention links). */
interface QuestionRefs { world?: RefWorld | null; org?: string; onOpen?: (r: ResolvedRef) => void; imgBase?: string }

/** One question as the mini card draws it: every option the card offered with
 *  the chosen ones marked, or the typed answer when it offered none. */
export interface MiniQuestion {
  label: string | null; question: string; options: AskOption[]; multi: boolean
  selected: string[]; typed: string | null; work_item?: string | null
}

const dash = ' · '
export function miniFromAsk(q: AnsweredQ & { work_item?: string | null }, text: string | null, only: boolean): MiniQuestion {
  const options = q.options ?? []
  return { label: q.label, question: q.question, options, multi: q.multi ?? false,
    selected: q.selected, typed: only && text && options.length === 0 && q.selected.length === 0 ? text : null,
    ...(q.work_item ? { work_item: q.work_item } : {}) }
}
export function miniFromBatch(q: BatchQ & { work_item?: string | null }): MiniQuestion {
  const options = q.options ?? []
  const selected = q.selected ?? (q.answer === null ? [] : options.length
    ? options.map(o => o.label).filter(l => (dash + q.answer + dash).includes(dash + l + dash)) : [])
  const typed = q.answer !== null && options.length === 0 && !q.selected ? q.answer : null
  return { label: q.label, question: q.question, options, multi: q.multi ?? false, selected, typed,
    ...(q.work_item ? { work_item: q.work_item } : {}) }
}

/** A question's text beside its label chip, rendered as the open card renders
 *  it. One paragraph stays in the line, so a plain question keeps its look;
 *  block structure (a heading, a list, display math) gets its own box. */
function QuestionText({ text, label, workItem, refs }: {
  text: string; label?: string | null; workItem?: string | null; refs: QuestionRefs
}) {
  const html = md(text, refs.imgBase).__html
  const inline = singleParagraph(html)
  const chipWorld = refs.world ?? (refs.org ? { org: refs.org } : undefined)
  return <div className="answered-qtext">{label && <span className="answered-chip">{label}</span>}
    {workItem && chipWorld && <RefChip r={resolveRef({ kind: 'item', org: chipWorld.org, id: workItem }, chipWorld)} onOpen={refs.onOpen} />}
    <RefMdBody el={inline === null ? 'div' : 'span'} className="answered-qbody md"
      html={{ __html: inline ?? html }} world={refs.world} onOpen={refs.onOpen} /></div>
}

function Question({ q, dismissed, refs }: { q: MiniQuestion; dismissed: boolean; refs: QuestionRefs }) {
  const known = new Set(q.options.map(o => o.label))
  // a pick that is not one of the offered options (typed "other") still shows as chosen
  const extra = q.selected.filter(s => !known.has(s))
  const mark = (on: boolean) => q.multi ? (on ? '☑' : '☐') : (on ? '●' : '○')
  // the label stays plain text, as on the open card's buttons it gets no chips
  const row = (label: string, description: string | undefined, on: boolean) =>
    <li key={label} className={'answered-opt' + (on ? ' chosen' : '')} data-chosen={on ? 'true' : 'false'}>
      <span className="answered-mark" aria-hidden="true">{mark(on)}</span>
      <span><span className="answered-opt-label">{label}</span>
        {description && <RefMdBody el="span" className="answered-opt-desc"
          html={inlineMd(description, refs.imgBase)} world={refs.world} onOpen={refs.onOpen} />}</span>
    </li>
  const skipped = !dismissed && q.selected.length === 0 && q.typed === null
  return <div className="answered-q" data-multi={q.multi ? 'true' : 'false'}>
    <QuestionText text={q.question} label={q.label} workItem={q.work_item} refs={refs} />
    {(q.options.length > 0 || extra.length > 0) && <ul className="answered-opts">
      {q.options.map(o => row(o.label, o.description, q.selected.includes(o.label)))}
      {extra.map(s => row(s, undefined, true))}
    </ul>}
    {q.typed !== null && <div className="answered-typed">{q.typed}</div>}
    {skipped && q.options.length === 0 && <div className="answered-skipped dim">Skipped</div>}
  </div>
}

export function AnsweredCard({ questions, dismissed, note, ...refs }: {
  questions: MiniQuestion[]; dismissed: boolean; note?: string | null } & QuestionRefs) {
  const n = questions.length
  const head = (dismissed ? 'Dismissed' : 'Answered') + ' · ' + n + ' question' + (n === 1 ? '' : 's')
  return <details className="answered-card" open={n <= 2} data-dismissed={dismissed ? 'true' : 'false'}>
    <summary>{head}</summary>
    {questions.map((q, i) => <Question key={i} q={q} dismissed={dismissed} refs={refs} />)}
    {note && <div className="answered-note"><span className="dim">Note: </span>{note}</div>}
  </details>
}

export function AnsweredAsk({ event, ...refs }: { event: AnswerAsk } & QuestionRefs) {
  const only = event.questions.length === 1
  return <AnsweredCard dismissed={event.dismissed} {...refs}
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
export function ResolvedSections({ event, ...refs }: { event: AnswerBatch } & QuestionRefs) {
  return <>{event.sections.map((s, i) =>
    s.kind === 'scope' ? <ScopeCard key={i} section={s} />
    : s.kind === 'credit' ? <CreditCard key={i} section={s} />
    : s.kind === 'skipped' ? <details key={i} className="answered-card resolved-card" open>
        <summary>Skipped question</summary><div className="answered-q"><QuestionText text={s.question} refs={refs} /></div></details>
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
  // the batch route stores its whole body as the card's answer: {answers: [one per tab], ...}
  const batch = (own as { answers?: unknown } | undefined)?.answers
  const qTabs = (ask.tabs ?? []).filter(x => x.kind === 'question')
  const questions = tabs.map((t, i) => {
    const options = (t.options ?? []).map(o => typeof o === 'string' ? { label: o } : o)
    let selected = flat(t.answer)
    if (selected.length === 0 && Array.isArray(batch)) selected = flat(batch[i])
    if (selected.length === 0 && tabs.length === 1) selected = ownSel
    // a card with several tabs answered through the question route: one list of picks per tab
    if (selected.length === 0 && tabs.length > 1 && Array.isArray(own?.selected)) selected = flat((own.selected as unknown[])[i])
    // a "typed" reply: the pick is not among the offered options, or none were offered
    let typed: string | null = null
    if (options.length === 0) typed = selected.join(' · ') || (tabs.length === 1 ? ownText : null)
    else if (selected.length === 0 && tabs.length === 1 && ownText) typed = ownText
    if (options.length === 0) selected = []
    used = used || !!typed
    const work_item = t.work_item ?? qTabs[i]?.work_item
      ?? (tabs.length === 1 ? ask.work_items?.[0] : undefined)
    return { label: t.header ?? null, question: t.question, options, multi: t.multi ?? false, selected, typed,
      ...(work_item ? { work_item } : {}) }
  })
  const note = tabs.length === 1 && ownText && !used && questions[0].selected.length > 0 ? ownText : null
  return { questions, note }
}
