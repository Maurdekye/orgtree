import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, flush, inAct, realClock, useFakeClock } from './harness'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { galleryRows, installGalleryFixture } from './galleryrows-fixture'
import { PresentationCard, presentationMenu } from '../src/canvas/docs'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ticketOwnerAction } from '../src/canvas/objectactions'
import type { ReactNode } from 'react'

function NodeMenus({children,focus}:{children:ReactNode;focus:(id:string)=>void}) {
  useProvideAgentNav(id=>[{label:'Focus',onSelect:()=>focus(id)}, {label:'Open',onSelect:()=>{}}])
  return children
}

for (const surface of ['modal','desk'] as const) {
  test(`${surface}: list names are plain and presenter attribution stays inline`, async t => {
    useFakeClock(); installGalleryFixture()
    const focused:string[]=[]
    const props={slug:'synthetic',toast:()=>{},onFocusAgent:(id:string)=>focused.push(id)}
    const v=await mountView(<AgentNavProvider><NodeMenus focus={id=>focused.push(id)}>
      {surface==='modal' ? <DocGalleryModal {...props} close={()=>{}} />
      : <AgentGalleryView {...props} nid="test-project" node={{id:'test-project',kind:'project'} as any} />}
      </NodeMenus></AgentNavProvider>, host=>host)
    t.after(async()=>{await v.unmount();realClock()})
    await flush()
    const rows=[...v.el.querySelectorAll<HTMLElement>('.doc-gallery-row')]
    assert.equal(rows.length,4)
    assert.equal(rows.some(r=>!!r.querySelector('.l2 button,.l2 a,[data-agent-nav]')),false,'list identities must not navigate')
    const project=rows[1]!
    assert.equal(project.querySelector('.doc-row-attribution')?.textContent,'by test-proj-worker-c')
    assert.equal(project.querySelector('.doc-row-owner')?.textContent,'test-project')
    assert.equal(!!project.querySelector('.project-mark'),true)
    const long=rows[2]!.querySelector<HTMLElement>('.doc-row-attribution')!
    assert.equal(long.title,`Presented by ${galleryRows[2]!.presented_by}`)
    await inAct(()=>project.querySelector<HTMLElement>('.doc-row-owner')!.click())
    await flush()
    assert.deepEqual(focused,[])
    assert.equal(project.classList.contains('on'),true,'clicking the owner selects its presentation')
    assert.equal(v.el.querySelector('.doc-pane-head .cc-name')?.textContent,'test-project','details retain project link')
    await inAct(()=>project.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:50,clientY:50})))
    const labels=[...document.querySelectorAll('.ctxmenu button')].map(b=>b.textContent)
    assert.equal(labels.some(s=>s?.includes('Presenter…')),true,'gallery menu offers canonical presenter actions')
    assert.equal(labels.some(s=>s?.includes('Project…')),true,'gallery menu offers canonical project actions')
  })
}

test('details keep project and presenter navigation',async t=>{
  useFakeClock();installGalleryFixture()
  const focus:string[]=[]
  const v=await mountView(<AgentGalleryView slug="synthetic" nid="test-project" node={{id:'test-project',kind:'project'} as any}
    toast={()=>{}} onFocusAgent={id=>focus.push(id)} initialDocument="project" />,host=>host)
  t.after(async()=>{await v.unmount();realClock()});await flush()
  const links=[...v.el.querySelectorAll<HTMLButtonElement>('.doc-pane-head button.cc-name')]
  assert.deepEqual(links.map(b=>b.textContent),['test-project','test-proj-worker-c'])
  await inAct(()=>links.forEach(b=>b.click()))
  assert.deepEqual(focus,['test-project','test-proj-worker-c'])
})

test('presentation identities reuse ticket owner actions, including focus and tooltip',()=>{
  const focus:string[]=[]
  const builder=(name:string)=>[{label:'Focus',onSelect:()=>focus.push(name)}, {label:'Settings',onSelect:()=>{}}]
  const menu=presentationMenu(document.body,'synthetic',galleryRows[1]!,{nodeMenu:builder})
  for(const [label,name] of [['Presenter…','test-proj-worker-c'],['Project…','test-project']]){
    const entry=menu.find(e=>e!=='sep'&&e.label===label)
    assert.ok(entry&&entry!=='sep')
    const owner=ticketOwnerAction(document.body,name,builder(name!))!
    assert.equal(entry.agentTooltipId,owner.agentTooltipId)
    assert.deepEqual(entry.children?.map(e=>e==='sep'?'sep':e.label),owner.children?.map(e=>e==='sep'?'sep':e.label))
    entry.onSelect()
  }
  assert.deepEqual(focus,['test-proj-worker-c','test-project'])
  assert.equal(presentationMenu(document.body,'synthetic',galleryRows[0]!,{nodeMenu:builder})
    .some(e=>e!=='sep'&&e.label==='Project…'),false)
})

test('legacy presentation chips resolve recorded presenter and project on opening',async t=>{
  useFakeClock();installGalleryFixture()
  const v=await mountView(<AgentNavProvider><NodeMenus focus={()=>{}}>
    <PresentationCard slug="synthetic" doc={{id:'project',title:'Old payload'}} onOpen={()=>{}} className="doc-badge">document</PresentationCard>
  </NodeMenus></AgentNavProvider>,host=>host)
  t.after(async()=>{await v.unmount();realClock()})
  await inAct(()=>v.el.querySelector<HTMLElement>('.doc-badge')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:50,clientY:50})))
  await flush()
  const labels=[...document.querySelectorAll('.ctxmenu button')].map(b=>b.textContent)
  assert.equal(labels.some(s=>s?.includes('Presenter…')),true)
  assert.equal(labels.some(s=>s?.includes('Project…')),true)
})
