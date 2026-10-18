import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, flush, inAct, realClock, useFakeClock } from './harness'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { galleryRows, installGalleryFixture } from './galleryrows-fixture'

for (const surface of ['modal','desk'] as const) {
  test(`${surface}: list names are plain and presenter attribution stays inline`, async t => {
    useFakeClock(); installGalleryFixture()
    const focused:string[]=[]
    const props={slug:'synthetic',toast:()=>{},onFocusAgent:(id:string)=>focused.push(id)}
    const v=await mountView(surface==='modal' ? <DocGalleryModal {...props} close={()=>{}} />
      : <AgentGalleryView {...props} nid="test-project" node={{id:'test-project',kind:'project'} as any} />)
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
  })
}

test('details keep project and presenter navigation',async t=>{
  useFakeClock();installGalleryFixture()
  const focus:string[]=[]
  const v=await mountView(<AgentGalleryView slug="synthetic" nid="test-project" node={{id:'test-project',kind:'project'} as any}
    toast={()=>{}} onFocusAgent={id=>focus.push(id)} initialDocument="project" />)
  t.after(async()=>{await v.unmount();realClock()});await flush()
  const links=[...v.el.querySelectorAll<HTMLButtonElement>('.doc-pane-head button.cc-name')]
  assert.deepEqual(links.map(b=>b.textContent),['test-project','test-proj-worker-c'])
  await inAct(()=>links.forEach(b=>b.click()))
  assert.deepEqual(focus,['test-project','test-proj-worker-c'])
})
