// Browser fixture for replysize_probe.py. Mounts the REAL ReplyPreview
// component beside a composer clone built from desk.tsx's own markup shape
// (same classnames — `.cc-composer` / `.cc-attach` / `.cc-send` — so the
// real styles.css rules apply exactly as they do in the app; the icons and
// wiring desk.tsx's composer carries are irrelevant to the CSS under test
// here, so they are not reproduced). `#composing` is the annotation shown
// while actively composing a reply (has a remove control, matching the
// desk.tsx call site that sets `onRemove`); `#settled` is every other
// caller (a settled message's own quoted-reply card, a pending row, draft
// recovery) — read-only, no remove control, and the docket's user
// clarification (2026-09-09 11:07) is explicit that ONLY the composing one
// should resize.
import { createRoot } from 'react-dom/client'
import { ReplyPreview } from '../src/canvas/replypreview'
import type { ReplyContext } from '../src/eventReply'

const noop = () => {}
const shortReply: ReplyContext = {
  org: 'org', agent: 'peer-one', generation: 3, eventId: 'e1',
  quote: 'A single short line of quoted reply context.',
}
const longReply: ReplyContext = {
  org: 'org', agent: 'peer-one', generation: 3, eventId: 'e2',
  quote: 'A much longer quoted reply that runs past a couple of lines of '
    + 'text so the scrollable overflow behaviour of the blockquote can '
    + 'actually be exercised by the probe, the same way a real long reply '
    + 'would in the live app.',
}

function Composer() {
  return (
    <div className="cc-composer">
      <button className="cc-attach" type="button">a</button>
      <textarea rows={2} placeholder="message…" />
      <button className="cc-send" type="button">s</button>
    </div>
  )
}

function Fixture() {
  return <>
    <div id="composing-short">
      <ReplyPreview reply={shortReply} available onLocate={noop} onRemove={noop} />
      <Composer />
    </div>
    <div id="composing-long">
      <ReplyPreview reply={longReply} available onLocate={noop} onRemove={noop} />
      <Composer />
    </div>
    <div id="settled">
      <ReplyPreview reply={shortReply} available onLocate={noop} />
    </div>
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
