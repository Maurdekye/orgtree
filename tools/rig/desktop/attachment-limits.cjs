module.exports = async page => {
  await page.waitFor('[data-first-use-agent="rhea"]')
  await page.click('header.orgbar button.iconbtn')
  await page.click('button[title="App settings"]')
  await page.click({ selector: '[role="tab"]', text: 'Mail hub' })
  const selector = '[aria-label="Maximum attachment size (MiB)"]'
  await page.waitFor(selector)
  const before = await page.eval(s => document.querySelector(s).value, selector)
  if (before !== '64') throw Error(`expected saved 64 MiB, got ${before}`)
  await page.click(selector)
  await page.press('a', { modifiers: 2 })
  await page.type('128')
  await page.eval(() => document.querySelector('.host-hub button[type="submit"]').scrollIntoView({ block: 'center' }))
  await page.click({ selector: 'button', text: 'Save hosting settings' })
  await page.waitFor(() => document.querySelector('.host-hub')?.textContent.includes('Hosting settings saved.'))
  await page.eval(s => document.querySelector(s).scrollIntoView({ block: 'center' }), selector)
  await page.screenshot('live-upload-limit')
  return { before, after: await page.eval(s => document.querySelector(s).value, selector) }
}
