module.exports = async page => {
  const checks = []
  for (const contrast of ['dark', 'light']) for (const size of ['1366x768', '390x844']) {
    await page.resize(size)
    await page.goto('/')
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), contrast === 'light')
    await page.waitFor('input[aria-label="First server active"]')
    const inspect = async (name, label, checked, disabled) => {
      await page.eval(label => document.querySelector(`input[aria-label="${label}"]`).scrollIntoView({ block: 'center' }), label)
      const result = await page.eval(({ label, checked, disabled }) => {
        const input = document.querySelector(`input[aria-label="${label}"]`)
        const r = input.getBoundingClientRect()
        const row = input.closest('.set-row').getBoundingClientRect()
        const panel = document.querySelector('.settings').getBoundingClientRect()
        return { checked: input.checked === checked, disabled: input.disabled === disabled,
          visible: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
          fits: row.left >= panel.left && row.right <= Math.min(panel.right, innerWidth) }
      }, { label, checked, disabled })
      if (!Object.values(result).every(Boolean)) {
        const overflow = await page.eval(() => [...document.querySelectorAll('.settings, .settings *')]
          .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({ tag: e.tagName, cls: e.className,
            width: e.clientWidth, scroll: e.scrollWidth })))
        throw new Error(`${name}: ${JSON.stringify({ result, overflow })}`)
      }
      await page.screenshot(`${name}-${size}-${contrast}`)
      checks.push({ name, size, contrast, ...result })
    }
    await inspect('providers-on', 'First server active', true, false)
    await page.click('input[aria-label="First server active"]')
    await inspect('providers-off', 'First server active', false, false)
    await page.click({ selector: 'button', text: 'Show Org Settings', scroll: true })
    await page.waitFor('input[aria-label="Second server"]')
    await inspect('org-global-off', 'Second server', false, true)
    await page.click('input[aria-label="First server"]')
    await inspect('org-revoked', 'First server', false, true)
    await page.click({ selector: 'button', text: 'Show Providers', scroll: true })
    await page.waitFor('input[aria-label="First server active"]')
    await page.click({ selector: 'input[aria-label="First server active"]', scroll: true })
    await page.click({ selector: 'button', text: 'Show Org Settings', scroll: true })
    await page.waitFor('input[aria-label="First server"]')
    await inspect('org-global-restored', 'First server', false, false)
  }
  return checks
}
