// Synthetic mailboxes for projectdelivery-visual: a project desk's inbox inside
// the same frame the real modal uses (`desk-body eye-chat`, whose name rule is
// what broke the recipient letter by letter), an agent's Sent folder, the
// user's Sent folder and an ordinary agent inbox, switched through
// window.__rows. Fixture data only; nothing here talks to an engine.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MailFolders, MailList } from '../src/canvas/mail'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { applyTheme } from '../src/themes'
import type { MailRow } from '../src/canvas/shared'

const tiers: Record<string, string> = {
  'image-embed-luna': 'luna', 'rig-sol-b': 'sol', 'hubchat-jumplist-sol': 'sol', 'epic-combo-sol': 'sol',
  'agent-tooltip-luna': 'luna', 'activefilter-luna': 'luna', 'taskbar-orgs-sol': 'sol', 'skilltree-opus': 'opus',
  'usage-header-sonnet': 'sonnet', 'coordinator-opus': 'opus', 'helper-transcript-sol': 'sol', 'inbox-ui-opus': 'opus',
  'build-slot': 'project',
}
const mail = (id: string, from: string, at: string, variant: string, body: string, extra: Partial<MailRow> = {}): MailRow => ({
  id, from, at: `2026-10-18T${at}:00Z`, kind: variant.split('.')[1]!, body,
  ev: { v: 1, variant, actor: { kind: 'agent', id: from }, object: null, engine_authored: false, body }, ...extra,
})
const to = (q: MailRow['queue']) => ({ queue: q })
const held = (by: string, more: object = {}) => to({ held_by: by, held_at: '2026-10-18T14:00:00Z', ack: false, ...more })

// the project inbox of the user's screenshot (build-slot, 4.4.0-alpha.8)
const projectWaiting = [
  mail('w1', 'usage-header-sonnet', '17:02', 'ordinary.question', 'Is the usage header fix in this alpha, or the next one?'),
  mail('w2', 'taskbar-orgs-sol', '13:40', 'ordinary.message', 'Released back to the queue: the inbox tag filter phase needs a fresh slot.',
    to({ released: { by: 'helper-transcript-sol', why: 'was halted' } })),
]
const projectDelivered = [
  mail('p1', 'image-embed-luna', '16:58', 'ordinary.message', 'New project-message history assignment is underway. The paging docket is next.', held('coordinator-opus')),
  mail('p2', 'rig-sol-b', '16:31', 'ordinary.notice', 'BUILD22 alpha.8 assigned directly by coordinator-opus on docket build-22.', { notice: true, ...held('coordinator-opus') }),
  mail('p3', 'hubchat-jumplist-sol', '14:12', 'ordinary.question', 'Assigned @item:orgtree/user-s-inbox-history-stops-scrolling: may I take the slot now?', held('coordinator-opus')),
  mail('p4', 'epic-combo-sol', '13:58', 'ordinary.request', 'Assigned desk-send chat-tab fix (base 0842fc4). My CLI tools are ready.', held('coordinator-opus')),
  mail('p5', 'skilltree-opus', '13:55', 'ordinary.question', 'Who reviews the glossary trim before the alpha?',
    { urgent: true, urgent_reason: 'blocks 4.4.0-alpha.9', ...held('helper-transcript-sol') }),
  mail('p6', 'activefilter-luna', '13:51', 'ordinary.question', 'Coordinator assigned the rail-label phase and specified the slot. Is it mine now?',
    held('coordinator-opus', { ack: true })),
  mail('p7', 'agent-tooltip-luna', '13:50', 'ordinary.question', 'Coordinator directed me to claim the new project build-slot. Which lease do I use?',
    held('coordinator-opus', { ack: true, acked_at: '2026-10-18T14:05:00Z', ack_mail: 'm77' })),
  mail('p8', 'coordinator-opus', '13:45', 'ordinary.message', 'Done: the lease is released and the phase is recorded.', to({ ack_of: 'm71c0' })),
  mail('p9', 'helper-transcript-sol', '13:20', 'ordinary.message', 'Transcript helper capture is queued behind the build slot.',
    to({ dead_letter: { by: 'helper-transcript-sol', why: 'did not ack it after 3 reminders', attempts: 3 } })),
]
// an agent's Sent folder: its mail to the project carries the same queue state
const agentSent = [
  { ...mail('s1', 'coordinator-opus', '16:40', 'ordinary.question', 'Who takes the alpha.9 smoke? It needs the slot for ten minutes.'), to: 'build-slot', ...held('agent-tooltip-luna') },
  { ...mail('s2', 'coordinator-opus', '16:10', 'ordinary.message', 'Integrated the paging fix as f762d99; please rebase.'), to: 'build-slot', ...held('hubchat-jumplist-sol', { ack: true }) },
  { ...mail('s3', 'coordinator-opus', '15:55', 'ordinary.message', 'Your popover width fix is fast-forwarded onto rust-engine.'), to: 'inbox-ui-opus' },
  { ...mail('s4', 'coordinator-opus', '15:30', 'ordinary.message', 'Old queue entry, no longer needed.'), to: 'build-slot', ...to({ purged: { by: '@user' } }) },
]
// the user's Sent folder: plain-text recipients and custom tags (App.tsx)
const userSent = [
  { ...mail('u1', '@user', '14:24', 'ordinary.message', 'Mail tags are heavily compressed and wrapped here; maybe a third row per project mail?'),
    to: 'build-slot', tags: ['ui', 'alpha'], ...held('coordinator-opus') },
  { ...mail('u2', '@user', '13:53', 'ordinary.message', 'Use the concurrency slot as the only build permit from now on.'), to: 'coordinator-opus', tags: ['build'] },
  { ...mail('u3', '@user', '13:10', 'ordinary.question', 'Which agent is on the inbox history fix?'), to: 'build-slot', ...held('hubchat-jumplist-sol', { ack: true }) },
]
// an ordinary agent inbox: no queue states, so its rows must not change
const agentInbox = [
  mail('i1', 'coordinator-opus', '14:25', 'ordinary.request', 'The user asked for you by name for this one: the project inbox rows.'),
  mail('i2', 'coordinator-opus', '13:58', 'ordinary.notice', 'Build permit change: the concurrency slot is the only permit.', { notice: true }),
  mail('i3', 'taskbar-orgs-sol', '12:07', 'ordinary.question', 'Can you send me the picker structure before I wire the pointer grace?'),
  mail('i4', 'hubchat-jumplist-sol', '12:08', 'ordinary.message', 'Inbox response-shape correction integrated at f762d99.'),
  mail('i5', 'coordinator-opus', '11:32', 'ordinary.question', 'Please clean up the inbox filter bar.', { urgent: true, urgent_reason: 'the user asked' }),
]

