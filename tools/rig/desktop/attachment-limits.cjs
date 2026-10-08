module.exports = async page => {
  await page.waitFor('button[aria-label="Orgtree menu"]')
  await page.click('button[aria-label="Orgtree menu"]')
  await page.click({ selector: '[role="menuitem"]', text: 'App settings' })
  await page.click({ selector: '[role="tab"]', text: 'Mail hub' })
  const selector = '[aria-label="Maximum attachment size (MiB)"]'
  await page.waitFor(selector)
  const before = await page.eval(s => document.querySelector(s).value, selector)
  if (before !== '64') throw Error(`expected saved 64 MiB, got ${before}`)
  await page.click(selector)
  await page.press('Ctrl+A')
  await page.type('128')
  await page.click({ selector: 'button', text: 'Save hosting settings' })
  await page.waitFor(() => document.querySelector('.host-hub')?.textContent.includes('Hosting settings saved.'))
  await page.screenshot('live-upload-limit')
  return { before, after: await page.eval(s => document.querySelector(s).value, selector) }
}
