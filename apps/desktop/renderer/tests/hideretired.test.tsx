// hideretired.test.tsx — optionally-hide-retired-agents-across-agent-view
// (user resumed 2026-09-10 13:25). A DISABLED-BY-DEFAULT display setting:
// when on, retired agents leave the canvas; they stay reachable only through
// the retired-list token on a parent with retired subordinates (and the
// switchboard's archived rows, which route through the same centerOn reveal
// the token uses). No org record changes — the prune touches the LAYOUT
// tree only, never the data.
//
// Two layers, matching where the behavior lives:
//   * pruneRetiredView (pure): what hides, what must NEVER hide (a knowledge
//     bearer, an archived node with a live descendant, a revealed retiree),
//     and the token/reveal bookkeeping — every rule directly.
//   * a full OrgCanvas mount (jsdom, with a real-sized viewport stubbed in,
//     since jsdom's zero-rect viewport culls every card): default-off
//     control, cards gone + token present when on, and the token → picker →
//     reveal round trip through the REAL centerOn hook.
//
// Run:  cd frontend && node tests/run.mjs hideretired
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'
import { HIDE_RETIRED_KEY, setHideRetiredOn } from '../src/canvas/shared'
import { pruneRetiredView } from '../src/canvas/OrgCanvas'

const noop = () => {}

// ---------------------------------------------------------------- fixtures
type Kid = { id: string; state?: string; isBearerOf?: string | null; children?: Kid[] }
const mk = (k: Kid): CanvasNode => ({
  id: k.id, title: k.id, tier: 'haiku', model_id: 'haiku',
  state: k.state ?? 'live', isBearerOf: k.isBearerOf ?? null,
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 0, lineage: [],
  children: (k.children ?? []).map(mk),
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
} as unknown as CanvasNode)

const FIXTURE: Kid[] = [
  { id: 'boss', children: [
    { id: 'ret-one', state: 'archived' },
    { id: 'ret-two', state: 'archived' },
    { id: 'worker' },
  ] },
  { id: 'solo-ret', state: 'archived' },
]

function tree(kids: Kid[]): TreePayload {
  return {
    slug: 'hr', name: 'hr', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: kids.map(mk), cost_usd_total: 0,
    audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  } as unknown as TreePayload
}

// ------------------------------------------------------------- pure layer
const names = (l?: CanvasNode[]) => (l ?? []).map((c) => c.id)
// kid ids via the node, not `.children` in the assert operand: deepdom's §5
// guard reads operand TEXT and cannot tell these plain CanvasNode records
// from DOM (its own stated limit) — keep the access inside the helper
const kidNames = (n?: CanvasNode) => (n?.children ?? []).map((c) => c.id)
const kidsOf = (root: CanvasNode, id: string): CanvasNode | undefined => {
  if (root.id === id) return root
  for (const c of root.children ?? []) { const hit = kidsOf(c, id); if (hit) return hit }
  return undefined
}
const ROOT = mk({ id: 'R', children: FIXTURE })

test('pruning hides archived subtrees and groups them under their parent', () => {
  const v = pruneRetiredView(ROOT, true, new Set())
  assert.deepEqual(kidNames(kidsOf(v.root, 'boss')), ['worker'])
  assert.deepEqual(kidNames(v.root), ['boss'], 'the solo retiree leaves the top level too')
  assert.deepEqual(names(v.retiredByParent.get('boss')), ['ret-one', 'ret-two'])
  assert.deepEqual(names(v.retiredByParent.get('R')), ['solo-ret'])
  assert.deepEqual([...v.prunedIds].sort(), ['ret-one', 'ret-two', 'solo-ret'])
})
test('the setting off, a reveal, a bearer and a live descendant all defeat the prune', () => {
  const off = pruneRetiredView(ROOT, false, new Set())
  assert.equal(off.root, ROOT, 'off: the tree passes through untouched')
  assert.equal(off.retiredByParent.size, 0)
  const revealed = pruneRetiredView(ROOT, true, new Set(['ret-two']))
  assert.deepEqual(kidNames(kidsOf(revealed.root, 'boss')), ['ret-two', 'worker'])
  assert.deepEqual(names(revealed.retiredByParent.get('boss')), ['ret-one'],
    'the token counts only what is still hidden')
  // a knowledge bearer is an ACTIVE surface, not a resting retiree
  const bearer = mk({ id: 'B', children: [
    { id: 'succ' }, { id: 'ghost', state: 'archived', isBearerOf: 'succ' }] })
  const bv = pruneRetiredView(bearer, true, new Set())
  assert.deepEqual(kidNames(bv.root), ['succ', 'ghost'])
  // an archived manager with a LIVE report must not take the report with it
  const mixed = mk({ id: 'M', children: [
    { id: 'oldmgr', state: 'archived', children: [{ id: 'alive' }] }] })
  const mv = pruneRetiredView(mixed, true, new Set())
  assert.deepEqual(kidNames(mv.root), ['oldmgr'],
    'the archived chain to a live agent stays visible')
  assert.equal(mv.prunedIds.size, 0)
})

