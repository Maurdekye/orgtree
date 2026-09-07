// A Codex hire knows its provider while it is still the dashed
// "uninitialized" draft. Pin that provider class before a TreeNode or session
// exists, so the card never flashes Claude terracotta before turning teal.

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftNode } from '../src/canvas/cards'
import type { DraftState } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const tree = { cascade_hire: true } as unknown as TreePayload

async function draft(tier: string) {
  const state: DraftState = { parent: null, tier }
  return mountView(
    <DraftNode pos={{ x: 0, y: 0 }} draft={state} map={new Map()}
      seats={{ haiku: 1, sol: 5 }} maxTop={100} defaultTop={0}
      kioskRemaining={null} tree={tree} zoom={1} pxc={1}
      onConfirm={noop} onCancel={noop} />,
    (el) => el.querySelector('.sq.draft')!,
  )
}

test('an uninitialized Sol hire carries the OpenAI provider theme', async () => {
  const view = await draft('sol')
  const card = view.last()
  assert.ok(card.classList.contains('prov-openai'),
    'the Codex draft fell back to Claude terracotta before initialization')
  assert.equal(card.querySelector('.draft-tag')?.textContent, 'uninitialized')
  assert.equal(card.querySelector('.tier')?.textContent, 'S')
})

test('an uninitialized Claude hire does not carry the OpenAI theme', async () => {
  const view = await draft('haiku')
  const card = view.last()
  assert.equal(card.classList.contains('prov-openai'), false,
    'the provider class leaked from Codex drafts onto Claude drafts')
})
