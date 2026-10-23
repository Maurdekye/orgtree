import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { CurrentOrg } from '../src/popout'
import { AgentNavProvider } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { PresentationCard } from '../src/canvas/docs'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { MailReadPane, MailReplyBox } from '../src/canvas/mail'
import { QuickChat } from '../src/QuickChatBox'
import { refreshConvo, resetConvos } from '../src/convo'
import { objectReplyContext, replyWire, storeReplies, readReplies } from '../src/eventReply'
import { AgentDocketView } from '../src/canvas/docket'
import { captureSelectionComposer } from '../src/canvas/selectioncomposer'
import { captureObjectActions } from '../src/canvas/composerobjects'
import { selectionSnapshot } from '../src/replySelection'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, WorkItem } from '../src/types'

const noop = () => {}
const item = { slug: 'ticket', title: 'Fix the ticket', status: 'open', kind: 'code', rev: 1,
  objective: 'Ticket scope', archived: false, owner: { node: 'author', generation: 1 }, owner_current: true,
  owner_state: 'live', participants: [], done_so_far: [], working_on_next: [], dependencies: [], evidence: [],
  questions: [], attention_sources: [], dismissals: [], history: [], acceptance: [], effective_attention: false,
  at: '2026-10-22T10:00:00Z', updated_at: '2026-10-22T10:00:00Z', docket_at: '2026-10-22T10:00:00Z' } as unknown as WorkItem
const doc = { id: 'plan', title: 'Presentation plan', node: 'author', presented_by: 'author', at: '2026-10-22T10:00:00Z' }
const node = (id: string, extra = {}): CanvasNode => ({ id, title: id, generation: 1, state: 'live',
  tier: 'sol', children: [], seat: 2, grant: 50, free: 48, documents: [doc],
  scope: { tools: {}, add_dirs: [] }, ...extra } as unknown as CanvasNode)

