module.exports = async (page, { args }) => {
  const card = '[data-first-use-agent="rhea"]'
  const readTitles = selector => [...document.querySelectorAll(selector)].map(e => e.title.replace(/^(new|updated): /, ''))
  const match = (actual, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(args.expected))
      throw Error(`${label}: ${JSON.stringify(actual)} expected ${JSON.stringify(args.expected)}`)
  }
  await page.waitFor(card)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.desk-docs .doc-badge')
  const header = await page.eval(readTitles, '.desk-docs .doc-badge')
  match(header, 'header')
  await page.screenshot('document-header')
  await page.click('.desk-docs .doc-badge')
  await page.waitFor(() => document.querySelector('.gallery-modal')?.textContent.includes('Unique report body 6.'))
  await page.press('Escape')
  await page.waitFor('.gallery-modal', { gone: true })
  for (let n = 0; n < 8; n++) {
    await page.click('button[title="zoom out"]')
    await page.sleep(350)
    if (await page.eval(() => !!document.querySelector('.doc-chips button.doc-chip'))) break
  }
  await page.waitFor('.doc-chips button.doc-chip')
  const node = await page.eval(readTitles, '.doc-chips button.doc-chip')
  match(node, 'canvas node')
  await page.hover('.doc-chips button.doc-chip')
  await page.screenshot('document-node-chips')
  await page.click('.doc-chips button.doc-chip')
  await page.waitFor(() => document.querySelector('.gallery-modal')?.textContent.includes('Unique report body 6.'))
  await page.screenshot('document-node-click')
  return { header, node, clickOpenedReport6: true }
}
