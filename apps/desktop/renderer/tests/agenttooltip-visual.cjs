module.exports = async (page) => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.hover('#agent-link')
  await page.waitFor('#agent-link[title]', { timeout: 5000 })

  const details = await page.eval(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
    const link = document.querySelector('#agent-link')
    return {
      title: link?.getAttribute('title') || '',
      customTooltip: !!document.querySelector('.agent-hover-tooltip, [role="tooltip"]'),
    }
  })
  if (!details.title || details.customTooltip) {
    throw new Error(`native tooltip state is invalid: ${JSON.stringify(details)}`)
  }
  const screenshot = await page.screenshot('agent-native-tooltip-1000x700')
  return { details, screenshots: [screenshot] }
}
