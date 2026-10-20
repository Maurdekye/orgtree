module.exports = async page => {
  await page.resize('1000x700')
  const screenshots = [], details = {}
  const capture = async name => {
    await page.eval(async () => {
      await new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => setTimeout(resolve, 300))))
    })
    screenshots.push(await page.screenshot(name))
  }
  for (const scene of ['retired-pile', 'retired-off', 'retired-circular']) {
    await page.goto('/?scene=' + scene)
    await page.waitFor('.sq.project.archived')
    await page.eval(async () => { await new Promise(resolve => setTimeout(resolve, 1800)) })
    details[scene] = await page.eval(() => {
      const cards = [...document.querySelectorAll('.sq.project.archived')]
      const viewport = document.querySelector('.viewport').getBoundingClientRect()
      const count = document.querySelector('.pile-count'), button = count.getBoundingClientRect()
      return {
        ids: cards.map(c => c.dataset.copyAgentName),
        lines: document.querySelectorAll('.project-bunch-edge').length,
        pileCount: document.querySelector('.pile-count')?.textContent,
        pickerHit: count.contains(document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)),
        viewport: { width: viewport.width, height: viewport.height },
        cards: cards.map(c => {
          const r = c.getBoundingClientRect()
          return { id: c.dataset.copyAgentName, x: r.x, y: r.y, w: r.width, h: r.height }
        }),
      }
    })
    const state = details[scene], expected = scene === 'retired-off' ? 0 : 4
    if (state.lines !== expected || state.pileCount !== '2' || !state.pickerHit
      || state.ids.join(',') !== 'project-1,project-2,project-3,project-4,project-5')
      throw new Error('Retired pile did not keep exactly its selected project chain: ' + JSON.stringify(state))
    if (state.viewport.height < 500 || state.cards.some(c => c.x < 0 || c.y < 48 || c.x + c.w > 1000 || c.y + c.h > 700))
      throw new Error('Retired capture has clipped or missing canvas geometry: ' + JSON.stringify(state))
    await capture('project-bunch-' + scene)
    if (scene === 'retired-pile') {
      await page.eval(() => document.querySelector('.pile-count').click())
      await page.waitFor('.pile-row')
      details.picker = await page.eval(() => ({
        rows: [...document.querySelectorAll('.pile-name')].map(el => el.textContent),
        search: !!document.querySelector('.pile-picker input[type="search"]'),
      }))
      if (details.picker.rows.join(',') !== 'older-1,project-1' || !details.picker.search)
        throw new Error('Retired project picker lost its separate sibling rows or search')
      await capture('project-bunch-retired-picker')
      await page.eval(async () => {
        [...document.querySelectorAll('.pile-row')]
          .find(el => el.querySelector('.pile-name')?.textContent === 'older-1').click()
        await new Promise(resolve => setTimeout(resolve, 1800))
      })
      details.selected = await page.eval(() => ({
        ids: [...document.querySelectorAll('.sq.project.archived')].map(c => c.dataset.copyAgentName),
        lines: document.querySelectorAll('.project-bunch-edge').length,
      }))
      if (details.selected.ids.join(',') !== 'older-1,older-2,older-3' || details.selected.lines !== 2)
        throw new Error('Selecting an archived root failed to select its bunch')
      await capture('project-bunch-retired-other-front')
    }
  }
  return { details, screenshots }
}
