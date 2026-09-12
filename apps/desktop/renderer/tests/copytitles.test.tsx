// Every object renderer is catalogued in docs/copy-title-surfaces.md. These
// tests press real renderer objects and select the real shared menu item.
import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import { JSDOM } from 'jsdom'
import { ObjectMenuBoundary, useContextMenu } from '../src/canvas/contextmenu'
import { AgentDirectoryProvider, AgentName } from '../src/canvas/identity'
import { EyeDesk, NodeSquare } from '../src/canvas/cards'
import { DeskChat, LineagePanel, NavChip, PendingMailRow } from '../src/canvas/desk'
import { NodeConfig, PilePicker } from '../src/canvas/modals'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AgentDocketView, buildNodeFacts, DocketModal } from '../src/canvas/docket'
import { AgentGalleryModal, AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { MailList, NodeInboxModal } from '../src/canvas/mail'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { AskCard } from '../src/canvas/asks'
import { PinFrame, forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import { PinLayer, PinnedPlaceholder, addPin, forgetPins, readPins } from '../src/canvas/pins'
import { CurrentOrg } from '../src/popout'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import type { RefWorld } from '../src/canvas/reflinks'
import { linkifyRefs, RefMdBody } from '../src/canvas/refmd'
import { buildMentionIndex, WorkRefText } from '../src/canvas/workrefs'
import { md, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, WorkItem } from '../src/types'
import { resetConvos } from '../src/convo'

const noop = () => {}
const BAD = () => assert.fail('copy activated the underlying object')
const noOp = async () => { BAD(); return {} as never }
const W = window as unknown as Window & typeof globalThis
const TITLE = '  Repair “résumé” & <title>\nsecond line  '
const agent = (id = 'worker', extra = {}): CanvasNode => ({
  id, title: 'Different title', tier: 'haiku', model_id: 'haiku', state: 'live',
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 0, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  ...extra,
} as unknown as CanvasNode)
const tree = (roots = [agent()]): TreePayload => ({
  slug: 'mine', name: 'mine', roots, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, credit_requests: [], tiers: { haiku: 1 }, audiences: [],
  cost_usd_total: 0, audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, fable_lock: null, spend_frozen: false, storage_blocked: false,
  audience_requests: [], org_inbox: null, net: null, asks: [],
} as unknown as TreePayload)
const ticket = (extra: Partial<WorkItem> = {}): WorkItem => ({
  slug: 'repair-resume', title: TITLE, rev: 1, kind: 'code', objective: 'Description',
  status: 'in_progress', archived: false, owner: { node: 'worker', generation: 0 },
  owner_current: true, owner_state: 'live', reviewer: null, participants: [],
  at: '2026-09-10T00:00:00Z', updated_at: '2026-09-11T00:00:00Z',
  docket_at: '2026-09-11T00:00:00Z', done_so_far: [], working_on_next: [],
  effective_attention: false, attention_sources: [], acceptance: [], dismissals: [],
  questions: [], dependencies: [], evidence: [], delivery: null, history: [], ...extra,
} as WorkItem)

async function context(el: Element) {
  assert.ok(el, 'the inventoried surface rendered')
  const win = el.ownerDocument.defaultView as typeof W
  const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  await inAct(() => { el.dispatchEvent(event) })
  await flush(2)
  return event.defaultPrevented
}
async function copy(el: Element, label: string) {
  assert.equal(await context(el), true)
  const doc = el.ownerDocument
  const choices = [...doc.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
  assert.equal(choices.filter(b => b.textContent === label).length, 1, 'one copy entry')
  const button = choices.find(b => b.textContent === label)!
  await inAct(() => {
    // Portal events must not start a drag or bubble to a row's activation.
    button.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    button.click()
  })
  await flush(3)
  assert.equal(doc.querySelector('.ctxmenu'), null, 'copy closes only its menu')
}

type Rig = { mount: (node: ReactElement) => Promise<Awaited<ReturnType<typeof mountView<HTMLElement>>>>;
  server: FakeServer; writes: string[]; feedback: string[][] }
function ui(name: string, run: (rig: Rig) => Promise<void>) {
  test(name, async () => {
    useFakeClock(); localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); resetConvos()
    window.getSelection()?.removeAllRanges()
    const savedFetch = globalThis.fetch
    const savedClip = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writes: string[] = [], feedback: string[][] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: (text: string) => { writes.push(text); return Promise.resolve() } } })
    const server = new FakeServer(); installFetch(server)
    const views: { unmount: () => Promise<void> }[] = []
    try {
      await run({ server, writes, feedback, mount: async node => {
        const v = await mountView(<CurrentOrg.Provider value="mine">
          <ObjectMenuBoundary toast={lines => feedback.push(lines ?? [])}>{node}</ObjectMenuBoundary>
        </CurrentOrg.Provider>, h => h)
        views.push(v); await flush(); return v
      } })
    } finally {
      for (const v of views.reverse()) await v.unmount()
      globalThis.fetch = savedFetch
      if (savedClip) Object.defineProperty(navigator, 'clipboard', savedClip)
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard
      realClock()
    }
  })
}

