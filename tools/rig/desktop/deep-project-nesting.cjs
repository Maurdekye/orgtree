// Scalar assertions and two paint frames before screenshots; no native input.
module.exports = async (page, { args }) => {
  await page.waitFor(() => document.querySelector('.viewport') || /hit a problem/.test(document.body.innerText), { timeout: 25000 })
  const crashed = await page.eval(() => /hit a problem and had to stop/.test(document.body.innerText))
  if (crashed) { await page.screenshot(`depth-${args.depth}-crash`); return { crashed, rows: 0, leaf: false } }
  await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot(`depth-${args.depth}-canvas`)
  await page.click('.tray-toggle')
  await page.waitFor('.tray-row', { timeout: 10000 })
  const result = await page.eval(() => {
    const rows = [...document.querySelectorAll('.tray-row')]
    return { rows: rows.length, leaf: rows.some(r => r.innerText.includes('leaf')),
      crashed: /hit a problem and had to stop/.test(document.body.innerText),
      finite: rows.every(r => Number.isFinite(r.getBoundingClientRect().x)) }
  })
  await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot(`depth-${args.depth}-agents`)
  return { ...result, consoleErrors: page.consoleErrors }
}
