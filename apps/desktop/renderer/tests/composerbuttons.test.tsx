import {FakeServer,installFetch,flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {ComposerButtonsFixture,seedComposer} from './composerbuttons-fixture'

test('urgent toggle precedes speed and keeps its armed state behavior',async t=>{
  installFetch(new FakeServer());seedComposer()
  const v=await mountView(<ComposerButtonsFixture/>,el=>el)
  t.after(()=>v.unmount());await flush(6)
  const row=v.el.querySelector('.cc-fast-row')!,urgent=row.querySelector<HTMLButtonElement>('.cc-urgent-toggle')!,fast=row.querySelector('.cc-fast')!
  assert.equal(!!urgent&&!!fast,true,'production urgent/speed controls are present')
  assert.equal(!!(urgent.compareDocumentPosition(fast)&Node.DOCUMENT_POSITION_FOLLOWING),true,'urgent must precede speed')
  await inAct(()=>urgent.click());assert.equal(urgent.getAttribute('aria-pressed'),'true')
  assert.equal(v.el.querySelector('.cc-composer')!.classList.contains('urgent-armed'),true)
  await inAct(()=>urgent.click());assert.equal(urgent.getAttribute('aria-pressed'),'false')
})
