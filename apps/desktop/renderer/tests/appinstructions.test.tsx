// App settings > Runtime > Instructions for all orgs (USER 2026-10-31
// m187a259a848d; coordinator rulings mdd81da812d3b 7-9): the org charter's
// editor pattern, above the feedback group. The Connect your phone note is
// ordinary editable text in the block (USER 2026-10-31 13:59:20Z md088b15466fa).
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { AccountsPanel } from '../src/canvas/accounts'

const NOTE = '<!-- added by Connect your phone; Unlink removes it -->\n'
  + '@net:alex.123456 is the user\'s account and carries their authority.\n'
  + '<!-- end of the Connect your phone note -->\n'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

interface Doc { content: string; rev: string }
function service(initial: Doc, opts: { failFirstLoad?: boolean; conflict?: boolean } = {}) {
  let doc = { ...initial }
  const writes: { content: string; base_rev?: string }[] = []
  let loads = 0
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path === '/api/app-settings/instructions') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        writes.push(body)
        if (opts.conflict) return json({ detail: 'The instructions for all orgs changed since you opened them. Reload them and make your edit again.' }, 409)
        doc = { ...doc, content: body.content, rev: `rev-${writes.length + 1}` }
        return json({ chars: [...body.content].length, rev: doc.rev, prompt_max: 16000, prompt_truncated: false, warnings: [] })
      }
      loads += 1
      if (opts.failFirstLoad && loads === 1) return json({ detail: 'Synthetic load failure' }, 500)
      return json({ content: doc.content, chars: [...doc.content].length, read_truncated: false,
        edit_max: 200000, prompt_max: 16000, rev: doc.rev })
    }
    if (path === '/api/app-settings/runtime') return json({ warming_enabled: true, working_checkups_enabled: true, suggest_agent_feedback_enabled: true })
    if (path === '/api/providers') return json({ providers: [] })
    if (path === '/api/accounts') return json({ accounts: [], primary: {}, keys: [], assignments: {} })
    // Runtime's other independent groups receive synthetic empty data.
    return json({})
  }) as typeof fetch
  return { writes, loads: () => loads }
}

async function mount() {
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="runtime" />, el => el)
  await inAct(async () => { await flush(20) })
  return view
}
const group = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.set-group')]
  .find(g => g.querySelector('.set-group-head')?.textContent === 'Instructions for all orgs')
const editor = (g: HTMLElement) => g.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions for all orgs"]')!
const save = (g: HTMLElement) => g.querySelector<HTMLButtonElement>('button[aria-label="Save instructions for all orgs"]')!
async function type(area: HTMLTextAreaElement, value: string) {
  await inAct(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(area, value)
    area.dispatchEvent(new window.Event('input', { bubbles: true }))
    await flush(5)
  })
}

test('the group sits in Runtime right above the feedback group, which stays last', async () => {
  service({ content: '', rev: 'rev-1' })
  const view = await mount()
  try {
    const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-runtime') ?? view.el.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
    const groups = [...panel.querySelectorAll<HTMLElement>('.set-group')]
    const mine = group(view.el)
    assert.ok(mine, 'an "Instructions for all orgs" group in Runtime')
    const feedback = groups.findIndex(g => g.querySelector('.set-group-head')?.textContent === 'Orgtree feedback')
    assert.equal(groups.indexOf(mine!), feedback - 1, 'directly above Orgtree feedback')
    assert.match(mine!.textContent ?? '', /every agent in every organization/i)
    assert.match(mine!.textContent ?? '', /next turn/i)
    const rows = [...panel.querySelectorAll('.set-row')]
    assert.match(rows.at(-1)?.textContent ?? '', /Suggest agents to give feedback to Orgtree/)
    assert.match(mine!.textContent ?? '', /No instructions for all orgs are configured/)
  } finally { await view.unmount() }
})

