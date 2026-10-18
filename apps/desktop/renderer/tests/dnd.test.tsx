import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentWorkstate } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'

const node = (dnd: boolean) => ({ id:'focused-agent',tier:'sol',state:'live',busy:true,
  phase:'thinking',dnd,last_status:{status:'working',summary:'Focused work'} } as unknown as CanvasNode)

test('do not disturb is visible alongside the running agent state', async t => {
  const v=await mountView(<AgentWorkstate node={node(true)} />,el=>el)
  t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.dnd-badge')?.textContent,'DND','focused turn needs DND badge')
})

test('ordinary running state does not show DND', async t => {
  const v=await mountView(<AgentWorkstate node={node(false)} />,el=>el)
  t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.dnd-badge')===null,true)
})
