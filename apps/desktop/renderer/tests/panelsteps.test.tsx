// Mounted pre-fix regression: selection, viewer, focus ownership and draft
// preservation on actual gallery/docket surfaces. No engine or live sends.
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import { compatibilityWorkFixture } from './workcompat.fixture'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { AgentDocketView, buildNodeFacts, DocketModal } from '../src/canvas/docket'
import type { DocRow } from '../src/api'
import type { AskInfo, TreePayload, WorkItem } from '../src/types'

type Surface = 'org-docs' | 'agent-docs' | 'org-work' | 'agent-work'
const surfaces: Surface[] = ['org-docs', 'agent-docs', 'org-work', 'agent-work']
const noop = () => {}
const doc = (id: string, extra: Partial<DocRow> = {}): DocRow => ({
  id, title: id, node: 'worker', node_state: 'live', evicted: false,
  at: '2026-10-15T12:00:00Z', ...extra,
})
const item = (slug: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  slug, title: slug, objective: 'Detail ' + slug, rev: 1, kind: 'code', status: 'open',
  archived: false, owner: { node: 'worker', generation: 1 }, owner_current: true,
  owner_state: 'live', participants: [], questions: [], done_so_far: [], working_on_next: [],
  dependencies: [], evidence: [], history: [], dismissals: [], acceptance: [],
  attention_sources: [], effective_attention: false, manual_attention: null,
  at: '2026-10-15T12:00:00Z', updated_at: '2026-10-15T12:00:00Z',
  docket_at: '2026-10-15T12:00:00Z', ...extra,
} as WorkItem)
let sequence = 0
async function fixture(t: TestContext, surface: Surface, options: {
  blank?: boolean; foreign?: boolean; docs?: DocRow[]; items?: WorkItem[]; asks?: AskInfo[]
} = {}) {
  useFakeClock()
  const previous = globalThis.fetch
  const previousGroup = window.localStorage.getItem('orgtree.docket.group')
  const previousSort = window.localStorage.getItem('orgtree.docket.sort')
  window.localStorage.setItem('orgtree.docket.group', 'none')
  window.localStorage.setItem('orgtree.docket.sort', 'updated')
  const slug = 'panel-steps-' + ++sequence
  const documents = options.docs ?? ['alpha', 'beta', 'gamma'].map(id => doc(id))
  const items = options.items ?? ['alpha', 'beta', 'gamma'].map(id => item(id))
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200,
    headers: new Headers(), json: async () => body } as Response)
  globalThis.fetch = compatibilityWorkFixture(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/\/documents\/viewed$/.test(url) && init?.method === 'POST') return ok({ ok: true })
    assert.equal(init?.method === 'POST' || init?.method === 'DELETE', false, 'navigation never sends or deletes')
    const document = /\/documents\/([^/?]+)$/.exec(url)
    if (document) {
      const found = documents.find(row => row.id === document[1])
      return ok({ ...found, body: 'Body ' + document[1] })
    }
    if (url.includes('/documents')) return ok({ documents, total: documents.length, more: false })
    const work = /\/work-items\/([^/?]+)$/.exec(url)
    if (work) return ok({ item: items.find(row => row.slug === work[1]) ?? null })
    if (url.includes('/work-items')) return ok({ items, archived: [], backlogged: [],
      counts: { active: items.length, archived: 0, backlogged: 0 } })
    return ok({})
  }) as typeof fetch)
  let frame: HTMLIFrameElement | undefined
  let portalHost: HTMLDivElement | undefined
  if (options.foreign) {
    frame = document.createElement('iframe'); document.body.appendChild(frame)
    portalHost = frame.contentDocument!.createElement('div')
    frame.contentDocument!.body.appendChild(portalHost)
  }
  const scrolled: { name: string; block?: ScrollLogicalPosition }[] = []
  const prototypes = [window.HTMLElement.prototype]
  if (frame) prototypes.push((frame.contentWindow! as unknown as typeof window).HTMLElement.prototype)
  const oldScroll = prototypes.map(proto => proto.scrollIntoView)
  for (const proto of prototypes) proto.scrollIntoView = function (options) {
    scrolled.push({ name: this.querySelector('.mfrom')?.textContent ?? '',
      block: typeof options === 'object' ? options.block : undefined })
  }
  const blank = options.blank ? 'absent-selection' : undefined
  const body = surface === 'org-docs'
    ? <DocGalleryModal slug={slug} close={noop} toast={noop}
        jumpTo={blank ? { id: blank, seq: 1 } : undefined} />
    : surface === 'agent-docs'
      ? <AgentGalleryView slug={slug} nid="worker" toast={noop} initialDocument={blank} />
      : surface === 'org-work'
        ? <DocketModal slug={slug} close={noop} toast={noop} jumpTo={blank}
            tree={{ slug, name: slug, roots: [], asks: options.asks ?? [], epoch: 1, rev: 1 } as unknown as TreePayload} />
        : <AgentDocketView slug={slug} nid="worker" mine={items} facts={buildNodeFacts([])}
            toast={noop} onFocusAgent={noop} refs={{ world: { org: slug }, onOpen: noop }} />
  let unmount: (() => Promise<void>) | undefined
  t.after(async () => {
    try { await unmount?.() } finally {
      prototypes.forEach((proto, i) => { proto.scrollIntoView = oldScroll[i]! })
      frame?.remove(); globalThis.fetch = previous; realClock()
      for (const [key, value] of [['orgtree.docket.group', previousGroup], ['orgtree.docket.sort', previousSort]]) {
        if (value === null) window.localStorage.removeItem(key!)
        else window.localStorage.setItem(key!, value!)
      }
    }
  })
  const view = await mountView(portalHost ? createPortal(body, portalHost) : body, el => el)
  unmount = () => view.unmount()
  await inAct(async () => { await flush(15) })
  const el = portalHost ?? view.el
  const root = el.querySelector<HTMLElement>('.mailer')
  assert.ok(root, 'actual list and viewer mounted')
  const selector = surface.endsWith('docs') ? '.doc-gallery-row' : '.docket-row'
  const rows = () => [...root.querySelectorAll<HTMLElement>(selector)]
    .filter(row => !row.closest('[hidden]'))
  const name = (row: Element) => row.querySelector('.mfrom')?.textContent ?? ''
  const selected = () => root.querySelector(selector + '.on .mfrom')?.textContent ?? null
  const pick = async (id: string) => {
    const row = rows().find(row => name(row) === id)
    assert.ok(row, `click target ${id} exists`)
    if (selected() !== id) await inAct(async () => { row.click(); await flush(6) })
  }
  if (!options.blank) await pick(name(rows()[0]!))
  scrolled.length = 0
  return { el, root, rows, name, selected, pick, scrolled }
}
async function press(target: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  const owner = target.ownerDocument.defaultView as Window & typeof globalThis
  const event = new owner.KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true, ...extra })
  await inAct(async () => { target.dispatchEvent(event); await flush(8) })
  return event
}
async function type(box: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const owner = box.ownerDocument.defaultView as Window & typeof globalThis
  const proto = box.tagName === 'TEXTAREA' ? owner.HTMLTextAreaElement.prototype : owner.HTMLInputElement.prototype
  await inAct(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(box, value)
    box.dispatchEvent(new owner.Event('input', { bubbles: true }))
  })
}
async function choose(box: HTMLSelectElement, value: string) {
  const owner = box.ownerDocument.defaultView as Window & typeof globalThis
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(owner.HTMLSelectElement.prototype, 'value')!.set!.call(box, value)
    box.dispatchEvent(new owner.Event('change', { bubbles: true }))
    await flush(8)
  })
}