function Wrapper({ org, children }: { org: string; children: ReactNode }) {
  return <CurrentOrg.Provider value={org}><AgentNavProvider><ObjectNavProvider>
    <ObjectNavHost org={org} dogs={[]} openDog={noop} openTicket={noop} openDocument={noop} toast={noop} />
    <ObjectMenuBoundary>{children}</ObjectMenuBoundary>
  </ObjectNavProvider></AgentNavProvider></CurrentOrg.Provider>
}
function Links({ org }: { org: string }) {
  return <><RefChip r={resolveRef({ kind: 'item', org, id: 'ticket' }, { org })} onOpen={noop} />
    <RefChip r={resolveRef({ kind: 'doc', org, id: 'plan' }, { org, docs: new Map([['plan', 'Presentation plan']]) })} onOpen={noop} />
    <PresentationCard slug={org} doc={doc} onOpen={noop} className="test-presentation">Presentation plan</PresentationCard></>
}
function backend(t: TestContext, org: string) {
  localStorage.clear(); resetConvos(); resetStaffingOptionsForTests()
  const prior = globalThis.fetch, server = new FakeServer(), writes: { url: string; body: Record<string, unknown> }[] = []
  server.workItems = [item]
  server.messages = [{ role: 'assistant', text: `See @item:${org}/ticket and @doc:${org}/plan.`, seq: 0, event_id: 'event-1' }]
  installFetch(server)
  const fallback = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input), path = new URL(url, 'http://localhost').pathname
    if (init?.method === 'POST') {
      writes.push({ url, body: JSON.parse(String(init.body || '{}')) })
      return new Response(JSON.stringify(path.endsWith('/broadcast') ? { sent: ['member'], refused: [] } : { id: 'sent-1', queued: 0 }), { status: 200 })
    }
    const body = path.endsWith('/work-items-page') ? { format: 'orgtree.work-page/v1', group: 'items', rows: server.workItems, total: server.workItems.length,
      totals: { items: server.workItems.length, archived: 0, backlogged: 0 }, matched: { items: server.workItems.length, archived: 0, backlogged: 0 },
      counts: { active: server.workItems.length, attention: 0, archived: 0, backlogged: 0 }, assigned_count: 0, next_offset: null, revision: 'r1', at: '' }
      : path.endsWith('/documents/plan') ? { ...doc, body: 'Plan body', node_state: 'live', format: 'markdown' }
      : path.endsWith('/work-items/ticket') ? { item }
        : path === '/api/providers' ? { providers: [{ id: 'openai', hire_enabled: true, status: { installed: true } }] }
          : path.endsWith('/staffing-options') ? { tiers: [{ tier: 'sol', seat: 2, efforts: ['high', 'xhigh'], accounts: [], default_ok: true }],
            errors: [], loading: false, stale: false, at: 0, generation: 0 } : null
    return body ? new Response(JSON.stringify(body), { status: 200 }) : fallback(input, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = prior; resetConvos() })
  return { server, writes }
}
async function settle() { await inAct(async () => { await flush(10) }) }
async function right(el: Element) {
  await inAct(async () => {
    for (const type of ['pointerdown', 'mousedown', 'contextmenu']) el.dispatchEvent(new window.MouseEvent(type,
      { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 40 }))
    await flush(10)
  }); await settle()
}
const menuButtons = () => {
  const root = document.querySelector('.ctxmenu:not(.ctxmenu-submenu)')
  return root ? [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(b => b.closest('[role="menu"]') === root) : []
}
const labels = () => menuButtons().map(b => b.textContent?.replace('▸', '').trim())

for(const kind of ['document','work_item'] as const) for(const order of ['selection-first','object-first'] as const)
test(`embedded docket sends both ${kind} object and selected passage (${order})`,async t=>{
  const org=`mixed-docket-${kind}-${order}`,{writes}=backend(t,org)
  const view=await mountView(<Wrapper org={org}><div className="desk-body"><AgentDocketView slug={org} nid="author" mine={[item]}
    facts={new Map()} toast={noop} refs={{world:{org},onOpen:noop}}/></div></Wrapper>,el=>el)
  t.after(()=>view.unmount());await settle()
  const box=view.el.querySelector<HTMLTextAreaElement>('.mailer-read textarea')!
  assert.equal(!!box,true,'actual docket reply box mounted in its desk scope')
  const selector={part:'work_item.objective',projection:'source-v1' as const,unit:'unicode-scalar' as const,expected_sha256:'a'.repeat(64),start:0,end:6}
  const selected={target:{kind:'work_item' as const,org,slug:item.slug},selection:selector}
  const passage={...selected,snapshot:selectionSnapshot(item.objective,selector,1)}
  const object={kind,org,id:kind==='document'?'plan':'another-ticket',title:'Referenced object'}
  const stageSelection=()=>captureSelectionComposer(box)!(passage)
  const stageObject=()=>captureObjectActions(box,'reference').reply!(object)
  for(const stage of order==='selection-first'?[stageSelection,stageObject]:[stageObject,stageSelection])await inAct(stage)
  assert.equal(view.el.querySelectorAll('.selection-excerpt').length,1)
  assert.equal(!!view.el.querySelector('[aria-label="Replying to '+(kind==='document'?'presentation':'ticket')+'"]'),true)
  await fill(box,'Explain both')
  await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click();await flush(10)})
  const sent=writes.find(write=>write.url.endsWith('/nodes/author/message'))?.body
  assert.equal(!!sent,true,'combined reply uses the real message adapter')
  assert.deepEqual(sent!.targets,[kind==='document'?{kind,org,id:object.id}:{kind,org,slug:object.id},selected])
  assert.equal(view.el.querySelectorAll('.selection-excerpt').length,0,'accepted send clears the sent selection')
})
async function choose(label: string) {
  const button = menuButtons().find(b => b.textContent?.trim() === label)
  assert.equal(!!button, true, `${label}: ${JSON.stringify(labels())}`)
  await inAct(async () => { button!.click(); await flush(8) })
}
async function fill(box: HTMLInputElement | HTMLTextAreaElement, value: string, caret = value.length) {
  await inAct(async () => {
    const prototype = box instanceof window.HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(box, value)
    box.dispatchEvent(new window.Event('input', { bubbles: true }))
    box.focus(); box.setSelectionRange(caret, caret); await flush(5)
  })
}
async function stage(anchor: Element, box: HTMLTextAreaElement | HTMLInputElement) {
  await fill(box, 'before after', 7)
  await right(anchor)
  assert.deepEqual(labels().slice(0, 2), ['Mention', 'Reply'])
  await choose('Mention')
  assert.equal(box.value.startsWith('before @'), true)
  assert.equal(box.value.endsWith(' after'), true)
  await right(anchor); await choose('Reply')
  assert.equal(document.activeElement === box, true)
}