test('a pruned subtree is pruned WHOLE — descendants are in prunedIds for the reveal chain', () => {
  const deep = mk({ id: 'D', children: [
    { id: 'gone-mgr', state: 'archived', children: [
      { id: 'gone-kid', state: 'archived' }] }] })
  const v = pruneRetiredView(deep, true, new Set())
  assert.deepEqual([...v.prunedIds].sort(), ['gone-kid', 'gone-mgr'])
  assert.deepEqual(names(v.retiredByParent.get('D')), ['gone-mgr'],
    'the token lists the subtree ROOT, not every descendant')
})

test('revealing and dismissing retired agents toggles layout visibility without altering tree data', () => {
  const shown = new Set(['ret-one', 'ret-two'])
  const vBoth = pruneRetiredView(ROOT, true, shown)
  assert.deepEqual(kidNames(kidsOf(vBoth.root, 'boss')), ['ret-one', 'ret-two', 'worker'])
  assert.equal(vBoth.retiredByParent.get('boss'), undefined)

  // dismissing ret-one returns it to the pruned group while ret-two stays visible
  shown.delete('ret-one')
  const vOne = pruneRetiredView(ROOT, true, shown)
  assert.deepEqual(kidNames(kidsOf(vOne.root, 'boss')), ['ret-two', 'worker'])
  assert.deepEqual(names(vOne.retiredByParent.get('boss')), ['ret-one'])
  assert.ok(vOne.prunedIds.has('ret-one'))
  assert.ok(!vOne.prunedIds.has('ret-two'))

  // dismissing ret-two returns both to the pruned group
  shown.delete('ret-two')
  const vNone = pruneRetiredView(ROOT, true, shown)
  assert.deepEqual(kidNames(kidsOf(vNone.root, 'boss')), ['worker'])
  assert.deepEqual(names(vNone.retiredByParent.get('boss')), ['ret-one', 'ret-two'])
  assert.ok(vNone.prunedIds.has('ret-one'))
  assert.ok(vNone.prunedIds.has('ret-two'))
})

test('agentMenuEntries offers Dismiss only for retired agents with onDismiss handler', async () => {
  const { agentMenuEntries } = await import('../src/canvas/agentmenu')
  const retNode = mk({ id: 'ret-one', state: 'archived' })
  const liveNode = mk({ id: 'live-one', state: 'live' })

  let dismissed = false
  const handlersWithDismiss = { onDismiss: () => { dismissed = true } }
  const handlersWithoutDismiss = {}

  // retired node with onDismiss -> Dismiss entry present
  const entries = agentMenuEntries(retNode, handlersWithDismiss, {})
  const dismissItem = entries.find((e) => typeof e === 'object' && e.label === 'Dismiss') as { label: string; onSelect: () => void; title?: string } | undefined
  assert.ok(dismissItem, 'Dismiss menu item present for retired agent with handler')
  assert.equal(dismissItem.title, 'hide this retired agent again')
  dismissItem.onSelect()
  assert.equal(dismissed, true, 'onSelect invokes onDismiss')

  // retired node without onDismiss (e.g. hideRetired is off) -> no Dismiss entry
  const entriesNoDismiss = agentMenuEntries(retNode, handlersWithoutDismiss, {})
  assert.ok(!entriesNoDismiss.some((e) => typeof e === 'object' && e.label === 'Dismiss'),
    'Dismiss not offered when onDismiss is absent')

  // live node even with onDismiss -> live branch takes precedence, no Dismiss entry
  const entriesLive = agentMenuEntries(liveNode, handlersWithDismiss, {})
  assert.ok(!entriesLive.some((e) => typeof e === 'object' && e.label === 'Dismiss'),
    'Dismiss not offered for live agents')
})

