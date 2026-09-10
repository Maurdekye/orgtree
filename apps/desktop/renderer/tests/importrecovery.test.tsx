import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ImportRecovery } from '../src/canvas/importrecovery'
import type { RecoveryNode, RecoveryState } from '../src/canvas/importrecovery'

const row = (node: string, phase: string): RecoveryNode => ({ node, attempt: `attempt-${node}`, phase,
  identity: { generation: 3, session_id: `session-${node}` }, intent: { text: `Original work for ${node}`, view: 'original pending mail' } })
const settle = () => inAct(async () => { await flush(18) })
const button = (el: ParentNode, text: string) => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => (b.getAttribute('aria-label') || b.textContent) === text)
  assert.ok(found, text); return found
}
async function click(el: ParentNode, text: string) { await inAct(async () => { button(el, text).click(); await flush(18) }) }
async function note(el: ParentNode, value = 'I reviewed the original intent and current work.') {
  const field = el.querySelector('textarea')!
  assert.ok(field)
  await inAct(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function acknowledge(el: ParentNode) { await inAct(() => { el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() }) }
const agent = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-agent="${id}"]`)!
function server(states: Record<string, RecoveryState>, resolve: (body: any) => unknown | Promise<unknown>) {
  const posts: any[] = [], reads: string[] = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path === '/api/orgs') return new Response(JSON.stringify(Object.keys(states).map(slug => ({ slug, name: slug }))))
    const slug = path.split('/')[4]!
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); posts.push(body); return new Response(JSON.stringify(await resolve(body))) }
    reads.push(slug)
    return new Response(JSON.stringify(states[slug]))
  }
  return { posts, reads }
}

test('Settings discovers unresolved rows after mount; only proven holds can retry and uncertainty requires reviewed continuation', async () => {
  const original = globalThis.fetch
  const states = { first: { pending: true, phase: 'uncertain', nodes: [row('held-agent', 'held'), row('unknown-agent', 'uncertain'), row('accepted-agent', 'admitted')] },
    ordinary: { pending: false, phase: 'none', nodes: [] } }
  const seen = server(states, body => {
    const selected = states.first.nodes.find(n => n.node === body.nodes[0].node)!
    selected.phase = 'handled'
    return { pending: true, results: [{ node: selected.node, attempt: selected.attempt, phase: 'handled' }] }
  })
  const v = await mountView(<ImportRecovery />, el => el)
  try {
    await settle()
    assert.deepEqual(seen.reads.sort(), ['first', 'ordinary'])
    assert.equal(seen.posts.length, 0, 'discovery never dispatches work')
    const held = agent(v.el, 'held-agent'), unknown = agent(v.el, 'unknown-agent')
    assert.ok(held && unknown, 'both real unresolved rows are visible')
    assert.match(unknown.textContent!, /Original work for unknown-agent/)
    assert.match(unknown.textContent!, /attempt-unknown-agent.*Generation: 3.*session-unknown-agent/s)
    assert.equal([...unknown.querySelectorAll('button')].some(b => b.textContent === 'Retry'), false)
    assert.equal(agent(v.el, 'accepted-agent').querySelector('button'), null, 'admitted work is not retried')
    await click(unknown, 'Continue after review')
    assert.equal(button(unknown, 'Confirm continuation').disabled, true)
    await note(unknown)
    assert.equal(button(unknown, 'Confirm continuation').disabled, true, 'note alone is not acknowledgment')
    await acknowledge(unknown)
    await click(unknown, 'Confirm continuation')
    assert.deepEqual(seen.posts[0], { nodes: [{ node: 'unknown-agent', attempt: 'attempt-unknown-agent', expected_phase: 'uncertain' }],
      action: 'continue', acknowledge_duplicate_work: true, note: 'I reviewed the original intent and current work.' })
    assert.equal(agent(v.el, 'unknown-agent').querySelector('button'), null, 'fresh handled state replaces the old actionable row')
    await click(agent(v.el, 'held-agent'), 'Retry'); await note(agent(v.el, 'held-agent')); await acknowledge(agent(v.el, 'held-agent'))
    await click(agent(v.el, 'held-agent'), 'Confirm retry')
    assert.equal(seen.posts[1].action, 'retry')
    assert.equal(seen.posts[1].nodes[0].expected_phase, 'held')
  } finally { await v.unmount(); globalThis.fetch = original }
})

test('lost resolution response disables actions until explicit GET refresh and restart never repeats the POST', async () => {
  const original = globalThis.fetch
  const states = { imported: { pending: true, phase: 'uncertain', nodes: [row('agent', 'uncertain')] } }
  const seen = server(states, () => { throw Error('response lost') })
  let v = await mountView(<ImportRecovery />, el => el)
  try {
    await settle()
    await click(agent(v.el, 'agent'), 'Mark handled')
    assert.match(v.el.textContent!, /without dispatching any work/)
    await click(agent(v.el, 'agent'), 'Cancel review')
    assert.equal(seen.posts.length, 0)
    await click(agent(v.el, 'agent'), 'Mark handled'); await note(v.el); await acknowledge(v.el)
    await click(v.el, 'Confirm mark handled')
    assert.equal(seen.posts.length, 1)
    assert.equal(seen.posts[0].action, 'mark-handled', 'engine receives no dispatch action')
    assert.match(v.el.textContent!, /outcome is not confirmed.*The request was not repeated/s)
    assert.ok([...agent(v.el, 'agent').querySelectorAll('button')].every(b => b.disabled))
    const workingFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => String(url).endsWith('/recovery')
      ? new Response(JSON.stringify({ detail: 'Recovery temporarily unavailable' }), { status: 503 }) : workingFetch(url, init)
    await click(v.el, 'Refresh recovery')
    assert.match(v.el.textContent!, /503|Recovery temporarily unavailable/)
    assert.ok(![...v.el.querySelectorAll<HTMLButtonElement>('button')].some(b =>
      ['Retry', 'Mark handled', 'Continue after review'].includes(b.textContent!) && !b.disabled), 'failed GET cannot restore stale actions')
    assert.equal(seen.posts.length, 1, 'failed refresh never repeats a resolution')
    globalThis.fetch = workingFetch
    await click(v.el, 'Refresh recovery')
    assert.equal(seen.posts.length, 1, 'refresh is GET only')
    assert.equal(button(agent(v.el, 'agent'), 'Continue after review').disabled, false)
    await v.unmount(); v = await mountView(<ImportRecovery />, el => el); await settle()
    assert.match(v.el.textContent!, /result cannot be established, including after a restart/)
    assert.equal(seen.posts.length, 1, 'remount never retries an old resolution')
    await click(agent(v.el, 'agent'), 'Continue after review')
    assert.equal(v.el.querySelector<HTMLTextAreaElement>('textarea')!.value, '', 'review authorization is not restored silently')
  } finally { await v.unmount(); globalThis.fetch = original }
})

test('per-node refusal remains visible and fresh phase prevents repeating stale retry', async () => {
  const original = globalThis.fetch
  const states = { imported: { pending: true, phase: 'held', nodes: [row('agent', 'not-dispatched')] } }
  const seen = server(states, () => {
    states.imported.nodes[0]!.phase = 'uncertain'
    return { pending: true, results: [{ node: 'agent', attempt: 'attempt-agent', phase: 'uncertain', error: 'Attempt phase changed; review current state.' }] }
  })
  const v = await mountView(<ImportRecovery />, el => el)
  try {
    await settle(); await click(agent(v.el, 'agent'), 'Retry'); await note(v.el); await acknowledge(v.el); await click(v.el, 'Confirm retry')
    assert.match(v.el.textContent!, /Attempt phase changed; review current state/)
    assert.equal([...agent(v.el, 'agent').querySelectorAll('button')].some(b => b.textContent === 'Retry'), false)
    assert.equal(seen.posts.length, 1)
  } finally { await v.unmount(); globalThis.fetch = original }
})


test('recovery discovery is inactive in hidden settings and bounds simultaneous status reads', async () => {
  const original = globalThis.fetch
  let reads = 0, current = 0, peak = 0
  const waiting: (() => void)[] = []
  globalThis.fetch = async url => {
    if (String(url) === '/api/orgs') return new Response(JSON.stringify(['one', 'two', 'three'].map(slug => ({ slug, name: slug }))))
    reads++; current++; peak = Math.max(peak, current)
    await new Promise<void>(resolve => { waiting.push(() => { current--; resolve() }) })
    return new Response(JSON.stringify({ pending: false, phase: 'none', nodes: [] }))
  }
  let v = await mountView(<ImportRecovery active={false} />, el => el)
  try {
    await settle(); assert.equal(reads, 0)
    await v.unmount(); v = await mountView(<ImportRecovery />, el => el); await settle()
    assert.equal(reads, 2, 'active positive control fills both worker slots')
    assert.equal(current, 2)
    await inAct(async () => { waiting.shift()!(); await flush(12) })
    assert.equal(reads, 3, 'next organization is checked when a slot opens')
    assert.equal(peak, 2)
    await inAct(async () => { waiting.splice(0).forEach(release => release()); await flush(12) })
    assert.match(v.el.textContent!, /No imported work needs review/)
  } finally { waiting.splice(0).forEach(release => release()); await v.unmount(); globalThis.fetch = original }
})
