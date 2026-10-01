// shell/modetoggle.tsx — the Canvas/Attention switch.
//
// ONE SWITCH, ONE WORD (user 2026-09-29). There are exactly two views and one
// is always current, so this is a single two-position switch: a CIRCULAR knob
// that slides from one end of the track to the other and carries the current
// view's icon in its centre, and beside it, in the space the knob is not
// using, the name of the view you are in. Only that one word is ever shown.
// The icon and the word swap when the knob flicks across.
//
// ACCESSIBILITY. It is a `role="switch"` named "Attention view": checked means
// the Attention view is on, unchecked means the Canvas. Space and Enter flip
// it (a native button); the arrow keys choose a side directly, which the old
// radio group offered and a plain switch would otherwise lose.
import type { KeyboardEvent } from 'react'
import type { OrgView } from '../attention/mode'
import { CanvasIcon, NotificationsIcon } from '../icons'

export function OrgViewToggle({ mode, setMode, attentionCount }: {
  mode: OrgView
  setMode: (mode: OrgView) => void
  /** how many rows are waiting in the attention queue; omitted when unknown */
  attentionCount?: number | null
}) {
  const attention = mode === 'attention'
  const choose = (next: OrgView) => { if (next !== mode) setMode(next) }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); choose('canvas') }
    else if (e.key === 'ArrowRight') { e.preventDefault(); choose('attention') }
  }
  const word = attention ? 'Attention' : 'Canvas'
  return (
    <button type="button" role="switch" aria-checked={attention}
      aria-label="Attention view"
      title={attention ? 'Attention view — switch to Canvas' : 'Canvas view — switch to Attention'}
      className={'shell-switch' + (attention ? ' on' : '')}
      onClick={() => choose(attention ? 'canvas' : 'attention')} onKeyDown={onKey}>
      <span className="shell-switch-knob" aria-hidden="true">
        {attention ? <NotificationsIcon fontSize="inherit" /> : <CanvasIcon fontSize="inherit" />}
      </span>
      <span className="shell-switch-word">{word}</span>
      {typeof attentionCount === 'number' && attentionCount > 0 &&
        <b className="shell-mode-count eye-count">{attentionCount}</b>}
    </button>
  )
}