for (const surface of surfaces) {
  test(`${surface}: Alt arrows open adjacent rows, update viewer, clamp and scroll nearest`, async t => {
    const f = await fixture(t, surface)
    assert.equal(f.selected(), 'alpha')
    const event = await press(f.root, 'ArrowDown')
    assert.equal(f.selected(), 'beta', 'Alt+Down selects next visible row')
    assert.equal(event.defaultPrevented, true)
    assert.match(f.root.querySelector('.mailer-read')?.textContent ?? '', /(?:Body|Detail) beta/)
    assert.equal(f.root.getAttribute('tabindex'), '-1', 'row clicks have a focusable panel ancestor')
    assert.equal(f.scrolled.some(row => row.name === 'beta' && row.block === 'nearest'), true)
    await press(f.root, 'ArrowDown'); assert.equal(f.selected(), 'gamma')
    await press(f.root, 'ArrowDown'); assert.equal(f.selected(), 'gamma', 'no wrap at end')
    await press(f.root, 'ArrowUp'); await press(f.root, 'ArrowUp')
    assert.equal(f.selected(), 'alpha')
    await press(f.root, 'ArrowUp'); assert.equal(f.selected(), 'alpha', 'no wrap at beginning')
  })
  for (const direction of ['ArrowUp', 'ArrowDown']) test(`${surface}: ${direction} with no selected row opens the first`, async t => {
    const f = await fixture(t, surface, { blank: true })
    assert.equal(f.selected() === null, true, 'fixture has no selected list row')
    await press(f.root, direction)
    assert.equal(f.selected(), 'alpha')
  })
  test(`${surface}: editing, ask cards and consumed chords retain their owner`, async t => {
    const f = await fixture(t, surface)
    const doc = f.root.ownerDocument
    for (const tag of ['input', 'textarea', 'select', 'editable', 'ask', 'consumed']) {
      const host = doc.createElement('div')
      const control = doc.createElement(tag === 'editable' ? 'span' : tag === 'ask' || tag === 'consumed' ? 'button' : tag)
      if (tag === 'editable') host.setAttribute('contenteditable', 'true')
      if (tag === 'ask') host.className = 'askcard'
      if (tag === 'consumed') control.addEventListener('keydown', event => event.preventDefault())
      host.appendChild(control); f.root.appendChild(host)
      control.focus()
      const event = await press(control, 'ArrowDown')
      assert.equal(f.selected(), 'alpha', tag + ' retains selection')
      assert.equal(event.defaultPrevented, tag === 'consumed', tag + ' owns native/default behavior')
      host.remove()
    }
    const event = await press(f.root, 'ArrowDown', { altKey: false })
    assert.equal(event.defaultPrevented, false); assert.equal(f.selected(), 'alpha')
  })
  test(`${surface}: a reply draft survives Alt navigation after focus leaves the editor`, async t => {
    const f = await fixture(t, surface)
    const box = f.root.querySelector<HTMLTextAreaElement>('.mailer-read textarea')
    assert.ok(box, 'actual reply editor mounted')
    await type(box, 'Keep this unfinished reply')
    f.root.focus()
    await press(f.root, 'ArrowDown')
    assert.equal(f.selected(), 'alpha')
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('.mailer-read textarea')?.value, 'Keep this unfinished reply')
  })
  test(`${surface}: clearing a reply draft releases Alt navigation`, async t => {
    const f = await fixture(t, surface)
    const box = f.root.querySelector<HTMLTextAreaElement>('.mailer-read textarea')
    assert.ok(box, 'actual reply editor mounted')
    await type(box, 'An editable draft')
    await type(box, '')
    f.root.focus()
    await press(f.root, 'ArrowDown')
    assert.equal(f.selected(), 'beta', 'clearing the draft releases panel navigation')
  })
}