test('agent desk: ticket and presentation cards/links stage exact reply identities, preserve text and send only on request', async t => {
  const org = 'objects-agent', { writes } = backend(t, org), agent = node('receiver')
  const view = await mountView(<Wrapper org={org}><DeskChat node={agent} map={new Map([[agent.id, agent]])}
    slug={org} op={async () => ({})} toast={noop} bare onJump={noop} onWorkLink={noop} onOpenDoc={noop} /></Wrapper>, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await refreshConvo(org, agent.id); await flush(10) })
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('[data-tab="chat"]')?.click(); await flush(10) })
  const box = view.el.querySelector<HTMLTextAreaElement>('fieldset textarea')!
  const ticket = view.el.querySelector('[data-object-nav="ticket"]')!
  const presentation = view.el.querySelector('[data-doc-id="plan"]')!
  assert.equal(!!ticket && !!presentation && !!box, true, 'agent ticket, presentation and composer mounted')
  await stage(ticket, box); await stage(presentation, box)
  const documentLink = view.el.querySelector('[data-object-nav="document"]')
  assert.equal(!!documentLink, true, 'presentation reference link is available')
  await stage(documentLink!, box)
  assert.equal(writes.length, 0, 'menu actions never send')
  assert.equal(view.el.querySelectorAll('.reply-preview-composing').length, 2)
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-send')!.click(); await flush(8) })
  const sent = writes.find(w => w.url.endsWith('/message'))?.body
  assert.equal(!!sent, true, `send button must post; writes=${JSON.stringify(writes)}`)
  assert.deepEqual((sent!.replies as Record<string, unknown>[]).map(r => [r.kind, r.kind === 'work_item' ? r.slug : r.id]), [['work_item', 'ticket'], ['document', 'plan']])
})

