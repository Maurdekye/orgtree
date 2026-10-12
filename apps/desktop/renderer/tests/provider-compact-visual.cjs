module.exports = async page => {
  const results = []
  for (const contrast of ['dark', 'light']) for (const size of ['1366x768', '390x844']) {
    await page.resize(size)
    await page.goto('/')
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), contrast === 'light')
    await page.waitFor('input[aria-label="Use Local models"]')
    await page.waitFor({ selector: '.acct-provider-note', text: 'Sign in to use this harness.' })
    const dimensions = await page.eval(() => {
      const panel = document.querySelector('#app-settings-panel-providers')
      const rect = panel.getBoundingClientRect()
      const groups = [...panel.querySelectorAll('.acct-provider-group, .ls-section')].map(e => ({ height: e.getBoundingClientRect().height, text: e.innerText.slice(0, 40) }))
      return { width: rect.width, contentHeight: panel.scrollHeight, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth, groups }
    })
    const controls = await page.eval(() => [...document.querySelectorAll('#app-settings-panel-providers input[type="checkbox"], #app-settings-panel-providers button, #app-settings-panel-providers a')]
      .filter(e => e.getBoundingClientRect().width > 0).map((e, index) => ({ index, name: e.getAttribute('aria-label') || e.title || e.innerText, checked: e.checked, disabled: e.disabled })))
    for (const control of controls) {
      const bounds = await page.eval(index => {
        const els = [...document.querySelectorAll('#app-settings-panel-providers input[type="checkbox"], #app-settings-panel-providers button, #app-settings-panel-providers a')].filter(e => e.getBoundingClientRect().width > 0)
        const e = els[index]
        e.scrollIntoView({ block: 'center' })
        const r = e.getBoundingClientRect()
        const label = e.closest('label')
        const hit = (label || e).getBoundingClientRect()
        return { inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          width: r.width, height: r.height, hitWidth: hit.width, hitHeight: hit.height }
      }, control.index)
      if (!bounds.inViewport) throw new Error(`Unreachable control ${size}/${contrast}: ${JSON.stringify({ control, bounds })}`)
      control.bounds = bounds
    }
    await page.eval(() => document.querySelector('.settings').scrollTop = 0)
    await page.screenshot(`providers-top-${size}-${contrast}`)
    await page.eval(() => document.querySelector('.ls-section').scrollIntoView({ block: 'end' }))
    await page.screenshot(`providers-servers-${size}-${contrast}`)
    results.push({ size, contrast, ...dimensions, controls })
  }
  return results
}
