// canvas/deaddesk.tsx — the project desk's DEAD LETTERS tab (Orgtree 4.4.0;
// docket `project-dead-letter-queue-failed-ack-queue-jobs-a`, user 2026-10-18
// 19:38Z-19:40Z). Shown while the project holds open dead letters: ack-queue
// jobs that ran out of attempts. Each row has the sender, the job, how many
// times it was handed out and how it last ended; a row opens to the whole
// mail and the attempt history (who held it, when, how each hand-out ended).
// Retry puts the job back in the queue with its attempts reset; drop closes it
// with a reason (it leaves the list and the count and stays readable under
// "show dropped"). The lists come from the `dead_letters` op, re-read whenever
// the project's open count changes; the buttons are the user's (the desktop's
// viewer), as the project's agents' through orgtree_project.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ToastFn } from '../types'
import { ago } from './shared'
import type { CanvasNode, OpFn } from './shared'
import { AgentLink, nodeTierOf } from './identity'
import { ageClockNow, subscribeAgeClock } from './desk'

interface Ended { how?: string | null; why?: string | null; at?: string | null }
interface Attempt { n: number; by?: string | null; at?: string | null; ended?: Ended | null }
interface Letter {
  id: string; from: string; at: string; preview?: string; attempts?: number; by?: string | null; why?: string | null
  how?: string | null; dead_at?: string | null; attachments?: number; retried?: number
  dropped?: { by?: string | null; reason?: string | null; at?: string | null } | null
}
interface Detail extends Letter { body?: string; history?: Attempt[] }
interface DeadList { project: string; total: number; dropped: number; letters: Letter[] }

/** "2 attempts", "1 attempt" */
const attemptsText = (n?: number) => `${n ?? 0} attempt${n === 1 ? '' : 's'}`

export function DeadLettersView({ node, map, onJump, op, toast }: {
  node: CanvasNode; map: Map<string, CanvasNode>; onJump?: (id: string) => void; op: OpFn; toast: ToastFn
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const [list, setList] = useState<DeadList | null>(null)
  const [dropped, setDropped] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [dropping, setDropping] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [bump, setBump] = useState(0)
  const count = node.dead_letters ?? 0
  useEffect(() => {
    let live = true
    op({ op: 'dead_letters', node: node.id, include_dropped: dropped })
      .then((r) => { if (live) setList(r as unknown as DeadList) })
      .catch(() => {})   // `op` toasts the refusal
    return () => { live = false }
  }, [node.id, count, dropped, bump])
  useEffect(() => {
    if (!open) { setDetail(null); return }
    let live = true
    op({ op: 'dead_letters', node: node.id, id: open })
      .then((r) => { if (live) setDetail(r as unknown as Detail) })
      .catch(() => {})
    return () => { live = false }
  }, [node.id, open, bump])
  const reread = () => setBump((n) => n + 1)
  const agentLink = (id: string) => <AgentLink id={id} tier={nodeTierOf(map.get(id))} onFocus={onJump} />
  const letters = list?.letters ?? []
  const retry = (l: Letter) => {
    op({ op: 'dead_letter_retry', node: node.id, id: l.id })
      .then(() => { toast([`dead letter ${l.id} of project ${node.id} is back in the queue with its attempts reset`]); setOpen(null); reread() })
      .catch(() => {})
  }
  const drop = (l: Letter) => {
    op({ op: 'dead_letter_drop', node: node.id, id: l.id, reason: reason.trim() })
      .then(() => { toast([`dead letter ${l.id} of project ${node.id} dropped`]); setDropping(null); setReason(''); setOpen(null); reread() })
      .catch(() => {})
  }
  return (
    <div className="desk-tabpanel project-dead-letters">
      <div className="dead-lead dim">
        Jobs this project's ack queue gave up on after they ran out of attempts. They are not handed out again unless you retry them.
        Agents above or below the project see them with <code>orgtree_project action=dead_letters name={node.id}</code> and can attach an
        event watchdog on <code>project.dead_letter</code> to be alerted.
      </div>
      <div className="dead-tools">
        <label className="dim"><input type="checkbox" data-action="show-dropped" checked={dropped}
          onChange={(e) => setDropped(e.target.checked)} /> show dropped{list && list.dropped > 0 ? ` (${list.dropped})` : ''}</label>
      </div>
      <div className="dead-list">
        {list && letters.length === 0 && <div className="dim">No dead letters.</div>}
        {letters.map((l) => {
          const isOpen = open === l.id
          return (
            <div key={l.id} className={'dead-row' + (l.dropped ? ' dropped' : '')} data-dead={l.id}>
              <div className="dead-summary">
                <span className="dead-from">{l.from.startsWith('@') || !map.has(l.from) ? l.from : agentLink(l.from)}</span>
                <span className="dead-preview">{l.preview ?? ''}</span>
                <span className="dim">{attemptsText(l.attempts)}</span>
                {l.by && <span className="dim">last held by {agentLink(l.by)}</span>}
                {l.dead_at && <span className="dim" title={'gave up ' + l.dead_at}>gave up {ago(l.dead_at)} ago</span>}
                {(l.retried ?? 0) > 0 && <span className="dim">retried {l.retried}×</span>}
                {l.dropped && <span className="dim" title={l.dropped.at ?? ''}>dropped by {l.dropped.by}: {l.dropped.reason}</span>}
                <span className="spacer" />
                <button type="button" data-action="open" onClick={() => setOpen(isOpen ? null : l.id)}>{isOpen ? 'hide' : 'details'}</button>
                {!l.dropped && <>
                  <button type="button" data-action="retry"
                    title="put the job back in the queue with its attempts reset" onClick={() => retry(l)}>retry</button>
                  <button type="button" className="danger" data-action="drop" title="close the job with a reason"
                    onClick={() => { setDropping(dropping === l.id ? null : l.id); setReason('') }}>drop</button>
                </>}
              </div>
              {l.why && <div className="dead-why dim">{l.why}</div>}
              {dropping === l.id && <div className="dead-drop">
                <input type="text" data-field="drop-reason" placeholder="why is this job dropped?" value={reason}
                  onChange={(e) => setReason(e.target.value)} />
                <button type="button" className="danger" data-action="confirm-drop" disabled={!reason.trim()}
                  onClick={() => drop(l)}>drop it</button>
                <button type="button" data-action="cancel-drop" onClick={() => setDropping(null)}>cancel</button>
              </div>}
              {isOpen && <div className="dead-detail">
                {!detail && <div className="dim">reading…</div>}
                {detail && <>
                  <pre className="dead-body">{detail.body}</pre>
                  <h4>Attempts</h4>
                  {(detail.history ?? []).length === 0 && <div className="dim">No attempt history was kept for this job.</div>}
                  {(detail.history ?? []).map((a) => (
                    <div key={a.n} className="dead-attempt">
                      <span>#{a.n}</span>
                      {a.by && <span>{agentLink(a.by)}</span>}
                      {a.at && <span className="dim" title={a.at}>handed out {ago(a.at)} ago</span>}
                      <span className="dim">{a.ended ? `${a.ended.how ?? 'ended'}${a.ended.why ? `: ${a.ended.why}` : ''}` : 'still held'}</span>
                    </div>
                  ))}
                </>}
              </div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
