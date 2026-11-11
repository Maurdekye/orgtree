// canvas/settingssearch.tsx — the search box at the top of a settings window
// (docket settings-search-idea-backlogged; USER 2026-11-08 m2149285a4d0a
// "staff this ... for 4.5.9"; the liaison's defaults on that item are the
// spec, each flagged at hand-in for the user's veto). App settings
// (canvas/accounts.tsx), Org settings (App.tsx) and Agent settings
// (canvas/modals.tsx) each carry one, and each searches its OWN window across
// all of its tabs and sections.
//
// ⚠ THE INDEX IS THE WINDOW ITSELF, NOT A LIST KEPT BESIDE IT. Every setting
// is already a SetRow, SetToggle or SetBlock (canvas/settingskit.tsx) with a
// `.set-label`, perhaps a `.set-hint`, inside a SetGroup and a tab panel, so
// the rendered rows ARE the catalogue: a label renamed in its component is
// searched under its new name with no second copy to forget, and a row that
// is not rendered (a provider that is not installed) is not offered. The
// panels stay mounted (useVisitedTabs; App and Agent settings mount every
// panel), so hidden tabs can be read; the one ask that mounts Org settings'
// unvisited tabs is a search itself (`onSearching`).
//
// ⚠ NOTHING UNMOUNTS WHILE SEARCHING. The results replace the tab strip and the
// panels by CSS alone (`.settings:has(> .set-search[data-searching])` in the
// sheet), so a half-typed field, a scroll position and a draft charter are
// exactly where they were when the box is cleared.
//
// Matching is the docket's (queryTerms/matchesTerms): every word, any order,
// case-insensitive, over a row's label, help text, section and tab names,
// with typographic quotes folded so "agent's" finds "agent’s". A choice lands
// through the same mark a link into settings uses (markSettingsRow).

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { DocketSearchBox, matchesTerms, queryTerms } from './docket'
import { markSettingsRow } from './settingskit'
import type { SettingsTab } from './settingskit'

const ROW = '.set-row, .set-block'
/** `data-settings-search="skip"` keeps a row (and everything in it) out of the
 *  results: the secret EPIC mode switch, invisible until hovered (epic/). */
export const SETTINGS_SEARCH_SKIP = 'data-settings-search'
/** a group head's controls and quiet notes are not part of its name */
const HEAD_SKIP = '.dim, .set-head-right, button, input, select, textarea, label, [role="switch"], .set-state'

interface Entry {
  el: HTMLElement
  /** the tab id; null for a row above the tabs (Agent settings' Name) */
  tab: string | null
  section: string
  label: string
  hint: string
  /** folded label, hint, section and tab label */
  hay: string
}
type Choice = { kind: 'row'; entry: Entry } | { kind: 'tab'; tab: string }

/** lowercased, typographic quotes as ASCII ones; one character for one, so a
 *  match's offsets in the folded text are its offsets in the shown text */
export function foldText(text: string): string {
  return text.replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').toLowerCase()
}
const clean = (text: string) => text.replace(/\s+/g, ' ').trim()
/** a tab's label and any former names it still answers to */
const tabNames = (t: SettingsTab<string>) => [t.label, ...(t.aliases ?? [])].join('\n')

/** the first `sel` that belongs to `row` itself, not to a row nested in it */
function own(row: HTMLElement, sel: string): HTMLElement | null {
  for (const el of row.querySelectorAll<HTMLElement>(sel)) if (el.closest(ROW) === row) return el
  return null
}

function headText(head: Element): string {
  let text = ''
  const walk = head.ownerDocument.createTreeWalker(head, 4 /* NodeFilter.SHOW_TEXT */)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const skip = n.parentElement?.closest(HEAD_SKIP)
    if (skip && skip !== head && head.contains(skip)) continue
    text += n.nodeValue ?? ''
  }
  return clean(text)
}

