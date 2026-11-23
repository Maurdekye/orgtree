// The page dm-panel-visual.mjs captures: the user's mailbox panel exactly as
// the shell mounts it (`UserMailbox`, the classic switch included) over a
// synthetic organization, with the header's inbox button beside it. Every
// engine request goes to the driver's own fake engine on the same origin, so
// what a click changes (a grant, a read, a sent message) is what the next read
// returns. No real organization, mail or name is involved.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { AskBell, UserMailbox } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { applyContrast } from '../src/contrast'
import { syncFastModes } from '../src/canvas/fastmode'
import { noteProjectThemes } from '../src/projecttheme'
import { OPEN_SETTINGS_AT_EVENT } from '../src/canvas/settingskit'
import type { TreePayload } from '../src/types'

const node = (id: string, tier: string, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id, title: id, tier, model_id: tier, state: 'live', seat: 2, grant: 4, free: 2, ui_order: 0, cost_usd: 0,
  occupancy: 0.31, context_window: 200000, charter: `${id} keeps its part of the synthetic organization.`,
  mail_pending: 0, limit_locked: false, last_status: null, prev_status: null, inflight_at: null,
  last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null, generation: 1, busy: false,
  children, lineage: [], scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  ...extra,
})

const QUESTIONS = [
  { kind: 'question', header: 'Channel', question: 'Which channel should the **4.7.0** build go to first?',
    options: [{ label: 'Alpha', description: 'this computer only' }, { label: 'Beta', description: 'everyone who opted in' }] },
  { kind: 'question', header: 'Notes', question: 'Anything the release notes must mention?' },
]
const SCOPE = { kind: 'dir', path: 'S:/synthetic/reports', mode: 'rw' }
/** the one open request: two questions and a scope request, one submit */
const ASK = {
  id: 'ask-1', node: 'lead', kind: 'batch', status: 'open', at: '', revs: { ask: 2, scope: 1 },
  tabs: [...QUESTIONS, { kind: 'scope', id: 'scope-1', label: 'folder S:/synthetic/reports (rw)', reason: 'to save the weekly report there', item: SCOPE }],
}

interface Answer { answers: unknown[]; scope: string[]; when: string }

/** The engine's tree. Once the request is answered the node no longer waits,
 *  and the organization's request history lists what was resolved in the
 *  shapes the ledger gives a resolved batch: the question card with each
 *  tab's answer, and the scope request with each item's decision. */
function tree(at: string, answer: Answer | null, unread: number, granted: readonly string[]): TreePayload {
  /** what the engine's tree says of a project's direct agent while the project holds the user's audience */
  const through = (project: string) => granted.includes(project) ? { audiences_inherited: [{ grantor: '@user', project }] } : {}
  const own = (id: string) => granted.includes(id) ? { audiences_held: ['@user'], audiences_explicit: ['@user'] } : {}
  const ask = { ...ASK, at }
  const resolved = answer ? [
    // (the top-level question mirrors the first tab, for surfaces that read one question)
    { id: 'ask-1', node: 'lead', kind: 'question', status: 'answered', at, resolved_at: answer.when, rev: 2,
      question: QUESTIONS[0]!.question, header: QUESTIONS[0]!.header, options: QUESTIONS[0]!.options,
      questions: QUESTIONS.map((q, i) => ({ ...q, answer: answer.answers[i] })) },
    { id: 'scope-1', node: 'lead', kind: 'scope', status: 'resolved', at, resolved_at: answer.when,
      items: [{ ...SCOPE, decision: answer.scope[0] }] },
  ] : []
  return {
    slug: 'mine', name: 'Synthetic', tiers: { opus: { name: 'Opus' }, sonnet: { name: 'Sonnet' }, haiku: { name: 'Haiku' } },
    roots: [
      node('lead', 'opus', [
        node('worker', 'sonnet', [], { audiences_held: ['@user'], audiences_explicit: ['@user'] }),
        node('helper', 'haiku'),
        node('scout', 'haiku'),
        node('drafter', 'haiku'),
        node('archivist', 'haiku', [], { state: 'archived' }),
        // a project with its own icon and colour, holding the user's audience: clerk reaches the user only
        // through it, runner also holds a grant of its own
        node('desk', 'opus', [node('clerk', 'haiku', [], through('desk')), node('runner', 'haiku', [], { ...through('desk'), ...own('runner') })],
          { kind: 'project', tier: null, theme_color: '#e11d48', theme_icon: 'rocket', ...own('desk') }),
      ], { busy: true, inflight_at: at, last_status: { status: 'working', summary: 'preparing the 4.7.0 notes', at }, ...(answer ? {} : { ask }) }),
      node('solo', 'sonnet', [], { audiences_held: ['@user'], audiences_explicit: ['@user'], busy: true, inflight_at: at,
        last_status: { status: 'working', summary: 'importing the second batch', at } }),
      // a project holding the user's audience (the user wrote to it), with two members
      node('crew', 'opus', [node('member', 'haiku', [], through('crew')), node('mate', 'haiku', [], through('crew'))],
        { kind: 'project', tier: null, ...own('crew') }),
    ],
    asks: answer ? resolved : [ask],
    asks_open: answer ? 0 : 1, user_inbox_count: unread, urgent_unread: 0,
    default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
    default_visibility: 'full', max_top_grant: 100, compact_at: 0.8,
  } as unknown as TreePayload
}

