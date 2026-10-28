import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { beginFirstUse, firstUseProgress, firstUseToken, firstUseName, firstUseHired, firstUseSent, firstUseCancel, firstUseDismiss } from '../src/canvas/firstuse'

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

// USER 2026-10-28 me1fad212bab7: "allow the user to dismiss the initial intro 4-step intro tutorial".
test('dismissing ends the tutorial from any step, for that org only, and nothing revives it', () => {
  const reach = {
    token: (slug: string) => beginFirstUse(slug),
    name: (slug: string) => { beginFirstUse(slug); firstUseToken(slug) },
    hire: (slug: string) => { beginFirstUse(slug); firstUseToken(slug); firstUseName(slug, 'a') },
    message: (slug: string) => { beginFirstUse(slug); firstUseToken(slug); firstUseName(slug, 'a'); firstUseHired(slug, 'a') },
  }
  beginFirstUse('bystander')
  for (const [step, go] of Object.entries(reach)) {
    const slug = 'dismiss-' + step
    go(slug)
    assert.equal(firstUseProgress(slug)?.step, step, 'the control reaches the step it is named for')
    firstUseDismiss(slug)
    assert.equal(firstUseProgress(slug)?.step, 'done')
    assert.equal(JSON.parse(localStorage.getItem('orgtree-first-use:' + slug)!).step, 'done', 'kept for the next launch')
    firstUseToken(slug); firstUseName(slug, 'b'); firstUseHired(slug, 'b'); firstUseCancel(slug); firstUseSent(slug, 'a')
    assert.equal(firstUseProgress(slug)?.step, 'done', 'the real controls no longer advance a dismissed guide')
    firstUseDismiss(slug)
    assert.equal(firstUseProgress(slug)?.step, 'done', 'dismissing twice is harmless')
  }
  assert.equal(firstUseProgress('bystander')?.step, 'token', 'another organization keeps its own guide')
  firstUseDismiss('never-started')
  assert.equal(firstUseProgress('never-started'), null, 'an organization without a guide does not acquire a record')
  assert.equal(localStorage.getItem('orgtree-first-use:never-started'), null)
})