test('project desk: presentation and ticket targets survive an ordinary send and a broadcast', async t => {
  const org = 'objects-project', { server, writes } = backend(t, org), member = node('member'), project = node('team', { kind: 'project', tier: 'project', children: [member] })
  server.workItems = [{ ...item, owner: { node: 'member', generation: 1 } }]
  // A project's Docket is the member-owned subtree, not work owned by the
  // project id. Match the page above instead of the single-agent fallback.
  const availability = server.readerAvailability.bind(server)
  server.readerAvailability = (nid, archived, backlogged, retired) => {
    if (nid !== project.id) return availability(nid, archived, backlogged, retired)
    const hasWork = server.workItems.some((row: WorkItem) => row.owner?.node === member.id)
    return {work:{own:hasWork,team:hasWork},presented:{own:false,team:false}}
  }
  member.parent = 'team'
  const tree = { slug: org, roots: [project], watchdogs: [], slot_leases: [] } as unknown as TreePayload
  const view = await mountView(<Wrapper org={org}><ProjectDesk node={project} slug={org} tree={tree}
    map={new Map([[project.id, project], [member.id, member]])} op={async () => ({})} toast={noop}
    refs={{ world: { org }, onOpen: noop }} onJump={noop} onOpenDoc={noop} /></Wrapper>, el => el)
  t.after(() => view.unmount()); await settle()
  const box = view.el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  await stage(view.el.querySelector('[data-doc-id="plan"]')!, box)
  assert.equal(writes.length, 0)
  await inAct(async () => { box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush(10) })
  assert.deepEqual(writes.find(w => w.url.endsWith('/message'))?.body.targets, [{ kind: 'document', org, id: 'plan' }])
  // The docket tab owns the same composer as the other project tabs.
  const tab = view.el.querySelector<HTMLButtonElement>('[data-tab="docket"]')!
  await inAct(async () => { tab.click(); await flush(10) }); await settle()
  const row = view.el.querySelector('.docket-row')
  // Team items are owned by its member.
  if (row) {
    await stage(row, box)
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-broadcast-toggle')!.click(); await flush(3) })
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.project-composer .cc-send')!.click(); await flush(10) })
    assert.deepEqual(writes.find(w => w.url.endsWith('/broadcast'))?.body.targets, [{ kind: 'work_item', org, slug: 'ticket' }])
  } else assert.fail('Project docket row must render')
})

test('mail reader: both object link menus use its reply box; selected context and draft return on refusal', async t => {
  const org = 'objects-mail'; backend(t, org)
  const sent: unknown[][] = []
  const view = await mountView(<Wrapper org={org}><div className="mailer-read">
    <Links org={org} />
    <MailReadPane cur={{ id: 'mail-1', from: 'author', to: 'user', kind: 'message', body: 'Read this', at: '' } as never}
      org={org} refs={{ world: { org }, onOpen: noop }} sender={id => id} party="author"
      onReply={async (...args) => { sent.push(args); throw Error('fixture refused') }} />
  </div></Wrapper>, el => el)
  t.after(() => view.unmount()); await settle()
  const box = view.el.querySelector<HTMLTextAreaElement>('textarea')!
  for (const anchor of [view.el.querySelector('[data-object-nav="ticket"]')!, view.el.querySelector('.test-presentation')!]) await stage(anchor, box)
  const draft = box.value
  assert.equal(sent.length, 0)
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click(); await flush(10) })
  assert.deepEqual(sent[0]?.[3], { kind: 'document', org, id: 'plan' })
  assert.equal(box.value, draft)
  assert.equal(view.el.querySelector('[aria-label="Replying to presentation"]') !== null, true)
  await inAct(async () => { box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush(3) })
  assert.equal(view.el.querySelector('.reply-preview-composing') === null, true)
})

test('Quick chat: canvas-only fallback, nearer desk priority, outside menus unchanged, deferred kickoff carries identity', async t => {
  const org = 'objects-quick', { writes } = backend(t, org), agent = node('receiver')
  const hires: Record<string, unknown>[] = []
  const tree = { slug: org, roots: [agent], default_top_grant: 30, tiers: { sol: 2 } } as unknown as TreePayload
  const view = await mountView(<Wrapper org={org}><main><div className="canvas-world"><Links org={org} />
    <DeskChat node={agent} map={new Map([[agent.id, agent]])} slug={org} op={async () => ({})} toast={noop} bare onJump={noop} onWorkLink={noop} />
    </div><footer><QuickChat slug={org} tree={tree} op={async body => { hires.push(body as unknown as Record<string, unknown>); return { node: 'new-agent' } }}
      toast={noop} onHired={noop} /></footer><aside className="outside"><Links org={org} /></aside></main></Wrapper>, el => el)
  t.after(() => view.unmount()); await settle()
  await inAct(async () => { await refreshConvo(org, agent.id); await flush(10) })
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('[data-tab="chat"]')?.click(); await flush(10) })
  const quick = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
  const desk = view.el.querySelector<HTMLTextAreaElement>('fieldset textarea')!
  const canvasLink = view.el.querySelector('.canvas-world > .test-presentation')!
  await stage(canvasLink, quick)
  const deskTicket = view.el.querySelector('fieldset [data-object-nav="ticket"]')
  assert.equal(!!deskTicket, true, 'nearer desk ticket rendered in Chat')
  await right(deskTicket!); await choose('Mention')
  assert.equal(desk.value.includes(`@item:${org}/ticket`), true)
  assert.equal(quick.value.includes('@item:'), false, 'nearer desk wins')
  await right(view.el.querySelector('.outside .test-presentation')!)
  assert.equal(labels().includes('Mention') || labels().includes('Reply'), false)
  await inAct(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(3) })
  assert.equal(hires.length + writes.length, 0)
  await inAct(async () => { quick.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush(10) })
  assert.equal(hires.length, 1)
  assert.equal(hires[0]!.kickoff, undefined, 'object reply must not send a second kickoff')
  assert.deepEqual(writes.find(w => w.url.endsWith('/message'))?.body.target, { kind: 'document', org, id: 'plan' })
})