function scan(scope: HTMLElement, self: HTMLElement, tabs: readonly SettingsTab<string>[], idBase: string): Entry[] {
  const prefix = `${idBase}-panel-`
  const tabLabel = new Map(tabs.map((t) => [t.id, tabNames(t)]))
  const out: Entry[] = []
  for (const el of scope.querySelectorAll<HTMLElement>(ROW)) {
    if (self.contains(el) || el.closest(`[${SETTINGS_SEARCH_SKIP}="skip"]`)) continue
    const label = clean(own(el, '.set-label')?.textContent ?? '')
    if (!label) continue                          // a status or warning block, not a setting
    let tab: string | null = null
    for (let p = el.closest<HTMLElement>('[role="tabpanel"]'); p && scope.contains(p);
      p = p.parentElement?.closest<HTMLElement>('[role="tabpanel"]') ?? null) {
      if (p.id.startsWith(prefix)) { tab = p.id.slice(prefix.length); break }
    }
    if (tab !== null && !tabLabel.has(tab)) continue
    const group = el.closest('.set-group')
    const head = group && scope.contains(group)
      ? [...group.children].find((c) => c.classList.contains('set-group-head')) : undefined
    const section = head ? headText(head) : ''
    const hint = clean(own(el, '.set-hint')?.textContent ?? '')
    out.push({ el, tab, section, label, hint,
      hay: foldText([label, hint, section, tab === null ? '' : tabLabel.get(tab) ?? ''].join('\n')) })
  }
  return out
}
const sameEntries = (a: Entry[], b: Entry[]) =>
  a.length === b.length && a.every((e, i) => e.el === b[i]!.el && e.hay === b[i]!.hay && e.tab === b[i]!.tab)

/** `text` with every occurrence of every term in a <mark> */
function marked(text: string, terms: readonly string[]): ReactNode {
  const folded = foldText(text)
  if (!terms.length || folded.length !== text.length) return text
  const spans: [number, number][] = []
  for (const t of terms) {
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) spans.push([i, i + t.length])
  }
  if (!spans.length) return text
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  const parts: ReactNode[] = []
  let at = 0
  merged.forEach(([from, to], k) => {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(<mark key={k}>{text.slice(from, to)}</mark>)
    at = to
  })
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/** the settings window a bare Ctrl+F (focus on nothing) belongs to: the one
 *  last clicked or focused in this document */
const lastTouched = new WeakMap<Document, Element>()
/** each mounted box's "clear me if I hold the focus and a query" */
const escapers = new Set<() => boolean>()

/** For a CENTRED settings window's `onEsc`. PinFrame's capture-phase Escape
 *  runs before the box's own key handler, so the window asks first: a focused,
 *  non-empty query is cleared (focus stays in the box) and true says this
 *  Escape is spent. Any other Escape keeps the window's ordinary dismissal,
 *  the agent docket's first-Escape rule (canvas/agentdocket.tsx). A pinned or
 *  popped-out window registers no Escape and the box clears itself. */
export function settingsSearchEscape(): boolean {
  for (const tryClear of escapers) if (tryClear()) return true
  return false
}

const isFindKey = (e: KeyboardEvent) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false
  // a Latin layout names the letter; any other (Hebrew, Cyrillic) names the
  // physical F key, so Ctrl+F works without switching the keyboard
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'f' : e.code === 'KeyF'
}

