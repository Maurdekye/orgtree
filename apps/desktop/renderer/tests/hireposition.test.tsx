import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { withDraftTree, DRAFT, layout } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, TreePayload } from '../src/types'
import { NEW_HIRE_POSITION_KEY, newHireIndex, newHirePlacement, newHirePositionOf, setNewHirePosition } from '../src/hireposition'
import { NewHirePositionSetting } from '../src/canvas/hirepositionsetting'
import { projectDraftSteps } from '../src/canvas/newproject'
import { quickChatHire } from '../src/quickchat'
import { quickStaffEntry } from '../src/canvas/quickstaff'
import type { MenuItem } from '../src/canvas/contextmenu'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'

const node = (id: string, extra = {}): CanvasNode => ({
  id, title: id, tier: 'sol', state: 'live', children: [], ...extra,
} as CanvasNode)
const tree = (roots: CanvasNode[]): TreePayload => ({ roots } as unknown as TreePayload)
const preview = withDraftTree

test('centre hire is after the old middle among live direct children', () => {
  const roots = [node('alpha'), node('project', { kind: 'project' }), node('omega')]
  const shown = preview(tree(roots), { parent: null, tier: 'sol' }, 'centre')
  assert.deepEqual(shown.children.map(n => n.id), ['alpha', 'project', DRAFT, 'omega'])
  assert.deepEqual(roots.map(n => n.id), ['alpha', 'project', 'omega'])
})

test('centre counts live physical children, projects included, without flattening descendants', () => {
  const kids = [node('alpha'), node('old', { state: 'archived' }), node('project', { kind: 'project', children: [node('deep')] }), node('omega')]
  const t = tree([node('boss', { children: kids })])
  for (const project of [false, true]) {
    const shown = preview(t, { parent: 'boss', tier: project ? 'project' : 'sol', project }, 'centre')
    assert.deepEqual(shown.children[0]!.children.map(n => n.id), ['alpha', 'old', 'project', DRAFT, 'omega'])
  }
})

test('start, end and centre handle empty, odd and even teams in both layouts', () => {
  for (let n = 0; n <= 6; n++) for (const position of ['start', 'end', 'centre'] as const) {
    const roots = Array.from({ length: n }, (_, i) => node('agent-' + i))
    const shown = preview(tree(roots), { parent: null, tier: 'sol' }, position)
    assert.equal(shown.children.findIndex(k => k.id === DRAFT), newHireIndex(n, position))
    for (const mode of ['row', 'circular'] as const) {
      const positions = layout(shown, new Map(), mode, false)
      assert.equal(positions.size, n + 2)
      for (const p of positions.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
    }
  }
  const shown = preview(tree(['a', 'b', 'c'].map(id => node(id))), { parent: null, tier: 'sol' }, 'centre')
  for (const mode of ['row', 'circular'] as const) {
    const p = layout(shown, new Map(), mode, false)
    assert.ok(p.get('b')!.x < p.get(DRAFT)!.x && p.get(DRAFT)!.x < p.get('c')!.x)
  }
})

test('explicit side and above draft placements override every app choice', () => {
  for (const position of ['start', 'end', 'centre'] as const) {
    const t = tree(['a', 'b', 'c'].map(id => node(id)))
    assert.deepEqual(preview(t, { parent: null, tier: 'sol', beside: { anchor: 'c', side: 'right' } }, position).children.map(n => n.id), ['a', 'b', 'c', DRAFT])
    const shown = preview(t, { parent: null, tier: 'sol', above: { anchor: 'a' } }, position)
    assert.deepEqual(shown.children.map(n => n.id), [DRAFT, 'b', 'c'])
    assert.equal(shown.children[0]!.children[0]!.id, 'a')
    assert.deepEqual(preview(t, null, position).children.map(n => n.id), ['a', 'b', 'c'])
  }
})

test('Display setting defaults to End, saves immediately and refreshes other subscribers/windows', async t => {
  localStorage.removeItem(NEW_HIRE_POSITION_KEY)
  assert.equal(newHirePositionOf(), 'end')
  localStorage.setItem(NEW_HIRE_POSITION_KEY, 'unknown')
  assert.equal(newHirePositionOf(), 'end')
  const v = await mountView(<><NewHirePositionSetting /><NewHirePositionSetting /></>, el => el)
  t.after(() => { v.unmount(); setNewHirePosition('end') })
  const controls = [...v.el.querySelectorAll<HTMLSelectElement>('select[aria-label="New hires go"]')]
  await inAct(() => { controls[0]!.value = 'centre'; controls[0]!.dispatchEvent(new window.Event('change', { bubbles: true })) })
  assert.equal(localStorage.getItem(NEW_HIRE_POSITION_KEY), 'centre')
  assert.deepEqual(controls.map(c => c.value), ['centre', 'centre'])
  await inAct(() => {
    localStorage.setItem(NEW_HIRE_POSITION_KEY, 'start')
    window.dispatchEvent(new window.StorageEvent('storage', { key: NEW_HIRE_POSITION_KEY, newValue: 'start' }))
  })
  assert.deepEqual(controls.map(c => c.value), ['start', 'start'])
})

test('Quick chat and ordinary project submissions read the app choice at creation time', () => {
  try {
    for (const position of ['start', 'centre', 'end'] as const) {
      setNewHirePosition(position)
      const want = position === 'end' ? undefined : position
      const quick = quickChatHire({ message: 'task', name: 'worker', tier: 'sol', effort: '', superior: null, grant: 0 })
      assert.equal(quick.user_position, want)
      assert.equal(projectDraftSteps({ parent: null, tier: 'project', project: true }, 'project', '')[0]!.user_position, want)
      assert.deepEqual(newHirePlacement(true), {})
      for (const relation of [{ beside: { anchor: 'a', side: 'left' as const } }, { above: { anchor: 'a' } }]) {
        assert.equal(projectDraftSteps({ parent: null, tier: 'project', project: true, ...relation }, 'project', '')[0]!.user_position, undefined)
      }
    }
  } finally { setNewHirePosition('end') }
})

test('immediate Staff carries the app choice while request Staff leaves the assignee free', async t => {
  const before = globalThis.fetch, sent: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ message: 'staffed' }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = before; setNewHirePosition('end') })
  setNewHirePosition('centre')
  for (const mode of ['request', 'under_assignee', 'top_level'] as const) {
    const entry = quickStaffEntry('org', 'position-' + mode, {
      mode, configured_mode: mode, owner: { node: 'manager', born: 'one' }, fallback: false,
      disclosure: 'synthetic', models: [{ tier: 'sol', seat: 2, efforts: [] }],
    }, () => {})
    if (mode === 'request') entry.onSelect()
    else (entry.children![0] as MenuItem).onSelect()
    await flush()
    assert.equal(sent.at(-1)!.user_position, mode === 'request' ? undefined : 'centre')
  }
})

