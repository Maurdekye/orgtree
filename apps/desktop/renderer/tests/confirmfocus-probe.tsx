// confirmfocus-probe.tsx — the page `confirmfocus_probe.py` drives in a real
// browser. It renders the REAL ConfirmModal (bundled from ../src by the probe)
// behind an opener button and one background control, and exposes a tiny
// `window.__probe` surface so the probe can do the things a user cannot do
// through the overlay: remove the opener while the dialog is open, add or
// drop the optional alternate action, and record which callback fired.
//
// Nothing here is a test — the assertions live in the .py file. This file
// only has to be an honest host: the same component, the same stylesheet,
// no focus management of its own.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { ConfirmModal } from '../src/canvas/modals'

const q = new URLSearchParams(location.search)
const log: string[] = []
const probe = { log } as {
  log: string[]
  removeOpener?: () => void
  setAlt?: (on: boolean) => void
}
;(window as unknown as { __probe: typeof probe }).__probe = probe

function Fixture() {
  const [open, setOpen] = useState(false)
  const [openerGone, setOpenerGone] = useState(false)
  const [alt, setAlt] = useState(q.get('alt') === '1')
  probe.removeOpener = () => setOpenerGone(true)
  probe.setAlt = setAlt
  const close = () => { log.push('close'); setOpen(false) }
  // `refocus=1`: the confirmed action moves focus somewhere of its own (the
  // way a hire walks you to the new desk's composer). The dialog must not
  // yank it back to the opener afterwards.
  const onConfirm = () => {
    log.push('confirm')
    if (q.get('refocus') === '1') document.getElementById('behind-modal')?.focus()
  }
  return <>
    <p>
      {!openerGone && <button id="open-confirm" onClick={() => setOpen(true)}>
        Open existing confirmation</button>}
      <button id="behind-modal">Background control</button>
    </p>
    {open && <ConfirmModal title="Existing confirmation" body="Fixture only."
      confirmLabel="confirm" onConfirm={onConfirm} close={close}
      {...(alt ? { altLabel: 'alternate', onAlt: () => log.push('alt') } : {})} />}
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
