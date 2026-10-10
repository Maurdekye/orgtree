// The provider cards' model chips, clicked (user 2026-10-10: "i should be able
// to click to change the models available without editing the entry"; "do
// this for both openrouter and language servers, if there are many models
// selected at once (say >8) then only show their icons, omit their names").
// provider-chips.mjs adds the servers and the favorites and decides what
// passes; this script clicks as the user would, reads what the cards show,
// and asks the engine after each click what it saved.
// args: { cards: { user, down, ten, many } (server labels), q38v, qwen, downModel, model0, manyMoreAfter, orFirst,
//   orPickName }
module.exports = async (page, { args }) => {
  const res = {}
  await page.sleep(1200)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
  await page.waitFor('.ls-section .ls-server', { timeout: 20000 })
  // tag each server card with its key, and the OpenRouter row
  await page.eval((cards) => { window.__cards = cards; return true }, args.cards)
  await page.waitFor(() => {
    const all = [...document.querySelectorAll('.ls-section .ls-server')]
    let n = 0
    for (const [key, label] of Object.entries(window.__cards)) {
      const el = all.find((s) => (s.querySelector('.ls-server-head b')?.innerText || '').trim() === label)
      if (el) { el.setAttribute('data-chips', key); n++ }
    }
    const or = document.querySelector('.orr-toggles:not(.ls-toggles)')
    if (or) or.setAttribute('data-chips', 'openrouter')
    return n === Object.keys(window.__cards).length && !!or
  }, { timeout: 20000 })
  // every card has heard from its server (or that it is not answering)
  await page.waitFor(() => [...document.querySelectorAll('.ls-server[data-chips] .acct-provenance')]
    .every((p) => /answering/.test(p.innerText || '')), { timeout: 30000 })
  await page.sleep(500)

  /** a row as the user sees it, with the resting look of each chip */
  const read = (key) => page.eval((key) => {
    const host = document.querySelector(`[data-chips="${key}"]`)
    const row = host?.classList.contains('orr-toggles') ? host : host?.querySelector('.ls-toggles')
    const t = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim()
    return {
      chips: [...(row?.querySelectorAll('.orr-tog') ?? [])].map((x) => ({
        name: t(x.querySelector('.orr-sel-name')) || x.getAttribute('aria-label'), on: x.getAttribute('aria-pressed') === 'true',
        letter: t(x.querySelector('.orr-card')), title: x.getAttribute('title'),
        opacity: getComputedStyle(x).opacity, border: getComputedStyle(x).borderTopStyle })),
      icons: !!row?.classList.contains('icons'),
      more: row?.querySelector('.orr-more') ? t(row.querySelector('.orr-more')) : null,
      digest: host?.classList.contains('orr-toggles') ? [] : [...(host?.querySelectorAll('.acct-provenance span') ?? [])].map(t),
      editing: !!document.querySelector('.ls-edit'),
      browser: !!document.querySelector('.ls-browser, .orr-picker'),
    }
  }, key)
  const scrollTo = (sel) => page.eval((sel) => { document.querySelector(sel)?.scrollIntoView({ block: 'center' }); return true }, sel)
  // the pointer off the chips, so a screenshot and a reading show them at rest
  const away = () => page.mouse('mouseMoved', 2, 2)
  /** click the chip `name` on a row, then wait until it reads `on` and the write is over */
  const tap = async (key, name, on) => {
    const found = await page.eval(({ key, name }) => {
      document.querySelectorAll('[data-chip-target]').forEach((e) => e.removeAttribute('data-chip-target'))
      const host = document.querySelector(`[data-chips="${key}"]`)
      const chip = [...(host?.querySelectorAll('.orr-tog') ?? [])].find((x) =>
        ((x.querySelector('.orr-sel-name')?.innerText || '').trim() || x.getAttribute('aria-label')) === name)
      if (!chip) return false
      chip.setAttribute('data-chip-target', '1')
      chip.scrollIntoView({ block: 'center' })
      return true
    }, { key, name })
    if (!found) throw new Error(`no chip ${name} on ${key}`)
    await page.sleep(300)
    await page.click('[data-chip-target]')
    await page.eval((want) => { window.__want = want; return true }, { key, name, on })
    await page.waitFor(() => {
      const { key, name, on } = window.__want
      const host = document.querySelector(`[data-chips="${key}"]`)
      const chip = [...(host?.querySelectorAll('.orr-tog') ?? [])].find((x) =>
        ((x.querySelector('.orr-sel-name')?.innerText || '').trim() || x.getAttribute('aria-label')) === name)
      return !!chip && chip.getAttribute('aria-pressed') === String(on) && !chip.disabled
    }, { timeout: 15000 })
    await away()
    await page.sleep(300)
  }
  const offered = async (label) => {
    const s = ((await page.api('GET', '/api/langservers')).servers ?? []).find((x) => x.label === label)
    return Object.values(s?.models ?? {}).filter((m) => m.offered).map((m) => ({ id: m.id, told: m.context_in_use }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  const favorites = async () => ((await page.api('GET', '/api/openrouter')).tiers ?? []).map((t) => t.model)

  // 1. the Language Server cards as they open
  await scrollTo('[data-chips="user"]')
  await away()
  await page.sleep(600)
  await page.screenshot('1-servers')
  res.start = { user: await read('user'), down: await read('down'), ten: await read('ten'), many: await read('many') }

  // 2. the user's own Ollama: offer the dimmed 64K Qwen 3.8, then withdraw the plain Qwen 3.6
  await tap('user', args.q38v, true)
  res.afterOffer = { row: await read('user'), offered: await offered(args.cards.user) }
  await scrollTo('[data-chips="user"]')
  await page.screenshot('2-user-offered-q38-64k')
  await tap('user', args.qwen, false)
  res.afterWithdraw = { row: await read('user'), offered: await offered(args.cards.user) }
  await scrollTo('[data-chips="user"]')
  await page.screenshot('3-user-withdrew-qwen36')

  // 3. a server that is not answering: its known chips still switch
  await tap('down', args.downModel, false)
  res.down = { row: await read('down'), offered: await offered(args.cards.down) }

  // 4. ten of twelve offered: the chips are cards alone
  await scrollTo('[data-chips="ten"]')
  await away()
  await page.screenshot('4-ten-offered-icons')

  // 5. 302 models: "+300 more" opens the browser, which saves each change at once
  await scrollTo('[data-chips="many"] .orr-more')
  await page.sleep(300)
  await page.click('[data-chips="many"] .orr-more')
  await page.waitFor(() => document.querySelectorAll('.ls-browser .orr-row').length >= 25, { timeout: 30000 })
  await page.sleep(500)
  const title = () => page.eval(() => (document.querySelector('.ls-browser h3')?.innerText || '').replace(/\s+/g, ' ').trim())
  res.browser = { title: await title() }
  await page.eval((id) => {
    const row = [...document.querySelectorAll('.ls-browser .orr-row')].find((r) => (r.querySelector('b')?.innerText || '').trim() === id)
    row?.querySelector('button.ls-offer')?.setAttribute('data-offer-target', '1')
    return true
  }, args.model0)
  await page.click('[data-offer-target]')
  await page.waitFor(() => /3 offered/.test(document.querySelector('.ls-browser h3')?.innerText || '')
    && !document.querySelector('[data-offer-target]')?.disabled, { timeout: 15000 })
  res.browser.after = await title()
  res.browser.editing = await page.eval(() => !!document.querySelector('.ls-edit'))
  res.browser.offered = await offered(args.cards.many)
  await page.screenshot('5-browser-saves-at-once')
  await page.click({ selector: '.ls-browser .orr-pager button', text: '^done$', regex: true })
  await page.waitFor('.ls-browser', { timeout: 10000, gone: true }).catch(() => null)
  // the card asks the server about its known models again (one more now): wait for that answer
  await page.eval((more) => { window.__more = more; return true }, args.manyMoreAfter)
  await page.waitFor(() => (document.querySelector('[data-chips="many"] .orr-more')?.innerText || '').trim() === window.__more,
    { timeout: 15000 }).catch(() => null)
  await away()
  res.many = await read('many')

  // 6. OpenRouter with nine favorites: cards alone
  await scrollTo('[data-chips="openrouter"]')
  await away()
  await page.sleep(500)
  res.or = { start: await read('openrouter'), favorites: await favorites() }
  await page.screenshot('6-openrouter-nine-icons')
  // a click deselects one (eight left: the names come back), a second selects it again
  await tap('openrouter', args.orFirst, false)
  res.or.deselected = { row: await read('openrouter'), favorites: await favorites() }
  await scrollTo('[data-chips="openrouter"]')
  await page.screenshot('7-openrouter-deselected-names')
  await tap('openrouter', args.orFirst, true)
  res.or.reselected = { row: await read('openrouter'), favorites: await favorites() }
  // "+" opens the picker; a pick there adds a chip
  await scrollTo('[data-chips="openrouter"] .orr-more')
  await page.sleep(300)
  await page.click('[data-chips="openrouter"] .orr-more')
  await page.waitFor(() => document.querySelectorAll('.orr-picker .orr-row').length > 0, { timeout: 15000 })
  await page.sleep(500)
  await page.screenshot('8-openrouter-picker')
  const picked = await page.eval((name) => {
    const row = [...document.querySelectorAll('.orr-picker .orr-row')].find((r) => (r.querySelector('b')?.innerText || '').trim() === name)
    row?.setAttribute('data-pick-target', '1')
    row?.scrollIntoView({ block: 'center' })
    return !!row
  }, args.orPickName)
  if (!picked) throw new Error(`no picker row ${args.orPickName}`)
  await page.sleep(300)
  await page.click('[data-pick-target]')
  await page.waitFor(() => document.querySelector('[data-pick-target]')?.getAttribute('aria-pressed') === 'true', { timeout: 15000 })
  res.or.picked = { favorites: await favorites() }
  await page.click({ selector: '.orr-picker .orr-pager button', text: '^done$', regex: true })
  await page.waitFor('.orr-picker', { timeout: 10000, gone: true }).catch(() => null)
  await away()
  res.or.end = await read('openrouter')
  await scrollTo('[data-chips="openrouter"]')
  await page.screenshot('9-openrouter-after-pick')

  // 7. the light theme: the dimmed chips and the lanes' colours there
  await page.eval(() => { document.documentElement.classList.add('contrast-light'); return true })
  await scrollTo('[data-chips="user"]')
  await page.sleep(600)
  await page.screenshot('10-light-servers')
  res.light = { user: await read('user') }
  await scrollTo('[data-chips="openrouter"]')
  await page.sleep(400)
  await page.screenshot('11-light-openrouter')
  await page.eval(() => { document.documentElement.classList.remove('contrast-light'); return true })
  return res
}
