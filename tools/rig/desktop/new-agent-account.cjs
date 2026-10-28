// new-agent-account.mjs's desktop stage: Org settings › Hire defaults, the
// "account for NEW agents" row, at one width in one contrast theme. It is read
// and shot with the machine default, then with another account chosen (the
// "Use machine default" button appears beside the picker), and the neighbouring
// rows are measured too. Reports what it saw; the proof decides what passes.
// Auto-save persists each edit: reset the prior choice before measurement and
// restore the machine default afterwards so the six runs cannot affect each other.
// args: { org, theme: 'charcoal' | 'light', other: '<account value>', tag }
module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}` })
  await page.goto(`/o/${args.org}`)
  await page.waitFor('.sq.user', { timeout: 60000 })
  await page.rightClick('.sq.user')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Org settings' })
  await page.waitFor('#org-settings-tab-hiredefaults')
  await page.click('#org-settings-tab-hiredefaults')
  const SEL = 'select[aria-label="Default provider account for new hires"]'
  await page.waitFor(SEL)
  // Executed in the renderer by waitFor: read only this disposable fixture org.
  // A locally selected option is not a completed auto-save.
  const persisted = async () => {
    const slug = decodeURIComponent(location.pathname.split('/')[2])
    const response = await fetch(`/api/orgs/${encodeURIComponent(slug)}`)
    if (!response.ok) throw new Error(`read default account: HTTP ${response.status}`)
    const saved = (await response.json()).default_account ?? ''
    const select = document.querySelector('select[aria-label="Default provider account for new hires"]')
    if (!select) return null
    const explicit = [...(select.closest('.set-row')?.querySelectorAll('button') ?? [])]
      .some(b => b.innerText.trim() === 'Use machine default')
    return saved === (explicit ? select.value : '') ? { default_account: saved } : null
  }
  const reset = async () => {
    const explicit = await page.eval(sel => [...(document.querySelector(sel)?.closest('.set-row')?.querySelectorAll('button') ?? [])]
      .some(b => b.innerText.trim() === 'Use machine default'), SEL)
    if (explicit) await page.click({ selector: 'button', text: 'Use machine default', scroll: true })
    const saved = await page.waitFor(persisted, { timeout: 15000 })
    if (saved.default_account !== '') throw new Error('machine default was not restored')
    return saved
  }
  const savedDefault = await reset()
  const measure = () => page.eval((sel) => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), t: Math.round(r.top), b: Math.round(r.bottom) } }
    const rowOf = (el) => el?.closest('.set-row')
    const select = document.querySelector(sel)
    const row = rowOf(select)
    const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => /machine default/.test(b.innerText))
    // the scrolling panel the rows live in: any horizontal overflow shows here
    let scroller = row?.parentElement
    while (scroller && scroller.scrollWidth <= scroller.clientWidth && scroller !== document.body) scroller = scroller.parentElement
    const neighbours = ['File and command access', 'Provider for default account'].map((label) => {
      const s = document.querySelector(`select[aria-label="${label}"]`)
      return { label, select: box(s), row: box(rowOf(s)) }
    })
    row?.scrollIntoView({ block: 'center' })
    return {
      theme: document.documentElement.dataset.contrastTheme ?? document.documentElement.className,
      row: box(row), select: box(select), selectTitle: select?.title ?? null, selectText: select?.selectedOptions[0]?.innerText ?? null,
      button: box(button), buttonText: button?.innerText.trim() ?? null,
      buttonClipped: !!button && (button.scrollWidth > button.clientWidth + 1),
      hint: row?.querySelector('.set-hint')?.innerText.trim() ?? null,
      overflowX: scroller && scroller !== document.body ? scroller.scrollWidth - scroller.clientWidth : 0,
      viewport: window.innerWidth,
      neighbours,
    }
  }, SEL)
  const before = await measure()
  await page.sleep(300)
  await page.screenshot(`${args.tag}-default`)
  await page.eval((sel, v) => {
    const el = document.querySelector(sel)
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, SEL, args.other)
  await page.waitFor({ selector: 'button', text: 'Use machine default' })
  const savedOther = await page.waitFor(persisted, { timeout: 15000 })
  if (savedOther.default_account !== args.other) throw new Error('the chosen account was not persisted')
  await page.sleep(400)
  const after = await measure()
  await page.screenshot(`${args.tag}-other`)
  const restored = await reset()
  await page.press('Escape') // Org settings has no footer Close (USER 2026-10-28 m3291e5890d55)
  await page.waitFor('#org-settings-tab-hiredefaults', { gone: true })
  return { before, after, persisted: { before: savedDefault, after: savedOther, restored } }
}
