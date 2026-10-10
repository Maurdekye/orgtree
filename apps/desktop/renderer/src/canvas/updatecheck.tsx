import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import type { UpdateStatus } from '../../../../../packages/contracts'
import { describeUpdateStatus } from '../update-notice'
import { SetRow } from './settingskit'

/** The result of a manual check in plain words. The version is the running
 *  one, so "up to date" says which release that is. Anything not covered here
 *  falls back to the wording the header notice already uses. */
export function describeCheck(status: UpdateStatus, running: string | null): string | null {
  switch (status.state) {
    case 'idle': return null
    case 'checking': return 'Checking…'
    case 'up-to-date': return running ? `Orgtree is up to date (${running}).` : 'Orgtree is up to date.'
    case 'downloading': return (status.version ? `Version ${status.version} is available` : 'An update is available')
      + (status.percent === undefined ? ' — downloading…' : ` — downloading… ${status.percent}%`)
    case 'pending-idle': return (status.version ? `Version ${status.version} is ready to install` : 'An update is ready to install')
      + ' — use “Update now” in the header.'
      + (status.recheck === 'up-to-date' ? ' No newer release.' : '')
    case 'unavailable': return status.error ? `Could not check for updates: ${status.error}` : 'Could not check for updates.'
    case 'failed': return status.error ? `The update download failed: ${status.error}` : (describeUpdateStatus(status) ?? null)
  }
}

/** "Check for updates" in Settings › About: the same check the automatic one
 *  runs (the app's updater through the desktop bridge), answered in words
 *  beside the button. Absent in a plain browser, which has no updater. */
export function UpdateCheckRow({ appVersion }: { appVersion: string | null }) {
  const bridge = desktop()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!bridge) return
    let alive = true, pushed = false
    // subscribe before reading: a pushed status is newer than the read in flight
    const off = bridge.onEvent(e => {
      if (alive && e.type === 'update') { pushed = true; setStatus(e.data as UpdateStatus) }
    })
    if (bridge.getUpdateStatus) void bridge.getUpdateStatus().then(s => { if (alive && !pushed) setStatus(s) }).catch(() => {})
    return () => { alive = false; off() }
  }, [bridge])
  if (!bridge?.checkForUpdates) return null
  const check = () => {
    setChecking(true); setFailure(null)
    bridge.checkForUpdates().then(setStatus)
      .catch((e: Error) => setFailure(e.message || 'The update check failed.'))
      .finally(() => setChecking(false))
  }
  const text = failure ? `Could not check for updates: ${failure}`
    : checking ? 'Checking…' : status ? describeCheck(status, appVersion) ?? undefined : undefined
  return <SetRow label="updates" hint={text}>
    <button type="button" onClick={check} disabled={checking}>
      {checking ? 'Checking…' : 'Check for updates'}
    </button>
  </SetRow>
}
