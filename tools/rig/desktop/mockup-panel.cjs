// The presentations panel keeps the two-step flow: row -> reader -> mockup link.
module.exports = async (page) => {
  const card = '[data-first-use-agent="rhea"]'
  await page.waitFor(card)
  await page.eval(() => { window.__opens = []; window.open = (...a) => { window.__opens.push(String(a[0])); return null } })
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.desk-docs .doc-badge')
  await page.click({ selector: 'button', text: 'presented 1' })
  await page.sleep(1500)
  await page.screenshot('mockup-panel')
  // the row opens in the panel's own reader pane (no window); select it if it is not already
  if (!await page.eval(() => !!document.querySelector('.desk-tabpanel .mockup-open a'))) await page.click('.desk-tabpanel .doc-gallery-row')
  await page.waitFor('.desk-tabpanel .mockup-open a')
  const opens = await page.eval(() => window.__opens)
  const href = await page.eval(() => document.querySelector('.desk-tabpanel .mockup-open a').getAttribute('href'))
  if (opens.length || !/\/mockup$/.test(href)) throw Error('panel: ' + JSON.stringify({ opens, href }))
  return { opensFromRowClick: opens.length, secondClickLink: href }
}
