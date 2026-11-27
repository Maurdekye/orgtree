// waitingmail.visual.tsx - the fixture for waitingmail.capture.cjs: a project's Mail > listeners folder in ack mode with
// one held job, two listeners, three waiting mails and three finished jobs (docket
// project-mail-listeners-tab-waiting-mail-section-a; USER 2026-11-27 m7472b6f3a603). REAL: the app's stylesheets and
// MailListenersView. SYNTHETIC: the org, the rows and the engine's history answer. Browser-only; nothing is requested.
import { createRoot } from 'react-dom/client'
import { MailListenersView } from '../src/canvas/maillisteners'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { mailListenerState } from '../src/canvas/listeners'
import type { CanvasNode, MailRow, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const node = (id: string): CanvasNode => ({ id, title: id, parent: id === 'sync' ? 'boss' : id === 'boss' ? null : 'sync', state: 'live',
  tier: id === 'sync' ? 'project' : 'haiku', kind: id === 'sync' ? 'project' : 'agent', model_id: '', children: [], seat: 0, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [], mail_queue: 'ack' }, mail_pending: 3, mail_held: 1 } as unknown as CanvasNode)
const map = new Map(['boss', 'sync', 'sa', 'sb'].map((id) => [id, node(id)] as [string, CanvasNode]))
const dog = (owner: string, name: string, last?: string): Watchdog => ({ id: owner + '/' + name, owner, name, kind: 'fair_queue', target: 'sync',
  interval_s: 5, state: 'armed', at: ago(7200), fired: 4, last_fired: last, once: false, spent: false, batch: 1 } as Watchdog)
const listeners = [dog('sa', 'mail-a', ago(900)), dog('sb', 'mail-b', ago(400))]
const fq = (owner: string, name: string) => ({ id: `${owner}/${name}`, owner, name, kind: 'fair_queue' as const, once: false, state: 'armed', gone: false })
const rows = [
  { id: 'w1', from: 'boss', kind: 'message', body: 'Rebuild the docs index', at: ago(840), _wait: true },
  { id: 'w2', from: 'sa', kind: 'message', body: 'Check the release notes links', at: ago(300), _wait: true },
  { id: 'w3', from: '@user', kind: 'message', body: 'Rename the tutorial folder', at: ago(45), _wait: true },
] as MailRow[]
const end = (id: number, how: string, extra = {}) => ({ id, mail: `m${id}`, gist: `job ${id}`, copy: `c${id}`, agent: id % 2 ? 'sa' : 'sb',
  dog: fq(id % 2 ? 'sa' : 'sb', id % 2 ? 'mail-a' : 'mail-b'), how, attempt: 1, waited_from: ago(5000 - id * 600), held_at: ago(4900 - id * 600),
  ended_at: ago(4000 - id * 600), ...extra })
const history = { project: 'sync', ack: true, max_attempts: 3, dead_letters: true, history_next: null,
  working: [{ mail: 'h1', gist: 'Translate the help pages', copy: 'hc1', agent: 'sa', dog: fq('sa', 'mail-a'), attempts: 1, waited_from: ago(1500), held_at: ago(900) }],
  history: [end(4, 'acked', { ack: 'a4', ack_gist: 'done, all green' }), end(3, 'failed', { why: 'was halted' }), end(2, 'acked', { ack: 'a2', ack_gist: 'merged' })] }
const op = async () => history as unknown as OpResult

// `waiting` is spread in, so the same fixture also bundles against the base, which has no such prop
createRoot(document.getElementById('root')!).render(
  <div className="project-desk" style={{ width: 1000, height: 620, padding: 8, overflow: 'auto' }}>
    <div className="mailwrap"><div className="mailpane">
      <DeskDogsProvider value={{ org: 'org', dogs: listeners, open: () => {} }}>
        <MailListenersView node={map.get('sync')!} state={mailListenerState('sync', listeners)} map={map} rows={rows}
          {...({ waiting: 3 } as object)} ack dogs={listeners} onOpenMail={() => {}} op={op} toast={() => {}} />
      </DeskDogsProvider>
    </div></div>
  </div>)