for (const batch of [false, true]) test(`org-work: blurred ${batch ? 'inactive batch-tab' : 'question-option'} draft survives navigation`, async t => {
  const questions = [{ question: 'Choose first', options: [{ label: 'Keep' }, { label: 'Change' }] },
    { question: 'Choose second', options: [{ label: 'Later' }, { label: 'Now' }] }]
  const ask: AskInfo = { id: 'panel-question', node: 'worker', status: 'open',
    at: '2026-10-15T12:00:00Z', ...(batch
      ? { kind: 'batch', tabs: questions.map((q, index) => ({ ...q, index, kind: 'question' as const })) }
      : { questions: [questions[0]!] }) }
  const f = await fixture(t, 'org-work', { asks: [ask], items: [item('alpha', {
    questions: [{ ask_id: ask.id, node: ask.node, rev: 1, at: ask.at,
      tabs: [{ index: 0, question: questions[0]!.question }] }],
  }), item('beta')] })
  const option = f.root.querySelector<HTMLButtonElement>('.askcard .ask-row')
  assert.ok(option, 'real question card and selectable option mounted')
  await inAct(async () => { option.click(); await flush(6) })
  if (batch) assert.equal(f.root.querySelector('.ask-q')?.textContent?.trim(), 'Choose second',
    'the selected answer belongs to a different tab after auto-advance')
  else assert.equal(f.root.querySelectorAll('.ask-row.on').length, 1)
  f.root.focus()
  const event = await press(f.root, 'ArrowDown')
  assert.equal(f.selected(), 'alpha')
  assert.equal(event.defaultPrevented, false, 'draft guard leaves the chord unconsumed')
  if (batch) {
    const first = f.root.querySelector<HTMLButtonElement>('.ask-tabbtn')!
    await inAct(async () => { first.click(); await flush(4) })
  }
  assert.equal(f.root.querySelector('.ask-row.on .ask-option-label')?.textContent, 'Keep')
})

