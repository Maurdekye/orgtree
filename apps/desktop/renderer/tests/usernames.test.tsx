// User-entered canvas names normalize spaces before the existing validation.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftNode } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { normalizeUserEnteredName } from '../src/canvas/nameinput'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const tree = { slug: 'name-test', name: 'name-test', roots: [], dirs: [], tiers: { haiku: 1 },
  default_top_grant: 0, max_top_grant: 10, cascade_hire: true,
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
  default_visibility: 'team', default_tools: {} } as unknown as TreePayload
const anchor = { id: 'boss', title: 'boss', state: 'live', tier: 'haiku', model_id: 'haiku',
  parent: 'user', children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [] }, seat: 1, grant: 0, free: 0 } as unknown as CanvasNode

async function enter(input: HTMLInputElement, value: string) {
  await inAct(async () => {
    const inputWindow = input.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(inputWindow.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  })
}

test('UI name normalization trims ends and collapses space runs without hiding other invalid characters', () => {
  assert.equal(normalizeUserEnteredName('  Front   End  '), 'Front-End')
  assert.equal(normalizeUserEnteredName('  bad/name  '), 'bad/name')
  assert.equal(normalizeUserEnteredName('   '), '')
})

test('manual canvas draft displays the normalized name and submits that same value', async (t) => {
  installFetch(new FakeServer())
  let submitted = ''
  const view = await mountView(<DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }}
    tree={tree} seats={tree.tiers!} map={new Map()} maxTop={10} defaultTop={0} zoom={1} pxc={1}
    onConfirm={(name) => { submitted = name }} onCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const input = view.el.querySelector<HTMLInputElement>('.df-name')!
  await enter(input, '  Front   End  ')
  assert.equal(input.value, 'Front-End', 'the text field shows what will be submitted')
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.df-foot button.primary')!.click(); await flush() })
  assert.equal(submitted, 'Front-End')
})

test('manual canvas draft preserves a space while the name is typed incrementally', async (t) => {
  installFetch(new FakeServer())
  let submitted = ''
  const view = await mountView(<DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }}
    tree={tree} seats={tree.tiers!} map={new Map()} maxTop={10} defaultTop={0} zoom={1} pxc={1}
    onConfirm={(name) => { submitted = name }} onCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const input = view.el.querySelector<HTMLInputElement>('.df-name')!

  await enter(input, 'Front')
  await enter(input, 'Front ')
  assert.equal(input.value, 'Front ', 'a trailing space remains visible while editing')
  await enter(input, 'Front End')
  assert.equal(input.value, 'Front End', 'the user can type the next word after the separator')
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.df-foot button.primary')!.click(); await flush() })
  assert.equal(submitted, 'Front-End')
})

test('hire sheet lowercases and displays the normalized user-entered name before hiring', async (t) => {
  installFetch(new FakeServer())
  let hired = ''
  const view = await mountView(<HireSheet anchor={anchor} seats={{ haiku: 1 }}
    claudeHire={{ enabled: true, installed: true, reason: null }} defaultGrant={0}
    onHire={(_tier, name) => { hired = name }} onClose={noop} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  const input = document.querySelector<HTMLInputElement>('.hire-sheet input:not([type="number"])')!
  await enter(input, '  Front   End  ')
  assert.equal(input.value, 'front-end', 'the existing lowercase rule still applies')
  const hire = [...document.querySelectorAll<HTMLButtonElement>('.hire-sheet button')].find((b) => b.textContent === 'hire')!
  await inAct(async () => { hire.click(); await flush() })
  assert.equal(hired, 'front-end')
})

test('hire sheet preserves a separator while the name is typed incrementally', async (t) => {
  installFetch(new FakeServer())
  let hired = ''
  const view = await mountView(<HireSheet anchor={anchor} seats={{ haiku: 1 }}
    claudeHire={{ enabled: true, installed: true, reason: null }} defaultGrant={0}
    onHire={(_tier, name) => { hired = name }} onClose={noop} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  const input = document.querySelector<HTMLInputElement>('.hire-sheet input:not([type="number"])')!

  await enter(input, 'front')
  await enter(input, 'front ')
  assert.equal(input.value, 'front ', 'a trailing space remains visible while editing')
  await enter(input, 'front end')
  assert.equal(input.value, 'front end', 'the user can type the next word after the separator')
  const hire = [...document.querySelectorAll<HTMLButtonElement>('.hire-sheet button')].find((b) => b.textContent === 'hire')!
  await inAct(async () => { hire.click(); await flush() })
  assert.equal(hired, 'front-end')
})
