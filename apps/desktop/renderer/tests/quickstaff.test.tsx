import { flush, inAct, mountView, advance, useFakeClock, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { JSDOM } from 'jsdom'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import { quickStaffEntry } from '../src/canvas/quickstaff'
import type { QuickStaffPreview } from '../src/canvas/quickstaff'
import { QuickStaffSetting } from '../src/canvas/quickstaffsetting'
import { DocketModal } from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const preview = (mode: QuickStaffPreview['mode'] = 'request'): QuickStaffPreview => ({
  mode, configured_mode: mode, owner: { node: 'manager', born: 'one' }, fallback: false,
  disclosure: mode === 'request' ? 'Request staffing from the assignee.' : 'Staff immediately at top level. Choose a model.',
  models: [{ tier: 'dynamic-model', seat: 2, efforts: ['low', 'high'] }],
})
function Fixture({ entries }: { entries: MenuEntry[] }) {
  const menu = useContextMenu()
  return <div tabIndex={0} data-open onContextMenu={e => menu.open(e, entries)}>Ticket{menu.node}</div>
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const named = (name: string) => buttons().find(b => b.textContent?.replace(' ▸', '') === name)!
async function key(el: Element, value: string) {
  await inAct(() => { el.dispatchEvent(new W.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) })
  await flush(2)
}
async function open() {
  await inAct(() => { document.querySelector('[data-open]')!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  await flush(2)
}
function captureFetch(t: { after: (fn: () => void) => void }, fail = false) {
  const old = globalThis.fetch
  const sent: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(fail ? { detail: 'Account unavailable' } : { message: 'Staffed successfully' }),
      { status: fail ? 422 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = old })
  return sent
}

test('request selection sends exactly bare, model-only, or model-and-effort', async t => {
  const sent = captureFetch(t)
  for (const [depth, expected] of [[0, {}], [1, { tier: 'dynamic-model' }], [2, { tier: 'dynamic-model', effort: 'high' }]] as const) {
    const menu = quickStaffEntry('org', `request-${depth}`, preview(), () => {})
    const model = menu.children![0] as MenuItem
    const entry = depth === 0 ? menu : depth === 1 ? model : model.children![1] as MenuItem
    entry.onSelect(); await flush()
    const body = sent.at(-1)!
    assert.deepEqual({ ...(body.tier ? { tier: body.tier } : {}), ...(body.effort ? { effort: body.effort } : {}) }, expected)
    assert.equal(body.mode, 'request')
  }
})

test('both immediate modes require a model and leave model-only effort absent', async t => {
  const sent = captureFetch(t)
  for (const mode of ['under_assignee', 'top_level'] as const) {
    const entry = quickStaffEntry('org', mode, preview(mode), () => {})
    assert.equal(entry.actionDisabled, true)
    entry.onSelect(); await flush()
    const count = sent.length
    ;(entry.children![0] as MenuItem).onSelect(); await flush()
    assert.equal(sent.length, count + 1)
    assert.equal(sent.at(-1)!.mode, mode)
    assert.equal('effort' in sent.at(-1)!, false)
  }
})

test('keyboard traverses three levels and Escape returns to the parent before dismissal', async t => {
  const sent = captureFetch(t)
  const v = await mountView(<Fixture entries={[quickStaffEntry('org', 'keyboard', preview('top_level'), () => {})]} />, h => h)
  t.after(() => v.unmount())
  await open()
  const root = named('Staff…')
  assert.equal(root.getAttribute('aria-haspopup'), 'menu')
  assert.equal(root.getAttribute('aria-disabled'), 'true')
  await key(root, 'ArrowRight')
  assert.equal(document.activeElement, named('dynamic-model'))
  await key(named('dynamic-model'), 'ArrowRight')
  assert.equal(document.activeElement, named('low'))
  await key(named('low'), 'ArrowDown')
  assert.equal(document.activeElement, named('high'))
  await key(named('high'), 'Escape')
  assert.equal(document.activeElement, named('dynamic-model'))
  assert.ok(document.querySelector('.ctxmenu'))
  await key(named('dynamic-model'), 'ArrowLeft')
  assert.equal(document.activeElement, root)
  assert.equal(sent.length, 0)
  await key(root, 'Escape')
  assert.equal(document.querySelector('.ctxmenu'), null)
})

test('pointer hover reveals fallback before model selection, with clickable model parents', async t => {
  const sent = captureFetch(t)
  const p = { ...preview('top_level'), configured_mode: 'request' as const, fallback: true,
    disclosure: 'Assignee unavailable — selected agent will be staffed immediately at top level. Choose a model.' }
  const v = await mountView(<Fixture entries={[quickStaffEntry('org', 'pointer', p, () => {})]} />, h => h)
  t.after(() => v.unmount())
  await open()
  await inAct(() => { named('Staff…').dispatchEvent(new W.MouseEvent('mouseover', { bubbles: true })) })
  await flush()
  assert.match(document.querySelector('.ctxmenu-description')!.textContent!, /Assignee unavailable.*immediately at top level/)
  await inAct(() => { named('dynamic-model').dispatchEvent(new W.MouseEvent('mouseover', { bubbles: true })) })
  await flush()
  assert.ok(named('high'))
  await inAct(() => { named('dynamic-model').click() }); await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.tier, 'dynamic-model')
  assert.equal('effort' in sent[0]!, false)
  assert.equal(document.querySelector('.ctxmenu'), null)
})

test('popout nested menus join the origin Escape stack and collapse one level at a time', async () => {
  const child = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const childDoc = child.window.document
  function PopoutFixture() {
    const menu = useContextMenu()
    return <>{createPortal(<button data-origin onContextMenu={e => menu.open(e,
      [quickStaffEntry('org', 'popout-keyboard', preview('top_level'), () => {})])}>Ticket</button>, childDoc.body)}{menu.node}</>
  }
  const v = await mountView(<PopoutFixture />, h => h)
  const item = (name: string) => [...childDoc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(b => b.textContent?.replace(' ▸', '') === name)!
  const childKey = async (el: EventTarget, value: string) => {
    await inAct(() => { el.dispatchEvent(new child.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) })
    await flush(2)
  }
  try {
    await inAct(() => { childDoc.querySelector('[data-origin]')!.dispatchEvent(
      new child.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    await flush(2)
    assert.equal(document.querySelector('.ctxmenu'), null)
    assert.ok(item('Staff…'))
    await childKey(item('Staff…'), 'ArrowRight')
    await childKey(item('dynamic-model'), 'ArrowRight')
    assert.equal(childDoc.activeElement, item('low'))
    assert.equal(childDoc.querySelectorAll('[role="menu"]').length, 3)
    // A key in another window must not dismiss any level in this one.
    await key(document.body, 'Escape')
    assert.equal(childDoc.querySelectorAll('[role="menu"]').length, 3)
    // Dispatch on the origin window itself to exercise the Escape stack,
    // without the submenu's React key handler masking incorrect registration.
    await childKey(child.window, 'Escape')
    assert.equal(childDoc.querySelectorAll('[role="menu"]').length, 2)
    assert.equal(childDoc.activeElement, item('dynamic-model'))
    await childKey(child.window, 'Escape')
    assert.equal(childDoc.querySelectorAll('[role="menu"]').length, 1)
    assert.equal(childDoc.activeElement, item('Staff…'))
    await childKey(child.window, 'Escape')
    assert.equal(childDoc.querySelector('.ctxmenu'), null)
  } finally { await v.unmount(); child.window.close() }
})

test('duplicates are suppressed and failed retries retain the operation identity', async t => {
  const sent = captureFetch(t, true)
  const feedback: string[] = []
  const entry = quickStaffEntry('org', 'retry', preview(), x => feedback.push(x))
  entry.onSelect(); entry.onSelect(); await flush()
  assert.equal(sent.length, 1)
  assert.ok(feedback.some(x => x.includes('Account unavailable')))
  entry.onSelect(); await flush()
  assert.equal(sent.length, 2)
  assert.equal(sent[0]!.request_id, sent[1]!.request_id)
})

test('a model with no eligible account is absent, not a disabled row', () => {
  // The backend stopped sending unstaffable models at all (user ruling
  // 2026-09-15), because a disabled row is still an offer. This asserts the
  // renderer has no path left that can draw one.
  const p = preview()
  p.models = [{ tier: 'haiku', seat: 1, efforts: ['low'], accounts: [], default_ok: true }]
  const entry = quickStaffEntry('org', 'omitted', p, () => {})
  const rows = entry.children as MenuItem[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.disabled, undefined)
  // CONTROL: the ONE disabled row the menu may still draw is the empty state,
  // and it says which of the two empties it is.
  const none = quickStaffEntry('org', 'none', { ...preview(), models: [] }, () => {})
  assert.equal((none.children![0] as MenuItem).disabled, true)
  assert.equal((none.children![0] as MenuItem).label, 'No models available')
  const broken = quickStaffEntry('org', 'broken', { ...preview(), models: [],
    availability: { at: 0, stale: false, errors: ['OpenRouter catalog unavailable'] } }, () => {})
  assert.equal((broken.children![0] as MenuItem).label, 'Staffing options could not be loaded')
  assert.match((broken.children![0] as MenuItem).title!, /OpenRouter/)
})

test('a tier whose default account cannot run it stays offered through its accounts', async t => {
  // THE MODEL-LIST DEFECT ITSELF. The tier is reachable — another account can
  // run it — so it must not vanish; only its own one-click closes.
  const sent = captureFetch(t)
  const p = preview('top_level')
  p.models = [{ tier: 'haiku', seat: 1, efforts: ['low', 'high'], default_ok: false,
    accounts: [
      { value: 'claude/primary', id: 'default', provider: 'claude', ambient: true, email: 'host@x.y' },
      { value: 'claude-4', id: 'claude-4', provider: 'claude', ambient: false, email: 'a@b.c' }] }]
  const entry = quickStaffEntry('org', 'accounts', p, () => {})
  const model = entry.children![0] as MenuItem
  assert.equal(model.label, 'haiku')
  assert.equal(model.actionDisabled, true)
  assert.deepEqual((model.children as MenuItem[]).map(c => c.label),
                   ['default \u00b7 host@x.y', 'claude-4 \u00b7 a@b.c'])
  const account = model.children![1] as MenuItem
  account.onSelect(); await flush()
  assert.equal(sent.at(-1)!.account, 'claude-4')
  assert.equal(sent.at(-1)!.tier, 'haiku')
  assert.equal('effort' in sent.at(-1)!, false)
  // and the effort sits UNDER the account, so every leaf is a whole selection
  ;(account.children![1] as MenuItem).onSelect(); await flush()
  assert.deepEqual({ tier: sent.at(-1)!.tier, account: sent.at(-1)!.account, effort: sent.at(-1)!.effort },
                   { tier: 'haiku', account: 'claude-4', effort: 'high' })
})

test('one eligible account that the tier would take anyway adds no account layer', async t => {
  // CONTROL for the layer above: it appears where there is a CHOICE, and the
  // ordinary one-account machine keeps exactly the menu it had before.
  const sent = captureFetch(t)
  const p = preview('top_level')
  p.models = [{ tier: 'haiku', seat: 1, efforts: ['low', 'high'], default_ok: true,
    accounts: [{ value: 'claude/primary', id: 'default', provider: 'claude', ambient: true, email: null }] }]
  const model = quickStaffEntry('org', 'single', p, () => {}).children![0] as MenuItem
  assert.equal(model.actionDisabled, false)
  assert.deepEqual((model.children as MenuItem[]).map(c => c.label), ['low', 'high'])
  ;(model.children![0] as MenuItem).onSelect(); await flush()
  assert.equal('account' in sent.at(-1)!, false)
})

test('setting restores and writes all three modes through application preferences', async t => {
  const old = globalThis.fetch
  let mode = 'under_assignee'
  globalThis.fetch = async (_url, init) => {
    if (init?.body) mode = JSON.parse(String(init.body)).quick_staff_behavior
    return new Response(JSON.stringify({ quick_staff_behavior: mode }))
  }
  t.after(() => { globalThis.fetch = old })
  const v = await mountView(<QuickStaffSetting />, h => h); t.after(() => v.unmount()); await flush()
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Quick staff behavior"]')!
  assert.equal(select.value, 'under_assignee')
  for (const value of ['request', 'under_assignee', 'top_level']) {
    await inAct(() => { select.value = value; select.dispatchEvent(new W.Event('change', { bubbles: true })) }); await flush()
    assert.equal(mode, value); assert.equal(select.value, value)
  }
})

test('real docket rows load Staff only for backlog and submit the previewed selection', async t => {
  useFakeClock(); t.after(realClock)
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old })
  window.localStorage.removeItem('orgtree.docket.group')
  const base = { rev: 1, kind: 'code', title: 'Ticket', owner: { node: 'manager', generation: 0 },
    created_by: { node: 'manager', generation: 0 }, at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    done_so_far: [], working_on_next: [], objective: 'Do it', acceptance: [], evidence: [],
    questions: [], attention_sources: [], effective_attention: false, archived: false, history: [], participants: [] }
  const backlog = { ...base, slug: 'backlog', status: 'backlogged' } as unknown as WorkItem
  const active = { ...base, slug: 'active', status: 'open' } as unknown as WorkItem
  const requests: { url: string; body?: Record<string, unknown> }[] = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.endsWith('/quick-staff')) {
      requests.push({ url: path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      return new Response(JSON.stringify(init?.method === 'POST' ? { message: 'Staffing requested from manager; ticket moved to Open.' } : preview()))
    }
    return new Response(JSON.stringify(path.includes('/work-items') ? {
      items: [active], backlogged: [backlog], counts: { active: 1, backlogged: 1, archived: 0, attention: 0 }, now: '2026-09-01T00:00:00Z',
    } : { pending: [], delivered: [], sent: [] }))
  }
  const tree = { slug: 'org1', name: 'Org', epoch: 1, rev: 1, roots: [], asks: [],
    work_items_summary: { active: 1, attention: 0 } } as unknown as TreePayload
  const v = await mountView(<DocketModal slug="org1" tree={tree} close={() => {}} toast={() => {}} jumpTo={null} />, h => h)
  t.after(() => v.unmount()); await flush(); await advance(200, 16); await flush()
  const toggle = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find(x => x.parentElement?.textContent?.includes('Show backlogged'))!
  assert.ok(toggle)
  if (!toggle.checked) await inAct(() => { toggle.click() })
  await flush(); await advance(200, 16); await flush()
  const row = (slug: string) => [...document.querySelectorAll('.docket-row')]
    .find(x => x.querySelector('.docket-rowname')?.textContent === slug)!
  await inAct(() => { row('active').dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) }); await flush()
  assert.equal(named('Staff…'), undefined)
  assert.equal(requests.length, 0)
  await inAct(() => { row('backlog').dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) }); await flush()
  assert.ok(named('Staff…'))
  assert.equal(requests.length, 1)
  await inAct(() => { named('Staff…').click() }); await flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1]!.body!.mode, 'request')
  assert.equal('tier' in requests[1]!.body!, false)
})


