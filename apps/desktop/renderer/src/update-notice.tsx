import { useEffect, useRef, useState } from 'react'
import { desktop } from './desktop'
import type { UpdateStatus } from '../../../../packages/contracts'

const TRANSIENT_STATES = new Set<UpdateStatus['state']>(['up-to-date', 'unavailable', 'failed'])

const LABEL: Record<UpdateStatus['state'], (status: UpdateStatus) => string | null> = {
  idle: () => null,
  checking: () => 'Checking for updates…',
  downloading: status => status.percent === undefined ? 'Downloading update…' : `Downloading update… ${status.percent}%`,
  'pending-idle': () => 'Update ready — installs automatically when idle',
  'up-to-date': () => 'You’re up to date',
  unavailable: () => 'Update check unavailable',
  failed: () => 'Update download failed',
}

/** Purely informational — automatic install still only happens at idle, with
 * no user-triggered override (docket add-automatic-update-discovery-and-in-
 * app-instal). Self-contained: renders null when there is nothing to show
 * and hides its own transient states, so the caller only needs to place it
 * outside `.window-controls`, no dedicated wrapper class required. */
export function UpdateNotice({ transientMs = 6000 }: { transientMs?: number } = {}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const bridge = desktop()
    if (!bridge?.getUpdateStatus) return
    let alive = true
    const apply = (next: UpdateStatus) => {
      if (!alive) return
      setStatus(next)
      setVisible(next.state !== 'idle')
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (TRANSIENT_STATES.has(next.state)) hideTimer.current = setTimeout(() => { if (alive) setVisible(false) }, transientMs)
    }
    void bridge.getUpdateStatus().then(apply).catch(() => {})
    const unsubscribe = bridge.onEvent(event => { if (alive && event.type === 'update') apply(event.data as UpdateStatus) })
    return () => { alive = false; unsubscribe(); if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [transientMs])
  if (!status || !visible) return null
  const label = LABEL[status.state](status)
  if (!label) return null
  return <div className="update-notice" role="status" aria-live="polite">{label}</div>
}
