module.exports = async page => {
  const checks = []
  for (const contrast of ['dark', 'light']) for (const size of ['1366x768', '390x844']) {
    await page.resize(size); await page.goto('/')
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), contrast === 'light')
    await page.rightClick('.sq.user')
    await page.waitFor('.ctxmenu')
    const actual = await page.eval(() => {
      const root = document.querySelector('.ctxmenu'), r = root.getBoundingClientRect()
      const buttons = [...root.querySelectorAll('[role="menuitem"]')]
      const css = getComputedStyle(buttons[0])
      return { labels: buttons.map(b => b.textContent.trim()),
        flatOpen: buttons.filter(b => b.textContent.startsWith('Open ')).length === 3
          && buttons.filter(b => b.textContent.startsWith('Open ')).every(b => !b.hasAttribute('aria-haspopup')),
        visible: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        layout: [...root.children].map(e => e.getAttribute('role') === 'separator' ? 'sep' : e.textContent.trim()),
        style: [css.fontFamily, css.fontSize, css.fontWeight, css.padding, css.lineHeight] }
    })
    if (!actual.flatOpen || !actual.visible || actual.layout.indexOf('sep') !== 6)
      throw new Error(JSON.stringify(actual))
    await page.screenshot(`switchboard-${size}-${contrast}`)
    await page.press('Escape')
    await page.rightClick('#reference')
    const reference = await page.eval(() => {
      const root = document.querySelector('.ctxmenu')
      const css = getComputedStyle(root.querySelector('[role="menuitem"]'))
      return { style: [css.fontFamily, css.fontSize, css.fontWeight, css.padding, css.lineHeight],
        layout: [...root.children].map(e => e.getAttribute('role') === 'separator' ? 'sep' : e.textContent.trim()) }
    })
    const sameFormat = JSON.stringify(reference.style) === JSON.stringify(actual.style)
    const lifecycleOrder = actual.layout.slice(-4)[0] === 'sep'
      && reference.layout.slice(-4)[0] === 'sep'
    if (!sameFormat || !lifecycleOrder) throw new Error(JSON.stringify({ actual, reference }))
    checks.push({ size, contrast, ...actual, sameFormat, lifecycleOrder })
    await page.screenshot(`agent-reference-${size}-${contrast}`)
    await page.press('Escape')
  }
  return checks
}
