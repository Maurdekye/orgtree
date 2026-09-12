// canvas/asks.tsx — the unified ask system (F-04 questions + F-05 credit
// counter-offers, user-ruled 2026-08-04). An ask is a card that renders in
// TWO places at once — the asking agent's desk and the user's inbox (as its
// own mail row) — and is answered from whichever the user reaches first.
// Answering (or any other mail waking the agent) nulls it EVERYWHERE.
//
// The form mimics Claude Code's own AskUserQuestion surface (user ruling,
// 2026-08-04, from a side-by-side): a header chip with a ✕, the question in
// bold, option ROWS (radio / checkbox) with a bold label and a dim
// description, an "Other" row that opens free text, and a submit bar.
// The credit request wears the same form family — header chip, ✕ = deny,
// the drag bar as its body.
//
// The answer itself travels as ordinary user mail (it is what drives the
// agent's next turn); this file never fabricates conversation state.

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { AskInfo, AskQuestion, AskTab, ToastFn } from '../types'
import { answerAsk, creditDecide, resolveBatch } from '../api'
import { CreditBar } from './cards'
import { CloseIcon, WarnIcon } from '../icons'
import { isMobile } from '../mobile'

const OTHER = '\0other'          // sentinel — no label can collide with it

/** ctrl+enter (⌘+enter on mac) — submits the card the user is working in.
 *  Live cards carry tabIndex=-1, so any click inside (an option row, the
 *  bar, the Other input) parks focus in the card and the keydown bubbles to
 *  its root; preventDefault also stops a focused row button from
 *  click-toggling on the same Enter. */
const isSubmitKey = (e: KeyboardEvent): boolean =>
  e.key === 'Enter' && (e.ctrlKey || e.metaKey)

/** WHY THE CREDIT STEPPER IS AT ITS END. Both bounds are real rules with real
 *  numbers, and a dead button shows neither: the floor is what the asking
 *  agent has already handed down to its own reports (grant − free), which
 *  cannot be taken back from this card, and the ceiling is the org's
 *  "top-level grant cap" — the setting's own words — which the stepper honours
 *  wherever the asking node sits. One pair of helpers serves both credit
 *  cards, so the two cannot drift into describing the same rule differently.
 *  Each returns undefined while the button is live: a title on an enabled
 *  control would be a tooltip explaining a limit the user has not hit. */
export const stepDownWhy = (g: number, committed: number): string | undefined => {
  if (g > committed) return undefined
  return committed > 0
    ? `${committed} credit${committed === 1 ? ' is' : 's are'} already committed `
      + "to this agent's own reports — take those back first to offer less"
    : 'a grant cannot go below zero'
}

export const stepUpWhy = (g: number, maxTop?: number): string | undefined =>
  (maxTop != null && g >= maxTop
    ? `the offer stops at this org's top-level grant cap of ${maxTop}`
    : undefined)

export function AskCard({ ask, slug, toast, seat = 0, committed = 0, maxTop,
  segments = [], pxc }: {
  ask: AskInfo
  slug: string
  toast: ToastFn
  /** credit-mode bar geometry: the asking node's seat and committed
   *  (grant − free) — committed is also the drag FLOOR, mirroring
   *  reallocate's own invariant rather than inventing one */
  seat?: number
  committed?: number
  maxTop?: number
  /** the node's live child slabs — the bar must look IDENTICAL to the
   *  agent's real card bar (user ruling 2026-08-05) */
  segments?: { seat: number; grant: number }[]
  /** the org's px-per-credit (orgPxc) — same scale as the canvas bars */
  pxc?: number
}) {
  const live = ask.status === 'open' || ask.status === 'pending'
  const credit = ask.kind === 'credit'
    || (ask.kind !== 'batch' && ask.old != null)
  if (!live) return <NulledAsk ask={ask} credit={credit} />
  // FR-14: the composed batch — mixed tabs, one submit. Legacy open cards
  // (a rolling deploy's pre-batch payload) fall through to the old forms.
  if (ask.kind === 'batch' && ask.tabs?.length) {
    return <BatchAsk ask={ask} slug={slug} toast={toast}
        seat={seat} committed={committed} maxTop={maxTop}
        segments={segments} pxc={pxc} />
  }
  return credit
    ? <CreditAsk ask={ask} slug={slug} toast={toast}
        seat={seat} committed={committed} maxTop={maxTop}
        segments={segments} pxc={pxc} />
    : <QuestionAsk ask={ask} slug={slug} toast={toast} />
}

