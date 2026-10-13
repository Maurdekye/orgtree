// muse-visual.mjs's desktop stage, in one contrast theme: Muse cards (one per
// tier, one frozen) beside an Antigravity Flash card, at normal and far zoom;
// the Providers row and the Usage card. Reads what each shows (classes,
// computed colours, tier letters, state text and icons) and screenshots it;
// the proof decides.
// args: { org, theme: 'charcoal' | 'light', agents: [names] }
module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}` })
  await page.goto(`/o/${args.org}`)
  const first = `.sq[data-copy-agent-name="${args.agents[0]}"]`
  await page.waitFor(first, { timeout: 40000 })
  await page.sleep(1500)
  const read = () => page.eval((names) => Object.fromEntries(names.map((n) => {
    const e = document.querySelector(`.sq[data-copy-agent-name="${n}"]`)
    if (!e) return [n, null]
    const cs = getComputedStyle(e)
    const rail = getComputedStyle(e, '::before')
    const chip = e.querySelector('.tier')
    return [n, {
      cls: [...e.classList].filter((c) => /^(prov-|tier-|mini|norm|frozen|busy)/.test(c)),
      providerAccent: cs.getPropertyValue('--provider-accent').trim(),
      borderTop: cs.borderTopColor, border: cs.borderLeftColor, background: cs.backgroundColor,
      rail: rail.content && rail.content !== 'none' ? rail.backgroundColor : null,
      chip: chip ? { text: chip.textContent.trim(), color: getComputedStyle(chip).color, bg: getComputedStyle(chip).backgroundColor } : null,
      state: e.querySelector('.sq-workstate')?.textContent ?? null,
      snowflake: !!e.querySelector('.badge.frozen svg, .sq-far-icon.frozen'),
      farIcons: [...e.querySelectorAll('.sq-far-icon')].map((x) => x.getAttribute('class')),
      text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }]
  })), args.agents)
  const out = { theme: args.theme }
  for (let i = 0; i < 16; i++) {
    if (await page.eval((sel) => document.querySelector(sel)?.classList.contains('norm'), first)) break
    await page.click('.zoomhud button[title="zoom in"]')
    await page.sleep(200)
  }
  await page.sleep(700)
  out.near = await read()
  await page.screenshot(`${args.theme}-near`)
  for (let i = 0; i < 20; i++) {
    if (await page.eval((sel) => document.querySelector(sel)?.classList.contains('mini'), first)) break
    await page.click('.zoomhud button[title="zoom out"]')
    await page.sleep(200)
  }
  await page.sleep(700)
  out.far = await read()
  await page.screenshot(`${args.theme}-far`)
  // the Providers row
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
  await page.waitFor('.acct-provider-head.prov-muse', { timeout: 20000 })
  await page.eval(() => document.querySelector('.acct-provider-head.prov-muse')?.scrollIntoView({ block: 'start' }))
  await page.sleep(900)
  out.providers = await page.eval(() => {
    const head = document.querySelector('.acct-provider-head.prov-muse')
    const group = head?.closest('.acct-provider-group')
    const t = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim()
    return {
      head: t(head), text: t(group).slice(0, 700),
      border: head ? getComputedStyle(head).borderBottomColor : null,
      tiers: [...(group?.querySelectorAll('.acct-provider-tier .tier') ?? [])].map((x) => ({
        cls: x.getAttribute('class'), text: x.textContent.trim(), color: getComputedStyle(x).color, bg: getComputedStyle(x).backgroundColor })),
      swatches: [...(group?.querySelectorAll('.account-swatch') ?? [])].map((x) => ({
        cls: x.getAttribute('class'), bg: getComputedStyle(x).backgroundColor, ring: getComputedStyle(x).boxShadow })),
    }
  })
  await page.screenshot(`${args.theme}-providers`)
  await page.press('Escape')
  await page.sleep(600)
  // the Usage card
  await page.eval(() => document.querySelector('.usage-history-btn')?.previousElementSibling?.click())
  await page.waitFor('.usage-modal', { timeout: 15000 })
  await page.sleep(2500)
  out.usage = await page.eval(() => [...document.querySelectorAll('.usage-modal .usage-acct')].map((c) => ({
    label: c.querySelector('.acct-label')?.innerText.trim() ?? null,
    text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  })))
  await page.screenshot(`${args.theme}-usage`)
  await page.press('Escape')
  out.consoleErrors = page.consoleErrors
  return out
}
