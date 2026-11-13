// saveconflict.test.tsx: the save that would replace someone's newer change,
// in the agent settings form (docs/rust-engine/remote-org.md, "The save that
// would replace a newer change"). A save sends only what was edited, with
// what each edit started from; a refused save shows the notice in place of
// the Save row, and nothing that was typed is thrown away.
//
// Run:  node tests/run.mjs saveconflict
import { FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import { askFailure, submitAsk } from '../src/asksubmitted'
import { changedBy, conflictSentence, saveConflictOf, settledOf, settledSentence, valueSentence } from '../src/saveconflict'
import { setDisplayZone } from '../src/timefmt'
import type { OpResult, ProviderInfo, TreePayload } from '../src/types'

const rev = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
const SAM = { id: 'c-sam', name: 'Sam', on: 'Orgtree desktop (PC2)' }

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: {
      permission_mode: 'acceptEdits', add_dirs: [{ path: 'C:/work', mode: 'rw' }],
      tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
      org_visibility: 'team', effort: 'medium',
    },
    charter: 'the role', team_charter: '', turns: [], audiences_held: [], ...patch,
  }
}

/** `checks`: the engine that runs the organization says a save may say what it was based on. */
function tree(checks: boolean): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10, 'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 },
    max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
    ...(checks ? { capabilities: { record_changes_v1: true, attribution: true, expect: true } } : {}),
  } as TreePayload
}

const codexProvider = (): ProviderInfo => ({ id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
  status: { installed: true, connected: true, kind: 'chatgpt' }, hire_enabled: true, reason: null })

/** The scope POSTs: what each was sent, answered from `answers` in order (the last one repeats).
 *  An answer with `status` is a refusal; everything that is not the scope POST goes to the harness stub. */
function scopePosts(answers: { status?: number; body: Record<string, unknown> }[] = [{ body: { scope: {}, warnings: [] } }]) {
  const sent: Record<string, unknown>[] = []
  const real = globalThis.fetch as unknown as (url: string, init?: { body?: string }) => Promise<unknown>
  const headers = new Headers({ 'X-Orgtree-Instance': 'inst-0' })
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: { body?: string }) => {
    if (!/\/scope$/.test(String(url))) return real(url, init)
    if (init?.body) sent.push(JSON.parse(init.body))
    const answer = answers[Math.min(sent.length, answers.length) - 1]!
    return Promise.resolve(answer.status
      ? { ok: false, status: answer.status, statusText: 'Conflict', headers, json: () => Promise.resolve(answer.body) }
      : { ok: true, status: 200, headers, json: () => Promise.resolve(answer.body) })
  }
  return sent
}

const refusal = (stored: string, by: unknown = SAM) => ({ status: 409, body: {
  detail: 'Sam changed charter since you opened it. Nothing was saved.', code: 'save_conflict',
  conflict: { target: 'agent:agent', fields: [{ field: 'charter', stored, actor: '@user', changed_by: by, changed_at: '2026-11-13T14:02:00Z' }] } } })

async function mount(t: TestContext, { n = node(), checks = true, answers }: { n?: CanvasNode; checks?: boolean; answers?: Parameters<typeof scopePosts>[0] } = {}) {
  useFakeClock(); installFetch(new FakeServer())
  // after the harness stub, so the scope POSTs are answered here
  const sent = scopePosts(answers)
  setDisplayZone('UTC')
  t.after(async () => { realClock(); setDisplayZone(null) })
  let closes = 0
  const toasts: string[][] = []
  const ui = (value: CanvasNode) => <NodeConfig node={value} map={new Map([[value.id, value]])} tree={tree(checks)} slug="org"
    op={() => Promise.resolve({} as OpResult)} toast={(lines) => { if (lines?.length) toasts.push(lines) }}
    codexProvider={codexProvider()} close={() => { closes++ }} />
  const view = await mountView(ui(n), (el) => el)
  t.after(() => view.unmount())
  await flush()
  return { el: view.el, sent, toasts, closed: () => closes, show: async (value: CanvasNode) => { await view.render(ui(value)); await flush() } }
}

const act = async (fn: () => void) => { const { act } = await import('react'); await act(async () => { fn() }); await flush() }
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
const press = (el: HTMLElement, label: string) => { const b = button(el, label); assert.ok(b, `no "${label}" button`); return act(() => b!.click()) }
const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.charterbox')!
async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  await act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