/** Question text is the ledger's per-request identity; the full editable
 * definition decides whether its draft still applies. Revisions remain CAS
 * stamps for submission, not instructions to discard every answer. */
function questionDraftKey(q: AskQuestion | AskTab): unknown[] {
  return [q.question, q.header ?? '', !!q.multi, q.work_item ?? '',
    (q.options ?? []).map(o => typeof o === 'string'
      ? [o, ''] : [o.label, o.description ?? ''])]
}

/** Reconcile before rendering inputs: no frame may pair an old draft with a
 * changed question. Only the immediately previous inventory is retained, so
 * removing a question also removes its draft. Matching consumes each old slot
 * once, even for a malformed payload with duplicate questions. */
function useRequestDrafts<D>(keys: string[], make: (i: number) => D) {
  const signature = JSON.stringify(keys)
  const [saved, setSaved] = useState(() => ({ signature, keys,
    drafts: keys.map((_, i) => make(i)) }))
  const [tab, setTab] = useState(0)
  let current = saved
  if (saved.signature !== signature) {
    const used = new Set<number>()
    const previous = keys.map(key => {
      const i = saved.keys.findIndex((old, j) => old === key && !used.has(j))
      if (i >= 0) used.add(i)
      return i
    })
    current = { signature, keys,
      drafts: previous.map((i, j) => i < 0 ? make(j) : saved.drafts[i]!) }
    setSaved(current)
    const moved = previous.indexOf(tab)
    setTab(moved >= 0 ? moved : Math.min(tab, keys.length - 1))
  }
  const setDrafts = (update: (ds: D[]) => D[]) =>
    setSaved(s => ({ ...s, drafts: update(s.drafts) }))
  return { drafts: current.drafts, setDrafts, tab, setTab }
}

/** FR-14: one draft state per tab. A tab is DECIDED when the user answered
 *  it or explicitly skipped it — the submit needs every tab decided, and a
 *  skip travels as an explicit null/skip, never a hole. */
interface BatchDraft {
  q: TabDraft & { skip: boolean }
  credits: { mode: 'grant' | 'deny' | 'skip' | null; g: number }
  scope: 'approve' | 'deny' | 'skip' | null
}

