module.exports = async page => {
  const CARD = '[data-copy-agent-name="gold-agent"].sq'
  await page.waitFor(CARD, { timeout: 60000 })
  const card = await page.eval(() => {
    const el = document.querySelector('[data-copy-agent-name="gold-agent"].sq')
    const css = getComputedStyle(el)
    // Resolves the provider's actual colour through the browser, including var().
    const probe = document.createElement('span')
    probe.style.color = 'var(--prov-langserver)'; el.appendChild(probe)
    const provider = getComputedStyle(probe).color
    probe.style.borderTop = '1px solid color-mix(in srgb, var(--tier-langserver) 55%, var(--line))'
    const tierBorder = getComputedStyle(probe).borderTopColor
    probe.remove()
    return { provider, tier: css.getPropertyValue('--langserver-gold').trim(), border: css.borderTopColor, tierBorder }
  })
  await page.screenshot('01-language-server-card')
  await page.eval(() => window.dispatchEvent(new CustomEvent('orgtree:open-app-settings', { detail: { tab: 'display' } })))
  const SELECT = '[aria-label="Visual theme"]'
  await page.waitFor(SELECT, { timeout: 20000 })
  await page.eval(() => {
    const select = document.querySelector('[aria-label="Visual theme"]')
    select.value = 'langserver'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitFor(() => document.documentElement.dataset.visualTheme === 'langserver')
  await page.screenshot('02-language-server-gold-picker')
  const selected = await page.eval(() => ({
    label: document.querySelector('[aria-label="Visual theme"]').selectedOptions[0].textContent,
    stored: localStorage.getItem('orgtree-visual-theme'),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  }))
  await page.eval(() => {
    const select = document.querySelector('[aria-label="Contrast color"]')
    select.value = 'light'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitFor(() => document.documentElement.classList.contains('contrast-light'))
  await page.screenshot('03-gold-picker-light')
  const light = await page.eval(() => ({
    provider: getComputedStyle(document.documentElement).getPropertyValue('--prov-langserver').trim(),
  }))
  return { ...selected, card, light, errors: page.consoleErrors }
}