export type Surface = 'project' | 'agent-sent' | 'user-sent' | 'inbox'
interface Mode { surface: Surface }
declare global { interface Window { __rows?: { set: (m: Partial<Mode>) => void } } }

const nav = { hasAgent: (id: string) => id in tiers, tierOf: (id: string) => tiers[id] ?? null }
function Desk({ folder, children, project }: { folder: string; children: ReactNode; project?: boolean }) {
  // the bare desk the modal and pinned/popped windows render (projectdesk.tsx, desk.tsx)
  return <div className={'tempdesk-panel ' + (project ? 'pin-project project-desk-modal' : 'prov-claude')} id="probe"
    style={{ width: 940, height: 600, position: 'static' }}>
    <div className={'desk-bare' + (project ? ' project-desk' : '')}>
      <div className="desk-body eye-chat">
        <div className="desk-tabpanel">
          <div className="mailwrap">
            <MailFolders folder={folder} setFolder={() => {}} unread={project ? 2 : 0} tier={project ? 'project' : 'opus'} />
            <div className="mailpane">{children}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
}

function Fixture() {
  useProvideAgentNav((id) => [{ label: `Desk of ${id}`, action: () => {} }], (id) => ({ title: `Agent ${id}` }))
  const [mode, setMode] = useState<Mode>({ surface: 'project' })
  useEffect(() => { window.__rows = { set: (m) => setMode((old) => ({ ...old, ...m })) } }, [])
  const key = mode.surface
  const focus = (id: string) => { document.body.dataset.focusedAgent = id }
  return <div data-surface={mode.surface}>
    {mode.surface === 'project' && <Desk folder="inbox" project>
      <MailList key={key} org="org" pending={projectWaiting} delivered={projectDelivered} waitLabel="awaiting next turn"
        projectMail onFocusAgent={focus} {...nav} /></Desk>}
    {mode.surface === 'agent-sent' && <Desk folder="sent">
      <MailList key={key} org="org" delivered={agentSent} outgoing onFocusAgent={focus} {...nav} /></Desk>}
    {mode.surface === 'inbox' && <Desk folder="inbox">
      <MailList key={key} org="org" delivered={agentInbox} onFocusAgent={focus} {...nav} /></Desk>}
    {mode.surface === 'user-sent' && <main className="settings wide" id="probe"
      style={{ width: 940, maxWidth: 'none', height: 600, position: 'static', transform: 'none', margin: 0, boxSizing: 'border-box' }}>
      <h3>Your inbox</h3>
      <MailFolders folder="sent" setFolder={() => {}} unread={0} />
      <div className="mailpane" style={{ height: 470 }}>
        <MailList key={key} delivered={userSent} outgoing onFocusAgent={focus}
          rowSender={(id: string) => <span>{id}</span>} /></div>
    </main>}
  </div>
}
window.fetch = async () => new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<AgentNavProvider><Fixture /></AgentNavProvider>)