for (const surface of ['agent-docs', 'agent-work'] as const) test(`${surface}: detached owner-document events select locally`, async t => {
  const f = await fixture(t, surface, { foreign: true })
  assert.equal(f.root.ownerDocument === document, false)
  await press(f.root, 'ArrowDown')
  assert.equal(f.selected(), 'beta')
  assert.equal(f.scrolled.some(row => row.name === 'beta' && row.block === 'nearest'), true)
})

for (const surface of ['org-work', 'agent-work'] as const) test(`${surface}: folded child tickets are skipped`, async t => {
  const f = await fixture(t, surface, { items: [item('parent'), item('child', { parent: 'parent' }), item('last')] })
  const parent = f.rows().find(row => f.name(row) === 'parent')!
  const fold = parent.querySelector<HTMLButtonElement>('button[aria-expanded]')
  assert.ok(fold, 'actual hierarchy fold button exists')
  await inAct(async () => { fold.click(); await flush(4) })
  assert.deepEqual(f.rows().map(f.name), ['parent', 'last'])
  await f.pick('parent'); await press(f.root, 'ArrowDown')
  assert.equal(f.selected(), 'last')
})

for (const surface of ['org-work', 'agent-work'] as const) {
  test(`${surface}: collapsed status groups are skipped in current rendered group order`, async t => {
    const f = await fixture(t, surface, { items: [item('alpha'),
      item('beta', { status: 'in_progress' }), item('gamma', { status: 'blocked', blocked_reason: 'fixture' })] })
    await choose(f.el.querySelector<HTMLSelectElement>('.docket-group-select')!, 'status')
    const selectedCategory = f.rows().find(row => f.name(row) === 'alpha')?.closest('.docket-section')
    assert.ok(selectedCategory, 'the selected Open category exists')
    const toggle = selectedCategory.querySelector<HTMLButtonElement>('.docket-category-toggle')!
    await inAct(async () => { toggle.click(); await flush(6) })
    const names = f.rows().map(f.name)
    assert.equal(names.includes('alpha'), false, 'selected category really folded')
    assert.equal(names.length, 2, 'other categories remain visible')
    await press(f.root, 'ArrowDown')
    assert.equal(f.selected(), names[0], 'hidden selection restarts at first displayed category')
  })
  test(`${surface}: a search selects only matching rows in the active sort order`, async t => {
    const f = await fixture(t, surface)
    const box = f.el.querySelector<HTMLInputElement>('.docket-search input[type="search"]')!
    await type(box, 'gamma'); await inAct(async () => { await flush(10) })
    assert.deepEqual(f.rows().map(f.name), ['gamma'])
    await press(f.root, 'ArrowDown')
    assert.equal(f.selected(), 'gamma')
  })
}

test('agent-work: keyboard steps across the virtualized viewport boundary', async t => {
  const items = Array.from({ length: 120 }, (_, i) => item('ticket-' + String(i).padStart(3, '0')))
  const f = await fixture(t, 'agent-work', { items })
  assert.equal(f.rows().length < items.length, true, 'fixture actually uses a bounded DOM window')
  const lastMounted = f.name(f.rows().at(-1)!)
  const next = items[items.findIndex(row => row.slug === lastMounted) + 1]!.slug
  await f.pick(lastMounted); f.scrolled.length = 0
  await press(f.root, 'ArrowDown')
  assert.equal(f.selected(), next, 'next eligible row is mounted and opened')
  assert.equal(f.scrolled.some(row => row.name === next && row.block === 'nearest'), true)
})

test('org-docs: visible hired/retired grouping controls keyboard order', async t => {
  const f = await fixture(t, 'org-docs', { docs: [doc('retired', { node_state: 'archived' }), doc('alpha'), doc('beta')] })
  assert.deepEqual(f.rows().map(f.name), ['alpha', 'beta'])
  await press(f.root, 'ArrowDown'); assert.equal(f.selected(), 'beta', 'hidden retired row is skipped')
  const toggle = f.el.querySelector<HTMLInputElement>('.gallery-showretired input')!
  await inAct(async () => { toggle.click(); await flush(4) })
  assert.deepEqual(f.rows().map(f.name), ['alpha', 'beta', 'retired'])
  await press(f.root, 'ArrowDown'); assert.equal(f.selected(), 'retired')
})
