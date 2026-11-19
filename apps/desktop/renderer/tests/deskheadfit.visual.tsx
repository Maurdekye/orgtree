// deskheadfit.visual.tsx — fixture for deskheadfit.capture.cjs (USER 2026-11-19 mc14eea0faf60 "at certain desk widths
// the dnd and halt buttons overlap the status"). The real desk header frame (DeskHead, DeskTabs), status banner, DND
// and halt controls and stylesheet, in a box whose width the capture sets. `pinned` wraps it as a pinned desk, where
// the stylesheet hides the tier chip and the name (the title bar shows them). Browser-only data; no engine.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeskHead, DeskTabs } from '../src/canvas/deskshell'
import { TurnStatusBanner } from '../src/canvas/desk'
import { DndControl } from '../src/canvas/dnd'
import { HaltControl } from '../src/canvas/haltcontrol'
import '../src/styles.css'

window.fetch = (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

type Case = { width: number; pinned: boolean; dnd: boolean; status: 'active' | 'compacting' | 'halted'; name: string }
const TABS = [{ id: 'chat', label: 'chat' }, { id: 'inbox', label: 'mail' }, { id: 'docket', label: 'docket', count: 11 },
  { id: 'presented', label: 'presented', count: 44 }, { id: 'files', label: 'files' }, { id: 'team', label: 'team', count: 5 }]
const noop = () => {}

function Surface() {
  const [c, setC] = useState<Case>({ width: 780, pinned: true, dnd: false, status: 'active', name: 'coordinator-opus' })
  useEffect(() => { Object.assign(window, { deskHeadFit: (next: Partial<Case>) => setC(old => ({ ...old, ...next })) }) }, [])
  const halted = c.status === 'halted'
  const at = new Date(Date.now() - (c.status === 'compacting' ? 725_000 : 28_000)).toISOString()
  const head = <div className="desk-body" id="box" style={{ width: c.width, boxSizing: 'border-box' }}>
    <DeskHead nodeId="coordinator-opus"
      left={<>
        <span className="tier">O</span>
        <span className="cc-name">{c.name}</span>
        <span className="cc-context-seat" />
        <span className="cc-process-seat" />
        <TurnStatusBanner state={halted ? 'idle' : c.status === 'compacting' ? 'compacting' : 'working'}
          inflightAt={halted ? null : at} halted={halted} haltedAt={halted ? at : null} tier="opus" />
      </>}
      actions={<>
        <DndControl slug="org" nid="coordinator-opus" active={false} nextTurn={c.dnd} toast={noop} />
        <HaltControl slug="org" nid="coordinator-opus" halt={halted ? { phase: 'halted', at } as never : undefined} toast={noop} />
        <button className="danger">dissolve · 231</button>
      </>}
      tabs={<DeskTabs shown="chat" tabs={TABS} onShow={noop} />}
      rightExtras={<><button type="button" className="popout-button">▤</button><button type="button" className="popout-button">↗</button></>}
      settings={{ label: 'coordinator-opus' }} />
  </div>
  return <div style={{ padding: 8 }}>{c.pinned ? <div className="pinwin-body">{head}</div> : head}</div>
}
createRoot(document.getElementById('root')!).render(<Surface />)
