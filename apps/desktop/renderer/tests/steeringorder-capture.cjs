module.exports = async page => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('fieldset textarea', { timeout: 5000 })
  await page.eval(async () => {
    const box = document.querySelector('fieldset textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Use the latest findings.')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    document.querySelector('.cc-send').click()
  })
  await page.waitFor('.sendmode', { timeout: 5000 })
  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const status = document.querySelector('.sendmode')
    const jump = document.querySelector('.desk-nav-chip[data-copy-agent-name="reviewer"]')
    const box = document.querySelector('fieldset textarea')
    const bounds = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    return { text: status.textContent, receipt: bounds(status), jump: bounds(jump), composer: bounds(box) }
  })
  if (details.text !== 'steering in mid-task' || details.receipt.height <= 0 || details.jump.height <= 0
    || details.receipt.bottom > details.jump.top || details.jump.bottom > details.composer.top)
    throw new Error(JSON.stringify(details))
  return { details, screenshots: [await page.screenshot('steering-above-jump-cards')] }
}
