// Idiom coverage only: this fixture exercises PinFrame's pinned visibility
// inversion, not production App/OrgCanvas wiring. Production wiring is
// verified separately with the built App probe.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { commitModalRect, isModalPinned, PinFrame } from '../src/canvas/modalpin'
import '../src/styles.css'

function Modal({ kind, close }: { kind: string; close: () => void }) {
  return <PinFrame kind={kind} title={kind} panel="settings" close={close}><div data-testid={`${kind}-body`}>{kind} body</div></PinFrame>
}
function App() {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  Object.assign(window, { movePinned: (kind: string) => commitModalRect(kind, { x: 500, y: 300, w: 300, h: 240 }) })
  const toggle = (kind: string) => setOpen(v => ({ ...v, [kind]: isModalPinned(kind) ? !v[kind] : true }))
  const show = (kind: string) => open[kind] ? <Modal kind={kind} close={() => setOpen(v => ({ ...v, [kind]: false }))} /> : null
  return <main>
    {['usage','defaults','git:fixture','common'].map(kind => <button key={kind} onClick={() => toggle(kind)}>{kind} opener</button>)}
    {Object.keys(open).map(kind => open[kind] && <div key={kind}>{show(kind)}</div>)}
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
