import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uniqueFileCards } from '../src/assistantMessages'
import type { ChatMessage } from '../src/types'

test('replayed deliveries across merged history pages show one card without mutating cached pages', () => {
  const row = (id: string, delivery: string): ChatMessage => ({role: 'assistant', text: '',
    tools: [{ id, name: 'orgtree_send_file', arg: 'sample.txt',
      file: {name: 'sample.txt', path: 'outbox/snapshot/sample.txt', bytes: 3, delivery_id: delivery} }]})
  const older = row('first', 'one-delivery'), latest = row('retry', 'one-delivery')
  const legacy = {role: 'user', text: '', tools: [null]} as unknown as ChatMessage
  const merged = uniqueFileCards([older, legacy, latest, row('separate', 'another-delivery')])
  assert.equal(merged.flatMap(m => m.tools ?? []).filter(t => t?.file).length, 2)
  assert.ok(latest.tools![0]!.file)
  assert.ok(uniqueFileCards([latest])[0].tools![0]!.file, 'a lost first response or a collapsed window still has its retry card')
})
