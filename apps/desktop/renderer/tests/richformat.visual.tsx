// richformat.visual.tsx: capture fixture for @item:orgtree/rich-formatting-everywhere-every-rich-text-surfa
// (spec rev 1.2 section 6). One scene per converted surface C1, C3-C18 (C2 was withdrawn) plus
// the S1/S3/S8/S10 symmetry references, each rendering the spec's fixture string through the app's own
// components. Browser-only synthetic data; the clipboard is refused.
//   window.richVisual.scenes  -> ['C1', 'C3', ...]
//   window.richVisual.only(name) shows one scene; theme(contrast) / width(px) as in the other fixtures
//   Scenes marked (click) need one click first, by the capture driver:
//     C1  click 'button.thoughtline'      C3  click '.msg.sys.click'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import { MailMessage } from '../src/events/segments'
import { ReplySourceContent, indexReplySources } from '../src/canvas/replysource'
import { AskCard } from '../src/canvas/asks'
import { AnsweredCard } from '../src/events/answered'
import { AgentTray } from '../src/canvas/agenttray'
import { ProgressView } from '../src/canvas/progress'
import { DescriptionEditor } from '../src/canvas/projectdesk'
import { AppSettings } from '../src/canvas/apps/settings'
import { AppsRefRoutes } from '../src/canvas/apps/events'
import { DocketAcceptance, DocketAttentionReason, DocketEvidenceNotes, DocketList, DocketPostCompletion,
  DocketReviewState, DocketStateReason, DocketVerification } from '../src/canvas/docket'
import { DocketDescription } from '../src/canvas/docketdesc'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { RICH, ORG, onOpen, refs, world } from './fixtures/richdata'
import '../src/styles.css'
import '../src/shell.css'

const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })

const app = { id: 'notes', name: 'Notes', description: RICH, rev: 1, width: 360, height: 280, capabilities: [], events: [], permissions: {},
  created_by: 'maker', updated_at: '' }
window.fetch = (async (raw: unknown, init?: RequestInit) => {
  const url = new URL(String(raw), 'http://local')
  const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
  const out = input.action === 'list' ? { items: input.kind === 'apps' ? [app] : [], next_cursor: null } : {}
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const idx = new Map() as never
const item = (over: Record<string, unknown>) => over as never
const ask = (over: Record<string, unknown>) => ({ id: 'a1', node: 'alpha', status: 'open', at: '2026-11-03T10:00:00Z', ...over }) as never
const node = (over: Record<string, unknown> = {}) => ({ id: 'alpha', state: 'live', kind: 'agent', tier: 'sonnet', children: [], turns: [], ...over }) as never
const sources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'e1', text: RICH, ts: '2026-11-03T10:00:00Z' } as never] })
const model = {
  lane: 'claude', laneLabel: 'Claude', processNote: 'running', historical: false,
  todo: { supply: 'live', source: 'claude-todo', note: '', items: [{ status: 'pending', content: RICH }] },
  subagents: { note: '' }, reported: { status: 'working', summary: RICH, note: '', stale: false }, activity: { note: '', tail: [] },
}
const chat = (m: Record<string, unknown>) => <Msg m={m as never} slug={ORG} nid="alpha" refs={refs} />

