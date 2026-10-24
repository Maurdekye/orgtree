// Project policy controls shared by live settings and the precreation draft.
import { useEffect, useState } from 'react'
import { getRuntimeSettings } from '../api'
import type { ProjectPolicySettings } from '../types'
import { MAX_SLOTS } from './slots'
import { SetRow, SetToggle } from './settingskit'

export const DEFAULT_PROJECT_POLICY: ProjectPolicySettings = {
  peer_mail: true, mail_queue: 'round_robin', exclude_sender: false, slots: 0,
  event_listeners: false, turn_end_reminder: true, ack_timeout: true,
  max_attempts: 3, ack_reminders: 3,
}

export function ProjectPolicyFields({ value, onChange, busy = false, draft = false }: {
  value: ProjectPolicySettings
  onChange: (patch: Partial<ProjectPolicySettings>) => void
  busy?: boolean
  draft?: boolean
}) {
  const { peer_mail: on, mail_queue: mode, exclude_sender: exclude, slots,
    event_listeners: listenersOn, turn_end_reminder: turnEnd, ack_timeout: timeout,
    max_attempts: attempts, ack_reminders: reminders } = value
  const set = <K extends keyof ProjectPolicySettings>(key: K) =>
    (next: ProjectPolicySettings[K]) => onChange({ [key]: next })
  // the ack timeout and max attempts ride the 20-minute checkup (user 08:11Z)
  const [checkups, setCheckups] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    getRuntimeSettings().then((r) => { if (live) setCheckups(r.working_checkups_enabled !== false) }).catch(() => {})
    return () => { live = false }
  }, [])
  return <>
      <SetToggle label="Subordinates may message each other" checked={on} disabled={busy} onChange={set('peer_mail')}
        hint={`Off requires an audience between this project's direct agents and hides their peer connector lines. ${draft ? 'Applied when the project is created.' : 'Changes apply immediately.'}`} />
      <SetRow label="Mail queue" hint={mode === 'ack'
        ? 'ACK works like a FIFO work queue: jobs in order, one per listener until it acks, with retries and dead letters.'
        : 'Round-robin works like a load balancer: each job goes to the least recently woken listener.'}>
        <select aria-label="Mail queue" value={mode} disabled={busy}
          onChange={(e) => set('mail_queue')(e.target.value as 'ack' | 'round_robin')}>
          <option value="round_robin">Round-robin</option>
          <option value="ack">Ack mode</option>
        </select>
      </SetRow>
      <SetToggle label="Never hand an agent its own mail" checked={exclude} disabled={busy} onChange={set('exclude_sender')}
        hint="On: mail an agent sends to the project goes to another watcher, and waits if the sender is the only one." />
      <SetRow label="Concurrency slots" hint="One slot works like a shared lock (mutex); several slots work like a counting semaphore. 0 = no concurrency slots.">
        <input type="number" aria-label="Concurrency slots" min={0} max={MAX_SLOTS} value={slots} disabled={busy}
          onChange={(e) => set('slots')(Math.max(0, Math.min(MAX_SLOTS, Math.floor(Number(e.target.value)) || 0)))} />
      </SetRow>
      <SetToggle label="Project events" checked={listenersOn} disabled={busy} onChange={set('event_listeners')}
        hint="On: the desk shows the events tab and the project's event can be fired. Any agent above or below the project switches it on by registering a listener; only you or an agent above the project switch it off. Off disables every event listener and listener watch on the project and tells their owners; switching it on again re-arms them." />
      {(mode === 'ack' || slots >= 1) && <section className="project-ack-settings" aria-label="Acknowledgement">
        <h4>Acknowledgement</h4>
        {mode === 'ack' && <SetToggle label="Remind an agent that ends its turn with an un-acked job" checked={turnEnd} disabled={busy}
          onChange={set('turn_end_reminder')}
          hint="Mail jobs only: when a listener's turn ends while it still holds an un-acked job, it gets one reminder turn right away naming the job: finish it and ack, or set status blocked with a reason. After that the 20-minute ack timeout applies. Not sent if it ended its turn blocked with a reason, or it is halted, frozen or out of usage. Slot leases use the checkup reminders below." />}
        <SetToggle label="Ack timeout" checked={timeout} disabled={busy || checkups === false} onChange={set('ack_timeout')}
          hint={checkups === false
            ? 'Inactive for both mail jobs and slot leases: the 20-minute checkup ("Check on working agents after 20 minutes" in Runtime settings) is off.'
            : `Applies to un-acked mail jobs and idle slot leases. Their holder gets up to ${reminders} reminders, one per 20-minute checkup; at the next checkup, mail is reclaimed for retry or dead letters and a slot lease is released in full so waiting claims can proceed.`} />
        <SetRow label="Max attempts" hint={checkups === false
          ? 'Mail jobs only; inactive while the 20-minute checkup is off. Does not limit slot claims.'
          : 'Mail jobs only: after this many hand-outs without an ack, a reclaimed job goes to the dead-letter list and you are told. Does not limit slot claims.'}>
          <input type="number" aria-label="Max attempts" min={1} max={100} value={attempts} disabled={busy || checkups === false}
            onChange={(e) => set('max_attempts')(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
        </SetRow>
        <SetRow label="Ack reminders" hint={checkups === false
          ? 'Inactive for both mail jobs and slot leases while the 20-minute checkup is off.'
          : 'Reminders per held mail job or slot lease before reclaim at the next 20-minute checkup, with Ack timeout on. A slot lease is released in full, even if it holds several slots. Default 3; from 1 to 10.'}>
          <input type="number" aria-label="Ack reminders" min={1} max={10} value={reminders} disabled={busy || checkups === false}
            onChange={(e) => set('ack_reminders')(Math.max(1, Math.min(10, Math.floor(Number(e.target.value)) || 1)))} />
        </SetRow>
      </section>}
  </>
}
