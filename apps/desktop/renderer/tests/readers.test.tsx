// The document readers (docket several-instances-of-the-same-modal-team-slots-i).
// USER 2026-10-20 19:03:28Z (md184a546b2d7): "one class of reader; one global
// reader, one agent / project reader per agent or project, one team reader per
// agent or project team. if a document is already viewable from one, then
// bring it to the front, otherwise open a new one". 19:05:36Z (mcebcf541bac6):
// "if several ones could win, choose one arbitrarily in a consistent manner".
//
// The real canvas, its node menu and the shell's document pointer (`openDocAt`,
// the route every chip, card and reference shares), so the same file is the
// red run against the base, whose single agent gallery belonged to App.
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { flush, inAct, mountView } from './harness'
import { CurrentOrg } from '../src/popout'
import { forgetModalOpenCache, forgetModalPins, MODAL_OPEN_KEY, MODAL_PINS_KEY, modalPinKey,
  readModalOpen, readModalPins } from '../src/canvas/modalpin'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AgentNavProvider, useAgentNavRegistry } from '../src/canvas/agentnav'
import { readPinSurfaces, removePinSurface } from '../src/canvas/pinspace'
import { resetConvos } from '../src/convo'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const org = 'readers', noop = () => {}
const R = { x: 40, y: 50, w: 520, h: 360 }
const at = '2026-10-20T10:00:00Z'
const doc = (id: string, title: string) => ({ id, title, at })
const DOCS: Record<string, { node: string; title: string }> = {
  'w-1': { node: 'worker', title: 'Worker plan' }, 'w-2': { node: 'worker', title: 'Worker notes' },
  'r-1': { node: 'report', title: 'Report draft' }, 'i-1': { node: 'intern', title: 'Intern memo' },
  // a document no card lists: the opening has to fetch it to learn whose it is
  'x-1': { node: 'report', title: 'Old report' },
}
const PARENT: Record<string, string | null> = { worker: null, report: 'worker', intern: 'report' }
const under = (node: string, team: string) => { for (let n: string | null = node; n; n = PARENT[n] ?? null) if (n === team) return true; return false }

function setup(t: TestContext) {
  const oldFetch = globalThis.fetch
  resetConvos(); localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const one = url.pathname.match(/\/documents\/([^/]+)$/)
    if (one && DOCS[one[1]!]) {
      const d = DOCS[one[1]!]!
      return json({ id: one[1], node: d.node, title: d.title, body: `${d.title} body`, at })
    }
    if (/\/documents$/.test(url.pathname)) {
      const node = url.searchParams.get('node') ?? '', team = url.searchParams.get('team') === '1'
      const rows = Object.entries(DOCS).filter(([, d]) => !node || (team ? under(d.node, node) : d.node === node))
        .map(([id, d]) => ({ id, node: d.node, title: d.title, at, evicted: false, node_state: 'live', tier: 'sol' }))
      const locate = url.searchParams.get('locate') ?? ''
      return json({ documents: rows, total: rows.length, next_offset: null, offset: 0,
        ...(locate ? { located: rows.some(r => r.id === locate) ? locate : '' } : {}) })
    }
    if (/\/inbox$/.test(url.pathname)) return json({ pending: [], delivered: [], sent: [], next_cursor: null })
    return json({ ok: true, entries: [], items: [], documents: [], refs: [], live: [], pending_mail: [], watchdogs: [] })
  }) as typeof fetch
  t.after(async () => {
    for (const s of readPinSurfaces().filter(s => s.org === org)) removePinSurface(s.key)
    await inAct(async () => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() })
    resetConvos(); globalThis.fetch = oldFetch
  })
}

const agent = (id: string, parent: string | null, children: CanvasNode[], documents: ReturnType<typeof doc>[]) => ({
  id, title: id, generation: 1, state: 'live', tier: 'sol', kind: 'agent', parent, children, turns: [], documents,
  seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }) as unknown as CanvasNode
