module.exports = async page => {
  const evidence = []
  for (const mode of ['user', 'agent', 'project']) {
    await page.resize('980x660')
    await page.goto('/?mode=' + mode)
    await page.waitFor('.mailrow')
    await page.eval(() => [...document.querySelectorAll('.mailrow')].find(el => el.textContent.includes('Currently open message')).click())
    await page.eval(() => [...document.querySelectorAll('.mailrow')].find(el => el.textContent.includes('Clicked tagged message')).querySelector('button[data-tag-key="review"]').click())
    await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))))
    const state = await page.eval(() => ({ selected: document.querySelector('.mailrow.on')?.textContent,
      body: document.querySelector('.mailer-read .mailer-body')?.textContent, count: document.querySelectorAll('.mailrow').length,
      filter: document.querySelector('.mail-tag-active')?.textContent }))
    if (!state.body?.includes('Clicked tagged message') || !state.selected?.includes('Clicked tagged message') || state.count !== 2)
      throw new Error(JSON.stringify({mode, ...state}))
    await page.screenshot('tag-click-' + mode)
    evidence.push({ mode, ...state })
  }
  return evidence
}
