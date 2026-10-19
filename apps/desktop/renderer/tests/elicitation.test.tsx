import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AskCard } from '../src/canvas/asks'
import { openAsks } from '../src/canvas/openasks'
import type { AskInfo, TreeNode } from '../src/types'

import { elicitationFixture } from './elicitation-fixture'
const originalFetch = globalThis.fetch
const requests: { url: string; body: Record<string, unknown> }[] = []
test.beforeEach(() => {
  requests.length = 0
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ answered: 'synthetic', node: 'synthetic-agent' }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
})
test.afterEach(() => { globalThis.fetch = originalFetch })
const mount = (ask = elicitationFixture()) => mountView(<AskCard ask={ask} slug="fixture" toast={() => {}} />, el => el)

test('elicitation submits typed values and explicit consent on the existing answer endpoint', async () => {
  const view = await mount()
  try {
    assert.equal(requests.length, 0, 'rendering never decides a permission')
    const form = document.querySelector('form[data-elicitation-id]')!
    assert.deepEqual([...form.querySelectorAll('button')].map(b => b.textContent), ['Accept', 'Decline', 'Cancel'])
    await inAct(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(3) })
    assert.equal(requests[0]?.url, '/api/orgs/fixture/asks/elicitation-synthetic/answer')
    assert.deepEqual(requests[0]?.body, { action: 'accept', content: { allow: false, visits: 2, policy: 'once', pages: ['home'] } })
  } finally { await view.unmount() }
})

test('elicitation Decline and Cancel send only the explicit action', async () => {
  for (const [label, action] of [['Decline', 'decline'], ['Cancel', 'cancel']]) {
    const view = await mount(elicitationFixture('elicitation-' + action))
    try {
      await inAct(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === label)!.click(); await flush(3) })
      assert.deepEqual(requests.at(-1)?.body, { action })
    } finally { await view.unmount() }
  }
})

test('URL elicitation displays a user-open link and never opens or requests it automatically', async () => {
  const ask = elicitationFixture(); ask.elicitation = { ...ask.elicitation!, mode: 'url', url: 'https://example.invalid/permission', schema: undefined }
  const view = await mount(ask)
  try {
    assert.equal(requests.length, 0)
    assert.equal(document.querySelector('a')?.href, 'https://example.invalid/permission')
    assert.equal(document.querySelectorAll('input,select').length, 0)
    await inAct(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(3) })
    assert.deepEqual(requests[0]?.body, { action: 'accept' })
  } finally { await view.unmount() }
})

test('Attention retains simultaneous MCP requests alongside the ordinary agent ask', () => {
  const ordinary: AskInfo = { id: 'ordinary', node: 'synthetic-agent', kind: 'batch', status: 'open', at: 'now', tabs: [{ kind: 'question', question: 'Ordinary work?' }] }
  const requests = [elicitationFixture('elicitation-a'), elicitationFixture('elicitation-b')]
  assert.deepEqual(openAsks({ asks: [ordinary, ...requests] }, [{ id: 'synthetic-agent', ask: ordinary } as TreeNode]).map(a => a.id).sort(), ['elicitation-a', 'elicitation-b', 'ordinary'])
})