function fixture(): TreePayload {
  const intern = agent('intern', 'report', [], [doc('i-1', 'Intern memo')])
  const report = agent('report', 'worker', [intern], [doc('r-1', 'Report draft')])
  const worker = agent('worker', null, [report], [doc('w-2', 'Worker notes'), doc('w-1', 'Worker plan')])
  return { slug: org, name: org, roots: [worker], dirs: [], tiers: { sol: 2 }, audiences: [],
    credit_requests: [], audience_requests: [], audit: { live_nodes: 3, top_level_holds: 0, problems: [] },
    user_inbox_count: 0, max_top_grant: 1000, default_top_grant: 50 } as unknown as TreePayload
}
const flatten = (entries: MenuEntry[]): MenuItem[] =>
  entries.flatMap(e => e === 'sep' ? [] : [e, ...flatten(e.children ?? [])])

async function canvas(t: TestContext) {
  let registry: ReturnType<typeof useAgentNavRegistry>
  let openDoc: (id: string) => void = noop
  function Probe() { registry = useAgentNavRegistry(); return null }
  function Host() {
    const [docAt, setDocAt] = useState<string | null>(null)
    openDoc = setDocAt
    return <CurrentOrg.Provider value={org}><AgentNavProvider>
      <OrgCanvas tree={fixture()} slug={org} op={async () => ({})} toast={noop} mailEvt={null}
        openDocAt={docAt} onOpenDocHandled={() => setDocAt(null)} /><Probe />
    </AgentNavProvider></CurrentOrg.Provider>
  }
  const view = await mountView(<Host />, el => el)
  let mounted = true
  const unmount = async () => { if (mounted) { mounted = false; await view.unmount() } }
  t.after(unmount); await inAct(async () => { await flush(8) })
  return {
    unmount,
    select: async (id: string, label: string) => inAct(async () => {
      const entry = flatten(registry!.current!(id)).find(e => e.label === label)
      assert.ok(entry, `${id}: the menu offers ${label}`)
      entry!.onSelect(); await flush(10)
    }),
    /** a chip, card or reference opening this document */
    open: async (id: string) => inAct(async () => { openDoc(id); await flush(12) }),
  }
}
/** the readers on screen: [whose, the document selected in it] */
const readers = () => [...document.querySelectorAll('.gallery-agent')].map(s => {
  const label = s.getAttribute('aria-label') ?? ''
  const team = /and the agents under it/.test(s.querySelector('.desk-presented-head .dim')?.textContent ?? '')
  return [(team ? 'team:' : '') + label.replace('presented documents for ', ''),
    s.querySelector('.mailrow.on .mfrom')?.textContent ?? null]
}).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
const pinOf = (kind: string) => readModalPins()[modalPinKey(kind, org)]?.rect ?? null
function legacyGallery(target: string, team = false) {
  localStorage.setItem(MODAL_PINS_KEY, JSON.stringify({ [JSON.stringify([org, 'agent-gallery'])]: { rect: R, z: 0 } }))
  localStorage.setItem(MODAL_OPEN_KEY, JSON.stringify([{ kind: 'agent-gallery', org,
    restore: { agent: target, generation: 1, ...(team ? { team: true } : {}) } }]))
  forgetModalPins(); forgetModalOpenCache()
}

// ------------------------------------------------------------- coexistence
test('§1 two agents\' readers coexist: the second opens beside the pinned first', async t => {
  setup(t); legacyGallery('worker')
  const c = await canvas(t)
  assert.deepEqual(readers().map(r => r[0]), ['worker'], 'the pinned reader is restored')
  await c.select('report', 'Presentations')
  assert.deepEqual(readers().map(r => r[0]), ['report', 'worker'])
  assert.deepEqual(pinOf('agent-gallery:worker'), R)
  assert.deepEqual(pinOf('agent-gallery:report'), { ...R, x: R.x + 28, y: R.y + 28 })
})

test('§2 an agent\'s reader and its team\'s reader are two readers', async t => {
  setup(t); legacyGallery('worker')
  const c = await canvas(t)
  await c.select('worker', 'Team presentations')
  assert.deepEqual(readers().map(r => r[0]), ['team:worker', 'worker'])
  // one class of reader: the team reader steps past the agent reader's window
  assert.deepEqual(pinOf('team-gallery:worker'), { ...R, x: R.x + 28, y: R.y + 28 })
  await c.select('worker', 'Team presentations'); await c.select('worker', 'Presentations')
  assert.deepEqual(readers().map(r => r[0]), ['team:worker', 'worker'], 'one of each, never two')
})