test('the setting is a real control in App settings, wired to the shared store', () => {
  // bound at source like the title spellings (apptitle.test.tsx): the toggle
  // renders THE store the canvas reads, in the Desk group beside the crowd
  // stack toggle it mirrors
  const src = readFileSync(joinPath(__SRC_DIR__, 'canvas', 'accounts.tsx'), 'utf8')
  assert.match(src, /label="hide retired agents" checked=\{on\}\r?\n\s*onChange=\{setHideRetiredOn\}/)
  assert.match(src, /<CrowdStackToggle \/><HideRetiredToggle \/>/)
})
declare const __SRC_DIR__: string   // injected by run.mjs

// -------------------------------------------------------------- DOM layer
// jsdom reports every rect as 0×0 and the canvas culls cards to the visible
// viewport, so a real-sized rect is stubbed for this file only (same idiom
// as contextmenu.test.tsx's per-element stubs, widened because the canvas
// measures the viewport it mounts).
function stubRects(): () => void {
  const proto = HTMLElement.prototype
  const had = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 1600, bottom: 1200, x: 0, y: 0,
      width: 1600, height: 1200, toJSON: () => ({}) } as DOMRect
  }
  return () => { proto.getBoundingClientRect = had }
}

function domTest(name: string, body: (k: {
  mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    localStorage.clear()
    const unstub = stubRects()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unstub()
      localStorage.clear()
      realClock()
    })
    await body({ mount: async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    } })
  })
}

async function mountCanvas(mount: (el: React.ReactElement) => Promise<HTMLElement>) {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const el = await mount(
    <OrgCanvas tree={tree(FIXTURE)} op={() => Promise.resolve({} as never)}
      slug="hr" toast={noop} mailEvt={null} />)
  await flush()
  await advance(2600)   // let the intro glide land before reading the DOM
  return el
}

const cardNames = (el: HTMLElement) =>
  [...el.querySelectorAll('.sq .sq-title .name')].map((n) => n.textContent)

domTest('OFF by construction: retirees render on a fresh profile — the control leg', async ({ mount }) => {
  const el = await mountCanvas(mount)
  const shown = cardNames(el)
  assert.ok(shown.includes('solo-ret'), `the solo retiree has a card (${shown.join(', ')})`)
  assert.ok(shown.some((n) => n === 'ret-one' || n === 'ret-two'),
    'the retired cohort shows its pile front')
  assert.equal(el.querySelector('.retired-token'), null, 'and no token renders')
})

domTest('ON: retired cards leave the canvas; the token stands in; live cards stay', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)
  const shown = cardNames(el)
  for (const gone of ['ret-one', 'ret-two', 'solo-ret']) {
    assert.ok(!shown.includes(gone), `${gone} is hidden (${shown.join(', ')})`)
  }
  assert.ok(shown.includes('boss') && shown.includes('worker'), 'live cards unaffected')
  const tokens = [...el.querySelectorAll('.retired-token')].map((t) => t.textContent)
  assert.deepEqual(tokens.sort(), ['1 retired', '2 retired'],
    'one token per parent with hidden retirees, carrying the count')
  assert.equal(el.querySelectorAll('.pile-stack').length, 0, 'no retired pile remains either')
})

domTest('the token lists the retirees and picking one REVEALS it through the real jump path', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)
  const token = [...el.querySelectorAll('.retired-token')]
    .find((t) => t.textContent === '2 retired') as HTMLElement
  assert.ok(token, 'the boss token rendered')
  await inAct(async () => { token.click(); await flush() })
  const picker = el.ownerDocument.querySelector('.pile-picker')
  assert.ok(picker, 'the picker opened')
  assert.equal(el.contains(picker), false, 'picker escapes the canvas stacking context')
  assert.ok(picker!.closest('.modalpin-over'), 'picker uses the above-pins dialog layer')
  const row = [...picker!.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-one')) as HTMLElement
  assert.ok(row, 'ret-one is listed')
  await inAct(async () => { row.click(); await flush() })
  await advance(400)   // the reveal retries centerOn across two frames
  await flush()
  const shown = cardNames(el)
  assert.ok(shown.includes('ret-one'), `picking revealed the card (${shown.join(', ')})`)
  assert.ok(!shown.includes('ret-two'), 'its still-hidden sibling stays hidden')
  const tokens = [...el.querySelectorAll('.retired-token')].map((t) => t.textContent)
  assert.ok(tokens.includes('1 retired'), 'the token count follows the reveal')
})

