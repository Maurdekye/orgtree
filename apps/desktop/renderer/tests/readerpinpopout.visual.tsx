// readerpinpopout.visual.tsx — the fixture for readerpinpopout.capture.cjs (user 2026-11-12 md15fcb3a298e: a reader
// opened from a popped-out desk "works, but trying to pin it makes it invisible and unable to be interacted with").
//
// The real pieces: `MovableSurface` (the desk that is popped out into a real window), `PopoutButton`, and `PinFrame`
// (every reader's frame, with the real pin button). What is synthetic is only what is inside them: a stand-in desk
// with a "presentation card" button, and a stand-in document with a button that counts its clicks. As in the app,
// the reader's open state lives ABOVE the desk, so the reader is not a React child of the popped-out desk.
// Browser-only: no engine, bridge or live org.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CurrentOrg, MovableSurface, PopoutButton } from '../src/popout'
import { PinFrame } from '../src/canvas/modalpin'
import { adoptPinLayer } from '../src/canvas/pinspace'
import '../src/styles.css'
import '../src/shell.css'

localStorage.clear()
const ORG = 'alpha'

function Reader({ kind, name, close }: { kind: string; name: string; close: () => void }) {
  const [clicks, setClicks] = useState(0)
  return <PinFrame kind={kind} title="Presented documents" panel={'settings ' + name} close={close}>
    <h2 style={{ margin: '4px 0 12px' }}>Quarterly plan</h2>
    <p data-body={name}>A presented document, opened from {name === 'rp-panel' ? 'the popped-out desk' : 'the main window'}.</p>
    <button type="button" data-count={name} onClick={() => setClicks(n => n + 1)}>clicked {clicks} times</button>
  </PinFrame>
}

function App() {
  const [fromDesk, setFromDesk] = useState(false)
  const [fromMain, setFromMain] = useState(false)
  return <CurrentOrg.Provider value={ORG}>
    {/* the org's canvas: the box main-window pins live in */}
    <div data-pin-org={ORG} ref={el => { if (el) adoptPinLayer(ORG, el) }}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>
      <button type="button" id="card-main" style={{ position: 'absolute', left: 20, top: 20 }} onClick={() => setFromMain(true)}>open a reader here</button>
      <div style={{ position: 'absolute', left: 20, top: 70, width: 420 }}>
        <MovableSurface kind="agent-desk-fixture" title="held-agent" org={ORG}>
          <div className="settings" data-desk style={{ width: '100%', height: 360, boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <b>held-agent desk</b><PopoutButton />
              <button type="button" id="card" onClick={() => setFromDesk(true)}>Quarterly plan (presentation card)</button>
            </div>
            <p>The desk's own content stays usable behind a pinned reader.</p>
            <button type="button" id="desk-button" onClick={e => { (e.currentTarget as HTMLButtonElement).dataset.hit = '1' }}>a desk button</button>
          </div>
        </MovableSurface>
      </div>
    </div>
    {fromDesk && <Reader kind="doc" name="rp-panel" close={() => setFromDesk(false)} />}
    {fromMain && <Reader kind="docket" name="rm-panel" close={() => setFromMain(false)} />}
  </CurrentOrg.Provider>
}

createRoot(document.getElementById('root')!).render(<App />)