test('§3 a single team gallery record comes back as the team reader', () => {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  legacyGallery('worker', true)
  assert.deepEqual(readModalOpen(org).map(o => o.kind), ['team-gallery:worker'])
  assert.deepEqual(pinOf('team-gallery:worker'), R)
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
})

// ------------------------------------------------- which reader a document opens in
test('§4 a document an open reader can show brings that reader to the front, showing it', async t => {
  setup(t); legacyGallery('worker')
  const c = await canvas(t)
  await c.open('w-1')
  assert.deepEqual(readers(), [['worker', 'Worker plan']], 'the open reader shows it; no second reader')
  await c.open('w-2')
  assert.deepEqual(readers(), [['worker', 'Worker notes']])
})

test('§5 a document no open reader can show opens its own agent\'s reader on it', async t => {
  setup(t); legacyGallery('worker')
  const c = await canvas(t)
  await c.open('r-1')
  assert.deepEqual(readers(), [['report', 'Report draft'], ['worker', readers()[1]?.[1] ?? null]])
  assert.equal(readers().length, 2)
})

test('§6 a team reader shows a document from anywhere under its node', async t => {
  setup(t)
  const c = await canvas(t)
  await c.select('worker', 'Team presentations')
  await c.open('i-1')
  assert.deepEqual(readers(), [['team:worker', 'Intern memo']], 'the team reader took it')
})

test('§7 several could show it: its own agent\'s reader before a team reader', async t => {
  setup(t)
  const c = await canvas(t)
  await c.select('worker', 'Team presentations')
  await c.select('report', 'Presentations')
  await c.open('r-1')
  const shown = Object.fromEntries(readers())
  assert.equal(shown['report'], 'Report draft', 'report\'s own reader shows it')
  assert.notEqual(shown['team:worker'], 'Report draft', 'the team reader was not the one')
})

test('§8 a document no card lists is fetched first, then opens in its agent\'s reader', async t => {
  setup(t)
  const c = await canvas(t)
  await c.open('x-1')
  assert.deepEqual(readers(), [['report', 'Old report']])
})

test('§9 the Team box in a pinned reader switches it to the team reader, in its place', async t => {
  setup(t); legacyGallery('worker')
  await canvas(t)
  const box = document.querySelector<HTMLInputElement>('.gallery-agent .gallery-team-check input')
  assert.ok(box, 'the reader\'s Team box')
  await inAct(async () => { box!.click(); await flush(10) })
  assert.deepEqual(readers().map(r => r[0]), ['team:worker'], 'one reader, now the team\'s')
  assert.deepEqual(pinOf('team-gallery:worker'), R, 'where the agent reader was')
})

for (const team of [false, true]) {
  test(`a pinned ${team ? 'team' : 'agent'} reader restores its selected document after another reader opens`, async t => {
    setup(t); legacyGallery('worker', team)
    const c = await canvas(t)
    const selected = [...document.querySelectorAll<HTMLElement>('.gallery-agent .mailrow')]
      .find(row => row.querySelector('.mfrom')?.textContent === 'Worker notes')
    assert.ok(selected, 'the older document is available in the first reader')
    await inAct(async () => {
      selected.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await flush(10)
    })
    const first = team ? 'team:worker' : 'worker'
    assert.equal(Object.fromEntries(readers())[first], 'Worker notes', 'the control selects the document')
    await c.select('report', team ? 'Team presentations' : 'Presentations')
    assert.equal(readers().length, 2, 'a second pinned reader is open')
    const marker = readModalOpen(org).find(r => r.kind === `${team ? 'team-gallery' : 'agent-gallery'}:worker`)
    await c.unmount()
    forgetModalOpenCache(); forgetModalPins()
    await canvas(t)
    assert.equal(Object.fromEntries(readers())[first], 'Worker notes', 'the lifecycle restores the document on screen')
    assert.equal(marker?.restore?.document, 'w-2', 'opening the second reader did not erase the first selection')
    const current = document.querySelector<HTMLElement>('[aria-label="presented documents for worker"] .mailrow.on')
    assert.ok(current)
    await inAct(async () => {
      current.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await flush(10)
    })
    assert.equal(Object.fromEntries(readers())[first], null, 'reporting a deselection must not reopen a default document')
  })
}
