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
import type { OrgViewMode } from './viewmode'

export function OrgViewToggle({ mode, setMode, attentionCount, attentionAvailable = true }: {
  mode: OrgViewMode
  setMode: (mode: OrgViewMode) => void
  /** how many rows are waiting in the attention queue; omitted when unknown */
  attentionCount?: number | null
  /** false while this build has no Attention view to show. The control still
   *  renders — it is part of the approved header — but it says plainly that
   *  the destination is not there yet rather than pretending. */
  attentionAvailable?: boolean
}) {
  const choose = (next: OrgViewMode) => () => { if (next !== mode) setMode(next) }
  return (
    <div className="shell-modes" role="radiogroup" aria-label="Organization view">
      <button type="button" role="radio" aria-checked={mode === 'canvas'}
        className={'shell-mode' + (mode === 'canvas' ? ' on' : '')}
        onClick={choose('canvas')}>Canvas</button>
      <button type="button" role="radio" aria-checked={mode === 'attention'}
        className={'shell-mode' + (mode === 'attention' ? ' on' : '')}
        title={attentionAvailable ? undefined
          : 'The Attention view is not available in this build yet'}
        onClick={choose('attention')}>
        Attention
        {attentionAvailable && typeof attentionCount === 'number' && attentionCount > 0 &&
          <b className="shell-mode-count">{attentionCount}</b>}
      </button>
    </div>
  )
}
