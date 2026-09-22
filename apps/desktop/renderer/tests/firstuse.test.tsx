import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { beginFirstUse, firstUseProgress, firstUseToken, firstUseName, firstUseHired, firstUseSent, firstUseCancel } from '../src/canvas/firstuse'

test('existing orgs, corrupt progress, and out-of-order actions do not start tutorials', () => {
  firstUseToken('existing'); firstUseName('existing', 'a'); firstUseHired('existing', 'a'); firstUseSent('existing', 'a')
  assert.equal(firstUseProgress('existing'), null)
  localStorage.setItem('orgtree-first-use:corrupt', '{')
  assert.equal(firstUseProgress('corrupt'), null)
  localStorage.setItem('orgtree-first-use:corrupt', '{"step":"message"}')
  assert.equal(firstUseProgress('corrupt'), null)
  beginFirstUse('fresh')
  firstUseName('fresh', 'a'); firstUseHired('fresh', 'a'); firstUseSent('fresh', 'a')
  assert.equal(firstUseProgress('fresh')?.step, 'token')
})

test('only the matching hired agent completes a pending tutorial, independently per org', () => {
  for (const slug of ['one', 'two']) {
    beginFirstUse(slug); firstUseToken(slug); firstUseName(slug, 'agent'); firstUseHired(slug, 'agent')
  }
  firstUseSent('one', 'different-agent')
  firstUseCancel('one')
  assert.deepEqual(firstUseProgress('one'), { step: 'message', agent: 'agent' })
  firstUseSent('one', 'agent')
  assert.equal(firstUseProgress('one')?.step, 'done')
  assert.equal(firstUseProgress('two')?.step, 'message')
  firstUseToken('one'); firstUseName('one', 'new'); firstUseCancel('one')
  assert.equal(firstUseProgress('one')?.step, 'done')
  assert.equal(JSON.parse(localStorage.getItem('orgtree-first-use:one')!).step, 'done')
})
