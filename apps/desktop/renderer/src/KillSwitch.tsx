import { useCallback, useEffect, useState } from 'react'
import { killAll, releaseKillswitch } from './api'
import { LockIcon, LockOpenIcon, StopIcon } from './icons'
import type { ToastFn } from './types'

export interface KillSwitchProps {
  slug: string
  toast: ToastFn
  refreshTree?: (slug: string) => unknown
  onKilled?: () => void
  className?: string
  /** the org-level killswitch state from the tree payload: while true the
   *  control's whole job flips from arming STOP ALL to offering the explicit
   *  release (user redesign 2026-09-13 — pressing STOP ALL now HALTS the org
   *  persistently instead of interrupting once) */
  latched?: boolean
  killFn?: (slug: string) => Promise<{
    latched?: boolean
    already_latched?: boolean
    interrupted: string[]
    watchdogs_paused?: Array<{ id: string; name: string; owner: string }>
  }>
  releaseFn?: (slug: string) => Promise<{ released: boolean; status?: string }>
  enableDelayMs?: number
  autoRelatchMs?: number
}

/**
 * The killswitch: a latch you must unlatch, which expands the STOP ALL
 * button out to the left. Pressing STOP ALL latches the PERSISTENT org-level
 * killswitch state (user redesign 2026-09-13): every agent is halted — not
 * merely interrupted — until the explicit release this same control offers
 * while `latched` is true.
 *
 * Accident prevention controls (the ARMING latch, distinct from the org
 * state above):
 * 1. Collapsed by default: STOP ALL is 0-width and unclickable while latched.
 * 2. Expands leftward: the pointer stays over the latch on the right, requiring
 *    intentional movement leftward to reach the expanded STOP ALL target.
 * 3. 500ms safety window: upon unlatching, the button starts disabled and enables
 *    only after 500ms. Clicks during this window are discarded.
 * 4. Cancellation on re-latch: re-latching collapses the button and cancels any
 *    pending enable timer immediately, preventing stale/early enablement.
 * 5. Auto-relatch: if left unlatched, automatically re-latches after 6s.
 * Release gets no arming dance: it makes agents ELIGIBLE again but starts
 * nothing, so a stray click costs far less than a stray STOP ALL.
 */
export function KillSwitch({
  slug,
  toast,
  refreshTree,
  onKilled,
  className,
  latched = false,
  killFn = killAll,
  releaseFn = releaseKillswitch,
  enableDelayMs = 500,
  autoRelatchMs = 6000,
}: KillSwitchProps) {
  const [armed, setArmed] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  // 1. Auto-re-latch after 6s of being armed
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => {
      setArmed(false)
    }, autoRelatchMs)
    return () => clearTimeout(t)
  }, [armed, autoRelatchMs])

  // 2. 500ms enable delay: starts disabled, enables after delay.
  // Re-latching (or unmount) cancels the timer and resets enabled to false.
  useEffect(() => {
    if (!armed) {
      setEnabled(false)
      return
    }
    setEnabled(false)
    const t = setTimeout(() => {
      setEnabled(true)
    }, enableDelayMs)
    return () => {
      clearTimeout(t)
      setEnabled(false)
    }
  }, [armed, enableDelayMs])

  const handleToggleLatch = useCallback(() => {
    setArmed((a) => !a)
  }, [])

  const handleKill = useCallback(() => {
    if (!armed || !enabled || busy) return
    setArmed(false)
    setEnabled(false)
    setBusy(true)
    killFn(slug)
      .then((r) => {
        const dogs = r.watchdogs_paused?.length
        const dogMsg = dogs ? ` · paused ${dogs} watchdog${dogs > 1 ? 's' : ''}` : ''
        toast([r.latched
          ? `org halted — killswitch latched; ${r.interrupted.length} turn(s) stopped${dogMsg}`
          : `interrupted ${r.interrupted.length} agent(s); queues cleared${dogMsg}`])
        if (refreshTree) refreshTree(slug)
        if (onKilled) onKilled()
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }, [armed, enabled, busy, killFn, slug, toast, refreshTree, onKilled])

  const handleRelease = useCallback(() => {
    if (busy) return
    setBusy(true)
    releaseFn(slug)
      .then((r) => {
        toast([r.released
          ? 'killswitch released — agents are eligible again; nothing was restarted'
          : r.status ?? 'the killswitch was not latched'])
        if (refreshTree) refreshTree(slug)
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }, [busy, releaseFn, slug, toast, refreshTree])

  if (latched) {
    return (
      <span className={'kill' + (className ? ' ' + className : '')}>
        <button
          type="button"
          className="kill-release"
          disabled={busy}
          title={'the killswitch is latched: every agent in this org is halted. '
            + 'Release restores eligibility only — individually halted agents stay '
            + 'halted, nothing restarts by itself, and watchdogs stay paused.'}
          onClick={handleRelease}
        >
          <StopIcon fontSize="inherit" /> HALTED — RELEASE
        </button>
      </span>
    )
  }

  return (
    <span className={'kill' + (className ? ' ' + className : '')}>
      <button
        type="button"
        className={'kill-btn' + (armed ? ' expanded' : ' collapsed')}
        disabled={!armed || !enabled || busy}
        tabIndex={armed ? 0 : -1}
        aria-hidden={!armed}
        title={armed ? (enabled ? 'halt every agent in this org until explicit release' : 'enabling...') : undefined}
        onClick={handleKill}
      >
        <StopIcon fontSize="inherit" /> STOP ALL
      </button>
      <button
        type="button"
        className={'kill-latch' + (armed ? ' open' : '')}
        title={armed ? 're-latch' : 'unlatch the killswitch'}
        onClick={handleToggleLatch}
      >
        {armed ? <LockOpenIcon fontSize="inherit" /> : <LockIcon fontSize="inherit" />}
      </button>
    </span>
  )
}
