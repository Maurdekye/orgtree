module.exports = async page => {
  const results = []
  for (const contrast of ['dark', 'light']) for (const size of ['1366x768', '390x844']) {
    await page.resize(size)
    await page.goto('/')
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), contrast === 'light')
    await page.waitFor('input[aria-label="Use Local models"]')
    await page.waitFor({ selector: '.acct-provider-note', text: 'Sign in to use this harness.' })
    await page.waitFor('input[aria-label="Team budget active"]')
    await page.waitFor('.provider-accounts[aria-label="Muse accounts"] .account-row:not(.native-login)')
    const dimensions = await page.eval(() => {
      const panel = document.querySelector('#app-settings-panel-providers')
      const rect = panel.getBoundingClientRect()
      const groups = [...panel.querySelectorAll('.acct-provider-group, .set-group:has(> .prov-openrouter), .ls-section')].map(e => ({ height: e.getBoundingClientRect().height, text: e.innerText.slice(0, 40) }))
      // each OpenRouter key row: whether its switch shares the identity line,
      // and whether the name and verdict are cut off
      const keyRows = [...panel.querySelectorAll('.orr-keyrow')].map(row => {
        const main = row.querySelector('.acct-main').getBoundingClientRect()
        const toggle = row.querySelector('.set-row').getBoundingClientRect()
        const name = row.querySelector('.acct-email')
        return { name: name.innerText, height: row.getBoundingClientRect().height,
          switchOnIdentityLine: toggle.top < main.bottom && toggle.bottom > main.top, nameClipped: name.scrollWidth > name.clientWidth }
      })
      return { width: rect.width, contentHeight: panel.scrollHeight, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth, groups, keyRows }
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
    for (const id of ['muse', 'openrouter']) {
      await page.eval(id => document.querySelector(`.acct-provider-head.prov-${id}`).scrollIntoView({ block: 'start' }), id)
      await page.screenshot(`providers-${id}-${size}-${contrast}`)
    }
    await page.eval(() => document.querySelector('.ls-section').scrollIntoView({ block: 'end' }))
    await page.screenshot(`providers-servers-${size}-${contrast}`)
    results.push({ size, contrast, ...dimensions, controls })
  }
  return results
}
