// openreference.test.tsx — an orgtree:// link's reference (Hubchat's Orgtree
// mention chips, docs/rust-engine/orgtree-links.md) opened in its org's own
// window through the SAME routes the shell's chips use. Main reveals the
// window and hands it a held `open-reference` event; this is the window's half.
//
// Run:  node apps/desktop/renderer/tests/run.mjs openreference
import { createElement, flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { HELD_TYPES, resetHeldEvents, startHeldEvents } from '../src/events/heldbus'
import { linkedReference, useLinkedReference } from '../src/canvas/openreference'
import type { TypedRef } from '../src/canvas/workrefs'

declare const __SRC_DIR__: string
const src = (p: string) => fs.readFileSync(path.join(__SRC_DIR__, p), 'utf8')

type Nativeish = { type: string; data?: unknown }
/** The real bridge's shape: `onEvent` is the ack that drains the held queue. */
function fakeBridge(held: Nativeish[]) {
  const listeners = new Set<(event: Nativeish) => void>()
  let queue = [...held]
  const bridge = {
    onEvent(fn: (event: Nativeish) => void) {
      listeners.add(fn)
      const drained = queue
      queue = []
      for (const e of drained) for (const l of [...listeners]) l(e)
      return () => { listeners.delete(fn) }
    },
    async takePendingWindowEvents() { const drained = queue; queue = []; return drained },
    send(event: Nativeish) { for (const l of [...listeners]) l(event) },
  }
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = bridge
  return bridge
}

test('the reference must be one canonical token of this window\'s own org', () => {
  assert.ok((HELD_TYPES as readonly string[]).includes('open-reference'), 'held until the window listens')
  assert.deepEqual(linkedReference({ org: 'alpha', token: '@item:alpha/one' }, 'alpha'),
    { kind: 'item', org: 'alpha', id: 'one' })
  assert.deepEqual(linkedReference({ org: 'alpha', token: '@mail:alpha/node/luna/ab12' }, 'alpha'),
    { kind: 'mail', org: 'alpha', box: 'node', node: 'luna', id: 'ab12' })
  for (const [data, org] of [
    [{ org: 'alpha', token: '@item:beta/one' }, 'alpha'],
    [{ org: 'beta', token: '@item:beta/one' }, 'alpha'],
    [{ org: 'alpha', token: '@item:alpha/one/extra' }, 'alpha'],
    [{ org: 'alpha', token: 'orgtree://item/alpha/one' }, 'alpha'],
    [{ org: 'alpha', token: ' @item:alpha/one' }, 'alpha'],
    [{ org: 'alpha' }, 'alpha'], [{ token: '@item:alpha/one' }, 'alpha'], [null, 'alpha'], ['@item:alpha/one', 'alpha'],
    [{ org: 'alpha', token: '@item:alpha/one' }, null],
  ] as [unknown, string | null][])
    assert.equal(linkedReference(data, org), null, JSON.stringify([data, org]))
})

test('it waits for this org\'s tree, then opens through the chips\' own routes, once', async () => {
  resetHeldEvents()
  const bridge = fakeBridge([{ type: 'open-reference', data: { org: 'alpha', token: '@agent:alpha/luna' } }])
  startHeldEvents()
  const opened: TypedRef[] = []
  function Probe({ treeOrg }: { treeOrg: string | null }) {
    useLinkedReference('alpha', treeOrg, ref => { opened.push(ref) })
    return null
  }
  const view = await mountView(createElement(Probe, { treeOrg: null }), () => opened.length)
  assert.equal(opened.length, 0, 'not before the tree arrives: the canvas cannot centre on a card it has not laid out')
  await view.render(createElement(Probe, { treeOrg: 'beta' }))
  assert.equal(opened.length, 0, 'nor on another org\'s tree')
  await view.render(createElement(Probe, { treeOrg: 'alpha' }))
  assert.deepEqual(opened, [{ kind: 'agent', org: 'alpha', id: 'luna' }])
  await view.render(createElement(Probe, { treeOrg: 'alpha' }))
  assert.equal(opened.length, 1, 'once')
  // a link arriving while the window is already showing its tree opens at once
  bridge.send({ type: 'open-reference', data: { org: 'alpha', token: '@doc:alpha/d1' } })
  await flush()
  await view.render(createElement(Probe, { treeOrg: 'alpha' }))
  assert.deepEqual(opened.at(-1), { kind: 'doc', org: 'alpha', id: 'd1' })
  // another org's reference never reaches this window's routes
  bridge.send({ type: 'open-reference', data: { org: 'beta', token: '@doc:beta/d2' } })
  await flush()
  await view.render(createElement(Probe, { treeOrg: 'alpha' }))
  assert.equal(opened.length, 2)
  await view.unmount()
  resetHeldEvents()
  delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
})

test('the org window opens it with the gallery\'s own chip routes', () => {
  const app = src('App.tsx')
  assert.match(app, /useLinkedReference\(slug, tree\?\.slug, ref => galleryRefs\.onOpen\(resolveRef\(ref, galleryRefs\.world\)\)\)/)
})
