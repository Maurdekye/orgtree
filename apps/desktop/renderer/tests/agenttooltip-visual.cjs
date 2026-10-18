module.exports = async (page) => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.sq-title .name', { timeout: 5000 })
  await page.hover('.sq-title .name')
  await page.waitFor('.sq-title .name[title]', { timeout: 5000 })

  const details = await page.eval(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const name = document.querySelector('.sq-title .name')
    return {
      visibleName: name?.textContent || '',
      title: name?.getAttribute('title') || '',
      cardLevel: document.querySelector('.sq')?.className || '',
      duplicatePlainTitle: name?.getAttribute('title') === name?.textContent,
    }
  })
  if (details.visibleName !== 'coordinator-opus'
      || details.title !== 'Claude Opus 5.5 · high'
      || details.duplicatePlainTitle) {
    throw new Error(`near-card tooltip state is invalid: ${JSON.stringify(details)}`)
  }
  const screenshot = await page.screenshot('near-card-rich-agent-tooltip-1000x700')
  return { details, screenshots: [screenshot] }
}