test('every rendered row is selectable, in Request and in Direct alike', async t => {
  // ⚠ REWRITTEN FOR THE OMISSION RULE (2026-09-15). This used to assert that
  // Direct DREW its unstaffable rows greyed out; the payload no longer carries
  // them, so what is checked now is that nothing reaching the menu is dead.
  const sent = captureFetch(t)
  const request = preview()
  request.models = [
    { tier: 'haiku', seat: 1, reason: null, efforts: ['low', 'high'] },
    { tier: 'or-vendor-live', seat: 2, reason: null, efforts: [] },
  ]
  const direct = preview('top_level')
  direct.models = [
    { tier: 'haiku', seat: 1, efforts: ['low', 'high'], accounts: [], default_ok: true },
    { tier: 'or-vendor-live', seat: 2, efforts: [], accounts: [], default_ok: true },
  ]
  for (const [id, data] of [['request', request], ['direct', direct]] as const) {
    const menu = quickStaffEntry('regression', id, data, () => {})
    const view = await mountView(<Fixture entries={[menu]} />, h => h)
    try {
      await open(); await key(named('Staff…'), 'ArrowRight')
      assert.ok(named('haiku')); assert.ok(named('or-vendor-live'))
      // the tier the backend withheld is nowhere, in either mode
      assert.equal(named('or-vendor-history'), undefined)
      // the MODEL rows specifically: the Staff… root is legitimately
      // non-actionable in Direct, and always was
      assert.deepEqual(['haiku', 'or-vendor-live'].map(n => named(n).getAttribute('aria-disabled')),
                       [null, null])
      await inAct(() => { named('or-vendor-live').click() }); await flush()
      assert.equal(sent.at(-1)!.tier, 'or-vendor-live')
    } finally { await view.unmount() }
  }
})