test('a refusal is read off a failed request, and its sentences name who changed what', () => {
  const failed = Object.assign(new Error('x'), { status: 409, ...refusal('theirs').body })
  const conflict = saveConflictOf(failed)!
  assert.deepEqual(conflict, { target: 'agent:agent', fields: [{ field: 'charter', stored: 'theirs', actor: '@user', changed_by: SAM, changed_at: '2026-11-13T14:02:00Z' }] })
  assert.equal(saveConflictOf(new Error('boom')), null)
  assert.equal(saveConflictOf(Object.assign(new Error('x'), { code: 'history_moved' })), null)
  setDisplayZone('UTC')
  try {
    const words = (f: string) => f === 'charter' ? 'the instructions' : f
    assert.equal(conflictSentence(conflict, words, 'local'), 'Sam changed the instructions at 14:02. Nothing was saved.')
    assert.equal(conflictSentence(conflict, words, 'c-sam'), 'You changed the instructions in another window at 14:02. Nothing was saved.')
    const byAgent = { target: 'agent:agent', fields: [{ field: 'effort', stored: 'max', actor: 'lead', changed_by: null, changed_at: '2026-11-13T14:02:00Z' },
      { field: 'tools', stored: {}, actor: null, changed_by: null, changed_at: null }] }
    assert.equal(conflictSentence(byAgent, (f) => 'the ' + f, 'local'), 'lead changed the effort and 1 more at 14:02. Nothing was saved.')
    const unknown = { target: 'org', fields: [{ field: 'default_effort', stored: 'high', actor: null, changed_by: null, changed_at: null }] }
    assert.equal(conflictSentence(unknown, () => 'the default effort', 'local'), 'The default effort changed since you opened it. Nothing was saved.')
    assert.equal(changedBy(conflict.fields[0]!, 'local'), 'Sam')
    assert.equal(valueSentence(conflict.fields[0]!, 'Effort', 'high', 'local'), 'Sam set Effort to high just now. Your change was not saved.')
    assert.equal(valueSentence(unknown.fields[0]!, 'effort', 'high', 'local'), 'Effort is now high. Your change was not saved.')
  } finally { setDisplayZone(null) }
  const settled = settledOf(Object.assign(new Error('that request was already answered'), { code: 'request_settled',
    settled: { id: 'q1', status: 'answered', answer: { selected: ['Green'] }, answered_via: SAM, resolved_at: '2026-11-13T14:02:00Z' } }))
  assert.deepEqual(settled, { status: 'answered', answered_via: SAM, resolved_at: '2026-11-13T14:02:00Z' })
  assert.equal(settledOf(new Error('boom')), null)
  setDisplayZone('UTC')
  try {
    assert.equal(settledSentence(settled!, 'local'), 'Sam answered this request at 14:02. Your answer was not sent.')
    assert.equal(settledSentence(settled!, 'c-sam'), 'This request was already answered at 14:02. Your answer was not sent.')
    assert.equal(settledSentence({ status: 'withdrawn', answered_via: null, resolved_at: null }, 'local'), 'This request was already settled. Your answer was not sent.')
  } finally { setDisplayZone(null) }
})

