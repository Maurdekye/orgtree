module.exports = async page => {
  const results = []
  const inspect = async name => {
    const check = await page.eval(() => {
      const d = document.querySelector('.provider-dialog')
      const r = d.getBoundingClientRect()
      return { outsideProviders: !d.closest('.set-group'), visible: r.left >= 0 && r.top >= 0
        && r.right <= innerWidth && r.bottom <= innerHeight, noHorizontalOverflow: d.scrollWidth <= d.clientWidth + 1,
        topmost: d.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }
    })
    if (!Object.values(check).every(Boolean)) {
      const dimensions = await page.eval(() => [...document.querySelectorAll('.provider-dialog, .provider-dialog *')]
        .map(e => ({ tag: e.tagName, cls: e.className, width: e.clientWidth, scroll: e.scrollWidth,
          rect: e.getBoundingClientRect().toJSON() })).filter(e => e.scroll > e.width + 1))
      throw new Error(`${name}: ${JSON.stringify({ check, dimensions })}`)
    }
    await page.screenshot(name)
    const actionsReachable = await page.eval(() => {
      const d = document.querySelector('.provider-dialog')
      d.scrollTop = d.scrollHeight
      const b = d.querySelector('.ls-actions button')
      const r = b.getBoundingClientRect()
      return r.top >= 0 && r.bottom <= innerHeight
        && b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
    if (!actionsReachable) throw new Error(`${name}: form actions are covered`)
    if (name.includes('language') && name.includes('390')) await page.screenshot(`${name}-actions`)
    results.push({ name, ...check, actionsReachable })
  }
  for (const contrast of ['dark', 'light']) {
  for (const width of ['1366x768', '390x844']) {
    await page.resize(width)
    await page.goto('/')
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), contrast === 'light')
    await page.waitFor('.ls-server')
    await page.click({ selector: 'button', text: 'Add OpenRouter key' })
    await inspect(`openrouter-add-${width}-${contrast}`)
    await page.type('synthetic-visual-fixture-key')
    await page.click('.provider-dialog button[title="set the key"]')
    await page.waitFor('.orr-standing')
    await page.click('button[title^="replace the key"]')
    await inspect(`openrouter-edit-${width}-${contrast}`)
    await page.press('Escape')
    await page.click('button[title^="add a model server"]')
    await inspect(`language-add-${width}-${contrast}`)
    await page.press('Escape')
    await page.click('button[title="edit this server"]')
    await inspect(`language-edit-${width}-${contrast}`)
    await page.press('Escape')
  }
  }
  return results
}
