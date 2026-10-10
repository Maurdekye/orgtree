// Focus alice's desk. Negative: boss retires carol (another agent) from outside:
// the view stays. Positive: boss dissolves alice: the view returns to the org fit
// (compared with what the fit button gives afterwards).
module.exports = async (page, { org }) => {
  const view = () => page.eval(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector('.space')).transform)
    return { x: m.e, y: m.f, z: m.a }
  })
  // the camera animates; wait until it has not moved for 800 ms
  const settled = async () => {
    let last = await view(), still = 0
    for (let i = 0; i < 100 && still < 4; i++) {
      await page.sleep(200)
      const v = await view()
      still = Math.abs(v.x - last.x) + Math.abs(v.y - last.y) + Math.abs(v.z - last.z) < 0.5 ? still + 1 : 0
      last = v
    }
    return last
  }
  const tool = (tool, args) => page.api('POST', '/api/rig/tool', { org, agent: 'boss', tool, args })
  const near = (a, b) => Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3 && Math.abs(a.z - b.z) < 0.01
  await page.waitFor('[data-first-use-agent="alice"]', { timeout: 30000 })
  await page.click('button[title="fit the whole org"]'); const fit0 = await settled()
  await page.rightClick('[data-first-use-agent="alice"]')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  const focused = await settled()
  await page.screenshot('1-focused-alice')
  const r1 = await tool('orgtree_retire', { node: 'carol' })
  await page.sleep(1500)
  const afterOther = await settled()
  await page.screenshot('2-other-retired-unchanged')
  const r2 = await tool('orgtree_dissolve', { node: 'alice' })
  await page.sleep(1500)
  const afterOwn = await settled()
  await page.screenshot('3-focused-retired-fit')
  await page.click('button[title="fit the whole org"]'); const fit1 = await settled()
  return {
    zoomedIn: focused.z > fit0.z * 1.5,
    otherRetireKeepsView: Math.abs(afterOther.z - focused.z) < 0.01 && !near(afterOther, fit0), // x may follow the focused card as the layout closes up
    ownRetireReturnsToFit: near(afterOwn, fit1) && afterOwn.z < focused.z * 0.7,
    detail: { fit0, focused, afterOther, afterOwn, fit1, r1: JSON.stringify(r1).slice(0, 120), r2: JSON.stringify(r2).slice(0, 120) },
  }
}
