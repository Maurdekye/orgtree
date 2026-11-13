// settingsconflict.test.tsx: the save that would replace someone's newer change,
// in the settings that save by themselves and in the instructions editor
// (docs/rust-engine/remote-org.md, "A refused save, in the window").
//
// Run:  node tests/run.mjs settingsconflict
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { AccountsPanel } from '../src/canvas/accounts'
import { orgSettingWords } from '../src/saveconflict'
import { useSettingsAutosave } from '../src/settingsautosave'
import { setDisplayZone } from '../src/timefmt'
import type { ToastUndo } from '../src/types'

const SAM = { id: 'c-sam', name: 'Sam', on: 'Orgtree desktop (PC2)' }
const refused = (field: string, stored: unknown) => Object.assign(new Error(`Sam changed ${field} since you opened it. Nothing was saved.`), {
  status: 409, code: 'save_conflict',
  conflict: { target: 'org', fields: [{ field, stored, actor: '@user', changed_by: SAM, changed_at: '2026-11-13T14:02:00Z' }] } })

type Call = { fields: Record<string, unknown>; bases: Record<string, unknown>; over: Record<string, unknown> }

/** One setting that saves by itself, as Org settings draws its rows. */
function Effort({ server, write, toast }: { server: { default_effort: string }
  write: (call: Call) => Promise<{ warnings?: string[] }>; toast: (lines: string[] | null | undefined, undo?: ToastUndo | null) => void }) {
  const autosave = useSettingsAutosave('org', server, (fields, bases, over) => write({ fields, bases, over }), toast, orgSettingWords)
  const value = autosave.value<string>('default_effort', server.default_effort)
  return <select aria-label="Default effort" value={value} onChange={(e) => autosave.set<string>('default_effort', value)(e.target.value)}>
    {['', 'low', 'medium', 'high', 'max'].map((v) => <option key={v} value={v}>{v || 'default'}</option>)}
  </select>
}

test('a setting that saves by itself says what it was based on; someone else\'s newer value wins until "Use mine"', async (t) => {
  const calls: Call[] = []
  const toasts: { lines: string[]; undo?: ToastUndo | null }[] = []
  let answer: (call: Call) => Promise<{ warnings?: string[] }> = async () => { throw refused('default_effort', 'max') }
  const ui = (effort: string) => <Effort server={{ default_effort: effort }} toast={(lines, undo) => { if (lines?.length) toasts.push({ lines, undo }) }}
    write={(call) => { calls.push(call); return answer(call) }} />
  const view = await mountView(ui('medium'), (el) => el)
  t.after(() => view.unmount())
  const select = () => view.el.querySelector('select') as HTMLSelectElement
  const choose = (value: string) => inAct(async () => { select().value = value; select().dispatchEvent(new window.Event('change', { bubbles: true })); await flush(10) })

  await choose('low')
  assert.deepEqual(calls, [{ fields: { default_effort: 'low' }, bases: { default_effort: 'medium' }, over: {} }], 'the save names what the edit started from')
  assert.equal(toasts.length, 1)
  assert.deepEqual(toasts[0]!.lines, ['Sam set the default effort to max just now. Your change was not saved.'])
  const undo = toasts[0]!.undo
  assert.ok(undo && typeof undo === 'object' && undo.label === 'Use mine', 'the toast offers to put one\'s own value over it')
  assert.equal(select().value, 'medium', 'the cell is back on what the window was shown; the feed brings the stored value')
  // the feed brings what is stored now
  await inAct(async () => { await view.render(ui('max')); await flush(5) })
  assert.equal(select().value, 'max')
  // "Use mine": a new save of the same value, based on what the refusal said is stored
  answer = async () => ({})
  await inAct(async () => { (undo as { fn: () => void }).fn(); await flush(10) })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.fields, { default_effort: 'low' })
  assert.deepEqual(calls[1]!.over, { default_effort: 'max' }, 'no force flag: the second save names what is stored now')
  assert.equal(toasts.length, 1, 'the save went through and says nothing more')
  assert.equal(select().value, 'low')
})

test('a setting\'s stored value is said the way its row shows it', () => {
  assert.deepEqual(orgSettingWords('compact_at', 0.85), { label: 'the compaction threshold', shown: '85%' })
  assert.deepEqual(orgSettingWords('default_effort', ''), { label: 'the default effort', shown: 'none' })
  assert.deepEqual(orgSettingWords('org_name', 'Far Lab'), { label: 'the name', shown: 'Far Lab' })
  assert.deepEqual(orgSettingWords('some_new_setting', 3), { label: 'some new setting', shown: '3' })
})

