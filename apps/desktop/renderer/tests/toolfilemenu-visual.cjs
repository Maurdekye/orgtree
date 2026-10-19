module.exports = async page => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('body[data-ready="true"] a.tool-file-link', { timeout: 5000 })
  await page.rightClick('a.tool-file-link')
  await page.waitFor('.ctxmenu [role="menuitem"]', { timeout: 5000 })

  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200))))
    return {
      title: document.querySelector('.tline')?.textContent?.trim(),
      labels: [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(item => item.textContent?.trim()),
      disabled: [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].some(item => item.disabled),
    }
  })
  if (!details.title?.includes('cancel-next.png')
      || JSON.stringify(details.labels) !== JSON.stringify(['Open', 'Show in folder', 'Copy path', 'Copy file name'])
      || details.disabled) throw new Error(`unexpected file menu capture: ${JSON.stringify(details)}`)
  const screenshot = await page.screenshot('tool-row-file-context-menu')
  return { details, screenshots: [screenshot] }
}
