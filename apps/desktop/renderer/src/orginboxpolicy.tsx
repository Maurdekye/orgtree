import { useState } from 'react'
import { SetGroup, SetRow, SetToggle } from './canvas/settingskit'
import { setNetLockdown } from './api'
import type { NetLockdownSummary } from './types'

/** The user's Outside communication value. `org` = Org decides (USER 2026-11-25 14:10:26Z m16ef9bb35e25, the
 *  default): the org mailbox holders choose open or closed, and the row says what is in force. */
export type OrgInboxMode = 'org' | 'normal' | 'dnd' | 'closed'
type Actual = 'normal' | 'dnd' | 'closed'
const ACTUAL: Record<Actual, string> = { normal: 'open', dnd: 'Do not disturb', closed: 'closed' }

/** What the lockdown setting's row says is in force (USER 2026-11-25 14:10:49Z m405b44961ff5). */
export function lockdownNow(l: NetLockdownSummary): string {
  if (!l.on) return 'off'
  const cover = l.coverage === 'enforced' ? '' : l.coverage === 'partial' ? ', on some hubs only' : l.coverage === 'pending' ? ', not yet on the hubs' : ''
  return `on${cover}`
}

export function OrgInboxPolicy({ mode, actual, onMode, multi, onMulti, slug, lockdown }: {
  mode: OrgInboxMode; actual?: Actual; onMode: (mode: OrgInboxMode) => void
  multi: boolean; onMulti: (on: boolean) => void
  /** the org, for the lockdown setting (saved at once, like the mailserver tab) */
  slug?: string
  /** missing on an engine without lockdown: no lockdown row */
  lockdown?: NetLockdownSummary
}) {
  const [lock, setLock] = useState<NetLockdownSummary['setting'] | null>(null)
  const [lockErr, setLockErr] = useState<string | null>(null)
  const lockSetting = lock ?? lockdown?.setting ?? 'org'
  const changeLock = (setting: NetLockdownSummary['setting']) => {
    if (!slug) return
    setLock(setting)
    setNetLockdown(slug, { setting }).then(() => setLockErr(null))
      .catch((e: unknown) => { setLock(null); setLockErr(e instanceof Error ? e.message : String(e)) })
  }
  const now = mode === 'org' && actual ? ` Now ${ACTUAL[actual]} (the org's choice).` : ''
  return <SetGroup title="External org mailbox">
    <SetRow label="Outside communication" hint={<>Org decides lets the org mailbox holders open or close it (open by default). Normal delivers outside mail to agents. Closed blocks outside communication and hides its retained history.<span id="org-inbox-actual">{now}</span></>}>
      <select aria-label="Org mailbox mode" value={mode}
        aria-describedby={mode === 'dnd' ? 'org-inbox-dnd-warning' : 'org-inbox-actual'}
        onChange={e => onMode(e.target.value as OrgInboxMode)}>
        <option value="org">Org decides</option>
        <option value="normal">Normal operations</option>
        <option value="dnd">Do not disturb</option>
        <option value="closed">Closed off mailbox</option>
      </select>
    </SetRow>
    {mode === 'dnd' && <p className="orgmd-warn" id="org-inbox-dnd-warning" role="note">
      Hubchat and other outside messages are kept but not read or delivered automatically.
      {' '}An agent must check the org mailbox to receive them.
    </p>}
    {lockdown && <SetRow label="Lockdown" hint={<>Only listed outside addresses reach the org mailbox; organizations on this computer still can. Org decides lets the holders turn it on as a last resort against a flood of new accounts. Edit the list in the org mailbox&apos;s mailservers tab.<span id="org-lockdown-actual">{` Now ${lockdownNow(lockdown)}.`}</span></>}>
      <select aria-label="Org mailbox lockdown" value={lockSetting} aria-describedby="org-lockdown-actual"
        onChange={e => changeLock(e.target.value as NetLockdownSummary['setting'])}>
        <option value="org">Org decides</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </SetRow>}
    {lockErr && <p className="orgmd-warn" role="alert">{lockErr}</p>}
    <SetToggle label="Allow multiple org-mailbox audience holders" checked={multi} onChange={onMulti}
      hint="Off: granting a different holder moves the audience; turning this off with several holders requires revoking all but one first" />
  </SetGroup>
}
