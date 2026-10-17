import test from 'node:test'
import assert from 'node:assert/strict'
import { maxSettledRenders } from './stream-render-contract.mjs'

test('mail segments sharing one durable row are separate mounted components', () => {
  const msgRenders = Array.from({length:5}, (_,instance) => Array.from({length:5}, () => ({role:'user',id:'r1',instance}))).flat()
  assert.deepEqual(maxSettledRenders({msgRenders}), {components:5,max:5})
})

test('per-token render churn still fails even with several quiet segments', () => {
  const msgRenders = Array.from({length:80}, () => ({role:'user',id:'r1',instance:1}))
    .concat({role:'user',id:'r1',instance:2})
  assert.equal(maxSettledRenders({msgRenders}).max > 20, true)
})

test('missing counters and absent settled rows cannot pass vacuously', () => {
  assert.throws(() => maxSettledRenders({msgRenders:[]}), /no settled/)
  assert.throws(() => maxSettledRenders({msgRenders:[{role:'user',id:'r1'}]}), /missing mounted/)
})
