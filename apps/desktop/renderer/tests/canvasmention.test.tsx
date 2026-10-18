import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import {installMentionFixture} from './canvasmention-fixture'
import {useMentionHighlight} from '../src/canvas/agentmentions'
function HighlightProbe(){const h=useMentionHighlight('transcript-jump','newest');return <output data-highlight={h?.mentionId??''}/>}

for(const mode of ['canvas','attention'] as const)test(`${mode}: newest transcript jump shares header guard, observes once and walks to the next`,async()=>{
  const rig=installMentionFixture(mode),view=await mountView(<><App/><HighlightProbe/></>,el=>el)
  try{
    await inAct(()=>flush(65))
    const button=view.el.querySelector<HTMLButtonElement>('.mention-bell')
    assert.ok(button,'unobserved transcript mentions reveal @ button')
    assert.equal(button.textContent?.replace(/\s/g,''),'@2','mail mention is excluded from transcript count')
    assert.equal(button.classList.contains('glow'),true)
    assert.equal(button.nextElementSibling?.classList.contains('kill-switch'),true,'@ immediately precedes latch')
    await inAct(async()=>{button.click();await flush(65)})
    assert.equal(view.el.querySelector('[data-highlight]')?.getAttribute('data-highlight'),'um-newest')
    assert.equal(rig.observed.includes('newest'),true,'existing observed API used')
    assert.equal(view.el.querySelector('.mention-bell .eye-count')?.textContent,'1')
    if(mode==='attention')assert.equal(view.el.querySelector('.agent-desk-panel')?.textContent?.includes('newest'),true,'destination is Attention desk')
    await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mention-bell')!.click();await flush(65)})
    assert.equal(rig.observed.includes('older'),true)
    assert.equal(view.el.querySelector('.mention-bell')===null,true,'hidden after all transcript mentions observed')
    assert.equal(view.el.querySelector('.ask-bell')?.classList.contains('glow'),true,'mail cue stays independent')
  }finally{await view.unmount();rig.restore()}
})
test('mail-only mentions keep inbox attention without exposing the transcript button',async()=>{
  const rig=installMentionFixture('canvas',false),view=await mountView(<App/>,el=>el)
  try{await inAct(()=>flush(65));assert.equal(view.el.querySelector('.mention-bell')===null,true);assert.equal(view.el.querySelector('.ask-bell')?.classList.contains('glow'),true)}
  finally{await view.unmount();rig.restore()}
})
