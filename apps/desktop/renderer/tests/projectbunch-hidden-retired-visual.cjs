module.exports = async page => {
  await page.resize('1000x700')
  const details = {}, screenshots = []
  for (const scene of ['hidden-retired', 'hidden-retired-circular', 'hidden-retired-shown']) {
    await page.goto('/?scene=' + scene)
    await page.waitFor('.sq.project')
    await page.eval(async () => {
      await new Promise(resolve => setTimeout(resolve, 1800))
      await new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => setTimeout(resolve, 300))))
    })
    const state = details[scene] = await page.eval(() => {
      const token = document.querySelector('.retired-token')
      const owner = document.querySelector('.sq[data-copy-agent-name="project-transparency-committee"]')
      const p = token?.getBoundingClientRect(), r = owner.getBoundingClientRect()
      return {
        links: document.querySelectorAll('.project-bunch-edge').length,
        projects: [...document.querySelectorAll('.sq.project')].map(el => el.dataset.copyAgentName),
        retiredVisible: !!document.querySelector('.sq[data-copy-agent-name="retired-member"]'),
        token: token?.textContent, parent: token?.dataset.retiredParent,
        hit: !!p && token.contains(document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2)),
        inside: !!p && p.left >= r.left && p.top >= r.top && p.right <= r.right && p.bottom <= r.bottom,
      }
    })
    const shown = scene.endsWith('-shown')
    if (state.links !== (shown ? 1 : 2) || state.retiredVisible !== shown
      || state.projects.join(',') !== 'project-transparency-committee,listener-smoke,test-project'
      || (!shown && (state.token !== '1 retired' || state.parent !== 'project-transparency-committee' || !state.hit || !state.inside)))
      throw new Error('Hidden retired bunch mismatch: ' + JSON.stringify(state))
    screenshots.push(await page.screenshot(scene))
    if (!shown) {
      await page.eval(() => document.querySelector('.retired-token').click())
      await page.waitFor('.pile-row')
      const rows = await page.eval(() => [...document.querySelectorAll('.pile-name')].map(el => el.textContent))
      if (rows.join(',') !== 'retired-member') throw new Error('Owning project picker lost its retired child')
      details[scene].picker = rows
    }
  }
  return { details, screenshots }
}
