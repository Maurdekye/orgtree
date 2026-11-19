// selectinpage.visual.tsx — the fixture for selectinpage.capture.cjs (USER 2026-11-19 m6a2395ab50fb "Everywhere": every
// dropdown draws its option list inside the window; look choices mf7601ffdfba7).
//
// REAL: the app's stylesheets, the key module installed as main.tsx installs it, the shared modal frame (PinFrame, with
// its Escape stack and its pop-out into a real second window), the settings rows, the account select, and a
// presentation frame built by `presentationDocument` from the sheet every frame receives. SYNTHETIC: the choices, and
// the places the selects stand in (a scaled "desk", the window's bottom edge, a narrow column). Browser-only: no
// engine, bridge or live org; every request is answered here.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { adoptPinLayer } from '../src/canvas/pinspace'
import { PinFrame } from '../src/canvas/modalpin'
import { instanceKind } from '../src/modalkinds'
import { SetGroup, SetRow } from '../src/canvas/settingskit'
import { AccountSelect } from '../src/canvas/accountselect'
import { presentationDocument } from '../src/canvas/docs'
import { installSelectKeys } from '../src/selectkeys'
import { frameThemeCss } from '../../../../packages/contracts/frame-theme'
import '../src/styles.css'
import '../src/shell.css'

localStorage.clear()
installSelectKeys(window)   // as main.tsx: before React
window.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

const ORG = 'alpha'
const ACCOUNTS = [
  { id: 'claude-5', provider: 'claude', identity: { email: 'a-rather-long-mailbox-name-for-the-second-account@example.invalid' } },
  { id: 'claude-6', provider: 'claude', mode: 'apikey', label: 'metered key' },
]
const FRAME_HTML = '<!doctype html><html><body style="margin:8px;font:13px system-ui;background:var(--orgtree-bg,#fff);color:var(--orgtree-text,#111)">'
  + '<label>In a presentation <select id="fs"><option value="one">one</option><option value="two">two</option><option value="three">three</option></select></label>'
  + '<button id="fb" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">a button</button>'
  + '<p><select id="own" style="appearance:auto"><option>a page that sets its own appearance</option><option>keeps what it set</option></select></p></body></html>'
const FRAME_THEME = { colorScheme: 'dark' as const, colors: { bg: '#1f1f1f', text: '#dddddd', card: '#262626', border: '#444444' } }

function Model({ id, value, set }: { id: string; value: string; set: (v: string) => void }) {
  return <select id={id} aria-label="Model tier" title="the model this agent runs on" value={value} onChange={e => set(e.target.value)}>
    <optgroup label="Anthropic">
      <option value="fable">Claude Fable 5.2</option><option value="opus">Claude Opus 5.5</option>
      <option value="sonnet" disabled title="sign in to use it">Claude Sonnet 5.5 (not signed in)</option>
    </optgroup>
    <optgroup label="OpenAI"><option value="sol">Sol</option><option value="terra">Terra</option></optgroup>
    <optgroup label="Google"><option value="carbon">Gemini Carbon</option><option value="hydrogen">Gemini Hydrogen</option></optgroup>
  </select>
}

