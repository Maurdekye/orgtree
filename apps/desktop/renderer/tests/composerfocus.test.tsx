import { FakeServer, flush, inAct, installFetch, mountView, useFakeClock, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ComposerFocusFixture, seedComposer } from './composerfocus-fixture'
import { resetConvos } from '../src/convo'

for(const surface of ['agent','project','quick','reply'] as const){
  test(`${surface}: empty composer areas focus text without taking focus from controls`,async t=>{
    useFakeClock();resetConvos();installFetch(new FakeServer());seedComposer()
    const v=await mountView(<div role="dialog"><ComposerFocusFixture surface={surface}/></div>,el=>el)
    t.after(async()=>{await v.unmount();resetConvos();realClock()});await flush(5)
    const box=v.el.querySelector<HTMLElement>('.cc-composer,.quickchat,.mail-reply')!
    const input=box.querySelector<HTMLInputElement|HTMLTextAreaElement>('textarea,.quickchat-input')!
    assert.equal(!!box&&!!input,true,'production composer mounted')
    const sentinel=document.createElement('button');document.body.append(sentinel);t.after(()=>sentinel.remove())
    for(const blank of [box,...box.querySelectorAll<HTMLElement>('.cc-btnstack,.cc-controls,.cc-primary-row,.cc-fast-row')]){
      sentinel.focus();await inAct(()=>blank.click())
      assert.equal(document.activeElement===input,true,'empty composer background must focus the text input')
    }
    const control=box.querySelector<HTMLButtonElement>(surface==='quick'?'.quickchat-attach':'.cc-notice-toggle')!
    assert.equal(!!control,true,'real nested control remains available')
    control.focus();await inAct(()=>control.querySelector<SVGElement>('svg')!
      .dispatchEvent(new MouseEvent('click',{bubbles:true})))
    assert.equal(document.activeElement===input,false,'clicking a control icon must not redirect focus to text')
    if(surface!=='quick')assert.equal(control.classList.contains('armed'),true,'notice action still runs')
  })
}
