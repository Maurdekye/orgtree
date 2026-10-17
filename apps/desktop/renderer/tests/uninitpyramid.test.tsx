import { FakeServer, flush, installFetch, mountView } from './harness'
import { act } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftNode, SpawnChips } from '../src/canvas/cards'
import type { HireProviders } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const tree = {slug:'pyramid',roots:[],dirs:[],default_tools:{},default_visibility:'team'} as unknown as TreePayload
const seats = {haiku:1,sonnet:2,sol:2,astra:6}
const hires:HireProviders = {
  claudeHire:{installed:true,enabled:true},
  codexHire:{installed:true,enabled:false,reason:'sign in first'},
  antigravityHire:{installed:false,enabled:false,reason:'not installed'},
}
const tokens = (host:Element) => [...host.querySelectorAll<HTMLButtonElement>('.hsof button')]
  .map(b=>({classes:b.className,disabled:b.disabled,title:b.title,selected:b.getAttribute('aria-pressed')}))

test('draft model icon opens the same token pyramid and disabled reasons as hiring', async t=>{
  installFetch(new FakeServer())
  const view=await mountView(<>
    <DraftNode pos={{x:0,y:0}} draft={{parent:null,tier:'haiku'}} map={new Map()} seats={seats}
      maxTop={100} defaultTop={12} tree={tree} zoom={1} pxc={1} onConfirm={()=>{}} onCancel={()=>{}}
      onTierChange={()=>{}} hires={hires}/>
    <div className="reference-tokens"><SpawnChips seats={seats} soleHire selected="haiku" onSpawn={()=>{}} {...hires}/></div>
  </>,h=>h)
  t.after(()=>view.unmount())
  await act(async()=>{view.el.querySelector<HTMLButtonElement>('.df-model')!.click();await flush()})
  const picker=document.querySelector('.draft-model-picker')
  assert.ok(picker,'draft must open the shared hire-token pyramid')
  assert.deepEqual(tokens(picker),tokens(view.el.querySelector('.reference-tokens')!))
  const sol=picker.querySelector<HTMLButtonElement>('button.t-sol')!
  assert.equal(sol.disabled,true)
  assert.match(sol.title,/sign in first/)
  assert.equal(picker.querySelector('button.t-flash')===null,true)
})

test('selected token is marked and selecting it closes the picker without cancelling the draft', async t=>{
  installFetch(new FakeServer())
  let cancelled=false,chosen=false
  const view=await mountView(<DraftNode pos={{x:0,y:0}} draft={{parent:null,tier:'haiku'}} map={new Map()}
    seats={seats} maxTop={100} defaultTop={12} tree={tree} zoom={1} pxc={1} onConfirm={()=>{}}
    onCancel={()=>{cancelled=true}} onTierChange={()=>{chosen=true}} hires={hires}/>,h=>h)
  t.after(()=>view.unmount())
  await act(async()=>{view.el.querySelector<HTMLButtonElement>('.df-model')!.click();await flush()})
  const current=document.querySelector<HTMLButtonElement>('.draft-model-picker button.t-haiku')
  assert.ok(current,'current model is a token in the pyramid')
  assert.equal(current.getAttribute('aria-pressed'),'true')
  await act(async()=>{current.click();await flush()})
  assert.equal(document.querySelector('.draft-model-picker')===null,true)
  assert.equal(cancelled,false)
  assert.equal(chosen,false,'choosing current tier does not alter the proposal')
})