domTest('flipping the setting off mid-session brings every retiree back', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)
  assert.ok(el.querySelector('.retired-token'), 'fixture: hidden first')
  await inAct(async () => { setHideRetiredOn(false); await flush() })
  const shown = cardNames(el)
  assert.ok(shown.includes('solo-ret'), 'retirees return without a reload')
  assert.equal(el.querySelector('.retired-token'), null)
})

test('zoomed desk replaces retired jumps with a picker and hides retired audiences reactively', async () => {
  const { FakeServer, installFetch } = await import('./harness')
  const { DeskChat } = await import('../src/canvas/desk')
  const { RetiredFold } = await import('../src/canvas/mail')
  const { resetConvos } = await import('../src/convo')
  localStorage.clear(); resetConvos(); setHideRetiredOn(false)
  installFetch(new FakeServer())
  const boss = mk(FIXTURE[0]!)
  const map = new Map([boss, ...boss.children].map(n => [n.id, n]))
  const jumps: string[] = []
  const v = await mountView(<><DeskChat node={boss} map={map} slug="hr"
    op={async () => ({})} toast={noop} pub={false} bare onJump={id => { jumps.push(id) }} />
    <RetiredFold ids={['ret-audience']} render={id => <span key={id} className="test-retired-audience">{id}</span>} /></>, el => el)
  try {
    const old = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'show 2 retired')!
    assert.ok(old, 'setting-off positive control exposes old jump expansion')
    await inAct(() => { old.click(); (v.el.querySelector('.retired-fold') as HTMLButtonElement).click() })
    assert.ok(v.el.querySelector('.test-retired-audience'))
    await inAct(() => setHideRetiredOn(true))
    assert.equal(v.el.querySelector('.retired-fold'), null)
    assert.equal(v.el.querySelector('.test-retired-audience'), null)
    assert.equal([...v.el.querySelectorAll('button')].some(b => /show 2 retired|hide retired/.test(b.textContent || '')), false)
    const token = v.el.querySelector<HTMLButtonElement>('.desk-retired-token')!
    assert.equal(token.textContent, '2 retired')
    await inAct(() => token.click())
    const pick = [...document.querySelectorAll<HTMLButtonElement>('.pile-row')].find(b => b.textContent?.includes('ret-one'))
    assert.ok(pick, 'retired list opens over zoomed desk')
    await inAct(() => pick.click())
    assert.deepEqual(jumps, ['ret-one'])
  } finally { await v.unmount(); setHideRetiredOn(false); resetConvos() }
})

domTest('revealed retired agent can be dismissed via card action, restores token count, cleans up pinned window, and can be reselected', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  localStorage.setItem('orgtree-agent-shortcuts', '1')
  const ops: unknown[] = []
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { isPinned, addPin, forgetPins } = await import('../src/canvas/pins')
  forgetPins('hr')
  const el = await mount(
    <OrgCanvas tree={tree(FIXTURE)} op={async (o) => { ops.push(o); return {} as never }}
      slug="hr" toast={noop} mailEvt={null} />)
  await flush()
  await advance(2600)

  // 1. Reveal ret-one
  const token = [...el.querySelectorAll('.retired-token')]
    .find((t) => t.textContent === '2 retired') as HTMLElement
  assert.ok(token, 'boss token found')
  await inAct(async () => { token.click(); await flush() })
  const picker = el.ownerDocument.querySelector('.pile-picker')!
  const row = [...picker.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-one')) as HTMLElement
  await inAct(async () => { row.click(); await flush() })
  await advance(400)
  await flush()

  let shown = cardNames(el)
  assert.ok(shown.includes('ret-one'), 'ret-one is revealed')

  // Find ret-one card
  const retCard = [...el.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.sq-title .name')?.textContent === 'ret-one') as HTMLElement
  assert.ok(retCard, 'ret-one card found')

  // Dismiss button is present on card
  const dismissBtn = retCard.querySelector('.dismissbtn') as HTMLButtonElement
  assert.ok(dismissBtn, 'dismiss button exists on card')
  assert.equal(dismissBtn.getAttribute('title'), 'dismiss — hide this retired agent again')

  // Live card (boss) has no dismiss button
  const bossCard = [...el.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.sq-title .name')?.textContent === 'boss') as HTMLElement
  assert.equal(bossCard.querySelector('.dismissbtn'), null, 'live card has no dismiss button')

  // Right-click ret-one card to verify context menu also offers "Dismiss"
  const ev = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30,
  })
  await inAct(async () => { retCard.dispatchEvent(ev); await flush() })
  const ctxMenu = document.querySelector('.ctxmenu')
  assert.ok(ctxMenu, 'context menu opened for ret-one')
  const menuButtons = [...ctxMenu.querySelectorAll('button')]
  const menuDismiss = menuButtons.find((b) => b.textContent?.trim() === 'Dismiss')
  assert.ok(menuDismiss, 'Dismiss item present in context menu')

  // Close context menu by pressing Escape
  await inAct(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })

  // Pin ret-one to test pin cleanup
  await inAct(async () => {
    addPin('hr', 'ret-one', { x: 100, y: 100, w: 400, h: 300 })
    await flush()
  })
  assert.equal(isPinned('hr', 'ret-one'), true, 'ret-one is now pinned')

  // Now click dismiss button on card
  await inAct(async () => { dismissBtn.click(); await flush() })
  await advance(2600)
  await flush()

  // ret-one leaves canvas
  shown = cardNames(el)
  assert.ok(!shown.includes('ret-one'), 'ret-one removed from canvas')
  assert.ok([...el.querySelectorAll('.retired-token, .desk-retired-token')].some((t) => t.textContent === '2 retired'),
    'token count restored to 2')

  // Pin was cleaned up
  assert.equal(isPinned('hr', 'ret-one'), false, 'pinned window was removed on dismiss')

  // No op was called (purely transient view change)
  assert.equal(ops.length, 0, 'no op dispatched to server')

  // Reselection from token works
  const tokenRestored = [...el.querySelectorAll('.retired-token, .desk-retired-token')]
    .find((t) => t.textContent === '2 retired') as HTMLElement
  assert.ok(tokenRestored, 'token restored')
  await inAct(async () => { tokenRestored.click(); await flush() })
  const pickerRestored = el.ownerDocument.querySelector('.pile-picker')!
  const rowRestored = [...pickerRestored.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-one')) as HTMLElement
  assert.ok(rowRestored, 'ret-one is available in picker again')
  await inAct(async () => { rowRestored.click(); await flush() })
  await advance(400)
  await flush()

  shown = cardNames(el)
  assert.ok(shown.includes('ret-one'), 'ret-one is re-revealed successfully')
})

