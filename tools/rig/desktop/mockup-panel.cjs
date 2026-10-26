// The presentations panel shows the selected HTML presentation inline, in a
// sandboxed frame (no window opens from the row); its window link is a separate click.
module.exports = async (page) => {
  const card = '[data-first-use-agent="rhea"]'
  await page.waitFor(card)
  await page.eval(() => { window.__opens = []; window.open = (...a) => { window.__opens.push(String(a[0])); return null } })
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.desk-docs .doc-badge')
  await page.click({ selector: 'button', text: 'presented 1' })
  await page.sleep(1500)
  // the row opens in the panel's own reader pane (no window); select it if it is not already
  if (!await page.eval(() => !!document.querySelector('.desk-tabpanel .html-presentation-window'))) await page.click('.desk-tabpanel .doc-gallery-row')
  await page.waitFor('.desk-tabpanel iframe.html-presentation-frame')
  await page.sleep(500)
  await page.screenshot('mockup-panel')
  const opens = await page.eval(() => window.__opens)
  const frame = await page.eval(() => {
    const f = document.querySelector('.desk-tabpanel iframe.html-presentation-frame')
    return { sandbox: f.getAttribute('sandbox'), policy: /Content-Security-Policy/.test(f.getAttribute('srcdoc') || '') }
  })
  const href = await page.eval(() => document.querySelector('.desk-tabpanel .html-presentation-window').getAttribute('href'))
  if (opens.length || !/\/mockup$/.test(href) || frame.sandbox !== 'allow-scripts' || !frame.policy) {
    throw Error('panel: ' + JSON.stringify({ opens, href, frame }))
  }
  return { opensFromRowClick: opens.length, frame, windowLink: href }
}
