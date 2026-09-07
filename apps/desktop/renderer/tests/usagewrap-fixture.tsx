import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { UsageModal } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { commitModalRect } from '../src/canvas/modalpin'
import '../src/styles.css'
Object.assign(window, { usageProbe: { resize: commitModalRect } })
function Fixture() {
  const [open, setOpen] = useState(true)
  return <CurrentOrg.Provider value="fixture">{open ? <UsageModal close={() => setOpen(false)} /> : <p>Usage closed</p>}</CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
