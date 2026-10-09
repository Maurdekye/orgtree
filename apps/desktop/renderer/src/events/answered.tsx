import type { AnsweredQ, AnswerAsk, AnswerBatch, AskOption, BatchQ, Section } from '../generated/events'

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
