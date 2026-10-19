module.exports = async (page) => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.cc-composer.urgent-armed textarea', { timeout: 5000 })
  const details = await page.eval(async () => {
    await new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const composer = document.querySelector('.cc-composer.urgent-armed')
    const toggle = composer?.querySelector('.cc-urgent-toggle')
    const box = composer?.getBoundingClientRect()
    return {
      composer: composer?.className,
      outline: getComputedStyle(composer).borderColor,
      icon: getComputedStyle(toggle).color,
      iconBorder: getComputedStyle(toggle).borderColor,
      reasonFields: document.querySelectorAll('input[aria-label="Urgent reason"]').length,
      composerBox: box && { x: box.x, y: box.y, width: box.width, height: box.height },
    }
  })
  if (details.outline !== 'rgb(255, 69, 0)' || details.icon !== 'rgb(255, 69, 0)'
      || details.iconBorder !== 'rgb(255, 69, 0)' || details.reasonFields !== 0) {
    throw new Error(`urgent composer visual state is invalid: ${JSON.stringify(details)}`)
  }
  const screenshot = await page.screenshot('urgent-composer-orange-red')
  return { details, screenshots: [screenshot] }
}