// ---------------------------------------------------------------- the instructions for all orgs

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The instructions as the engine keeps them. The first save is refused: Sam saved a newer text meanwhile. */
function service() {
  let doc = { content: 'For every organization, as Sam left it.\n', rev: 'rev-sam' }
  const writes: { content: string; base_rev?: string }[] = []
  let reads = 0
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path === '/api/app-settings/instructions') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        writes.push(body)
        if (body.base_rev !== doc.rev) return json({ detail: 'Sam changed the instructions for all orgs since you opened them. Reload them and make your edit again.',
          code: 'save_conflict', conflict: { target: 'instructions', fields: [{ field: 'instructions', stored: doc.content, actor: '@user', changed_by: SAM, changed_at: '2026-11-13T14:02:00Z' }] } }, 409)
        doc = { content: body.content, rev: `rev-${writes.length}` }
        return json({ chars: [...body.content].length, rev: doc.rev, prompt_max: 16000, prompt_truncated: false, warnings: [] })
      }
      reads += 1
      // the window opened on the text as it was before Sam's save
      const shown = reads === 1 ? { content: 'For every organization.\n', rev: 'rev-old' } : doc
      return json({ content: shown.content, chars: [...shown.content].length, read_truncated: false, edit_max: 200000, prompt_max: 16000, rev: shown.rev })
    }
    if (path === '/api/app-settings/runtime') return json({ warming_enabled: true, working_checkups_enabled: true, suggest_agent_feedback_enabled: true })
    if (path === '/api/providers') return json({ providers: [] })
    if (path === '/api/accounts') return json({ accounts: [], primary: {}, keys: [], assignments: {} })
    return json({})
  }) as typeof fetch
  return { writes, stored: () => doc.content }
}

const group = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.set-group')]
  .find((g) => g.querySelector('.set-group-head')?.textContent === 'Instructions for all orgs')!
const editor = (g: HTMLElement) => g.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions for all orgs"]')!
const button = (g: HTMLElement, label: string) => [...g.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
const press = async (g: HTMLElement, label: string) => { const b = button(g, label); assert.ok(b, `no "${label}" button`); await inAct(async () => { b!.click(); await flush(20) }) }
async function type(area: HTMLTextAreaElement, value: string) {
  await inAct(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(area, value)
    area.dispatchEvent(new window.Event('input', { bubbles: true }))
    await flush(5)
  })
}
async function open() {
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="runtime" />, (el) => el)
  await inAct(async () => { await flush(20) })
  return view
}

test('the instructions editor: a newer text someone saved is shown, never replaced unseen', async () => {
  setDisplayZone('UTC')
  const svc = service()
  const view = await open()
  try {
    const g = group(view.el)
    await type(editor(g), 'For every organization, as I would have it.\n')
    await press(g, 'Save')
    const notice = () => g.querySelector('.save-conflict')
    assert.equal(notice()?.querySelector('.save-conflict-what')?.textContent, 'Sam changed the instructions for all orgs at 14:02. Nothing was saved.')
    assert.equal(button(g, 'Save'), undefined, 'the notice stands where the Save button was')
    assert.equal(editor(g).value, 'For every organization, as I would have it.\n', 'what was typed stays')
    assert.equal(svc.stored(), 'For every organization, as Sam left it.\n', 'nothing was saved')
    await press(g, 'See their version')
    assert.equal(notice()?.querySelector('.save-conflict-theirs')?.textContent, 'For every organization, as Sam left it.\n')
    // Save mine anyway: a new save based on the text that is stored now
    await press(g, 'Save mine anyway')
    assert.deepEqual(svc.writes.map((w) => w.base_rev), ['rev-old', 'rev-sam'])
    assert.equal(svc.stored(), 'For every organization, as I would have it.\n')
    assert.equal(notice(), null)
    assert.ok(button(g, 'Save'), 'the Save button is back')
  } finally { await view.unmount(); setDisplayZone(null) }
})

test('the instructions editor: Use theirs takes the stored text, Cancel keeps one\'s own', async () => {
  const svc = service()
  const view = await open()
  try {
    const g = group(view.el)
    await type(editor(g), 'Mine.\n')
    await press(g, 'Save')
    await press(g, 'Cancel')
    assert.equal(g.querySelector('.save-conflict'), null)
    assert.equal(editor(g).value, 'Mine.\n', 'Cancel leaves the editor as it is, unsaved')
    await press(g, 'Save')
    await press(g, 'See their version')
    await press(g, 'Use theirs')
    assert.equal(editor(g).value, 'For every organization, as Sam left it.\n')
    assert.equal(g.querySelector('.save-conflict'), null)
    assert.equal(svc.writes.length, 2, 'both saves were refused; taking theirs writes nothing')
    assert.equal(svc.stored(), 'For every organization, as Sam left it.\n')
  } finally { await view.unmount() }
})