export function SettingsSearch<T extends string>({ tabs, idBase, setTab, label, target, onSearching }: {
  tabs: readonly SettingsTab<T>[]
  /** the window's `idBase` on SettingsTabs: its panels are `${idBase}-panel-<tab>` */
  idBase: string
  setTab: (id: T) => void
  /** the box's accessible name, e.g. "Search app settings" */
  label: string
  /** the window's link-into-settings request: a new one clears the search, so
   *  its landing is seen */
  target?: { seq: number } | null
  /** told when a search starts and ends: Org settings mounts its unvisited
   *  tabs, App settings wakes its Mail hub section */
  onSearching?: (on: boolean) => void
}) {
  const id = useId()
  const listId = `${id}-list`
  const rootRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const terms = queryTerms(foldText(query))
  const searching = terms.length > 0
  const [index, setIndex] = useState<Entry[]>([])
  const [version, setVersion] = useState(0)
  const [active, setActive] = useState(0)
  const pending = useRef<Choice | null>(null)
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queryRef = useRef(query)
  queryRef.current = query
  const told = useRef(onSearching)
  told.current = onSearching
  // a window may hand a fresh tabs array each render (Agent settings): the
  // rescan follows what the tabs ARE, not the array's identity
  const tabsRef = useRef<readonly SettingsTab<string>[]>(tabs)
  tabsRef.current = tabs
  const tabKey = JSON.stringify(tabs.map((t) => [t.id, t.label, t.aliases ?? []]))

  // a new link into this window wins over a search on show
  const [seenSeq, setSeenSeq] = useState(target?.seq)
  if (target?.seq !== seenSeq) {
    setSeenSeq(target?.seq)
    if (query) setQuery('')
  }

  const clear = useCallback(() => { setQuery(''); boxRef.current?.focus() }, [])

  useEffect(() => () => { clearTimeout(fade.current) }, [])
  useEffect(() => {
    const tryClear = () => {
      const el = rootRef.current
      if (!el || !queryRef.current || !el.contains(el.ownerDocument.activeElement)) return false
      clear()
      return true
    }
    escapers.add(tryClear)
    return () => { escapers.delete(tryClear) }
  }, [clear])

  // while searching, any change in the window's rows (a tab mounting, an
  // answer arriving) rescans; the results' own changes are not the window's
  useEffect(() => {
    const self = rootRef.current, scope = self?.parentElement
    // the window's own constructor: a popped-out panel lives in another window
    const Watch = self?.ownerDocument.defaultView?.MutationObserver
    if (!searching || !self || !scope || !Watch) return
    const watch = new Watch((records) => {
      if (records.some((r) => !self.contains(r.target))) setVersion((v) => v + 1)
    })
    watch.observe(scope, { subtree: true, childList: true, characterData: true })
    told.current?.(true)
    return () => { watch.disconnect(); told.current?.(false) }
  }, [searching])
  useLayoutEffect(() => {
    const self = rootRef.current, scope = self?.parentElement
    if (!searching || !self || !scope) return
    const next = scan(scope, self, tabsRef.current, idBase)
    setIndex((prev) => (sameEntries(prev, next) ? prev : next))
  }, [searching, version, tabKey, idBase])
  const type = useCallback((q: string) => { setQuery(q); setActive(0) }, [])

  // ---- the results, in the window's own order: rows above the tabs first,
  // then each tab in strip order; in a tab, rows outside any section first,
  // then each section where it first appears
  const hits = searching ? index.filter((e) => matchesTerms(e.hay, terms)) : []
  const groups: { tab: string | null; label: string; sections: { title: string; rows: Entry[] }[] }[] = []
  const order: (string | null)[] = [null, ...tabs.map((t) => t.id)]
  for (const tab of order) {
    const rows = hits.filter((e) => e.tab === tab)
    const tabInfo = tabs.find((t) => t.id === tab)
    if (!rows.length) {
      // a tab named by the query that holds no settings (History, Activity)
      // still answers, as a result that opens it
      if (tabInfo && searching && matchesTerms(foldText(tabNames(tabInfo)), terms)) {
        groups.push({ tab, label: tabInfo.label, sections: [] })
      }
      continue
    }
    const sections: { title: string; rows: Entry[] }[] = []
    for (const e of rows) {
      const s = sections.find((x) => x.title === e.section)
      if (s) s.rows.push(e); else sections.push({ title: e.section, rows: [e] })
    }
    sections.sort((a, b) => (a.title === '' ? 0 : 1) - (b.title === '' ? 0 : 1))
    groups.push({ tab, label: tabInfo?.label ?? '', sections })
  }
  const choices: Choice[] = groups.flatMap((g) => (g.sections.length
    ? g.sections.flatMap((s) => s.rows.map((entry): Choice => ({ kind: 'row', entry })))
    : [{ kind: 'tab', tab: g.tab! } as Choice]))
  const chosen = Math.min(active, Math.max(0, choices.length - 1))
  const optionId = (n: number) => `${id}-opt-${n}`

  const choose = (choice: Choice) => {
    pending.current = choice
    setQuery('')
    const tab = choice.kind === 'tab' ? choice.tab : choice.entry.tab
    if (tab !== null) setTab(tab as T)
  }
  // the landing runs once the normal view is back: a row in a panel hidden by
  // the search could be neither scrolled to nor focused
  useEffect(() => {
    const choice = pending.current
    const self = rootRef.current, scope = self?.parentElement
    if (!choice || searching || !self || !scope) return
    pending.current = null
    if (choice.kind === 'tab') {
      self.ownerDocument.getElementById(`${idBase}-tab-${choice.tab}`)?.focus()
      return
    }
    let row: HTMLElement | undefined = choice.entry.el
    if (!row.isConnected) {
      const { tab, section, label: name } = choice.entry
      row = scan(scope, self, tabsRef.current, idBase)
        .find((e) => e.tab === tab && e.section === section && e.label === name)?.el
    }
    if (row) markSettingsRow(scope, row, fade)
  })

  // Ctrl+F in this window focuses the box (the window holding the focus, or
  // with the focus on nothing, the window last clicked here)
  useEffect(() => {
    const self = rootRef.current, scope = self?.parentElement
    const doc = self?.ownerDocument, win = doc?.defaultView
    if (!self || !scope || !doc || !win) return
    const touch = () => { lastTouched.set(doc, scope) }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isFindKey(e)) return
      const focused = doc.activeElement
      const mine = focused && focused !== doc.body && focused !== doc.documentElement
        ? scope.contains(focused)
        : lastTouched.get(doc)?.isConnected
          ? lastTouched.get(doc) === scope
          : doc.querySelectorAll('.set-search').length === 1
      if (!mine) return
      e.preventDefault()
      boxRef.current?.focus()
      boxRef.current?.select()
    }
    scope.addEventListener('pointerdown', touch, true)
    scope.addEventListener('focusin', touch)
    win.addEventListener('keydown', onKey, true)
    return () => {
      scope.removeEventListener('pointerdown', touch, true)
      scope.removeEventListener('focusin', touch)
      win.removeEventListener('keydown', onKey, true)
    }
  }, [])

  useEffect(() => {
    if (!searching) return
    rootRef.current?.ownerDocument.getElementById(optionId(chosen))?.scrollIntoView?.({ block: 'nearest' })
  }, [chosen, searching])  // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      if (!query || e.defaultPrevented) return
      e.preventDefault(); e.stopPropagation(); clear()
    } else if (e.key === 'Enter') {
      if (!searching) return
      e.preventDefault()
      const choice = choices[chosen]
      if (choice) choose(choice)
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && choices.length) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((chosen + step + choices.length) % choices.length)
    }
  }

  let n = -1
  const option = (choice: Choice, name: string, hint: string, key: string, extra = '') => {
    const k = ++n
    return (
      <div key={key} id={optionId(k)} role="option" aria-selected={k === chosen}
        className={'set-search-hit' + extra}
        onMouseDown={(e) => e.preventDefault()}   // the box keeps the focus until the jump
        onClick={() => choose(choice)}>
        <span className="set-label">{marked(name, terms)}</span>
        {hint && <span className="set-hint">{marked(hint, terms)}</span>}
      </div>
    )
  }
  return (
    <div className="set-search" ref={rootRef} data-searching={searching ? '' : undefined}>
      <DocketSearchBox searchId={id} query={query} setQuery={type} boxRef={boxRef}
        onKeyDown={onKeyDown} onClear={clear}
        count={searching ? `${hits.length} of ${index.length} match` : ''}
        placeholder="Search settings…" ariaLabel={label}
        inputProps={{ role: 'combobox', 'aria-expanded': searching && choices.length > 0,
          'aria-controls': searching && choices.length ? listId : undefined, 'aria-autocomplete': 'list',
          'aria-activedescendant': searching && choices.length ? optionId(chosen) : undefined }} />
      {searching && (choices.length ? (
        <div className="set-search-results" role="listbox" id={listId} aria-label="Matching settings">
          {groups.map((g) => (
            <div key={g.tab ?? ''} className="set-search-group" role="group" aria-label={g.label || undefined}>
              {g.sections.length === 0
                ? option({ kind: 'tab', tab: g.tab! }, g.label, 'Open this tab', 'tab', ' set-search-tabhit')
                : <>
                  {g.tab !== null && <div className="set-search-tab" aria-hidden="true">{marked(g.label, terms)}</div>}
                  {g.sections.map((s) => (
                    <Fragment key={s.title}>
                      {s.title && <div className="set-search-section" aria-hidden="true">{marked(s.title, terms)}</div>}
                      {s.rows.map((e, i) => option({ kind: 'row', entry: e }, e.label, e.hint, `${s.title}\u0000${i}`))}
                    </Fragment>
                  ))}
                </>}
            </div>
          ))}
        </div>
      ) : <p className="set-search-empty dim" role="status">No settings match “{query.trim()}”</p>)}
    </div>
  )
}
