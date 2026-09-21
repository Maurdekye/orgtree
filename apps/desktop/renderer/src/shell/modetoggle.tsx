// shell/modetoggle.tsx — the prominent Canvas/Attention toggle.
//
// The settled header's one large labelled control. It is a RADIO GROUP, not
// two buttons and not a switch: there are exactly two modes, one is always
// current, and neither is an "off" state. That also gets arrow-key movement
// between them for free, which two buttons would not.
//
// The labels are never hidden at narrow widths. Everything else in the header
// drops to icons; this does not, because it is the one control the settled
// design calls prominent and labelled, and an unlabelled pair of icons is
// exactly the thing it was specified against.
import type { OrgView } from '../attention/mode'

// ⚠ THE "not available in this build yet" STATE IS GONE, and deliberately so.
// It existed while the toggle shipped ahead of its destination; the Attention
// view is now rendered into the canvas host's slot, so both radios lead
// somewhere and a control that hedges about one of them would be lying.
export function OrgViewToggle({ mode, setMode, attentionCount }: {
  mode: OrgView
  setMode: (mode: OrgView) => void
  /** how many rows are waiting in the attention queue; omitted when unknown */
  attentionCount?: number | null
}) {
  const choose = (next: OrgView) => () => { if (next !== mode) setMode(next) }
  return (
    <div className="shell-modes" role="radiogroup" aria-label="Organization view">
      <button type="button" role="radio" aria-checked={mode === 'canvas'}
        className={'shell-mode' + (mode === 'canvas' ? ' on' : '')}
        onClick={choose('canvas')}>Canvas</button>
      <button type="button" role="radio" aria-checked={mode === 'attention'}
        className={'shell-mode' + (mode === 'attention' ? ' on' : '')}
        onClick={choose('attention')}>
        Attention
        {typeof attentionCount === 'number' && attentionCount > 0 &&
          <b className="shell-mode-count">{attentionCount}</b>}
      </button>
    </div>
  )
}
