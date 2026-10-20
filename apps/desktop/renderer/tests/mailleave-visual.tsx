// The real project mailbox, using a synthetic full ACK batch. No engine or live data.
import { createRoot } from 'react-dom/client'
import { ProjectInbox } from '../src/canvas/projectdesk'
import { CurrentOrg } from '../src/popout'
import { withoutMailTransfers } from './mailtransfers.fixture'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const node = { id: 'review-queue', kind: 'project', tier: 'project', state: 'live', children: [],
  configured_scope: { mail_queue: 'ack' } } as unknown as CanvasNode
const dev = { id: 'worker', kind: 'agent', tier: 'sol', state: 'live', children: [] } as unknown as CanvasNode
const dogs = ['worker', 'user'].map((owner) => ({ id: `${owner}/queue`, owner,
  name: owner === 'user' ? 'user-queue' : 'review-jobs', kind: 'fair_queue', target: node.id,
  state: 'armed', fired: owner === 'user' ? 1 : 0, batch: 1,
  once: false, spent: false, at: new Date(Date.now() - 120000).toISOString(), interval_s: 5 } as Watchdog))
const writes: string[] = []
Object.assign(window, { syntheticWrites: writes })
window.fetch = withoutMailTransfers((async () => new Response(JSON.stringify({
  pending: [], delivered: [], sent: [], next_cursor: null, tag_choices: [],
}), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch)
const op: OpFn = async (req) => {
  if (req.op !== 'mail_queue_history') { writes.push(req.op); return { ok: true } as never }
  return { project: node.id, ack: true, history: [], working: [{
    mail: 'synthetic-job', gist: 'Review the proposal', copy: 'synthetic-copy', agent: 'user',
    held_at: new Date(Date.now() - 60000).toISOString(),
    waited_from: new Date(Date.now() - 90000).toISOString(),
  }] } as never
}
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="synthetic-mail-leave">
  <main style={{ padding: 24, height: 700, boxSizing: 'border-box', fontFamily: 'Segoe UI, sans-serif', display: 'flex', flexDirection: 'column' }}>
    <h2>review-queue · mail</h2>
    <p className="dim">Synthetic full ACK batch · leave remains on the Working row</p>
    <ProjectInbox node={node} slug="synthetic-mail-leave" tree={{ watchdogs: dogs } as TreePayload}
      map={new Map([[node.id, node], [dev.id, dev]])} op={op} toast={() => {}}
      refs={{ world: { org: 'synthetic-mail-leave' }, onOpen: () => {} } as never}
      onOpenMail={() => {}} folderAsk={{ folder: 'listeners', seq: 1 }} />
  </main>
</CurrentOrg.Provider>)