const SCENES: Record<string, () => ReactNode> = {
  C1: () => chat({ role: 'assistant', text: 'done', thinking: RICH, think_secs: 5, seq: 1, thinking_event_id: 'th1' }),
  C3: () => chat({ role: 'system', text: 'Context compacted', summary: RICH, seq: 3 }),
  C4: () => <DescriptionEditor node={{ id: 'proj-one', state: 'live', kind: 'project', charter: RICH, children: [] } as never} op={async () => ({})} toast={noop} editable refs={refs} />,
  C5: () => <DocketList heading="DONE SO FAR" items={[RICH]} mark="done" refIndex={idx} refWorld={world} onOpenRef={onOpen} />,
  C6: () => <DocketStateReason field="blocked_reason" text={RICH} refWorld={world} onOpenRef={onOpen} />,
  C7: () => <DocketEvidenceNotes item={item({ evidence: [{ ref: 'abc123', note: RICH }] })} refWorld={world} onOpenRef={onOpen} />,
  C8: () => <DocketReviewState item={item({ candidate_verdict: { candidate: 'abc123', note: RICH, evidence: [{ ref: 'r1', note: RICH }] } })} refWorld={world} onOpenRef={onOpen} />,
  C9: () => <DocketVerification slug="x" refWorld={world} onOpenRef={onOpen}
    item={item({ findings: [{ id: 'F1', disposition: 'open', title: 'A finding', detail: RICH, decisions: [{ disposition: 'fixed', note: RICH }] }], findings_summary: { open: ['F1'] } })} />,
  C10: () => <DocketAcceptance item={item({ acceptance: [{ text: RICH }] })} refWorld={world} onOpenRef={onOpen} />,
  C11: () => <DocketPostCompletion item={item({ status: 'done', post_completion: { note: RICH, at: '2026-11-03T10:00:00Z', count: 1, by: 'alpha' } })} refWorld={world} onOpenRef={onOpen} />,
  C12: () => <DocketAttentionReason reason={RICH} refWorld={world} onOpenRef={onOpen} refIndex={idx} />,
  C13: () => { const n = node({ last_status: { status: 'working', summary: RICH, at: '2026-11-03T10:00:00Z' } })
    return <AgentTray map={new Map([['alpha', n]]) as never} rows={[{ node: n, depth: 0 }] as never} query="" onQuery={noop} archived={false} onArchived={noop} onPick={noop} refs={refs} /> },
  C14: () => <ProgressView model={model as never} refs={refs} />,
  C15: () => <AnsweredCard dismissed={false} note={RICH} world={world} onOpen={onOpen} org={ORG}
    questions={[{ label: 'Q', question: 'Which?', options: [], multi: false, selected: [], typed: RICH }]} />,
  C16: () => <AskCard ask={ask({ kind: 'credit', old: 2, new: 4, reason: RICH })} slug={ORG} toast={noop} refs={refs} seat={4} committed={1} />,
  C17: () => <AskCard ask={ask({ id: 'a4', kind: 'elicitation', elicitation: { server: 'srv', message: RICH, mode: 'form', schema: { properties: {} }, expires_at: '2026-11-04T00:00:00Z' } })}
    slug={ORG} toast={noop} refs={refs} />,
  C18: () => <AppsRefRoutes.Provider value={refs}><AppSettings slug={ORG} app={app as never} close={noop} /></AppsRefRoutes.Provider>,
  S1: () => <MailMessage profile="operator" slug={ORG} nid="alpha" world={world} onOpen={onOpen} row={{ id: 'm1', from: 'alpha', kind: 'message', body: RICH, at: '2026-11-03T10:00:00Z' }} />,
  S3: () => chat({ role: 'assistant', text: RICH, seq: 1 }),
  S7: () => <ReplySourceContent source={sources.get('e1')!} slug={ORG} nid="alpha" profile="operator" refs={refs} />,
  S8: () => <AskCard ask={ask({ id: 'q1', kind: 'question', question: RICH, options: [{ label: 'One', description: RICH }, { label: 'Two' }], header: 'H' })} slug={ORG} toast={noop} refs={refs} />,
  S10: () => <DocketDescription text={RICH} slug="x" world={world} onOpen={onOpen} />,
}

function Fixture() {
  const [state, setState] = useState({ width: 720, only: '' })
  ;(window as unknown as { richVisual: unknown }).richVisual = {
    scenes: Object.keys(SCENES),
    /** contrast: obsidian-black | charcoal | solarized-light | light */
    theme: (contrast: string, accent = 'claude') => { applyContrast(contrast); applyTheme(accent) },
    width: (width: number) => setState(s => ({ ...s, width })),
    only: (name: string) => setState(s => ({ ...s, only: name })),
  }
  const names = state.only ? [state.only] : Object.keys(SCENES)
  return <div style={{ width: state.width, padding: 10, background: 'var(--panel)' }} data-fixture="richformat">
    {names.map(name => <div key={name} data-scene={name} style={{ marginBottom: 14 }}>
      <div className="dim" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>{name}</div>
      <div className="desk-chat">{SCENES[name]!()}</div>
    </div>)}
  </div>
}

applyContrast('charcoal'); applyTheme('claude')
createRoot(document.getElementById('root')!).render(<Fixture />)
