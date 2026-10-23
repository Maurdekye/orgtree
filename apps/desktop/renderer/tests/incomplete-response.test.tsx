import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'

const partial: ChatMessage = { role:'assistant', text:'The **unfinished reply** stays visible.', tools:[],
  row_id:'r17', assistant_state:'partial', interrupted:true }
test('interrupted text remains ordinary visible Markdown after history reload',async t=>{
  const view=await mountView(<Msg m={JSON.parse(JSON.stringify(partial))} slug="fixture" nid="worker" />,
    el=>el.textContent??'')
  t.after(()=>view.unmount())
  assert.equal(view.el.querySelector('.msgtext strong')?.textContent,'unfinished reply')
  assert.equal(view.el.querySelector('.incomplete-response')?.textContent?.replace(/\s+/g,' ').trim(),'interrupted · incomplete response')
  assert.equal(view.el.querySelector('.thoughtline')===null,true)
  await view.render(<Msg m={{...partial,text:'The **finished reply** stays visible.',assistant_state:'complete',interrupted:false}} slug="fixture" nid="worker" />)
  assert.equal(view.el.querySelectorAll('.msgtext').length,1)
  assert.equal(view.el.querySelector('.incomplete-response')===null,true)
})
test('a non-interrupt end uses the incomplete marker and preserves ordered text',async t=>{
  const view=await mountView(<Msg m={{...partial,interrupted:false,content_blocks:[{kind:'text',start:0,end:partial.text.length}]}} slug="fixture" nid="worker" />,el=>el.textContent??'')
  t.after(()=>view.unmount())
  assert.equal(view.el.querySelector('.msgtext strong')?.textContent,'unfinished reply')
  assert.equal(view.el.querySelector('.incomplete-response')?.textContent?.trim(),'incomplete response')
})
