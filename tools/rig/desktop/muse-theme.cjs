// muse-visual.mjs's app-theme stage: the Muse Eggshell preset (visual theme
// `muse`) chosen the way a browser profile keeps it, under each contrast
// theme in turn. Reads what applyTheme set inline, what the cascade makes of
// it (the light surfaces' !important rule outranks the inline accent) and the
// colour an accent-painted probe actually gets; screenshots each.
// args: { org, agent, contrasts: ['charcoal', 'light', ...] }
module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try {
    localStorage.setItem('orgtree-visual-theme', 'muse')
    localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.contrasts[0])})
  } catch {}` })
  await page.goto(`/o/${args.org}`)
  await page.waitFor(`.sq[data-copy-agent-name="${args.agent}"]`, { timeout: 40000 })
  await page.sleep(1200)
  const out = { contrasts: {} }
  for (const contrast of args.contrasts) {
    // the contrast hook re-reads its key on a storage event, as another window's change would arrive
    await page.eval((c) => {
      localStorage.setItem('orgtree-contrast-theme', c)
      window.dispatchEvent(new window.StorageEvent('storage', { key: 'orgtree-contrast-theme', newValue: c }))
    }, contrast)
    await page.sleep(700)
    out.contrasts[contrast] = await page.eval(() => {
      const root = document.documentElement
      const cs = getComputedStyle(root)
      const probe = document.createElement('span')
      probe.dataset.museThemeProbe = ''
      probe.textContent = 'accent'
      probe.style.cssText = 'color: var(--accent); background: var(--accent-soft); position: fixed; left: 8px; top: 8px'
      document.body.append(probe)
      const fill = document.createElement('span')
      fill.dataset.museThemeProbe = ''
      fill.textContent = 'ink'
      fill.style.cssText = 'color: var(--accent-ink); background: var(--accent); position: fixed; left: 80px; top: 8px'
      document.body.append(fill)
      const read = {
        visualTheme: root.dataset.visualTheme ?? null,
        classes: [...root.classList].filter((c) => c.startsWith('contrast-')),
        inlineAccent: root.style.getPropertyValue('--accent').trim(),
        accent: cs.getPropertyValue('--accent').trim(),
        accentInk: cs.getPropertyValue('--accent-ink').trim(),
        orgAccent: cs.getPropertyValue('--org-accent').trim(),
        bg: cs.getPropertyValue('--bg').trim(),
        panel: cs.getPropertyValue('--panel').trim(),
        painted: getComputedStyle(probe).color,
        fill: getComputedStyle(fill).backgroundColor,
        ink: getComputedStyle(fill).color,
      }
      return read
    })
    await page.screenshot(`muse-theme-${contrast}`)
    await page.eval(() => { for (const s of document.querySelectorAll('[data-muse-theme-probe]')) s.remove() })
  }
  out.consoleErrors = page.consoleErrors
  return out
}
