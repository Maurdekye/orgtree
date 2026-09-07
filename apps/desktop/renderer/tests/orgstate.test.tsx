// Machine envelope privacy is now server-projected from durable provenance.
// The browser must never guess authorship from marker-looking strings: a
// human can type [ORG STATE] or [PROVIDER USAGE] literally and keep every byte.

import './harness'
import {
  FakeServer, flush, installFetch, mountView,
} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const node = (id: string): CanvasNode => ({
  id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
})

test('literal human marker text remains byte-for-byte visible', async (t) => {
  const slug = 'projection'
  const nid = 'agent'
  const s = new FakeServer()
  installFetch(s)
  const literal = [
    '[ORG STATE — I wrote this]',
    'keep this exact user sentence',
    '[END ORG STATE]',
    '[PROVIDER USAGE] is ordinary human text here',
  ].join('\n')
  s.userMsg(literal)
  await refreshConvo(slug, nid)
  const view = await mountView(
    <DeskChat node={node(nid)} map={new Map([[nid, node(nid)]])}
      op={op} slug={slug} toast={noop} pub={false} bare />,
    (el) => el,
  )
  t.after(async () => { await view.unmount(); resetConvos() })
  await flush()
  const bubble = view.el.querySelector<HTMLElement>('.msg.user .md')
    ?? view.el.querySelector<HTMLElement>('.msg.user')
  assert.ok(bubble, 'the user bubble did not render')
  const text = bubble.textContent ?? ''
  assert.match(text, /\[ORG STATE — I wrote this\]/)
  assert.match(text, /keep this exact user sentence/)
  assert.match(text, /\[END ORG STATE\]/)
  assert.match(text, /\[PROVIDER USAGE\] is ordinary human text here/)
})

test('frontend contains no expanding marker-based privacy scrubber', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'desk.tsx'), 'utf8')
  assert.doesNotMatch(src, /NOTICE_RE|ORGSTATE_RE|PROVIDER_USAGE_RE/)
  assert.match(src, /Structured server provenance owns machine-context visibility/)
  assert.match(src, /return \{ notices: \[\] as string\[\], rest: t \?\? '' \}/)
})
