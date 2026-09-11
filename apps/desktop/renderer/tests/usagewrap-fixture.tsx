import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { UsageModal } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { commitModalRect } from '../src/canvas/modalpin'
import '../src/styles.css'
// ⚠ pins are keyed PER OPEN ORG (modalPinKey), so a rect committed without
// the org this modal renders in lands under a different key and the window
// never moves — which reads here as "the layout did not respond to width".
const ORG = 'fixture'
Object.assign(window, { usageProbe: {
  resize: (kind: string, rect: { x: number; y: number; w: number; h: number }) =>
    commitModalRect(kind, rect, ORG),
} })
function Fixture() {
  const [open, setOpen] = useState(true)
  return <CurrentOrg.Provider value={ORG}>{open ? <UsageModal close={() => setOpen(false)} toast={() => {}} /> : <p>Usage closed</p>}</CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
