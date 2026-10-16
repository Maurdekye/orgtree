module.exports = async (page) => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.hover('#agent-link')
  await page.waitFor('.agent-hover-tooltip', { timeout: 5000 })

  const details = await page.eval(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
    const tooltip = document.querySelector('.agent-hover-tooltip')
    const bounds = tooltip.getBoundingClientRect()
    return {
      text: tooltip.textContent.replace(/\s+/g, ' ').trim(),
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    }
  })
  if (!details.text.includes('coordinator-opus') || !details.text.includes('openai/primary')) {
    throw new Error(`tooltip identity is incomplete: ${JSON.stringify(details)}`)
  }
  const inside = (d) => d.bounds.left >= 0 && d.bounds.top >= 0
    && d.bounds.right <= d.viewport.width && d.bounds.bottom <= d.viewport.height
  if (!inside(details)) throw new Error(`tooltip is clipped: ${JSON.stringify(details)}`)
  const dark = await page.screenshot('agent-tooltip-dark-1000x700')

  await page.eval(async () => {
    document.documentElement.classList.add('contrast-light')
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
  })
  const light = await page.screenshot('agent-tooltip-light-1000x700')
  return { details, screenshots: [dark, light] }
}
