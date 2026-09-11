import { useEffect, useRef, useState } from 'react'
import { desktop } from './desktop'
import type { UpdateStatus } from '../../../../packages/contracts'

const TRANSIENT_STATES = new Set<UpdateStatus['state']>(['up-to-date', 'unavailable', 'failed'])

const LABEL: Record<UpdateStatus['state'], (status: UpdateStatus) => string | null> = {
  idle: () => null,
  checking: () => 'Checking for updates…',
  downloading: status => status.percent === undefined ? 'Downloading update…' : `Downloading update… ${status.percent}%`,
  'pending-idle': () => 'Update ready to install',
  'up-to-date': () => 'You’re up to date',
  unavailable: () => 'Update check unavailable',
  failed: () => 'Update download failed',
}

/** Shared with the app Settings manual-check row, so the two surfaces never drift apart in wording.
 *  Looked up defensively: `status` crosses the IPC boundary as `unknown` data cast at the call site,
 *  so an unrecognized state (a future addition, or a bug that leaks a different channel's vocabulary
 *  onto this one - see the 'maintenance' channel split) renders nothing instead of throwing. */
export function describeUpdateStatus(status: UpdateStatus): string | null { return LABEL[status.state]?.(status) ?? null }

/** What hovering `Update now` says (user 2026-09-11): the TARGET version that
 *  was downloaded, never the installed one. `UpdateStatus.version` is the
 *  downloaded release — main/updater.ts carries it from electron-updater's
 *  own update-available info through `downloading` into `pending-idle`, and
 *  the tray label already names it the same way ("Update 2.0.5 ready to
 *  install").
 *
 *  ⚠ IT IS OPTIONAL, AND THE FALLBACK IS NOT COSMETIC. The field is
 *  `version?: string`, and there is a real path that leaves it unset: a fast
 *  cached autoDownload can fire `update-downloaded` before the check's own
 *  promise settles, so no `downloading` status with a version was ever
 *  recorded (see the race main/updater.ts documents at `runCheck`). Inventing
 *  a number there — or showing the RUNNING version, which is the one thing
 *  the user said this must not be — would be worse than saying less, so an
 *  unknown version falls back to naming the action only. */
export function updateActionTitle(version?: string): string {
  return version
    ? `Update to Orgtree ${version} — installs the downloaded update and restarts`
    : 'Install the downloaded update and restart Orgtree'
}

/** Automatic installation waits for idle; a ready download also offers an
 * explicit install-and-restart action. Renders null when there is nothing to show
 * and hides its own transient states, so the caller only needs to place it
 * outside `.window-controls`, no dedicated wrapper class required. */
export function UpdateNotice({ transientMs = 6000 }: { transientMs?: number } = {}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [visible, setVisible] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  const label = describeUpdateStatus(status)
  if (!label) return null
  return <div className="update-notice" role="status" aria-live="polite">
    {status.state === 'pending-idle' && desktop()?.installUpdate
      ? <button disabled={applying}
          /* The attention glow (user 2026-09-11), ONLY while a download is
             sitting there ready to install. Deliberately the SAME vocabulary
             as the chrome's unread-ask bell — class `glow`, and the shared
             `askbell` keyframes in styles.css — rather than a second
             animation that could drift out of step with it. It follows the
             active provider theme for free, because that treatment is built
             on `--accent`, which themes.tsx sets from the resolved theme.
             It stops the moment the button is pressed: `applying` is no
             longer "ready to install", and a glowing disabled control that
             reads "Restarting…" would be asking for a click it refuses. */
          className={'update-now' + (applying ? '' : ' glow')}
          title={updateActionTitle(status.version)}
          onClick={() => {
            setApplying(true); setError(null)
            void desktop()!.installUpdate().catch((reason: unknown) => {
              setApplying(false); setError(reason instanceof Error ? reason.message : String(reason))
            })
          }}>{applying ? 'Restarting…' : 'Update now'}</button>
      : label}
    {error && <span role="alert">{error}</span>}
  </div>
}