for (const history of [false, true]) for (const project of [false, true]) {
  test(`ordinary canvas ${project ? 'project' : 'hire'} sends centre, undo=${history}`, async t => {
    useFakeClock(); localStorage.clear(); setNewHirePosition('centre'); resetConvos(); installFetch(new FakeServer())
    const requests: OpRequest[] = [], before = globalThis.fetch
    const agent = { ...node('boss'), generation: 0, seat: 2, grant: 80, free: 80, turns: [], lineage: [], audiences_held: [],
      scope: { tools: {}, add_dirs: [], org_visibility: 'team' } }
    const payload = { slug: 'position-canvas', name: 'Synthetic', roots: [agent], dirs: [], tiers: { sol: 2 },
      undo_history: history, default_top_grant: 50, max_top_grant: 1000, cascade_hire: true,
      audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0 } as unknown as TreePayload
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('/gesture')) {
        const body = JSON.parse(String(init?.body))
        requests.push(...body.steps)
        return new Response(JSON.stringify({ results: body.steps.map(() => ({ node: 'newcomer' })) }), { headers: { 'Content-Type': 'application/json' } })
      }
      return before(url, init)
    }) as typeof fetch
    const v = await mountView(<OrgCanvas tree={payload} slug={payload.slug} mailEvt={null} toast={() => {}}
      op={async body => { requests.push(body); return { node: 'newcomer' } }} />, el => el)
    t.after(() => { v.unmount(); globalThis.fetch = before; setNewHirePosition('end'); realClock(); resetConvos() })
    await advance(1800)
    const card = v.el.querySelector('[data-first-use-agent="boss"]')!
    const expand = card.querySelector<HTMLButtonElement>('.hsof:not(.side) .hire-expand')
    if (expand?.getAttribute('aria-expanded') === 'false') await inAct(() => expand.click())
    const token = card.querySelector<HTMLButtonElement>('.hsof:not(.side) button.' + (project ? 'project-token' : 't-sol'))
    assert.ok(token, 'ordinary bottom creation token')
    await inAct(() => token.click()); await advance(1200)
    const input = v.el.querySelector<HTMLInputElement>('.sq.draft input')!
    assert.ok(input)
    await inAct(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'newcomer')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await inAct(() => v.el.querySelector<HTMLButtonElement>('.sq.draft button.primary')!.click()); await flush()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.op, project ? 'create_project' : 'hire')
    assert.equal(requests[0]!.user_position, 'centre')
    assert.equal(requests[0]!.parent, 'boss')
  })
}