function App() {
  const [open, setOpen] = useState(true)
  const [v, setV] = useState({ model: 'fable', perm: 'ask', account: '', long: 'm90', form: 'x', desk: 'alpha', bottom: 'b1', narrow: 'short', multi: '' })
  const [counts, setCounts] = useState({ changes: 0, submits: 0, wheel: 0 })
  const set = (key: keyof typeof v) => (value: string) => { setV(s => ({ ...s, [key]: value })); setCounts(c => ({ ...c, changes: c.changes + 1 })) }
  return <CurrentOrg.Provider value={ORG}>
    <div data-pin-org={ORG} ref={(el) => { if (el) adoptPinLayer(ORG, el) }} id="canvas"
      onWheel={() => setCounts(c => ({ ...c, wheel: c.wheel + 1 }))}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>
      <output id="state" style={{ position: 'absolute', left: 8, top: 4, font: '11px monospace', color: 'var(--dim)', maxWidth: 380, wordBreak: 'break-all' }}>{JSON.stringify({ ...v, ...counts, open })}</output>
      <button type="button" id="open-modal" style={{ position: 'absolute', left: 8, top: 60 }} onClick={() => setOpen(true)}>Open settings</button>

      {/* a desk on the canvas: under the camera's scale, in the small inline form a desk uses */}
      <div id="space" style={{ position: 'absolute', left: 16, top: 110, transform: 'scale(.6)', transformOrigin: '0 0' }}>
        <div className="desk-body" style={{ padding: 12, background: 'var(--panel)', border: '1px solid var(--line)', width: 380 }}>
          <div className="inline-form">A desk at 60% <select id="desk" aria-label="Scaled" value={v.desk} onChange={e => set('desk')(e.target.value)}>
            <option value="alpha">alpha</option><option value="beta">beta</option><option value="gamma" disabled title="not now">gamma</option></select></div>
        </div>
      </div>

      {/* a narrow column: the control may not be wider than its column, whatever the choice */}
      <div id="narrow-col" style={{ position: 'absolute', left: 16, top: 220, width: 150 }}>
        <select id="narrow" aria-label="Narrow" style={{ maxWidth: '100%' }} value={v.narrow} onChange={e => set('narrow')(e.target.value)}>
          <option value="short">short</option><option value="long">a choice whose label is far wider than the column it stands in</option></select>
      </div>

      {/* a list box: no pop-up, untouched */}
      <select id="multi" multiple aria-label="List box" style={{ position: 'absolute', left: 16, top: 270, width: 150 }}
        value={v.multi ? [v.multi] : []} onChange={e => set('multi')(e.target.value)}>
        <option value="red">red</option><option value="green">green</option><option value="blue">blue</option></select>

      {/* the control for the measurement itself: a select forced back to the OS pop-up has no option boxes in the page */}
      <select id="native-control" aria-label="Native control" style={{ position: 'absolute', left: 16, top: 360, appearance: 'auto' }} defaultValue="n1">
        <option value="n1">native one</option><option value="n2">native two</option></select>

      <div style={{ position: 'fixed', left: 16, bottom: 6 }}>
        <select id="bottom" aria-label="At the bottom edge" value={v.bottom} onChange={e => set('bottom')(e.target.value)}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={'b' + (i + 1)}>Bottom choice {i + 1}</option>)}</select>
      </div>

      <iframe id="frame" title="presentation" sandbox="allow-scripts" referrerPolicy="no-referrer"
        srcDoc={presentationDocument(FRAME_HTML, false, frameThemeCss(FRAME_THEME))}
        style={{ position: 'absolute', left: 16, top: 430, width: 330, height: 200, border: '1px solid var(--line)', background: '#1f1f1f' }} />

      {open && <PinFrame kind={instanceKind('watchdog', 'selects')} title="Dropdowns" panel="settings content-height" close={() => setOpen(false)}>
        <SetGroup title="Agent">
          <SetRow label="Model" hint="Choose its model."><Model id="model" value={v.model} set={set('model')} /></SetRow>
          <SetRow label="Internet access" hint="Three choices of very different length.">
            <select id="perm" aria-label="Internet access permission" value={v.perm} onChange={e => set('perm')(e.target.value)}>
              <option value="ask">Ask</option><option value="allow">Allow listed sites only, ask for the rest</option><option value="deny">Deny</option></select>
          </SetRow>
          <SetRow label="Account"><AccountSelect rows={ACCOUNTS} provider="claude" value={v.account} onChange={set('account')} /></SetRow>
          <SetRow label="Long list">
            <select id="long" aria-label="Long list" value={v.long} onChange={e => set('long')(e.target.value)}>
              {Array.from({ length: 120 }, (_, i) => <option key={i} value={'m' + (i + 1)}>Model number {i + 1}</option>)}</select>
          </SetRow>
          <SetRow label="Unavailable"><select id="off" aria-label="Unavailable" disabled defaultValue="r"><option value="r">Request</option><option value="o">Other</option></select></SetRow>
          <SetRow label="Next field"><input id="next" defaultValue="next" /></SetRow>
        </SetGroup>
        <form id="form" onSubmit={e => { e.preventDefault(); setCounts(c => ({ ...c, submits: c.submits + 1 })) }} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}>
          In a form <select id="inform" aria-label="In a form" value={v.form} onChange={e => set('form')(e.target.value)}><option value="x">x</option><option value="y">y</option></select>
          <button type="submit" id="submit">Save</button>
        </form>
      </PinFrame>}
    </div>
  </CurrentOrg.Provider>
}

/** The presentation frame alone, for the capture's second window: the off-screen main window does not deliver its
 *  synthetic mouse into a sandboxed frame (measured), an ordinary hidden window does. */
function FrameOnly() {
  return <iframe id="frame" title="presentation" sandbox="allow-scripts" referrerPolicy="no-referrer"
    srcDoc={presentationDocument(FRAME_HTML, false, frameThemeCss(FRAME_THEME))}
    style={{ position: 'fixed', left: 10, top: 10, width: 380, height: 260, border: '1px solid var(--line)', background: '#1f1f1f' }} />
}

createRoot(document.getElementById('root')!).render(location.hash === '#frame' ? <FrameOnly /> : <App />)