for (const variant of ['linked', 'own desk', 'read only', 'prefix', 'archived generation']) {
  ui(`AgentName: ${variant} copies only its exact name and keeps navigation idle`, async ({ mount, writes }) => {
    const id = variant === 'archived generation' ? 'worker@12' : 'worker'
    const v = await mount(<AgentName id={id} tier="haiku" onFocus={variant === 'read only' ? undefined : BAD}
      prefix={variant === 'prefix' ? '@' : undefined} atDestination={variant === 'own desk'} />)
    await copy(v.el.querySelector('.cc-name')!, 'Copy agent name')
    await copy(v.el.querySelector('.tier')!, 'Copy agent name')
    assert.deepEqual(writes, [id, id])
  })
}

for (const variant of ['normal', 'mini', 'map', 'archived', 'unrecoverable', 'bearer', 'public']) {
  ui(`Canvas card: ${variant}`, async ({ mount, writes }) => {
    const n = agent(variant === 'bearer' ? 'worker@3' : 'worker', {
      state: ['archived', 'unrecoverable'].includes(variant) ? variant : 'live',
      ...(variant === 'bearer' ? { bearer_state: 'consultable', isBearerOf: 'worker' } : {}),
    })
    const v = await mount(<NodeSquare node={n} pos={{ x: 0, y: 0 }}
      lod={variant === 'mini' ? 'mini' : 'norm'} focused={false} dragging={false} isDrop={false}
      seats={{ haiku: 1 }} map={new Map([[n.id, n]])} op={noOp} slug="mine" toast={noop}
      pxc={1} zoom={1} onSpawn={BAD} onConfig={BAD} onInbox={BAD} onLineage={BAD}
      onRecenter={BAD} onMailLink={BAD} onWorkLink={BAD} onDragStart={BAD}
      onDragMove={BAD} onDragEnd={BAD} onDragCancel={BAD} pub={variant === 'public'}
      mapMode={variant === 'map'} />)
    await copy(v.el.querySelector('.sq')!, 'Copy agent name')
    assert.deepEqual(writes, [n.id])
  })
}

ui('Focused desk, switchboard/pinned/mobile desk headers and jump cards', async ({ mount, writes }) => {
  const n = agent(), map = new Map([[n.id, n]])
  for (const bare of [false, true]) {
    const v = await mount(<DeskChat node={n} bare={bare} map={map} op={noOp} slug="mine"
      toast={noop} pub onJump={BAD} />)
    await copy(v.el.querySelector('.cc-head-left')!, 'Copy agent name')
  }
  const nav = await mount(<NavChip n={n} dir="down" onJump={BAD} />)
  await copy(nav.el.querySelector('.desk-nav-chip')!, 'Copy agent name')
  const placeholder = await mount(<PinnedPlaceholder id={n.id} onShow={BAD} />)
  await copy(placeholder.el.querySelector('.pin-placeholder')!, 'Copy agent name')
  assert.deepEqual(writes, ['worker', 'worker', 'worker', 'worker'])
})

