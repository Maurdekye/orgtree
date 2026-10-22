import test from 'node:test'
import assert from 'node:assert/strict'
import { setup } from '../tools/rig/proofs/credential-broker.mjs'

test('credential-broker prepares synthetic tools before the rig engine starts', async () => {
  const config = await setup()
  assert.equal(typeof config.prepare, 'function',
    'the broker and hosted child must receive scratch executables and homes before launch')
  assert.equal(config.bootIsolated, true)
})
