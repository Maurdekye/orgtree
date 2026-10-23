const assert = require('node:assert/strict')
module.exports = async page => {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false })
  await page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 120)) })
  const metrics = await page.eval(() => {
    const row = [...document.querySelectorAll('.set-row')].find(el => el.textContent.includes('Go to the latest @user mention'))
    row.scrollIntoView({ block: 'center' })
    const excerpt = document.querySelector('.mention-landing')
    return { caps: [...row.querySelectorAll('kbd')].map(el => el.textContent),
      excerpt: excerpt.textContent, hidden: excerpt.hidden, outline: getComputedStyle(excerpt).outlineStyle }
  })
  assert.deepEqual(metrics.caps, ['Shift', 'F4'])
  assert.equal(metrics.hidden, false)
  assert.equal(metrics.outline, 'solid')
  assert.ok(metrics.excerpt.includes('Ready for review, @user'))
  await page.screenshot('shiftf4-mention-navigation')
  return metrics
}
