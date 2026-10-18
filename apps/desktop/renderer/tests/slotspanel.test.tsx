import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { projectMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { claimSurfaceRequests, forgetModalPins, forgetSurfaceRequests } from '../src/canvas/modalpin'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
const noop=()=>{}
const project=(count=1)=>({id:'build',kind:'project',tier:'project',state:'live',generation:1,children:[],
  scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[],slots_capacity:count},seat:0,grant:0,free:0,
  turns:[],lineage:[],audiences_held:[],mail_pending:0} as unknown as CanvasNode)

test('project menu opens one Slots modal entry only with positive capacity',()=>{
  let opened=0
  const h={onInbox:noop,onSettings:noop,onSlots:()=>opened++} as unknown as AgentMenuHandlers
  const entries=(n:CanvasNode)=>projectMenuEntries(n,h).filter(e=>e!=='sep')
    .find(e=>e!=='sep'&&e.label==='Open')
  const entry=entries(project())?.children?.find(e=>e!=='sep'&&e.label==='Slots')
  assert.ok(entry&&entry!=='sep','one direct entry opens the slots modal')
  assert.equal(entry.children,undefined,'no presentation submenu')
  entry.onSelect?.();assert.equal(opened,1)
  assert.equal(entries(project(0))?.children?.some(e=>e!=='sep'&&e.label==='Slots'),false)
})

test('project slots tab uses the shared pin pop-out and modal routes',async t=>{
  installFetch(new FakeServer());localStorage.clear();forgetModalPins();forgetSurfaceRequests()
  const n=project(),calls:string[]=[]
  const v=await mountView(<AgentSurfaceRoutesProvider value={{open:(kind,id)=>calls.push('open:'+kind+':'+id),show:(kind,id)=>calls.push('show:'+kind+':'+id)}}>
    <ProjectDesk node={n} slug="slot-panel" tree={{slug:'slot-panel',roots:[n]} as unknown as TreePayload}
      map={new Map([[n.id,n]])} op={async()=>({holders:[],line:[],history:[]})} toast={noop}
      refs={{world:{org:'slot-panel'},onOpen:noop} as never} />
  </AgentSurfaceRoutesProvider>,el=>el)
  t.after(()=>v.unmount());await inAct(async()=>{await flush(4);v.el.querySelector<HTMLButtonElement>('[data-tab="slots"]')!.click();await flush(3)})
  const buttons=[...v.el.querySelectorAll<HTMLButtonElement>('.project-slots .panel-corner button')]
  assert.equal(buttons.length,3,'three standard shortcuts in the slots tab')
  await inAct(()=>buttons[0].click());assert.deepEqual(claimSurfaceRequests('project-slots','slot-panel'),['pin'])
  await inAct(()=>buttons[1].click());assert.deepEqual(claimSurfaceRequests('project-slots','slot-panel'),['popout'])
  await inAct(()=>buttons[2].click())
  assert.deepEqual(calls,['show:project-slots:build','show:project-slots:build','open:project-slots:build'])
})