ui('Lineage rows and live/retired pile picker entries', async ({ mount, writes }) => {
  const past = agent('worker@2', { state: 'archived', bearer_state: 'archived', generation: 2 })
  const n = agent('worker', { lineage: [past] }), map = new Map([[n.id, n], [past.id, past]])
  const lineage = await mount(<LineagePanel node={n} op={noOp} slug="mine" map={map} close={BAD} onFocusAgent={BAD} />)
  await copy(document.querySelector('.lineage-panel .lin-row')!, 'Copy agent name')
  await lineage.unmount()
  for (const kind of ['a', 'c'] as const) {
    const pile = await mount(<PilePicker pile={{ kind, list: [n.id, past.id], front: n.id } as never}
      map={map} onPick={BAD} close={BAD} />)
    const rows = [...document.querySelectorAll('.pile-row')]
    assert.equal(rows.length, 2)
    for (const row of rows) await copy(row, 'Copy agent name')
    await pile.unmount()
  }
  assert.equal(writes.filter(s => s === 'worker@2').length, 3)
  assert.equal(writes.filter(s => s === 'worker').length, 2)
})

ui('Agents List live and archived rows leave the camera and selection untouched', async ({ mount, writes }) => {
  const v = await mount(<OrgCanvas tree={tree([agent(), agent('gone', { state: 'archived' })])}
    slug="mine" op={noOp} toast={noop} mailEvt={null} />)
  await inAct(() => (v.el.querySelector('.tray-toggle') as HTMLElement).click())
  await flush(3)
  await inAct(() => (document.querySelector('.tray-arch') as HTMLElement).click())
  await advance(800, 50); await flush()
  const before = (v.el.querySelector('.space') as HTMLElement).style.transform
  const rows = [...document.querySelectorAll('.tray-row')]
  assert.equal(rows.length, 2)
  for (const row of rows) await copy(row, 'Copy agent name')
  await advance(800, 50)
  assert.equal((v.el.querySelector('.space') as HTMLElement).style.transform, before)
  assert.deepEqual(writes.sort(), ['gone', 'worker'])
  await context(rows[0]!)
  await inAct(() => W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  assert.equal(document.querySelector('.ctxmenu'), null)
  assert.ok(document.querySelector('.tray-row'), 'Escape closes the menu before the list')
})

for (const kind of ['node-config', 'lineage', 'node-inbox', 'agent-docket', 'agent-gallery']) {
  ui(`Agent-scoped modal bar: ${kind}`, async ({ mount, writes }) => {
    const n = agent('worker@2'), map = new Map([[n.id, n]]), common = { slug: 'mine', toast: noop, close: BAD }
    const fixture = kind === 'node-config' ? <NodeConfig {...common} node={n} map={map} tree={tree([n])} op={noOp} />
      : kind === 'lineage' ? <LineagePanel {...common} node={n} map={map} op={noOp} />
        : kind === 'node-inbox' ? <NodeInboxModal {...common} node={n} onFocusAgent={BAD} />
          : kind === 'agent-docket' ? <AgentDocketModal {...common} nid={n.id} tree={tree([n])}
              refs={{ world: { org: 'mine' }, onOpen: BAD }} />
            : <AgentGalleryModal {...common} nid={n.id} node={n} />
    await mount(fixture)
    await copy(document.querySelector('.modalpin-bar')!, 'Copy agent name')
    const heading = document.querySelector('h3[data-copy-agent-name], .gallery-head [data-copy-agent-name]')
    if (heading) await copy(heading, 'Copy agent name')
    assert.ok(writes.every(s => s === 'worker@2'))
    assert.ok(document.querySelector('.settings'), 'surface remains open')
  })
}

ui('Switchboard tabs retain their open state while their agent name is copied', async ({ mount, writes }) => {
  const n = agent('worker', { parent: USER })
  const v = await mount(<EyeDesk map={new Map([[n.id, n]])} op={noOp} slug="mine" toast={noop}
    pub eyeW={900} posX={() => 0} onJump={BAD} onMailLink={BAD} onWorkLink={BAD} />)
  const tab = v.el.querySelector('.eye-tab')!
  const before = tab.className
  await copy(tab, 'Copy agent name')
  assert.equal(tab.className, before)
  assert.deepEqual(writes, ['worker'])
})

ui('Mail list, reading pane, and transcript sender identities preserve the message', async ({ mount, writes }) => {
  const v = await mount(<MailList org="mine" delivered={[{ id: 'm1', from: 'worker', to: 'receiver',
    at: '2026-09-10T00:00:00Z', kind: 'message', body: 'Message body' }]}
    hasAgent={() => true} tierOf={() => 'haiku'} onFocusAgent={BAD} />)
  const row = v.el.querySelector('.mailrow') as HTMLElement
  await copy(row.querySelector('.cc-name')!, 'Copy agent name')
  assert.equal(row.classList.contains('on'), false)
  await inAct(() => row.click()); await flush(3)
  await copy(v.el.querySelector('.mailer-read .cc-name')!, 'Copy agent name')
  assert.ok(row.classList.contains('on'))
  const transcript = await mount(<AgentDirectoryProvider value={{ resolve: () => ({ tier: 'haiku' }), onFocus: BAD }}>
    <PendingMailRow m={{ id: 'p1', from: 'worker', body: 'Incoming message', at: '2026-09-10T00:00:00Z' }}
      slug="mine" nid="receiver" world={{ org: 'mine' }} />
  </AgentDirectoryProvider>)
  await copy(transcript.el.querySelector('.cc-name')!, 'Copy agent name')
  assert.deepEqual(writes, ['worker', 'worker', 'worker'])
})

for (const scope of ['agent', 'org']) {
  ui(`Presentation gallery ${scope}: publisher in list and reader`, async ({ mount, server, writes }) => {
    server.documents = [{ id: 'd1', node: 'worker', node_state: 'live', tier: 'haiku',
      title: 'A document, not a ticket', at: '2026-09-10T00:00:00Z', format: 'markdown', evicted: false }]
    const v = await mount(scope === 'agent'
      ? <AgentGalleryView slug="mine" nid="worker" toast={noop} onFocusAgent={BAD} />
      : <DocGalleryModal slug="mine" toast={noop} close={BAD} onFocusAgent={BAD} />)
    const row = document.querySelector('.doc-gallery-row') as HTMLElement
    await copy(row.querySelector('.l2')!, 'Copy agent name')
    assert.equal(row.classList.contains('on'), false)
    await inAct(() => row.click()); await flush(3)
    await copy(document.querySelector('.doc-pane-meta-row .cc-name')!, 'Copy agent name')
    assert.deepEqual(writes, ['worker', 'worker'])
    await context(row)
    assert.equal([...document.querySelectorAll('.ctxmenu button')].some(b => b.textContent === 'Copy ticket title'), false)
  })
}

for (const status of ['open', 'answered']) {
  ui(`Question card issuer: ${status}`, async ({ mount, writes }) => {
    const v = await mount(<AskCard ask={{ id: 'q1', node: 'worker', kind: 'question', status,
      questions: [{ question: 'Choose?', options: [] }] } as never} slug="mine" toast={noop} />)
    await copy(v.el.querySelector('[data-copy-agent-name]')!, 'Copy agent name')
    assert.deepEqual(writes, ['worker'])
  })
}

ui('Pinned agent title keeps its pin position and does not jump or unpin', async ({ mount, writes }) => {
  forgetPins('mine'); addPin('mine', 'worker', { x: 10, y: 10, w: 400, h: 300 })
  addPin('mine', 'other', { x: 30, y: 30, w: 400, h: 300 })
  const n = agent(), map = new Map([[n.id, n], ['other', agent('other')]])
  const viewport = { current: null as HTMLDivElement | null }
  await mount(<div ref={el => { viewport.current = el }}><PinLayer slug="mine" map={map}
    viewportRef={viewport} targetOf={() => null} op={noOp} toast={noop} pub maxTop={100} pxc={1}
    onMailLink={BAD} onWorkLink={BAD} onOpenDoc={BAD} onLineage={BAD} onConfig={BAD}
    onJump={BAD} onShowOnCanvas={BAD} /></div>)
  const before = structuredClone(readPins('mine'))
  await copy(document.querySelector('.pinwin[data-id="worker"] .pinwin-title')!, 'Copy agent name')
  assert.deepEqual(readPins('mine'), before)
  assert.deepEqual(writes, ['worker'])
})

for (const scope of ['org', 'agent']) {
  ui(`Docket ${scope}: active, nested, archived, backlog, detail title, slug and actors`, async ({ mount, server, writes }) => {
    const items = [ticket(), ticket({ slug: 'child', title: 'Child <&> title', parent: 'repair-resume' } as Partial<WorkItem>),
      ticket({ slug: 'old', title: 'Archived title', archived: true, status: 'done' }),
      ticket({ slug: 'later', title: 'Backlog title', status: 'backlogged' })]
    server.workItems = items.filter(it => !it.archived && it.status !== 'backlogged')
    server.workArchived = [items[2]]; server.workBacklogged = [items[3]]
    const fixture = scope === 'org'
      ? <DocketModal slug="mine" tree={tree()} toast={noop} close={BAD} onFocusAgent={BAD} />
      : <AgentDocketView slug="mine" nid="worker" mine={items} showArchived facts={buildNodeFacts(tree().roots)}
          toast={noop} onFocusAgent={BAD} refs={{ world: { org: 'mine' }, onOpen: BAD }} />
    await mount(fixture); await flush(5)
    for (const label of [...document.querySelectorAll('label')]) {
      if (/show (archived|backlogged)/i.test(label.textContent ?? '')) {
        const input = label.querySelector<HTMLInputElement>('input')
        if (input && !input.checked) await inAct(() => input.click())
      }
    }
    await flush(5)
    const rows = [...document.querySelectorAll<HTMLElement>('.docket-row')]
    assert.equal(rows.length, 4, 'all four ticket variants rendered')
    for (const row of rows) {
      const expected = items.find(it => it.slug === row.querySelector('.docket-rowname')?.textContent)!.title
      await copy(row, 'Copy ticket title')
      assert.equal(writes.at(-1), expected)
      assert.equal(row.classList.contains('on'), false)
    }
    await copy(rows[0]!.querySelector('.docket-actor-name')!, 'Copy agent name')
    assert.equal(writes.at(-1), 'worker', 'the inner agent has its own copy identity')
    await inAct(() => rows[0]!.click()); await flush(4)
    for (const selector of ['.docket-pane-head', '.docket-slug-text']) {
      const el = document.querySelector(selector)!
      await copy(el, 'Copy ticket title')
      assert.equal(writes.at(-1), rows[0]!.title)
      assert.ok(document.querySelector('.docket-pane-head'))
    }
  })
}

ui('React, Markdown and bare references copy authoritative names/titles, never slug labels', async ({ mount, writes }) => {
  const world: RefWorld = { org: 'mine', items: new Map([['repair-resume', 'repair-resume']]),
    itemTitles: new Map([['repair-resume', TITLE]]), agents: new Map([['worker@2', 'worker@2']]) }
  for (const open of [BAD, undefined]) {
    const v = await mount(<>
      <RefChip r={resolveRef({ kind: 'agent', org: 'mine', id: 'worker@2' }, world)} onOpen={open} />
      <RefChip r={resolveRef({ kind: 'item', org: 'mine', id: 'repair-resume' }, world)} onOpen={open} />
      <RefMdBody html={md('@agent:mine/worker@2 and @item:mine/repair-resume')} world={world} onOpen={open} />
      <WorkRefText text="repair-resume" index={buildMentionIndex([ticket()])} onPick={open} />
    </>)
    for (const el of v.el.querySelectorAll('[data-copy-agent-name]')) await copy(el, 'Copy agent name')
    for (const el of v.el.querySelectorAll('[data-copy-ticket-title]')) await copy(el, 'Copy ticket title')
  }
  assert.equal(writes.filter(s => s === 'worker@2').length, 4)
  assert.equal(writes.filter(s => s === TITLE).length, 6)
  assert.equal(writes.includes('repair-resume'), false)
})

ui('Reference copy metadata follows title changes, including an empty recorded title', async ({ mount, writes }) => {
  const world: RefWorld = { org: 'mine', items: new Map([['repair-resume', 'repair-resume']]) }
  const v = await mount(<RefMdBody className="body" html={md('@item:mine/repair-resume')}
    world={world} onOpen={BAD} />)
  assert.equal(await context(v.el.querySelector('.ref-item')!), false)
  for (const title of ['', TITLE, 'Renamed title']) {
    const next = { ...world, itemTitles: new Map([['repair-resume', title]]) }
    linkifyRefs(v.el.querySelector('.body')!, next)
    await copy(v.el.querySelector('.ref-item')!, 'Copy ticket title')
    assert.equal(writes.at(-1), title)
  }
  // A panel without a navigation route still knows what it is displaying.
  const readOnly = { ...world, itemTitles: new Map([['repair-resume', TITLE]]), handles: new Set<never>() }
  const r = resolveRef({ kind: 'item', org: 'mine', id: 'repair-resume' }, readOnly)
  assert.equal(r.outcome, 'elsewhere')
  const chip = await mount(<RefChip r={r} />)
  await copy(chip.el.querySelector('.ref-item')!, 'Copy ticket title')
  assert.equal(writes.at(-1), TITLE)
})

function MenuObject() {
  const menu = useContextMenu()
  return <div data-copy-agent-name="worker" onContextMenu={e => menu.open(e, [{ label: 'Activate', onSelect: BAD }])}>
    <span className="text">worker</span><input defaultValue="edit" />
    <a href="https://example.invalid">link</a>{menu.node}
  </div>
}
ui('Native edit/link/selected-text menus and unknown-title references are preserved', async ({ mount, writes }) => {
  const v = await mount(<><MenuObject />
    <RefChip r={resolveRef({ kind: 'item', org: 'mine', id: 'unknown' }, { org: 'mine' })} />
    <NavChip n={agent(USER)} dir="up" onJump={BAD} /></>)
  for (const selector of ['input', 'a', '.ref-item', '.desk-nav-chip']) {
    assert.equal(await context(v.el.querySelector(selector)!), false)
  }
  const range = document.createRange(); range.selectNodeContents(v.el.querySelector('.text')!)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  assert.equal(await context(v.el.querySelector('.text')!), false)
  window.getSelection()!.removeAllRanges()
  await copy(v.el.querySelector('.text')!, 'Copy agent name')
  assert.deepEqual(writes, ['worker'])
})

for (const unavailable of ['absent', 'no writeText', 'denied', 'throws']) {
  ui(`Clipboard failure: ${unavailable} reports failure without activating anything`, async ({ mount, feedback }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value:
      unavailable === 'absent' ? undefined : unavailable === 'no writeText' ? {} : {
        writeText: () => { if (unavailable === 'throws') throw Error('unavailable'); return Promise.reject(Error('denied')) },
      } })
    const v = await mount(<AgentName id="worker" onFocus={BAD} />)
    await copy(v.el.querySelector('.cc-name')!, 'Copy agent name')
    assert.deepEqual(feedback, [['could not copy — clipboard unavailable']])
  })
}