domTest('revealed retired agent can be dismissed via context menu Dismiss entry', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)

  // Reveal ret-one
  const token = [...el.querySelectorAll('.retired-token')]
    .find((t) => t.textContent === '2 retired') as HTMLElement
  await inAct(async () => { token.click(); await flush() })
  const picker = el.ownerDocument.querySelector('.pile-picker')!
  const row = [...picker.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-one')) as HTMLElement
  await inAct(async () => { row.click(); await flush() })
  await advance(400)
  await flush()

  const retCard = [...el.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.sq-title .name')?.textContent === 'ret-one') as HTMLElement

  const ev = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30,
  })
  await inAct(async () => { retCard.dispatchEvent(ev); await flush() })
  const ctxMenu = document.querySelector('.ctxmenu')!
  const menuDismiss = [...ctxMenu.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === 'Dismiss') as HTMLButtonElement
  assert.ok(menuDismiss, 'Dismiss option found in context menu')

  await inAct(async () => { menuDismiss.click(); await flush() })
  await advance(2600)
  await flush()

  const shown = cardNames(el)
  assert.ok(!shown.includes('ret-one'), 'ret-one dismissed via context menu')
  assert.ok([...el.querySelectorAll('.retired-token')].some((t) => t.textContent === '2 retired'))
})

