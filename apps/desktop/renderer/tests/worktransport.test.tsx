import './harness'
import { compatibilityWorkFixture } from './workcompat.fixture'
import { FakeServer, installFetch, flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { TeamDocketModal } from '../src/canvas/teamdocket'
import { AttentionQueue } from '../src/attention/AttentionQueue'
import { OwnedDeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import { forgetWorkInflight } from '../src/api'
import { bumpLive } from '../src/livebus'
import type { CanvasNode, TreePayload, WorkItem } from '../src/types'

window.HTMLElement.prototype.scrollIntoView = () => {}
const noop = () => {}
let counter = 0
const fixture = () => {
  const slug = `light-${++counter}`
  const item = { slug: 'active', rev: 1, title: 'Active item', objective: 'searchable current description',
    kind: 'code', status: 'in_progress', owner: { node: 'boss', generation: 1 },
    owner_current: true, owner_state: 'live', reviewer: null, participants: [],
    created_by: 'user', at: '2026-09-01', updated_at: '2026-09-01', docket_at: '2026-09-01',
    done_so_far: ['Completed step'], working_on_next: ['Next step'], manual_attention: null,
    attention_sources: [], effective_attention: false, questions: [],
    acceptance: [{ text: 'DETAIL ACCEPTANCE IS PRESENT', checked: null }],
    dependencies: [], evidence: [{ kind: 'note', note: 'DETAIL EVIDENCE IS PRESENT' }],
    history: [], scope: [], delivery: null, parent: null, archived: false, superseded_by: null,
  } as unknown as WorkItem
  const hidden = { ...item, slug: 'hidden', title: 'Hidden item', status: 'backlogged',
    manual_attention: { reason: 'DECISION REQUIRED', at: '2026-09-01', set_rev: 1, by: { node: 'boss', generation: 1 } },
    attention_sources: ['manual'], effective_attention: true } as WorkItem
  const node = { id: 'boss', parent: null, tier: 'luna', generation: 1, state: 'live',
    children: [], seat: 0.1, grant: 0, free: 0, lineage: [], scope: { tools: {}, add_dirs: [] },
    turns: [], last_status: null, prev_status: null, char_count: 0, mail_pending: 0,
  } as unknown as CanvasNode
  const tree = { slug, name: slug, roots: [node], asks: [], tiers: { luna: 0.1 },
    work_items_summary: { active: 1, attention: 1 }, user_inbox_count: 0,
  } as unknown as TreePayload
  const refs = { world: { org: slug }, onOpen: noop }
  const server = new FakeServer()
  installFetch(server)
  const original = globalThis.fetch
  const calls: string[] = []
  const pending: ((value: unknown) => void)[] = []
  let hold = false
  const light = (v: WorkItem) => {
    const { evidence: _ev, history: _history, acceptance: _acceptance, ...row } = v
    return { ...row, view: 'list', view_revision: `${v.slug}-${v.rev}` }
  }
  globalThis.fetch = compatibilityWorkFixture(((url: string, init?: RequestInit) => {
    const path = String(url)
    calls.push(path)
    const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body })
    if (path.includes('/work-items-view')) return Promise.resolve(ok({
      revision: `r${item.rev}`, items: [light(item)],
      ...(path.includes('backlogged=1') ? { backlogged: [light(hidden)] } : {}),
      ...(path.includes('archived=1') ? { archived: [] } : {}),
      references: [item, hidden].map(({ slug, title, status, parent, archived, rev }) => ({ slug, title, status, parent, archived, rev })),
      attention: [light(hidden)], counts: { active: 1, attention: 1, backlogged: 1, archived: 0 }, now: '',
    }))
    if (/\/work-items\/[^/]+$/.test(path)) {
      const answer = ok({ item: path.endsWith('/hidden') ? hidden : { ...item } })
      if (hold) return new Promise(resolve => pending.push(() => resolve(answer)))
      return Promise.resolve(answer)
    }
    return original(url, init)
  }) as typeof fetch)
  return { slug, item, hidden, node, tree, refs, calls, pending, setHold: (value: boolean) => { hold = value } }
}
const settle = () => inAct(() => flush(10))

