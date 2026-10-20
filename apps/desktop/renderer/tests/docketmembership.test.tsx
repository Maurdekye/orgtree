import { flush, inAct, mountView, useFakeClock, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { treeSelections } from '../src/treeselection'
import { Feedback, Panel, fallback, tree, transport } from './docketmembership.fixture'

async function check(el: HTMLElement, label: RegExp) {
  const input = [...el.querySelectorAll('label')].find(n => label.test(n.textContent ?? ''))?.querySelector('input')
  assert.ok(input, String(label)); await inAct(() => input.click()); await flush(12)
}
for (const mode of ['team', 'project', 'missing'] as const) test(`membership feedback settles once: ${mode}`, async t => {
  useFakeClock(); const had = globalThis.fetch
  const requests = { reads: 0 }, count = { reads: 0, renders: 0 }
  globalThis.fetch = transport(requests, mode === 'missing' ? 'missing-owner' : 'retired-owner')
  const v = await mountView(<Feedback count={count} project={mode === 'project'} missing={mode === 'missing'} />, h => h)
  t.after(async () => { await v.unmount(); globalThis.fetch = had; realClock() })
  await check(v.el, /Show archived/i)
  assert.equal(count.reads, 1, 'one selected-tree read, no release/request feedback')
  assert.ok(count.renders <= 3, `bounded feed renders: ${count.renders}`)
  assert.equal(v.el.textContent?.includes('Checking team membership'), false, 'resolved membership remains settled')
  const owner = mode === 'missing' ? 'missing-owner' : 'retired-owner'
  assert.deepEqual(treeSelections.read('membership-test', fallback).selection.include, [owner], 'keep both found and missing answers selected')
  const before = requests.reads
  await check(v.el, /Show backlogged/i)
  assert.equal(count.reads, 1, 'unrelated loaded group does not refetch ancestry')
  assert.ok(requests.reads - before <= 3, 'only requested work pages read')
  await check(v.el, /Show archived/i)
  assert.deepEqual(treeSelections.read('membership-test', fallback).selection.include, [], 'release owner when archived group is no longer needed')
})
test('membership selection is scoped and global/single-agent views do not request ancestry', async t => {
  useFakeClock(); const had = globalThis.fetch; globalThis.fetch = transport()
  const v = await mountView(<Panel tr={tree()} />, h => h)
  t.after(async () => { await v.unmount(); globalThis.fetch = had; realClock() })
  await check(v.el, /Show archived/i)
  assert.deepEqual(treeSelections.read('membership-test', fallback).selection.include, ['retired-owner'])
  await v.render(<Panel tr={tree(['retired-owner'])} />); await flush(4)
  assert.deepEqual(treeSelections.read('membership-test', fallback).selection.include, ['retired-owner'], 'fulfilled request stays held')
  await v.render(<Panel tr={tree()} slug="second-org" team={false} />); await flush(6)
  assert.deepEqual(treeSelections.read('membership-test', fallback).selection.include, [], 'org switch releases old selection')
  assert.deepEqual(treeSelections.read('second-org', fallback).selection.include, [], 'single agent never widens tree')
})