test('it loads the text, keeps Save off until an edit, and saves with the loaded revision', async () => {
  const svc = service({ content: 'Keep records.\n', rev: 'rev-1' })
  const view = await mount()
  try {
    const g = group(view.el)!
    assert.ok(g, 'group rendered')
    assert.equal(editor(g).value, 'Keep records.\n')
    assert.equal(editor(g).disabled, false)
    assert.equal(save(g).disabled, true, 'nothing to save yet')
    await type(editor(g), 'Keep records.\nAnswer briefly.\n')
    assert.equal(save(g).disabled, false)
    await inAct(async () => { save(g).click(); await flush(20) })
    assert.deepEqual(svc.writes, [{ content: 'Keep records.\nAnswer briefly.\n', base_rev: 'rev-1' }])
    assert.equal(save(g).disabled, true, 'saved text is the new baseline')
    await type(editor(g), 'Third version.\n')
    await inAct(async () => { save(g).click(); await flush(20) })
    assert.equal(svc.writes[1]?.base_rev, 'rev-2', 'the next save carries the revision the last one returned')
  } finally { await view.unmount() }
})

test('a save refused because the block changed meanwhile shows why and keeps the text', async () => {
  service({ content: 'Keep records.\n', rev: 'rev-1' }, { conflict: true })
  const view = await mount()
  try {
    const g = group(view.el)!
    await type(editor(g), 'My edit.\n')
    await inAct(async () => { save(g).click(); await flush(20) })
    assert.match(g.textContent ?? '', /Unable to save the instructions for all orgs: The instructions for all orgs changed since you opened them/)
    assert.equal(editor(g).value, 'My edit.\n', 'the unsaved edit stays in the editor')
  } finally { await view.unmount() }
})

test('the Connect your phone note is ordinary text in the editor, saved like the rest', async () => {
  const svc = service({ content: NOTE + '\nKeep records.\n', rev: 'rev-1' })
  const view = await mount()
  try {
    const g = group(view.el)!
    assert.equal(g.querySelector('[aria-label="Connect your phone note"]'), null, 'no read-only copy')
    assert.doesNotMatch(g.textContent ?? '', /Connect your phone added this note/)
    assert.equal(editor(g).value, NOTE + '\nKeep records.\n', 'the editor holds the whole block')
    await type(editor(g), NOTE + '\nKeep records.\nMore.\n')
    await inAct(async () => { save(g).click(); await flush(20) })
    await type(editor(g), 'Keep records.\nMore.\n')
    await inAct(async () => { save(g).click(); await flush(20) })
    assert.deepEqual(svc.writes.map(w => w.content), [NOTE + '\nKeep records.\nMore.\n', 'Keep records.\nMore.\n'],
      'a save carries the note, and one without it removes it')
  } finally { await view.unmount() }
})

test('a failed load leaves the editor disabled with Retry, and Retry loads it', async () => {
  const svc = service({ content: 'Keep records.\n', rev: 'rev-1' }, { failFirstLoad: true })
  const view = await mount()
  try {
    const g = group(view.el)!
    assert.match(g.textContent ?? '', /Unable to load the instructions for all orgs \(Synthetic load failure\)/)
    assert.equal(editor(g).disabled, true)
    assert.equal(save(g).disabled, true)
    const retry = [...g.querySelectorAll('button')].find(b => b.textContent === 'Retry')!
    await inAct(async () => { retry.click(); await flush(20) })
    assert.equal(svc.loads(), 2)
    assert.equal(editor(g).disabled, false)
    assert.equal(editor(g).value, 'Keep records.\n')
  } finally { await view.unmount() }
})

test('the delivery warning counts the whole text, the note included', async () => {
  service({ content: NOTE, rev: 'rev-1' })
  const view = await mount()
  try {
    const g = group(view.el)!
    const room = 16000 - [...NOTE].length
    await type(editor(g), NOTE + 'x'.repeat(room))
    assert.equal(g.querySelector('.orgmd-warn'), null, 'exactly at the limit: no warning')
    await type(editor(g), NOTE + 'x'.repeat(room + 1))
    assert.match(g.querySelector('.orgmd-warn')?.textContent ?? '', /only the first 16,000 characters reach an agent/)
  } finally { await view.unmount() }
})
