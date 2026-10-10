// canvas/modelbrowser.tsx — the model browser's parts, shared by the
// OpenRouter picker (openrouter.tsx: a server-side search of a large catalog)
// and the Language Server browser (lsbrowser.tsx: a server's own model list,
// searched and filtered here). One look for both (user 2026-10-10: "it needs
// some sort of browser like openrouter"); each keeps its own data and rows.
//   ModelCard        the monogram card: letter on colour
//   ToggleChips      a provider card's models as chips a click switches
//   BrowserSelected  the chosen models as chips, each with a ✕
//   BrowserPager     ‹ prev · next › · "1–25 of 300" · done

import type { CSSProperties } from 'react'
import { CloseIcon } from '../icons'
import { isDarkTierColor } from './shared'

/** the monogram card: letter on colour. One element, styled through `--orr-c`
 *  so the sheet owns every derived shade (border, wash) from one value — plus
 *  `--orr-a`, the rim, on a DARK card whose vendor serves an accent (the
 *  brand palette, 2026-09-03): a near-black fill cannot carry identity, so
 *  the rim does. A light card never draws one; a malformed one is ignored. */
export function ModelCard({ letter, color, accent, title, large }: {
  letter: string
  color: string
  accent?: string | null
  title?: string
  large?: boolean
}) {
  const dark = isDarkTierColor(color)
  const style: Record<string, string> = { '--orr-c': color }
  if (dark && accent && /^#[0-9a-f]{6}$/i.test(accent)) style['--orr-a'] = accent
  return (
    <span className={'orr-card' + (large ? ' lg' : '') + (dark ? ' dark' : '')}
      title={title} style={style as CSSProperties} aria-hidden={!title}>
      {letter}
    </span>
  )
}

/** more chosen models than this and a card's chips are their cards alone,
 *  each name in its tooltip (user 2026-10-10: "if there are many models
 *  selected at once (say >8) then only show their icons, omit their names") */
export const CHIP_NAMES_MAX = 8

/** one model on a provider card, as a chip a click switches */
export interface ToggleChip {
  key: string
  letter: string
  color: string
  accent?: string | null
  label: string
  /** the tooltip: the model, and what a click does */
  title: string
  /** chosen: an offered model, a favorite */
  on: boolean
  onToggle: () => void
}

/** a provider card's models as chips that a click switches, saved at once
 *  (user 2026-10-10: "i should be able to click to change the models
 *  available without editing the entry"). A chosen model is lit; the others
 *  stay in their places, dimmed, so a second click undoes a mis-click. With
 *  more than CHIP_NAMES_MAX chosen, every chip is its card alone. `more` is
 *  the last chip: "+", opening the browser for what the row does not show. */
export function ToggleChips({ chips, busy, label, more, hint, className }: {
  chips: ToggleChip[]
  busy: boolean
  label: string
  more?: { text?: string, title: string, open?: boolean, onClick: () => void }
  /** said after the chips */
  hint?: string
  className?: string
}) {
  const iconsOnly = chips.filter((c) => c.on).length > CHIP_NAMES_MAX
  return (
    <div className={'orr-favs orr-toggles' + (iconsOnly ? ' icons' : '') + (className ? ` ${className}` : '')}
      role="group" aria-label={label}>
      {chips.map((c) => (
        <button key={c.key} type="button" className={'orr-sel orr-tog' + (c.on ? ' on' : '')}
          aria-pressed={c.on} aria-label={iconsOnly ? c.label : undefined} title={c.title}
          disabled={busy} onClick={c.onToggle}>
          <ModelCard letter={c.letter} color={c.color} accent={c.accent} />
          {!iconsOnly && <span className="orr-sel-name">{c.label}</span>}
        </button>
      ))}
      {more && (
        <button type="button" className={'orr-sel orr-more' + (more.open ? ' on' : '')}
          aria-haspopup="dialog" aria-expanded={!!more.open} aria-label={more.text ? undefined : more.title}
          title={more.title} onClick={more.onClick}>
          +{more.text && <span className="orr-more-text">{more.text}</span>}
        </button>
      )}
      {hint && <span className="orr-hint">{hint}</span>}
    </div>
  )
}

/** one chosen model as a chip */
export interface BrowserChip {
  key: string
  letter: string
  color: string
  accent?: string | null
  label: string
  title?: string
  onRemove: () => void
}

/** the chosen models at a glance, each with a ✕ that drops it without
 *  searching for it first; in the chooser's own order, so a chip stays put */
export function BrowserSelected({ chips, empty, busy, removeVerb, removeTitle, label = 'selected models' }: {
  chips: BrowserChip[]
  /** what the row says while nothing is chosen */
  empty: string
  busy: boolean
  /** the ✕'s verb for screen readers: "deselect qwen…" */
  removeVerb: string
  /** the ✕'s tooltip: what dropping a model means */
  removeTitle: string
  label?: string
}) {
  return (
    <div className="orr-selected" role="group" aria-label={label}>
      {!chips.length && <span className="dim">{empty}</span>}
      {chips.map((c) => (
        <span key={c.key} className="orr-sel" title={c.title}>
          <ModelCard letter={c.letter} color={c.color} accent={c.accent} />
          <span className="orr-sel-name">{c.label}</span>
          <button type="button" className="orr-sel-x" disabled={busy}
            aria-label={`${removeVerb} ${c.label}`}
            title={removeTitle}
            onClick={c.onRemove}>
            <CloseIcon fontSize="inherit" />
          </button>
        </span>
      ))}
    </div>
  )
}

/** paging through results, and the way out */
export function BrowserPager({ offset, size, shown, total, onOffset, onDone }: {
  offset: number
  /** rows per page */
  size: number
  /** rows on this page; null while the page is still being read */
  shown: number | null
  total: number
  onOffset: (offset: number) => void
  onDone: () => void
}) {
  const from = total ? offset + 1 : 0
  const to = shown != null ? Math.min(offset + shown, total) : 0
  return (
    <div className="orr-pager">
      <button disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - size))}>
        ‹ prev</button>
      <button disabled={shown == null || to >= total} onClick={() => onOffset(offset + size)}>
        next ›</button>
      <span className="dim">{total ? `${from}–${to} of ${total}` : ''}</span>
      <button className="primary" type="button" onClick={onDone}>done</button>
    </div>
  )
}
