// settingssave.test.tsx — ONE press of Save applies the change and closes the agent settings, whatever was edited.
//
// USER 2026-10-31 10:21:55Z m081c587978bf, verbatim: "if i change the effort of an agent through its settings panel, when i
// clikc save the panel doesnt close immediately; i have to click it a second time". Cause (engine, docket
// agent-settings-save-after-an-effort-change-needs): the scope save was answered only after the engine had closed and
// re-warmed the agent's idle CLI, so the panel sat open for seconds with a Save that looked dead; the second press sent an
// unchanged effort, which answers at once. The engine now answers first (runtime/actor.rs answer_then). The panel's part,
// pinned here: while a Save is in flight the button says so and is disabled, a second press sends nothing, and the panel
// closes exactly once when the answer arrives; and every field closes on its one press, in both save paths (the plain
// scope POST and the undo-history gesture POST).
import { FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, ProviderInfo, TreePayload } from '../src/types'

function node(): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [{ path: 'C:/work', mode: 'rw' }],
      tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, org_visibility: 'team', effort: 'medium' },
    charter: 'the role', team_charter: '', turns: [], audiences_held: [],
  }
}
const tree = (history: boolean): TreePayload => ({
  slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10, 'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 },
  max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
  ...(history ? { undo_history: { rev: 1, undo: null, redo: null } } : {}),
}) as unknown as TreePayload
const codexProvider = (): ProviderInfo => ({ id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
  status: { installed: true, connected: true, kind: 'chatgpt' }, hire_enabled: true, reason: null })

/** the save POSTs (/scope, or /gesture under undo history); each answers when `release()` runs, or at once when `hold` is false */
function savePosts(hold: boolean) {
  const sent: Record<string, unknown>[] = []
  const waiting: (() => void)[] = []
  const real = globalThis.fetch as unknown as (url: string, init?: { body?: string }) => Promise<unknown>
  const headers = new Headers({ 'X-Orgtree-Instance': 'inst-0' })
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: { body?: string }) => {
    const u = String(url)
    if (!/\/(scope|gesture)$/.test(u)) return real(url, init)
    if (init?.body) sent.push(JSON.parse(init.body))
    const answer = u.endsWith('/gesture') ? { results: [{ scope: {}, warnings: [] }] } : { scope: {}, warnings: [] }
    return new Promise((resolve) => {
      const done = () => resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(answer) })
      if (hold) waiting.push(done); else done()
    })
  }
  return { sent, release: () => { while (waiting.length) waiting.shift()!() } }
}

async function mount(history: boolean, close: () => void) {
  const n = node()
  const view = await mountView(
    <NodeConfig node={n} map={new Map<string, CanvasNode>([[n.id, n]])} tree={tree(history)} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={() => {}} codexProvider={codexProvider()} close={close} />, (el) => el)
  await flush()
  return view.el
}
const saveButton = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('button.primary')]
  .find((x) => /^Sav/.test(x.textContent?.trim() ?? ''))!
async function press(el: HTMLElement) {
  const { act } = await import('react')
  await act(async () => { saveButton(el).click() })
  await flush()
}
async function pickEffort(el: HTMLElement, level: number) {
  const { act } = await import('react')
  const t = el.querySelector('.effort-bar-track') as HTMLElement
  assert.ok(t, 'no effort bar')
  t.getBoundingClientRect = () => ({ left: 0, top: 0, right: 140, bottom: 24, width: 140, height: 24, x: 0, y: 0, toJSON() {} }) as DOMRect
  const x = 10 + 120 * (level / 4)
  const fire = (type: string) => act(async () => {
    t.dispatchEvent(new (t.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      type, { bubbles: true, cancelable: true, clientX: x, button: 0 }))
  })
  await fire('pointerdown'); await fire('pointerup')
}
async function choose(el: HTMLElement, value: string, to: string) {
  const { act } = await import('react')
  const s = [...el.querySelectorAll<HTMLSelectElement>('select')].find((x) => [...x.options].some((o) => o.value === value))
  assert.ok(s, `no select offers ${value}`)
  await act(async () => { s!.value = to; s!.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function toggle(el: HTMLElement, label: string) {
  const { act } = await import('react')
  const box = el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  assert.ok(box, `no ${label} switch`)
  await act(async () => { box!.click() })
}
async function typeCharter(el: HTMLElement) {
  const { act } = await import('react')
  const ta = [...el.querySelectorAll<HTMLTextAreaElement>('textarea')].find((x) => x.value === 'the role')
  assert.ok(ta, 'no charter box')
  await act(async () => {
    const win = ta!.ownerDocument.defaultView as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }
    const set = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(ta, 'the role, edited'); ta!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const EDITS: [string, (el: HTMLElement) => Promise<void>][] = [
  ['effort only', (el) => pickEffort(el, 2)],
  ['visibility', (el) => choose(el, 'full', 'full')],
  ['permission mode', (el) => choose(el, 'bypassPermissions', 'default')],
  ['a tool', (el) => toggle(el, 'Run commands')],
  ['the instructions', typeCharter],
]

for (const history of [false, true]) {
  for (const [name, edit] of EDITS) {
    test(`§1 one press of Save sends once and closes once: ${name}; history=${history}`, async (t: TestContext) => {
      useFakeClock(); installFetch(new FakeServer())
      t.after(() => { realClock() })
      const posts = savePosts(false)
      let closed = 0
      const el = await mount(history, () => { closed++ })
      await edit(el)
      await press(el)
      assert.equal(posts.sent.length, 1, 'one save POST')
      assert.equal(closed, 1, 'the panel closed on the one press')
    })
  }

  test(`§2 while the save is in flight the button says Saving..., is disabled and a second press sends nothing; history=${history}`, async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    t.after(() => { realClock() })
    const posts = savePosts(true)
    let closed = 0
    const el = await mount(history, () => { closed++ })
    assert.equal(saveButton(el).textContent, 'Save', 'positive control: idle label')
    assert.equal(saveButton(el).disabled, false)
    await pickEffort(el, 2)
    await press(el)
    assert.equal(posts.sent.length, 1)
    assert.equal(closed, 0, 'the panel waits for the answer')
    assert.equal(saveButton(el).textContent, 'Saving...', 'the button says a save is running')
    assert.equal(saveButton(el).disabled, true, 'and takes no second press')
    await press(el)
    assert.equal(posts.sent.length, 1, 'a second press sent nothing')
    const { act } = await import('react')
    await act(async () => { posts.release() })
    await flush()
    assert.equal(posts.sent.length, 1)
    assert.equal(closed, 1, 'closed once, on the answer')
  })
}
