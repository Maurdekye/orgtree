module.exports = async page => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.pinwin .selection-source p', { timeout: 6000 })
  const details = await page.eval(async () => {
    const source = [...document.querySelectorAll('.pinwin .selection-source')].find(el => el.textContent.includes('beside this passage'))
    const text = source.querySelector('p'), node = text.firstChild
    const range = document.createRange(); range.setStart(node, 4); range.setEnd(node, 18)
    const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range)
    const rect = range.getBoundingClientRect(), point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: point.x, clientY: point.y }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const menu = document.querySelector('.ctxmenu'), menuRect = menu.getBoundingClientRect(), sourceRect = source.getBoundingClientRect()
    return { point, menu: { x: menuRect.x, y: menuRect.y, width: menuRect.width, height: menuRect.height },
      source: { width: sourceRect.width, height: sourceRect.height }, selected: selected.toString(),
      entries: [...menu.querySelectorAll('[role="menuitem"]')].map(el => el.getAttribute('aria-label') ?? el.textContent),
      origin: menu.parentElement === document.body, viewport: { width: innerWidth, height: innerHeight } }
  })
  if (details.source.width || details.source.height || !details.origin || details.point.x < 500
    || details.menu.x !== details.point.x || details.menu.y !== details.point.y
    || details.menu.x + details.menu.width > details.viewport.width || details.menu.y + details.menu.height > details.viewport.height
    || details.entries.join('|') !== 'Reply to selection|Copy|Select All') throw new Error(JSON.stringify(details))
  return { details, screenshots: [await page.screenshot('selection-menu-pinned-at-pointer')] }
}