domTest('dismissing an inactive revealed retiree preserves the active live target and camera', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)

  // Reveal two retirees, preserving both in transient view state.
  let token = [...el.querySelectorAll('.retired-token')]
    .find((t) => t.textContent === '2 retired') as HTMLElement
  await inAct(async () => { token.click(); await flush() })
  let picker = el.ownerDocument.querySelector('.pile-picker')!
  let row = [...picker.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-one')) as HTMLElement
  await inAct(async () => { row.click(); await flush() })
  await advance(400)
  await flush()

  token = [...el.querySelectorAll('.retired-token')]
    .find((t) => t.textContent === '1 retired') as HTMLElement
  await inAct(async () => { token.click(); await flush() })
  picker = el.ownerDocument.querySelector('.pile-picker')!
  row = [...picker.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-two')) as HTMLElement
  await inAct(async () => { row.click(); await flush() })
  await advance(400)
  await flush()

  // Select a live agent through the tray. Its camera target remains active
  // while the unrelated revealed retiree is dismissed from the tray menu.
  const toggle = el.querySelector('.tray-toggle') as HTMLElement
  await inAct(async () => { toggle.click(); await flush() })
  const worker = [...el.querySelectorAll('.tray-row')]
    .find((r) => r.querySelector('.tray-name')?.textContent === 'worker') as HTMLElement
  assert.ok(worker, 'live target row rendered')
  await inAct(async () => { (worker.querySelector('.tray-main') as HTMLElement).click(); await flush() })
  await advance(800)
  await flush()
  const before = (el.querySelector('.space') as HTMLElement).style.transform
  assert.ok(el.querySelector('.sq.desk [data-copy-agent-name="worker"]'),
    'worker owns the active desk before unrelated dismissal')

  const archivedToggle = el.querySelector('.tray-arch') as HTMLElement
  assert.ok(archivedToggle, 'archived rows can be shown')
  await inAct(async () => { archivedToggle.click(); await flush() })
  const retiredRow = [...el.querySelectorAll('.tray-row')]
    .find((r) => r.querySelector('.tray-name')?.textContent === 'ret-one') as HTMLElement
  assert.ok(retiredRow, 'revealed retired row remains addressable')
  await inAct(async () => {
    retiredRow.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30,
    }))
    await flush()
  })
  const dismiss = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button')]
    .find((b) => b.textContent?.trim() === 'Dismiss')
  assert.ok(dismiss, 'inactive revealed retiree offers Dismiss')
  await inAct(async () => { dismiss!.click(); await flush() })
  await advance(800)
  await flush()

  assert.equal((el.querySelector('.space') as HTMLElement).style.transform, before,
    'dismissing an inactive retiree does not move the camera')
  assert.ok(el.querySelector('.sq.desk [data-copy-agent-name="worker"]'),
    'the active live target remains selected')

  // The row stays in the lifecycle list, but its transient Dismiss affordance
  // is gone: the revealed retiree returned to the hidden canvas state.
  await inAct(async () => {
    retiredRow.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30,
    }))
    await flush()
  })
  const after = document.querySelector('.ctxmenu')
  assert.ok(after, 'retired row remains selectable after dismissal')
  assert.equal([...after!.querySelectorAll('button')]
    .some((b) => b.textContent?.trim() === 'Dismiss'), false,
    'dismissed retiree no longer has a transient Dismiss action')
})

domTest('setting OFF: retirees have no dismiss button on card, desk or context menu', async ({ mount }) => {
  localStorage.removeItem(HIDE_RETIRED_KEY)
  const el = await mountCanvas(mount)
  const shown = cardNames(el)
  assert.ok(shown.includes('solo-ret'), 'solo-ret visible with setting OFF')
  assert.equal(el.querySelectorAll('.dismissbtn').length, 0, 'no dismiss buttons on any card')

  const soloCard = [...el.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.sq-title .name')?.textContent === 'solo-ret') as HTMLElement
  assert.ok(soloCard)
  const ev = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30,
  })
  await inAct(async () => { soloCard.dispatchEvent(ev); await flush() })
  const ctxMenu = document.querySelector('.ctxmenu')
  if (ctxMenu) {
    const hasDismiss = [...ctxMenu.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Dismiss')
    assert.equal(hasDismiss, false, 'no Dismiss in context menu when setting is OFF')
  }
})

test('zoomed desk of a revealed retired agent offers dismiss button when onDismiss is passed', async () => {
  const { FakeServer, installFetch } = await import('./harness')
  const { DeskChat } = await import('../src/canvas/desk')
  const { resetConvos } = await import('../src/convo')
  localStorage.clear(); resetConvos()
  installFetch(new FakeServer())
  const ret = mk({ id: 'ret-one', state: 'archived' })
  const map = new Map([[ret.id, ret]])
  let dismissed = false
  const v = await mountView(
    <DeskChat node={ret} map={map} slug="hr"
      op={async () => ({})} toast={noop} pub={false} bare
      onDismiss={() => { dismissed = true }} />,
    (el) => el
  )
  try {
    const dismissBtn = [...v.el.querySelectorAll<HTMLButtonElement>('.cc-actions button')]
      .find((b) => b.textContent?.trim() === 'dismiss')
    assert.ok(dismissBtn, 'dismiss button rendered in .cc-actions')
    assert.equal(dismissBtn.title, 'dismiss — hide this retired agent again')
    await inAct(() => dismissBtn.click())
    assert.equal(dismissed, true, 'clicking dismiss button invokes onDismiss')
  } finally {
    await v.unmount()
    resetConvos()
  }
})