test('ticket draft persistence and wire use canonical work_item slug', () => {
  const reply = objectReplyContext('receiver', 1, { kind: 'work_item', org: 'objects-persist', id: 'ticket', title: 'Ticket' })
  storeReplies('objects-persist', [reply])
  assert.deepEqual(readReplies('objects-persist'), [reply])
  assert.equal((replyWire(reply) as { slug?: string }).slug, 'ticket')
})

test('ACK mail reply uses the same object context and does not acknowledge until explicit send', async t => {
  const org = 'objects-ack'; backend(t, org)
  const acks: unknown[][] = []
  const view = await mountView(<Wrapper org={org}><div className="mailer-read"><Links org={org} />
    <MailReadPane cur={{ id: 'job-1', from: 'author', to: 'user', kind: 'message', body: 'Review', at: '',
      queue: { job: { id: 7, name: 'jobs', mail: 'jm1', ack: true } } } as never}
      org={org} refs={{ world: { org }, onOpen: noop }} sender={id => id} party="author"
      onAckJob={async (...args) => { acks.push(args) }} />
  </div></Wrapper>, el => el)
  t.after(() => view.unmount()); await settle()
  await stage(view.el.querySelector('[data-object-nav="document"]')!, view.el.querySelector<HTMLTextAreaElement>('textarea')!)
  assert.equal(acks.length, 0)
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click(); await flush(8) })
  assert.deepEqual((acks[0]?.[1] as { objectTarget?: unknown }).objectTarget, { kind: 'document', org, id: 'plan' })
})

test('a contextual box inside a desk takes priority; a standalone contextual reader keeps its menu', async t => {
  const org = 'objects-nested'; backend(t, org)
  const sends: unknown[][] = []
  const reader = (standalone: boolean) => <div className={standalone ? 'standalone' : 'desk-body'}><div className="mailer-read">
    <Links org={org} /><MailReplyBox target="author" slug={org} onSend={async (...args) => { sends.push(args) }} />
  </div></div>
  const view = await mountView(<Wrapper org={org}>{reader(false)}{reader(true)}</Wrapper>, el => el)
  t.after(() => view.unmount()); await settle()
  const box = view.el.querySelector<HTMLTextAreaElement>('.desk-body textarea')!
  await stage(view.el.querySelector('.desk-body [data-object-nav="ticket"]')!, box)
  assert.equal(view.el.querySelector<HTMLTextAreaElement>('.standalone textarea')!.value, '')
  await right(view.el.querySelector('.standalone [data-object-nav="ticket"]')!)
  assert.equal(labels().includes('Mention') || labels().includes('Reply'), false)
  await inAct(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(3) })
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.desk-body .mail-reply-send')!.click(); await flush(8) })
  assert.deepEqual(sends[0]?.[4], { kind: 'work_item', org, slug: 'ticket' })
})
