module.exports = async page => {
  await page.resize('1000x700')
  await page.goto('/?scene=retired-pile')
  await page.waitFor('.pile-count')
  await page.eval(() => document.querySelector('.pile-count').click())
  await page.waitFor('.pile-row')
  const details = await page.eval(() => ({
    heading: document.querySelector('.pile-picker h3').textContent,
    rows: [...document.querySelectorAll('.pile-name')].map(el => el.textContent),
    folders: document.querySelectorAll('.pile-row .project-mark svg').length,
    tiers: document.querySelectorAll('.pile-row .tier').length,
    search: !!document.querySelector('.pile-picker input[type="search"]'),
  }))
  if (!details.heading.endsWith('2 projects') || details.folders !== 2 || details.tiers
    || details.rows.join(',') !== 'older-1,project-1' || !details.search)
    throw new Error('Retired picker identity mismatch: ' + JSON.stringify(details))
  await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, 300))))
  })
  return { details, screenshots: [await page.screenshot('retired-project-picker-labels')] }
}
