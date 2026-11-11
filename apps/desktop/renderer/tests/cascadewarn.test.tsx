// cascadewarn.test.tsx — the agent-settings "this also raises the agents
// between you and X" warning shows only for a PENDING raise, and only where
// its cause is edited.
//
// Docket `agent-settings-the-this-also-raises-the-agents-b` (USER 2026-11-08
// 15:17:14Z m2b8a6c58345c: "this appears below every tab in an agent's
// settings, it should only appear in probably a few tabs"). Root cause
// (measured in the code): the preview was computed from the form's CURRENT
// values, which start as the agent's saved scope, so an agent holding a
// folder its superior lacks verbatim showed the banner on every tab with
// nothing edited. The engine raises ancestors only for the capability fields
// the save SENDS (set_scope: `granted` = tools / org_visibility /
// permission_mode / add_dirs when named; scope::raise, containment-aware
// for folders), and the UI sends them only when EDITED.
//
//   §1 nothing edited → no banner on any tab (the report's case)
//   §2 an edited capability field → the full banner on Scope/Tools only; a
//      one-line note by Save on the other tabs
//   §3 a folder an ancestor already covers by a parent folder raises nobody
//      (scope::raise uses path_within); read-only parent + rw want upgrades
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig, cascadePreview } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

const noop = () => {}
const tools = { bash: true, web: true, edit: true, subagents: true, mcp: [] as string[] }
function world(midDirs: { path: string; mode: string }[], leafDirs: { path: string; mode: string }[]) {
  const mk = (id: string, parent: string | null, add_dirs: unknown[], extra: Record<string, unknown> = {}) =>
    ({ id, title: id, state: 'live', tier: 'opus', model_id: 'opus', parent, children: [], seat: 4,
       grant: 10, free: 10, charter: '', team_charter: '', turns: [], audiences_held: [], lineage: [],
       scope: { permission_mode: 'acceptEdits', add_dirs, tools, org_visibility: 'team' }, ...extra }) as unknown as CanvasNode
  const mid = mk('mid', null, midDirs)
  const leaf = mk('leaf', 'mid', leafDirs)
  return { map: new Map([['mid', mid], ['leaf', leaf]]), leaf }
}
async function open(t: TestContext, w: ReturnType<typeof world>) {
  localStorage.clear()
  installFetch(new FakeServer())
  const tree = { slug: 'org', dirs: [], tiers: { opus: 4 }, max_top_grant: 100, default_effort: '',
    effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const v = await mountView(
    <NodeConfig node={w.leaf} map={w.map} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={null} close={noop} />, (el) => el)
  t.after(() => v.unmount())
  await flush()
  return v
}
const goto = async (el: HTMLElement, label: string) => {
  const tab = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === label)
  assert.ok(tab, `no ${label} tab`)
  await inAct(async () => { tab!.click(); await flush() })
}
const banner = (el: HTMLElement) => el.querySelector('.cascade-warn')
const note = (el: HTMLElement) => el.querySelector('.cascade-note')
const TABS = ['General', 'Model', 'Scope', 'Tools']

test('§1 nothing edited: a folder the superior lacks verbatim raises nobody and shows no warning on any tab', async (t: TestContext) => {
  // the reported case: the agent holds a folder its superior does not list
  const v = await open(t, world([{ path: 'C:/boss', mode: 'rw' }], [{ path: 'D:/only-mine', mode: 'rw' }]))
  for (const tab of TABS) {
    await goto(v.el, tab)
    assert.equal(banner(v.el), null, `${tab}: a warning with nothing pending`)
    assert.equal(note(v.el), null, `${tab}: a note with nothing pending`)
  }
})

test('§2 an edited visibility: full banner on Scope, one-line note by Save elsewhere, none on Tools-only unrelated tabs', async (t: TestContext) => {
  const w = world([], [])
  w.map.get('mid')!.scope!.org_visibility = 'self'
  const v = await open(t, w)
  await goto(v.el, 'Scope')
  const sel = [...v.el.querySelectorAll<HTMLSelectElement>('select')]
    .find((s) => [...s.options].some((o) => o.value === 'full'))!
  assert.ok(sel, 'no visibility select')
  await inAct(async () => { sel.value = 'full'; sel.dispatchEvent(new Event('change', { bubbles: true })); await flush() })
  assert.ok(banner(v.el), 'Scope: the pending raise is not announced')
  assert.match(banner(v.el)!.textContent ?? '', /mid/)
  assert.equal(note(v.el), null, 'Scope shows the banner, not the note')
  await goto(v.el, 'General')
  assert.equal(banner(v.el), null, 'Charter: the full banner is noise there')
  assert.match(note(v.el)?.textContent ?? '', /mid/, 'Charter: Save must still say it raises mid')
  await goto(v.el, 'Model')
  assert.equal(banner(v.el), null)
  assert.ok(note(v.el), 'Model: the note')
  await goto(v.el, 'Tools')
  assert.ok(banner(v.el), 'Tools: the other raising tab shows the banner too')
})

test('§3 a parent folder covers a child folder (the engine rule); a ro parent does not cover rw', () => {
  const { map } = world([{ path: 'C:/', mode: 'rw' }, { path: 'E:/ro', mode: 'ro' }], [])
  const dirs = [
    { path: 'C:\\Users\\x\\scratch', mode: 'rw' },     // inside C:/ rw, other separators
    { path: 'c:/USERS/y', mode: 'ro' },                // case folds on a Windows path
    { path: 'E:/ro/sub', mode: 'ro' },                 // inside ro parent, ro want: covered
    { path: 'E:/ro/sub2', mode: 'rw' },                // ro parent, rw want: a raise
  ]
  const got = cascadePreview(map, 'leaf', { dirs })
  assert.deepEqual(got.map((g) => g.id), ['mid'])
  assert.deepEqual(got[0]!.gains, ['E:/ro/sub2 rw'], got[0]!.gains.join(', '))
})
