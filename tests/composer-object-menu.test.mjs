import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Cheap control executes the canonical menu builder, with only its TypeScript
// parameter annotation removed. No renderer bundle, engine or live data.
test('ticket menu offers Reply beside Mention only when a composer supplies it', () => {
  const source = readFileSync(new URL('../apps/desktop/renderer/src/canvas/objectactions.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function ticketReferenceActions(')
  const end = source.indexOf('\n/**', start + 1)
  const fn = source.slice(start, end).replace('export ', '')
    .replace(/\}: \{[\s\S]*?\}\): MenuEntry\[\]/, '})')
    .replace("'sep' as const", "'sep'")
  const build = vm.runInNewContext(`(${fn})`)
  const noop = () => {}
  const plain = { open: noop, copyTitle: noop, copySlug: noop }
  const labels = entries => Array.from(entries, e => e === 'sep' ? e : e.label)
  assert.deepEqual(labels(build({ ...plain, mention: noop, reply: noop })).slice(0, 2), ['Mention', 'Reply'])
  assert.equal(labels(build(plain)).includes('Reply'), false)
})
