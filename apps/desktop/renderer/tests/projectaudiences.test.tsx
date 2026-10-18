import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries, projectMenuEntries, type AgentMenuHandlers } from '../src/canvas/agentmenu'
import type { CanvasNode } from '../src/canvas/shared'

const make = (extra: Record<string, unknown> = {}) => ({id:'alpha',kind:'project',state:'live',children:[],documents:[],audiences_held:[],audiences_explicit:[],...extra}) as unknown as CanvasNode
const handlers = (toggle?: () => void) => ({onSettings:()=>{},onInbox:()=>{},onOpenDesk:()=>{},onToggleUserAudience:toggle}) as unknown as AgentMenuHandlers

test('project Acquire audience is after Settings and invokes the project handler', () => {
  let count=0
  const rows=projectMenuEntries(make(),handlers(()=>count++))
  const labels=rows.map(r=>r==='sep'?'sep':r.label)
  assert.equal(labels.includes('Acquire audience'),true)
  assert.equal(labels.indexOf('Acquire audience'),labels.indexOf('Settings')+1)
  const entry=rows.find(r=>r!=='sep'&&r.label==='Acquire audience')
  if(entry&&entry!=='sep')entry.onSelect?.()
  assert.equal(count,1)
})

test('project Drop audience reflects an explicit user grant', () => {
  const rows=projectMenuEntries(make({audiences_held:['@user'],audiences_explicit:['@user']}),handlers(()=>{}))
  assert.equal(rows.some(r=>r!=='sep'&&r.label==='Drop audience'),true)
})

test('inherited audience never offers a misleading Drop for an agent or project', () => {
  for(const kind of ['agent','project']){
    const node=make({kind,audiences_held:['@user'],audiences_explicit:[]})
    const rows=(kind==='project'?projectMenuEntries:agentMenuEntries)(node,handlers(()=>{}))
    assert.equal(rows.some(r=>r!=='sep'&&r.label==='Drop audience'),false)
    assert.equal(rows.some(r=>r!=='sep'&&r.label==='Acquire audience'),true)
  }
})

test('retired projects and hosts without an audience route offer no audience action', () => {
  for(const rows of [projectMenuEntries(make({state:'archived'}),handlers(()=>{})),projectMenuEntries(make(),handlers())])
    assert.equal(rows.some(r=>r!=='sep'&&/^(Acquire|Drop) audience$/.test(r.label)),false)
})
