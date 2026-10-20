import { CurrentOrg } from '../src/popout'
import { DocketRow } from '../src/canvas/docket'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { WorkRefText, buildMentionIndex } from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

export const item = (status: WorkItem['status'] = 'backlogged', slug = 'synthetic-staff-ticket'): WorkItem => ({
  slug, title: 'Synthetic backlog task', status, archived: false,
  owner: { node: 'synthetic-manager', generation: 1 }, at: '2026-10-20T12:00:00Z',
  updated_at: '2026-10-20T12:00:00Z', done_so_far: [], working_on_next: [], questions: [],
  effective_attention: false, attention_sources: [],
} as WorkItem)
export const preview = (value: WorkItem, mode = 'request') => ({ mode, configured_mode: mode,
  owner: value.owner, fallback: false, disclosure: mode === 'request' ? 'Request staffing from the assignee.' : 'Staff immediately at top level. Choose a model.',
  models: [{ tier: 'sol', seat: 2, efforts: ['high'], accounts: [], default_ok: true }] })

export function TicketStaffFixture({ value = item(), showRow = true, notify = (_: string[]) => {} }:
  { value?: WorkItem; showRow?: boolean; notify?: (message: string[]) => void }) {
  const world = { org: 'synthetic-org', items: new Map([[value.slug, value.title]]) }
  function Register() {
    useProvideAgentNav(() => agentMenuEntries({ id: 'synthetic-manager', tier: 'sol', state: 'live', children: [], turns: [], free: 0 } as unknown as CanvasNode,
      { onOpenDesk: () => {}, onOpenTemporary: () => {}, onInbox: () => {}, onSettings: () => {} }))
    return null
  }
  return <CurrentOrg.Provider value="synthetic-org"><AgentNavProvider><ObjectNavProvider><Register />
    <ObjectNavHost org="synthetic-org" dogs={[]} openDog={() => {}} openTicket={() => {}} toast={notify} />
    <ObjectMenuBoundary>
      {showRow && <DocketRow org="synthetic-org" item={value} selected={false} ageTick={0} facts={new Map()}
        toast={notify} onClick={() => {}} onDismiss={() => {}} />}
      <div data-link="react"><RefChip r={resolveRef({ kind: 'item', org: 'synthetic-org', id: value.slug }, world)} onOpen={() => {}} /></div>
      <div data-link="markdown"><RefMdBody html={{ __html: `<p>@item:synthetic-org/${value.slug}</p>` }} world={world} onOpen={() => {}} /></div>
      <div data-link="bare"><WorkRefText text={value.slug} index={buildMentionIndex([value])} onPick={() => {}} /></div>
    </ObjectMenuBoundary>
  </ObjectNavProvider></AgentNavProvider></CurrentOrg.Provider>
}
