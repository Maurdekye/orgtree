// The redesigned org Connections tab — the organization's OWN side of mail
// on the hub's real model: an owned address (secret revealed only on
// request, never rendered unasked), the V1 status ladder, the stuck-mail
// rollup, and destructive actions that state their scope first.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { Connections } from '../src/canvas/connections'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

const NET = {
  slug: 'acme.user.a1b2c3',
  hubs: [
    { id: 'local', address: 'http://127.0.0.1:7370', enabled: true, name: 'desk',
      connected: true, queued: 0, roster: [
        { slug: 'other.user.d4e5f6', org_name: 'Other', online: true, kind: 'org' },
        { slug: 'notes.user.778899', org_name: 'Notes', online: false, kind: 'chat' },
      ] },
    { id: 'r1', address: 'http://far.example:7370', enabled: true, name: null,
      connected: false, error: 'ConnectTimeout', queued: 3, stuck: 2,
      stuck_err: 'hub unreachable — ConnectTimeout', roster: [] },
  ],
} as unknown as TreePayload['net']

const TREE = { slug: 'acme', net: NET } as unknown as TreePayload

function Fixture({ tree }: { tree: TreePayload }) {
  const [adding, setAdding] = useState('')
  return <Connections tree={tree} toast={() => {}} adding={adding} setAdding={setAdding} />
}

test('the secret appears only after an explicit reveal, from the reveal endpoint', async () => {
  const urls: string[] = []
  g.fetch = async (input: unknown) => {
    urls.push(String(input))
    return new Response(JSON.stringify({
      identity: { secret: 'deadbeef'.repeat(4), fingerprint: 'f'.repeat(64), slug: NET!.slug, minted_at: 'now' },
      hubs: [], autoconnect: true,
    }), { headers: { 'Content-Type': 'application/json' } })
  }
  const view = await mountView(<Fixture tree={TREE} />, el => el)
  try {
    assert.doesNotMatch(view.el.textContent!, /deadbeef/, 'the secret is never rendered unasked')
    assert.match(view.el.textContent!, /acme\.user\.a1b2c3/)
    assert.match(view.el.textContent!, /losing it loses the address/i)
    const reveal = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => /Reveal secret/.test(b.textContent || ''))!
    await inAct(async () => { reveal.click(); await flush(8) })
    assert.ok(urls.some(u => u.includes('/api/orgs/acme/net')))
    assert.match(view.el.textContent!, /deadbeef/)
    const hide = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Hide')!
    await inAct(async () => { hide.click(); await flush(2) })
    assert.doesNotMatch(view.el.textContent!, /deadbeef/)
  } finally { await view.unmount(); delete g.fetch }
})

test('hub rows speak the real ladder and surface stuck mail with its reason', async () => {
  const view = await mountView(<Fixture tree={TREE} />, el => el)
  try {
    const text = view.el.textContent!
    assert.match(text, /Connected/)                       // the healthy hub
    assert.match(text, /Retrying — ConnectTimeout/)       // the failing one, with WHY
    assert.match(text, /3 queued/)
    assert.match(text, /⚠ 2 failing — hub unreachable/)   // the rollup
    assert.match(text, /connect to this computer's mail hub/)
    assert.match(text, /Other/)
    assert.match(text, /\(chat\)/)                        // kinds stay visible
    assert.match(text, /Online/)
  } finally { await view.unmount() }
})

test('removing a working connection states its scope first; cancel changes nothing', async () => {
  const asked: string[] = []
  const confirm = window.confirm
  window.confirm = (message?: string) => { asked.push(String(message)); return false }
  let saved = 0
  g.fetch = async () => { saved += 1; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }) }
  const view = await mountView(<Fixture tree={TREE} />, el => el)
  try {
    const remove = [...view.el.querySelectorAll<HTMLButtonElement>('button[title="Remove connection"]')].at(-1)!
    await inAct(async () => { remove.click(); await flush(4) })
    assert.equal(asked.length, 1)
    assert.match(asked[0]!, /3 queued outgoing message/)
    assert.equal(saved, 0, 'cancelling the confirm must not write anything')
  } finally { await view.unmount(); window.confirm = confirm; delete g.fetch }
})
