module.exports = async page => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('#org-inbox-dnd-warning', { timeout: 5000 })
  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const select = document.querySelector('select[aria-label="Org inbox mode"]')
    const warning = document.querySelector('#org-inbox-dnd-warning')
    const r = warning.getBoundingClientRect()
    return { mode: select.value, options: [...select.options].map(o => o.text), warning: warning.textContent,
      box: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: { width: innerWidth, height: innerHeight } }
  })
  if (details.mode !== 'dnd' || !details.warning.includes('Hubchat') || !details.warning.includes('not read or delivered automatically')
    || details.box.width <= 0 || details.box.x < 0 || details.box.y < 0
    || details.box.x + details.box.width > details.viewport.width || details.box.y + details.box.height > details.viewport.height)
    throw new Error(JSON.stringify(details))
  return { details, screenshots: [await page.screenshot('org-dnd-connections')] }
}
