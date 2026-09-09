import { useEffect, useState } from 'react'
import { desktop } from './desktop'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from './icons'
import type { DesktopControlsState } from '../../../../packages/contracts'

/** The native frame replacement. Every command goes through the opener's
 * sender-scoped bridge; the canvas and surrounding margins remain separate
 * drag regions. */
export function WindowControls() {
  const [state, setState] = useState<DesktopControlsState | null>(null)
  useEffect(() => {
    const bridge = desktop()
    if (!bridge?.getWindowControlsState) return
    let alive = true
    void bridge.getWindowControlsState().then(next => { if (alive) setState(next) }).catch(() => {})
    const unsubscribe = bridge.onEvent(event => {
      if (alive && event.type === 'window-state') setState(event.data as DesktopControlsState)
    })
    return () => { alive = false; unsubscribe() }
  }, [])
  const bridge = desktop()
  if (!state || !bridge) return null
  const action = (run: () => Promise<void>) => { void run().catch(() => {}) }
  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button type="button" className="window-control" aria-label="Minimize window" title="Minimize window"
        onClick={() => action(bridge.minimizeWindow)}><MinimizeIcon fontSize="inherit" /></button>
      <button type="button" className="window-control" aria-label={state.maximized ? 'Restore window' : 'Maximize window'}
        title={state.maximized ? 'Restore window' : 'Maximize window'}
        onClick={() => action(bridge.toggleMaximizeWindow)}>
        {state.maximized ? <RestoreIcon fontSize="inherit" /> : <MaximizeIcon fontSize="inherit" />}
      </button>
      <button type="button" className="window-control close" aria-label="Close window" title="Close window"
        onClick={() => action(bridge.closeWindow)}><CloseIcon fontSize="inherit" /></button>
    </div>
  )
}