test('an answer that came second is not "not sent, submit again": the card does not come back', async () => {
  const entry = (askId: string) => ({ slug: 'org', nid: 'lead', askId, drafts: { signature: '[]', drafts: [] }, sections: null })
  const settledFirst = Object.assign(new Error('that request was already answered'), { status: 409, code: 'request_settled',
    settled: { id: 'q-second', status: 'answered', answered_via: SAM, resolved_at: '2026-11-13T14:02:00Z' } })
  await assert.rejects(submitAsk(entry('q-second'), () => Promise.reject(settledFirst)), /already answered/)
  assert.equal(askFailure('org', 'q-second'), undefined, 'nothing to submit again')
  // any other failure still brings the card back with its error
  await assert.rejects(submitAsk(entry('q-broken'), () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal(askFailure('org', 'q-broken')?.error, 'boom')
})

test('a save sends only what was edited', async (t) => {
  const m = await mount(t)
  const sent = m.sent
  await press(m.el, 'Save')
  assert.equal(sent.length, 1, 'the save reaches the engine')
  for (const field of ['charter', 'team_charter', 'effort', 'auto_cheap_compact', 'add_dirs', 'tools', 'org_visibility', 'permission_mode', 'expect']) {
    assert.equal(field in sent[0]!, false, `${field} rode along without an edit`)
  }
})

test('an edited field is sent with what its edit started from, to an engine that checks', async (t) => {
  const m = await mount(t)
  const sent = m.sent
  await type(box(m.el), 'the role, rewritten')
  await press(m.el, 'Save')
  assert.equal(sent[0]!.charter, 'the role, rewritten')
  assert.deepEqual(sent[0]!.expect, { charter: { rev: rev('the role') } }, 'a long text is named by its revision')
  assert.equal('team_charter' in sent[0]!, false, 'the other text was not edited')
})

test('an engine that does not check is sent no expectation', async (t) => {
  const m = await mount(t, { checks: false })
  const sent = m.sent
  await type(box(m.el), 'the role, rewritten')
  await press(m.el, 'Save')
  assert.equal(sent[0]!.charter, 'the role, rewritten')
  assert.equal('expect' in sent[0]!, false)
})

test('a refused save shows the notice in place of the Save row; Cancel and Use theirs keep the form open', async (t) => {
  const m = await mount(t, { answers: [refusal('the role, as Sam left it')] })
  const sent = m.sent
  await type(box(m.el), 'the role, as I would have it')
  await press(m.el, 'Save')
  assert.equal(m.closed(), 0, 'a refused save does not close the form')
  assert.deepEqual(m.toasts, [], 'and pops no error')
  const notice = () => m.el.querySelector('.save-conflict')
  assert.equal(notice()?.querySelector('.save-conflict-what')?.textContent, 'Sam changed the instructions at 14:02. Nothing was saved.')
  assert.equal(button(m.el, 'Save'), undefined, 'the notice stands where the Save row was')
  assert.equal(box(m.el).value, 'the role, as I would have it', 'what was typed is still there')
  // Cancel: the form is as it was, unsaved
  await press(m.el, 'Cancel')
  assert.equal(notice(), null)
  assert.ok(button(m.el, 'Save'))
  assert.equal(box(m.el).value, 'the role, as I would have it')
  assert.equal(sent.length, 1, 'Cancel sends nothing')
  // again, and this time look at their version and take it
  await press(m.el, 'Save')
  await press(m.el, 'See their version')
  assert.equal(notice()?.querySelector('.save-conflict-theirs')?.textContent, 'the role, as Sam left it')
  assert.equal(box(m.el).value, 'the role, as I would have it', 'looking changes nothing')
  await press(m.el, 'Use theirs')
  assert.equal(notice(), null)
  assert.equal(box(m.el).value, 'the role, as Sam left it')
  assert.equal(m.closed(), 0)
})

test('Save mine anyway is a new save, based on what the refusal said is stored', async (t) => {
  const m = await mount(t, { answers: [refusal('the role, as Sam left it'), { body: { scope: {}, warnings: [] } }] })
  const sent = m.sent
  await type(box(m.el), 'the role, as I would have it')
  await press(m.el, 'Save')
  assert.deepEqual(sent[0]!.expect, { charter: { rev: rev('the role') } })
  await press(m.el, 'Save mine anyway')
  assert.equal(sent.length, 2)
  assert.equal(sent[1]!.charter, 'the role, as I would have it')
  assert.deepEqual(sent[1]!.expect, { charter: { rev: rev('the role, as Sam left it') } }, 'no force flag: the second save names what is stored now')
  assert.equal(m.closed(), 1, 'the save went through')
})

test('a text being edited says so at once when the stored text changes underneath', async (t) => {
  const m = await mount(t)
  const under = () => m.el.querySelector('.save-conflict-under')
  // someone else's change to a text nobody is editing here is simply shown
  await m.show(node({ charter: 'the role, changed by someone' }))
  assert.equal(under(), null)
  assert.equal(box(m.el).value, 'the role, changed by someone')
  // now this window edits it, and it changes underneath again
  await type(box(m.el), 'my edit')
  assert.equal(under(), null, 'an edit alone says nothing')
  await m.show(node({ charter: 'the role, changed again' }))
  assert.equal(box(m.el).value, 'my edit', 'what was typed stays')
  assert.match(under()?.textContent ?? '', /^This changed while you were editing\./)
  await press(m.el, 'See the new value')
  assert.equal(under()?.querySelector('.save-conflict-theirs')?.textContent, 'the role, changed again')
})