function BatchAsk({ ask, slug, toast, seat, committed, maxTop, segments,
  pxc: orgScale }: {
  ask: AskInfo; slug: string; toast: ToastFn
  seat: number; committed: number; maxTop?: number
  segments: { seat: number; grant: number }[]
  pxc?: number
}) {
  const tabs: AskTab[] = (ask.tabs ?? []).map((t) => ({
    ...t, options: (t.options ?? []).map((o) =>
      typeof o === 'string' ? { label: o } : o) }))
  const [busy, setBusy] = useState(false)
  const keys = tabs.map(t => JSON.stringify([slug, ask.node, t.kind,
    t.kind === 'question' ? [ask.id, questionDraftKey(t)]
      : t.kind === 'credits' ? [t.id, t.old, t.new, t.reason]
      : [t.id, t.item?.kind, t.item?.path, t.item?.mode, t.item?.tool,
          t.item?.server, t.label, t.reason]]))
  const { drafts, setDrafts, tab, setTab } = useRequestDrafts<BatchDraft>(keys,
    i => ({ q: { sel: [], text: '', skip: false },
      credits: { mode: null, g: tabs[i]?.kind === 'credits' ? (tabs[i]?.new ?? 0) : 0 },
      scope: null }))
  const cur = Math.min(tab, tabs.length - 1)
  const t = tabs[cur]!
  const fallback: BatchDraft = { q: { sel: [], text: '', skip: false },
    credits: { mode: null, g: 0 }, scope: null }
  const d = drafts[cur] ?? fallback
  const decided = (x: AskTab, dd: BatchDraft): boolean =>
    x.kind === 'question'
      ? dd.q.skip || tabAnswered(x as AskQuestion, dd.q)
      : x.kind === 'credits' ? dd.credits.mode !== null
      : dd.scope !== null
  const patch = (p: Partial<BatchDraft>, advance = false) => setDrafts((ds) => {
    const next = ds.map((x, i) => (i === cur ? { ...x, ...p } : x))
    // auto-advance (user addition 2026-08-12, mirroring Claude Code's batch
    // form): a click that DECIDES the current tab moves focus to the next
    // undecided one. Never on multi-option picks or Other typing — those
    // are mid-thought, not decisions.
    if (advance && decided(tabs[cur]!, next[cur] ?? fallback)) {
      for (let s = 1; s <= tabs.length; s++) {
        const j = (cur + s) % tabs.length
        if (!decided(tabs[j]!, next[j] ?? fallback)) { setTab(j); break }
      }
    }
    return next
  })
  const doneCount = tabs.filter((x, i) =>
    decided(x, drafts[i] ?? fallback)).length
  const ready = doneCount === tabs.length
  const label = (x: AskTab, i: number): string =>
    x.kind === 'question' ? (x.header || `Q${i + 1}`)
      : x.kind === 'credits' ? 'credits'
      : x.item?.kind === 'dir' ? 'folder'
      : x.item?.kind === 'tool' ? `tool: ${x.item.tool ?? ''}`
      : x.item?.kind === 'mcp' ? 'mcp'
      : 'mode'
  const submit = (all: BatchDraft[] | null) => {
    if (busy) return
    const ds = all ?? drafts
    const at = (i: number): BatchDraft => ds[i] ?? fallback
    const qIdx = tabs.map((x, i) => ({ x, i }))
      .filter(({ x }) => x.kind === 'question')
    const answers = qIdx.map(({ x, i }) => (at(i).q.skip ? null
      : tabValue(x as AskQuestion, at(i).q)))
    const ci = tabs.findIndex((x) => x.kind === 'credits')
    const cd = ci >= 0 ? at(ci).credits : null
    const scope = tabs.map((x, i) => ({ x, i }))
      .filter(({ x }) => x.kind === 'scope')
      .map(({ i }) => at(i).scope ?? 'skip')
    setBusy(true)
    resolveBatch(slug, ask.node, {
      revs: (ask.revs ?? {}) as Record<string, number>,
      ...(qIdx.length ? { answers } : {}),
      ...(cd ? { credits: cd.mode === 'grant' ? { granted: cd.g }
        : cd.mode === 'deny' ? { deny: true } : { skip: true } } : {}),
      ...(scope.length ? { scope } : {}),
    })
      // stays busy on success — the next payload nulls the card
      .then(() => toast([`resolved ${ask.node}'s batch`]))
      .catch((e: Error) => { toast([`error: ${e.message}`]); setBusy(false) })
  }
  const opts = (t.options ?? []) as { label: string; description?: string }[]
  const otherOn = d.q.sel.includes(OTHER)
  const toggle = (o: string) => patch({ q: { ...d.q, skip: false,
    sel: d.q.sel.includes(o) ? d.q.sel.filter((x) => x !== o)
      : t.multi ? [...d.q.sel, o] : [o] } }, !t.multi)
  const pxcV = orgScale ?? 4
  const oldG = t.kind === 'credits' ? (t.old ?? 0) : 0
  const boxH = Math.max(60, (seat + Math.max(d.credits.g, oldG)) * pxcV + 8)
  const onKey = (e: KeyboardEvent) => {
    if (isSubmitKey(e)) {
      e.preventDefault()
      if (ready && !busy) submit(null)
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        && tabs.length > 1 && !busy) {
      // alt+←/→ walks the tab strip, wrapping (preventDefault: the bare
      // combo is browser history navigation)
      e.preventDefault()
      setTab((cur + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length)
        % tabs.length)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && t.kind === 'credits' && !busy) {
      // alt+↑/↓ steps the staged offer — same clamps as the mobile stepper
      e.preventDefault()
      const g = e.key === 'ArrowUp'
        ? (maxTop ? Math.min(maxTop, d.credits.g + 1) : d.credits.g + 1)
        : Math.max(committed, d.credits.g - 1)
      patch({ credits: { mode: 'grant', g } })
    }
  }
  return (
    <div className="askcard" tabIndex={-1} onKeyDown={onKey}>
      <AskHead
        label={`${tabs.length} request${tabs.length === 1 ? '' : 's'}`}
        node={ask.node} busy={busy}
        closeTitle="close, skipping every tab (the agent is told; it may re-ask)"
        onClose={() => submit(tabs.map(() => ({
          q: { sel: [], text: '', skip: true },
          credits: { mode: 'skip', g: 0 },
          scope: 'skip' })))} />
      {tabs.length > 1 && (
        <div className="ask-tabstrip">
          {tabs.map((x, i) => (
            <button key={i} type="button" disabled={busy}
              className={'ask-tabbtn' + (i === cur ? ' on' : '')
                + (decided(x, drafts[i] ?? fallback) ? ' done' : '')}
              onClick={() => setTab(i)}>
              {label(x, i)}
            </button>
          ))}
        </div>
      )}
      {t.kind === 'question' && (<>
        <div className="ask-q"><b>{t.question}</b></div>
        <div className="ask-rows">
          {opts.map((o) => (
            <button key={o.label} type="button" disabled={busy}
              className={'ask-row' + (d.q.sel.includes(o.label) ? ' on' : '')}
              onClick={() => toggle(o.label)}>
              <span className={'ask-dot' + (t.multi ? ' sqr' : '')
                + (d.q.sel.includes(o.label) ? ' on' : '')} />
              <span className="ask-row-body">
                <b>{o.label}</b>
                {o.description && <span className="dim">{o.description}</span>}
              </span>
            </button>
          ))}
          {/* a no-options tab has Other implicitly selected — but never while
              SKIP holds the tab, and clicking Other must release the skip
              (both live-caught 2026-08-12: skip + a lit Other rendered as two
              selections, and the skip was one-way) */}
          <button type="button" disabled={busy}
            className={'ask-row'
              + (otherOn || (!opts.length && !d.q.skip) ? ' on' : '')}
            onClick={() => (opts.length ? toggle(OTHER)
              : patch({ q: { ...d.q, skip: false } }))}>
            <span className={'ask-dot' + (t.multi ? ' sqr' : '')
              + (otherOn || (!opts.length && !d.q.skip) ? ' on' : '')} />
            <span className="ask-row-body"><b>Other</b></span>
          </button>
          {(otherOn || !opts.length) && !d.q.skip && (
            <input value={d.q.text} disabled={busy}
              className="ask-other" placeholder="your answer…"
              onChange={(e) => patch({ q: { ...d.q, skip: false,
                text: e.target.value } })} />
          )}
          {/* FR-14: skippable tabs — an explicit skip, never a hole */}
          <button type="button" disabled={busy}
            className={'ask-row skiprow' + (d.q.skip ? ' on' : '')}
            onClick={() => patch({ q: { sel: [], text: '',
              skip: !d.q.skip } }, true)}>
            <span className={'ask-dot' + (d.q.skip ? ' on' : '')} />
            <span className="ask-row-body"><b>Skip</b>
              <span className="dim">leave this one unanswered</span></span>
          </button>
        </div>
        {t.multi && <div className="dim">several may apply</div>}
      </>)}
      {t.kind === 'credits' && (
        <div className="ask-credit-row">
          <div className="ask-barbox" style={{ height: boxH }}>
            <CreditBar seat={seat} grant={d.credits.g} committed={committed}
              segments={segments} baseline={oldG} min={committed}
              max={maxTop || undefined}
              onDragValue={(v) => patch({ credits: { mode: 'grant', g: v } })}
              onCommit={(delta) => patch({ credits: {
                mode: 'grant', g: d.credits.g + delta } })}
              zoom={1} pxc={pxcV} />
            {isMobile && <div className="ask-step">
              <button type="button" disabled={d.credits.g <= committed}
                title={stepDownWhy(d.credits.g, committed)}
                onClick={() => patch({ credits: { mode: 'grant',
                  g: Math.max(committed, d.credits.g - 1) } })}>−</button>
              <b>{d.credits.g}</b>
              <button type="button" disabled={maxTop != null && d.credits.g >= maxTop}
                title={stepUpWhy(d.credits.g, maxTop)}
                onClick={() => patch({ credits: { mode: 'grant',
                  g: maxTop ? Math.min(maxTop, d.credits.g + 1) : d.credits.g + 1 } })}>＋</button>
            </div>}
          </div>
          <div className="ask-credit-side">
            <div className="ask-q"><b>{oldG} → {t.new}</b>
              <span className="dim"> (+{(t.new ?? 0) - oldG} asked)</span></div>
            {t.reason && <div className="ask-q dim">{t.reason}</div>}
            <div className="dim">{isMobile ? 'step the offer with − / ＋'
              : 'drag the bar (or alt+↑/↓)'}, then pick an outcome — it
              commits with the batch submit</div>
            <div className="ask-rows">
              {([['grant', `grant ${d.credits.g}`],
                 ['deny', 'deny'],
                 ['skip', 'skip (undecided)']] as const).map(([m, lbl]) => (
                <button key={m} type="button" disabled={busy}
                  className={'ask-row' + (d.credits.mode === m ? ' on' : '')}
                  onClick={() => patch({ credits: { ...d.credits,
                    mode: m } }, true)}>
                  <span className={'ask-dot'
                    + (d.credits.mode === m ? ' on' : '')} />
                  <span className="ask-row-body"><b>{lbl}</b></span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {t.kind === 'scope' && (<>
        <div className="ask-q"><b>{t.label}</b></div>
        {t.reason && <div className="ask-q dim">{t.reason}</div>}
        <div className="ask-rows">
          {([['approve', 'approve — live from its next turn'],
             ['deny', 'deny'],
             ['skip', 'skip (undecided — it may re-ask)']] as const)
            .map(([m, lbl]) => (
            <button key={m} type="button" disabled={busy}
              className={'ask-row' + (d.scope === m ? ' on' : '')}
              onClick={() => patch({ scope: m }, true)}>
              <span className={'ask-dot' + (d.scope === m ? ' on' : '')} />
              <span className="ask-row-body"><b>{lbl}</b></span>
            </button>
          ))}
        </div>
      </>)}
      <button className="ask-submit" disabled={busy || !ready}
        title="ctrl+enter" onClick={() => submit(null)}>
        {busy ? 'sending…'
          : ready ? (tabs.length === 1 ? 'submit the decision'
            : `submit all ${tabs.length}`)
          : `${doneCount}/${tabs.length} decided`}
      </button>
    </div>
  )
}

function AskHead({ label, node, busy, onClose, closeTitle }: {
  label: string; node: string; busy: boolean
  onClose: () => void; closeTitle: string
}) {
  return (
    <div className="ask-tab">
      <span className="ask-tab-label">{label}</span>
      <span className="dim" data-copy-agent-name={node}>· {node}</span>
      <span className="spacer" />
      <button className="chip-x" title={closeTitle} disabled={busy}
        onClick={onClose}><CloseIcon fontSize="inherit" /></button>
    </div>
  )
}

/** the per-tab draft the batch form keeps while the user works the card */
interface TabDraft { sel: string[]; text: string }

const tabAnswered = (q: AskQuestion, d: TabDraft): boolean => {
  const opts = q.options ?? []
  const chosen = d.sel.filter((s) => s !== OTHER)
  return chosen.length > 0 || (d.sel.includes(OTHER) && d.text.trim().length > 0)
    || (!opts.length && d.text.trim().length > 0)
}

/** what one answered tab sends: a string, or a list for a multi tab */
const tabValue = (q: AskQuestion, d: TabDraft): string | string[] => {
  const chosen = d.sel.filter((s) => s !== OTHER)
  const extra = d.sel.includes(OTHER) || !(q.options ?? []).length
    ? d.text.trim() : ''
  if (q.multi) return [...chosen, ...(extra ? [extra] : [])]
  return chosen[0] ?? extra
}

/** F-04: the AskUserQuestion mirror — option rows + Other + submit.
 *  FR-04 (2026-08-05): batch-capable. `ask.questions` is the source of
 *  truth (both forms normalize to it server-side); more than one entry
 *  renders the Claude-Code-style TAB STRIP — per-tab option rows, answered
 *  tabs keep their selection, one submit bar carrying the answered count,
 *  ✕ cancels the whole batch. */
function QuestionAsk({ ask, slug, toast }: {
  ask: AskInfo; slug: string; toast: ToastFn
}) {
  // tolerate a stale backend payload with no `questions` — degrade to the
  // top-level mirror of tab 0
  const qs: AskQuestion[] = (ask.questions?.length ? ask.questions
    : [{ question: ask.question ?? '', header: ask.header,
         options: ask.options, multi: ask.multi }])
    .map((q) => ({ ...q, options: (q.options ?? []).map((o) =>
      typeof o === 'string' ? { label: o as string } : o) }))
  const batch = qs.length > 1
  const { drafts, setDrafts, tab, setTab } = useRequestDrafts<TabDraft>(
    qs.map(q => JSON.stringify([slug, ask.node, ask.id, questionDraftKey(q)])),
    () => ({ sel: [], text: '' }))
  const [busy, setBusy] = useState(false)
  const dr = (i: number): TabDraft => drafts[i] ?? { sel: [], text: '' }
  const q = qs[Math.min(tab, qs.length - 1)]!
  const d = dr(Math.min(tab, qs.length - 1))
  const patch = (p: Partial<TabDraft>) => setDrafts((ds) =>
    ds.map((x, i) => (i === tab ? { ...x, ...p } : x)))
  const opts = q.options ?? []
  const otherOn = d.sel.includes(OTHER)
  const toggle = (o: string) => patch({ sel: d.sel.includes(o)
    ? d.sel.filter((x) => x !== o)
    : q.multi ? [...d.sel, o] : [o] })
  const doneCount = qs.filter((x, i) => tabAnswered(x, dr(i))).length
  const ready = batch ? doneCount === qs.length : tabAnswered(q, d)
  const send = (body: { selected?: (string | string[])[]; text?: string
    dismiss?: boolean }) => {
    if (busy) return
    setBusy(true)
    answerAsk(slug, ask.id, body)
      // stays busy on success — the next payload nulls the card
      .then(() => toast([body.dismiss ? `dismissed ${ask.node}'s question`
        : `answered ${ask.node}`]))
      .catch((e: Error) => { toast([`error: ${e.message}`]); setBusy(false) })
  }
  const submit = () => {
    if (!ready) return
    // echo the card revision (CAS): if the agent amended between render
    // and submit, the server refuses instead of attaching these answers
    // to questions the user never saw
    const stamp = ask.rev != null ? { rev: ask.rev } : {}
    if (batch) {
      // one item per tab, positionally — the server refuses holes
      send({ selected: qs.map((x, i) => tabValue(x, dr(i))), ...stamp })
      return
    }
    const chosen = d.sel.filter((s) => s !== OTHER)
    const extra = d.text.trim()
    send({ ...(chosen.length ? { selected: chosen } : {}),
           ...(extra ? { text: extra } : {}), ...stamp })
  }
  const onKey = (e: KeyboardEvent) => {
    if (isSubmitKey(e)) {
      e.preventDefault()
      if (ready && !busy) submit()
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        && batch && !busy) {
      // alt+←/→ walks the tab strip, wrapping (preventDefault: the bare
      // combo is browser history navigation)
      e.preventDefault()
      setTab((tab + (e.key === 'ArrowRight' ? 1 : -1) + qs.length)
        % qs.length)
    }
  }
  return (
    <div className="askcard" tabIndex={-1} onKeyDown={onKey}>
      <AskHead
        label={batch ? `${qs.length} questions` : (q.header || 'Question')}
        node={ask.node} busy={busy}
        closeTitle={batch
          ? 'dismiss the whole batch without answering (the agent is told)'
          : 'dismiss without answering (the agent is told)'}
        onClose={() => send({ dismiss: true })} />
      {batch && (
        <div className="ask-tabstrip">
          {qs.map((x, i) => (
            <button key={i} type="button" disabled={busy}
              className={'ask-tabbtn' + (i === tab ? ' on' : '')
                + (tabAnswered(x, dr(i)) ? ' done' : '')}
              onClick={() => setTab(i)}>
              {x.header || `Q${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="ask-q"><b>{q.question}</b></div>
      <div className="ask-rows">
        {opts.map((o) => (
          <button key={o.label} type="button" disabled={busy}
            className={'ask-row' + (d.sel.includes(o.label) ? ' on' : '')}
            onClick={() => toggle(o.label)}>
            <span className={'ask-dot' + (q.multi ? ' sqr' : '')
              + (d.sel.includes(o.label) ? ' on' : '')} />
            <span className="ask-row-body">
              <b>{o.label}</b>
              {o.description && <span className="dim">{o.description}</span>}
            </span>
          </button>
        ))}
        {/* "Other" is always available — same as the Claude Code form */}
        <button type="button" disabled={busy}
          className={'ask-row' + (otherOn || !opts.length ? ' on' : '')}
          onClick={() => opts.length && toggle(OTHER)}>
          <span className={'ask-dot' + (q.multi ? ' sqr' : '')
            + (otherOn || !opts.length ? ' on' : '')} />
          <span className="ask-row-body"><b>Other</b></span>
        </button>
        {(otherOn || !opts.length) && (
          <input autoFocus={opts.length > 0} value={d.text} disabled={busy}
            className="ask-other" placeholder="your answer…"
            onChange={(e) => patch({ text: e.target.value })}
            onKeyDown={(e) => {
              // plain enter only — ctrl+enter bubbles to the card root (both
              // firing would double-send past the still-false busy closure)
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) submit() }} />
        )}
      </div>
      {q.multi && <div className="dim">several may apply</div>}
      <button className="ask-submit" disabled={busy || !ready}
        title="ctrl+enter" onClick={submit}>
        {busy ? 'sending…'
          : batch ? (ready ? `submit ${qs.length} answers`
            : `${doneCount}/${qs.length} answered`)
          : 'submit answer'}
      </button>
    </div>
  )
}

/** F-05: the request embeds its own drag-adjustable CreditBar — reduce the
 *  ask, exceed it, or claw back down to the committed floor. Stranding
 *  warnings surface on release, BEFORE the commit. Same form family as the
 *  question card: header chip, ✕ = deny. */
function CreditAsk({ ask, slug, toast, seat, committed, maxTop, segments,
  pxc: orgScale }: {
  ask: AskInfo; slug: string; toast: ToastFn
  seat: number; committed: number; maxTop?: number
  segments: { seat: number; grant: number }[]
  pxc?: number
}) {
  const oldG = ask.old ?? 0
  const askedG = ask.new ?? oldG
  const [g, setG] = useState(askedG)          // the staged offer
  const [warns, setWarns] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const gRef = useRef(g)
  gRef.current = g
  const preview = () => {
    void creditDecide(slug, ask.id, 'approve', gRef.current, true)
      .then((r) => setWarns(r.warnings ?? []))
      .catch(() => setWarns([]))
  }
  useEffect(preview, [])          // eslint-disable-line react-hooks/exhaustive-deps
  // alt+↑/↓ autorepeats — debounce the dry-run preview to the last step
  const pvTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(pvTimer.current), [])
  const step = (dir: 1 | -1) => {
    const v = dir > 0
      ? (maxTop ? Math.min(maxTop, gRef.current + 1) : gRef.current + 1)
      : Math.max(committed, gRef.current - 1)
    gRef.current = v
    setG(v)
    window.clearTimeout(pvTimer.current)
    pvTimer.current = window.setTimeout(preview, 200)
  }
  const onKey = (e: KeyboardEvent) => {
    if (isSubmitKey(e)) {
      e.preventDefault()
      if (!busy) decide('approve', gRef.current)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && !busy) {
      e.preventDefault()
      step(e.key === 'ArrowUp' ? 1 : -1)
    }
  }
  // IDENTICAL to the agent's real card bar (user ruling 2026-08-05): the
  // org's own px-per-credit scale, the same fill structure (own seat, child
  // slabs, grey rungs for everything unfilled), same width and radius. The
  // bar's total height IS the staged offer, so it grows and shrinks with the
  // drag — and may exit the top of the card; that is fine, the card closes
  // when answered.
  const pxc = orgScale ?? 4
  const BOX_H = Math.max(60, (seat + Math.max(g, oldG)) * pxc + 8)
  const decide = (action: string, granted?: number) => {
    if (busy) return
    setBusy(true)
    creditDecide(slug, ask.id, action, granted)
      .then((r) => {
        const w = (r.warnings ?? []) as string[]
        toast([action === 'deny' ? `denied ${ask.node}'s request`
          : `${ask.node}'s grant → ${granted ?? askedG}`, ...w])
      })
      .catch((e: Error) => { toast([`error: ${e.message}`]); setBusy(false) })
  }
  return (
    <div className="askcard credit" tabIndex={-1} onKeyDown={onKey}>
      <AskHead label="Credit request" node={ask.node} busy={busy}
        closeTitle="deny the request" onClose={() => decide('deny')} />
      {/* EVERYTHING sits beside the bar (user ruling 2026-08-05) — the bar
          owns the card's left edge and full height. Non-draft rendering =
          the real card bar: fill is what is COMMITTED (own seat at the foot,
          one slab per child), grey rungs above it up to the offered total;
          the drag stages the offer instead of committing a reallocate. */}
      <div className="ask-credit-row">
        <div className="ask-barbox" style={{ height: BOX_H }}>
          <CreditBar seat={seat} grant={g} committed={committed}
            segments={segments}
            baseline={oldG} min={committed}
            max={maxTop || undefined}
            onDragValue={(v) => { gRef.current = v; setG(v) }}
            onCommit={(delta) => {
              const nv = g + delta
              gRef.current = nv
              setG(nv)
              preview()
            }}
            zoom={1} pxc={pxc} />
          {/* mobile (spec §6): drag-to-reallocate is desktop-only — a finger
              cannot resolve ~2px per credit. The stepper stages the same
              offer the drag would; the bar stays the read-only gauge. */}
          {isMobile && <div className="ask-step">
            <button type="button" disabled={g <= committed}
              title={stepDownWhy(g, committed)}
              onClick={() => { const v = Math.max(committed, g - 1)
                gRef.current = v; setG(v); preview() }}>−</button>
            <b>{g}</b>
            <button type="button" disabled={maxTop != null && g >= maxTop}
              title={stepUpWhy(g, maxTop)}
              onClick={() => { const v = maxTop ? Math.min(maxTop, g + 1) : g + 1
                gRef.current = v; setG(v); preview() }}>＋</button>
          </div>}
        </div>
        <div className="ask-credit-side">
          <div className="ask-q"><b>{oldG} → {askedG}</b>
            <span className="dim"> (+{askedG - oldG} asked)</span>
            {g !== askedG && <span className={g < oldG ? 'n-down' : ''}>
              {' '}· offering {g}</span>}
          </div>
          {typeof ask.reason === 'string' && ask.reason &&
            <div className="ask-q dim">{ask.reason}</div>}
          <div className="dim">{isMobile
            ? <>step the offer with − / ＋ (floor: {committed} committed)</>
            : <>drag the bar or alt+↑/↓ — grant less, more, or claw back
            unused credits (floor: {committed} committed)</>}</div>
          {warns.map((w) => (
            <div key={w} className="ask-warn"><WarnIcon fontSize="inherit" /> {w}</div>
          ))}
          <button className="ask-submit" disabled={busy}
            title="ctrl+enter" onClick={() => decide('approve', g)}>
            {busy ? 'sending…'
              : g === askedG ? `grant ${g} (as asked)`
              : g === oldG ? 'decline the increase'
              : g < oldG ? `reduce to ${g}` : `grant ${g}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/** the nulled card: it KEEPS rendering, wearing why it nulled — grey for
 *  answered/denied/dismissed/withdrawn/superseded, orange for interrupted
 *  (historical: the retired wake-void; old entries may still carry it).
 *  Non-interactive by design. */
function NulledAsk({ ask, credit }: { ask: AskInfo; credit: boolean }) {
  const interrupted = ask.status === 'interrupted'
  const scope = ask.kind === 'scope'
  const label = interrupted ? 'interrupted'
    : ask.status === 'denied' ? 'denied'
    : ask.status === 'dismissed' ? 'dismissed'
    : ask.status === 'withdrawn' ? 'withdrawn'
    : ask.status === 'superseded' ? 'superseded'
    : ask.status === 'moot' ? 'moot — the agent left'
    : scope ? 'decided' : 'answered'
  return (
    <div className={'askcard nulled ' + (interrupted ? 'orange' : 'grey')}>
      <div className="ask-head">
        <b data-copy-agent-name={ask.node}>{ask.node}</b> {credit
          ? <>asked for credits: {ask.old} → {ask.new}</>
          : scope ? <>requested scope</> : <>asked</>}
        <span className={'ask-null-tag' + (interrupted ? ' warn' : '')}>{label}</span>
      </div>
      {/* FR-13: a resolved scope request lists its items with the per-item
          verdicts stamped at the batch submit */}
      {scope && (ask.items ?? []).map((it, i) => (
        <div key={i} className="ask-q">
          {it.kind === 'dir' ? `folder ${it.path} (${it.mode})`
            : it.kind === 'tool' ? `tool: ${it.tool}`
            : it.kind === 'mcp' ? `MCP server: ${it.server}`
            : `permission mode → ${it.mode}`}
          {it.decision && <span className="dim"> → {it.decision}</span>}
        </div>
      ))}
      {!credit && (ask.questions?.length ?? 0) > 1 ? (
        // FR-04: a nulled batch lists every tab with its answer (if any)
        (ask.questions ?? []).map((q, i) => (
          <div key={i} className="ask-q">
            {q.header ? <b>{q.header} · </b> : null}{q.question}
            {q.answer != null && (
              <span className="dim">
                {' → '}{Array.isArray(q.answer)
                  ? q.answer.join(' · ') : q.answer}
              </span>
            )}
          </div>
        ))
      ) : (
        <>
          {!credit && <div className="ask-q">{ask.question}</div>}
          {ask.answer && (
            <div className="ask-q dim">
              → {[...(ask.answer.selected ?? []),
                  ...(ask.answer.text ? [ask.answer.text] : [])].join(' · ')}
            </div>
          )}
        </>
      )}
      {credit && ask.granted != null && ask.status !== 'denied' && (
        <div className="ask-q dim">→ granted {ask.granted}</div>
      )}
      {interrupted && (
        <div className="ask-null-why">
          {ask.reason || 'the agent was woken by other input before an answer arrived'}
          {' — it must re-ask'}
        </div>
      )}
    </div>
  )
}
