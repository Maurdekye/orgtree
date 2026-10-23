module.exports = async page => {
  await page.resize('1000x700'); await page.goto('/')
  await page.waitFor('input[aria-label="Custom theme color"]', { timeout: 5000 })
  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const select = document.querySelector('select[aria-label="Visual theme"]')
    // Size it as a visible option list for this one capture, exposing every
    // actual production option without depending on a native dropdown popup.
    select.size = select.options.length
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = select.getBoundingClientRect()
    return { options: [...select.options].map(o => o.text), selected: select.value,
      color: document.querySelector('input[aria-label="Custom theme color"]').value,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, height: innerHeight }
  })
  if (details.options.includes('Orgtree Grey') || details.options.length !== 7
    || details.selected !== 'custom' || details.color !== '#b6bdc8'
    || details.box.height <= 0 || details.box.y + details.box.height > details.height) throw new Error(JSON.stringify(details))
  return { details, screenshots: [await page.screenshot('theme-list-with-migrated-custom-color')] }
}