for (const kind of ['docket', 'agent', 'team', 'desk'] as const) test(`${kind} uses light closed groups and fetches full selected detail`, async t => {
  const f = fixture()
  const common = { slug: f.slug, tree: f.tree, toast: noop, close: noop }
  const view = kind === 'docket' ? <DocketModal {...common} />
    : kind === 'agent' ? <AgentDocketModal {...common} nid="boss" refs={f.refs} />
      : kind === 'team' ? <TeamDocketModal {...common} nid="boss" refs={f.refs} />
        : <OwnedDeskChat slug={f.slug} node={f.node} map={new Map([['boss', f.node]])}
            op={async () => ({ ok: true }) as never} toast={noop} pub={false} />
  const m = await mountView(view, el => el)
  t.after(async () => { await m.unmount(); resetConvos() })
  await settle()
  assert.ok(f.calls.some(p => p.endsWith('/work-items-view')))
  assert.ok(!f.calls.some(p => p.includes('archived=1') || p.includes('backlogged=1')))
  assert.ok(!f.calls.some(p => /\/work-items\/[^/]+$/.test(p)))
  if (kind === 'desk') {
    const tab = [...m.el.querySelectorAll('button')].find(b => b.textContent?.toLowerCase().includes('docket'))
    assert.ok(tab, 'desk must expose its docket tab')
    await inAct(() => tab.click())
  }
  const row = m.el.querySelector('.docket-row') as HTMLElement
  assert.ok(row, `${kind} has an active row`)
  await inAct(() => row.click())
  await settle()
  assert.ok(f.calls.some(p => p.endsWith('/work-items/active')))
  assert.match(m.el.textContent ?? '', /DETAIL ACCEPTANCE IS PRESENT/)
})

test('hidden deep link reveals group and Attention retains its manual flag without loading backlog', async t => {
  const f = fixture()
  const attention = await mountView(<AttentionQueue slug={f.slug} tree={f.tree} toast={noop} />, el => el)
  t.after(() => attention.unmount())
  await settle()
  assert.match(attention.el.textContent ?? '', /Hidden item/)
  const row = attention.el.querySelector('[data-attn-key], .attn-row') as HTMLElement
  if (row) await inAct(() => row.click())
  assert.ok(!f.calls.some(p => p.includes('backlogged=1')))
  const docket = await mountView(<DocketModal slug={f.slug} tree={f.tree} toast={noop} close={noop}
    jumpTo="hidden" jumpSeq={1} />, el => el)
  t.after(() => docket.unmount())
  await settle()
  assert.ok(f.calls.some(p => p.includes('backlogged=1')))
  assert.ok(f.calls.some(p => p.endsWith('/work-items/hidden')))
  assert.match(docket.el.textContent ?? '', /DECISION REQUIRED/)
})

test('a list refresh retains the selected pane and its reply draft while detail is pending', async t => {
  const f = fixture()
  const m = await mountView(<DocketModal slug={f.slug} tree={f.tree} toast={noop} close={noop} />, el => el)
  t.after(() => m.unmount())
  await settle()
  await inAct(() => (m.el.querySelector('.docket-row') as HTMLElement).click())
  await settle()
  const field = m.el.querySelector('.mailer-read textarea') as HTMLTextAreaElement
  assert.ok(field)
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'unfinished reply')
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  f.setHold(true)
  f.item.rev++
  forgetWorkInflight()
  await inAct(() => bumpLive())
  await inAct(() => new Promise(resolve => setTimeout(resolve, 140)))
  await settle()
  assert.ok(f.pending.length > 0, 'detail refresh must actually be pending')
  assert.equal(m.el.querySelector('.mailer-read textarea'), field)
  assert.equal(field.value, 'unfinished reply')
  await inAct(() => { for (const done of f.pending) done(null) })
  await settle()
  assert.equal(field.value, 'unfinished reply')
})