ui('Detached surface uses the child clipboard, menu, feedback and Escape stack', async ({ mount, writes, feedback }) => {
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const win = child.window as unknown as Window
  win.focus = noop; win.requestAnimationFrame = () => 1; win.cancelAnimationFrame = noop
  const childWrites: string[] = []
  Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: {
    writeText: (s: string) => { childWrites.push(s); return Promise.resolve() },
  } })
  const oldOpen = window.open, oldObserver = globalThis.MutationObserver
  window.open = (() => win) as typeof window.open
  globalThis.MutationObserver = child.window.MutationObserver
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {} })
  let v: Awaited<ReturnType<Rig['mount']>> | undefined
  try {
    v = await mount(<PinFrame kind="copy-detached" restore={{ agent: 'worker' }} title="worker"
      panel="settings" close={BAD}><AgentName id="worker" onFocus={BAD} /></PinFrame>)
    await inAct(() => (document.querySelector('[aria-label="Open in new window"]') as HTMLElement).click())
    await flush(10)
    const name = win.document.querySelector('.cc-name') as HTMLElement
    name.focus()
    await copy(name, 'Copy agent name')
    assert.equal(win.document.activeElement, name, 'focus returns in the owning window')
    assert.deepEqual(childWrites, ['worker']); assert.deepEqual(writes, [])
    assert.deepEqual(feedback, [['copied agent name']])
    await context(win.document.querySelector('.cc-name')!)
    await inAct(() => win.dispatchEvent(new child.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(win.document.querySelector('.ctxmenu'), null)
    assert.ok(win.document.querySelector('.settings'))
    await v.unmount()
  } finally {
    window.open = oldOpen; globalThis.MutationObserver = oldObserver
    Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: undefined })
    child.window.close()
  }
})
