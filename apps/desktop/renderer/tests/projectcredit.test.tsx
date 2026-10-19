import { FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ProjectCreditFixture, groupedReports, makeTree, reports } from './projectcredit-fixture'
import { orgPxc } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

for(const surface of ['canvas','settings','desk','inbox'] as const){
  test(`${surface}: project wrappers preserve agent credit slabs and totals`,async t=>{
    useFakeClock();resetConvos();installFetch(new FakeServer())
    const v=await mountView(<><section data-group="direct"><ProjectCreditFixture surface={surface} grouped={false}/></section>
      <section data-group="project"><ProjectCreditFixture surface={surface} grouped/></section></>,el=>el)
    t.after(async()=>{await v.unmount();resetConvos();realClock()});await flush(5)
    const bars=[...v.el.querySelectorAll<HTMLElement>('.cbar-clip')]
    assert.equal(bars.length,2,'both production credit displays rendered')
    const geometry=(bar:HTMLElement)=>[...bar.querySelectorAll<HTMLElement>('.cbar-subseat,.cbar-div')]
      .map(e=>({kind:e.className,bottom:e.style.bottom,height:e.style.height}))
    assert.equal(bars[0]!.querySelectorAll('.cbar-subseat').length,surface==='desk'||surface==='inbox'?2:3,
      'direct agent control preserves live/held rules and keeps agent subtrees one slab')
    assert.deepEqual(geometry(bars[1]!),geometry(bars[0]!), 'projects must not change per-agent credit segmentation')
    const tips=[...v.el.querySelectorAll('.cbar-tip')].map(e=>e.textContent)
    assert.equal(tips.length,2);assert.equal(tips[1],tips[0],'grant/allocation/free/seat totals unchanged')
  })
}
test('top-level project grouping preserves the shared chart and request credit scale',()=>{
  assert.equal(orgPxc(makeTree(groupedReports)),orgPxc(makeTree(reports)),
    'project wrappers must not change pixel-per-credit scale')
})