declare global {
  interface Window {
    __dm: {
      confirms: number; toasts: string[]; focused: string[]; closed: number; opened: string[]
      /** what each confirmation asked */
      asked: string[]
      /** every request for a settings window the panel made (the canvas answers these in the app) */
      settings: unknown[]
      /** the engine's next tree: the request is resolved with what was submitted */
      answered(answer: { answers: unknown[]; scope: string[] }): void
      jump(id: string): void; open(peer: string): void
      /** the app's own theme switch (Display settings call the same function) */
      theme(id: string): void
    }
  }
}

function Probe({ at }: { at: string }) {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [jump, setJump] = useState<{ id: string; seq: number } | null>(null)
  const [chat, setChat] = useState<{ peer: string; seq: number } | null>(null)
  // the tree's unread count is the engine's own: how much mail still waits there
  const [unread, setUnread] = useState(3)
  // who holds the user's audience on the engine now: what a project's agents inherit follows it
  const [granted, setGranted] = useState<string[]>(['worker', 'solo', 'crew', 'desk', 'runner'])
  useEffect(() => {
    let live = true
    const read = () => { void fetch('/__state').then(r => r.json()).then((s: { unread: number; granted: string[] }) => {
      if (!live) return
      setUnread(s.unread)
      setGranted(old => old.join('|') === s.granted.join('|') ? old : s.granted)
    }).catch(() => {}) }
    read()
    const timer = window.setInterval(read, 400)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  window.__dm.answered = a => setAnswer({ ...a, when: new Date().toISOString() })
  window.__dm.jump = id => setJump({ id, seq: Date.now() })
  window.__dm.open = peer => setChat({ peer, seq: Date.now() })
  const t = tree(at, answer, unread, granted)
  // every tree the app receives feeds the projects' icons and colours (archived.ts hydrateTree)
  noteProjectThemes(t)
  return (
    <CurrentOrg.Provider value="mine">
      <header className="dm-probe-bar">
        <span className="dim">the header's inbox button:</span>
        <AskBell tree={t} label="Inbox" onOpen={() => {}} />
      </header>
      <UserMailbox slug="mine" tree={t} toast={lines => { window.__dm.toasts.push(...lines) }}
        close={() => { window.__dm.closed++ }} jumpTo={jump?.id ?? null} jumpSeq={jump?.seq ?? null}
        openChat={chat} onFocusAgent={id => { window.__dm.focused.push(id) }}
        // the shell's own route for a mail of the user's box: the inbox, at that mail
        onOpenMail={r => { window.__dm.opened.push(r.id); if (r.box === 'user') window.__dm.jump(r.id) }} />
    </CurrentOrg.Provider>
  )
}

window.__dm = { confirms: 0, toasts: [], focused: [], closed: 0, opened: [], asked: [], settings: [], answered() {}, jump() {}, open() {}, theme: id => applyContrast(id) }
window.addEventListener(OPEN_SETTINGS_AT_EVENT, e => { window.__dm.settings.push((e as CustomEvent).detail) })
// what the providers read tells the app in a real window: these models offer fast mode
syncFastModes([{ tiers: [{ tier: 'opus', fast_mode: true }, { tier: 'sonnet', fast_mode: true }] }] as unknown as Parameters<typeof syncFastModes>[0])
// "no confirmation on close": any confirm the panel raised would be counted here
window.confirm = (text?: string) => { window.__dm.confirms++; window.__dm.asked.push(String(text)); return true }
// when the open request was asked: the driver's clock, so ages read naturally
const at = (window as unknown as { __dmAt?: string }).__dmAt ?? new Date().toISOString()
createRoot(document.getElementById('root')!).render(<Probe at={at} />)
