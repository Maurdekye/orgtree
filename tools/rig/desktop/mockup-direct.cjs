// An HTML mockup opens straight in its own window from the desk header badge
// and the canvas chip (one click); the presentations panel still opens the
// reader first, whose mockup link is the second click.
module.exports = async (page) => {
  const card = '[data-first-use-agent="rhea"]'
  const arm = () => { window.__opens = []; window.open = (...a) => { window.__opens.push(String(a[0])); return null } }
  const opens = () => page.eval(() => window.__opens)
  await page.waitFor(card)
  await page.eval(arm)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.desk-docs .doc-badge')
  await page.click('.desk-docs .doc-badge')
  await page.sleep(500)
  const header = await opens()
  const readerOpen = await page.eval(() => !!document.querySelector('.gallery-modal'))
  if (header.length !== 1 || !/\/documents\/[^/]+\/mockup$/.test(header[0]) || readerOpen) throw Error('header: ' + JSON.stringify({ header, readerOpen }))
  const unread = await page.eval(() => document.querySelector('.desk-docs .doc-badge').dataset.docUnread || '')
  if (unread) throw Error('still unread: ' + unread)
  for (let n = 0; n < 8; n++) {
    await page.click('button[title="zoom out"]'); await page.sleep(350)
    if (await page.eval(() => !!document.querySelector('.doc-chips button.doc-chip'))) break
  }
  await page.waitFor('.doc-chips button.doc-chip')
  await page.eval(arm)
  await page.click('.doc-chips button.doc-chip')
  await page.sleep(500)
  const chip = await opens()
  if (chip.length !== 1 || await page.eval(() => !!document.querySelector('.gallery-modal'))) throw Error('chip: ' + JSON.stringify(chip))
  await page.screenshot('mockup-chip')
  return { header, chip }
}
