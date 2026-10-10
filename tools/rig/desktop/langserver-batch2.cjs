// The Language Server settings after the user's second round (2026-10-10
// 08:48–08:50Z), as the user sees them; langserver-lane.mjs section 9 decides
// what passes. One server (args.label) listing about 300 models:
//   the card: one read-only line, its digest, its models as chips, and where
//     the server runs another window than agents are told;
//   ✎: the draft form; the models chips open the browser;
//   the browser: page one, a search, the thinking + 256K filters, an offer
//     and a withdrawal (the draft only); done; Cancel drops the draft;
//   ✎ again: a new seat price, Save.
// args: { label }
module.exports = async (page, { args }) => {
  const card = '[data-ls-server]'
  // the settings panel scrolls: every click first brings its target into view
  const tap = async (sel, text) => {
    await page.eval(({ sel, text }) => {
      const re = text ? new RegExp(text) : null
      const el = [...document.querySelectorAll(sel)].find((e) => !re || re.test((e.innerText || '').trim()))
      el?.scrollIntoView({ block: 'center' })
      return true
    }, { sel, text: text ?? null })
    await page.sleep(300)
    await page.click(text ? { selector: sel, text, regex: true } : sel)
  }
  await page.sleep(1200)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
  await page.waitFor('.ls-section .ls-server', { timeout: 20000 })
  // tag the card by its name, so every step below finds the same one
  await page.eval((label) => { window.__lsLabel = label; return true }, args.label)
  await page.waitFor(() => {
    const el = [...document.querySelectorAll('.ls-section .ls-server')]
      .find((s) => (s.querySelector('.ls-server-head b')?.innerText || '').trim() === window.__lsLabel)
    if (el) el.setAttribute('data-ls-server', window.__lsLabel)
    return !!el
  }, { timeout: 20000 })
  // its check of the offered models' windows
  await page.waitFor(() => /answering/.test(document.querySelector('[data-ls-server] .acct-provenance')?.innerText || ''),
    { timeout: 30000 })
  await page.eval((sel) => { document.querySelector(sel)?.scrollIntoView({ block: 'center' }); return true }, card)
  await page.sleep(800)
  await page.screenshot('1-card-summary')
  const summary = await page.eval((sel) => {
    const c = document.querySelector(sel)
    const t = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim()
    return {
      head: t(c?.querySelector('.ls-server-head')),
      buttons: [...(c?.querySelectorAll('.acct-main > .acct-btn') ?? [])].map((b) => ({ title: b.getAttribute('title'), text: t(b), icon: !!b.querySelector('svg') })),
      digest: [...(c?.querySelectorAll('.acct-provenance span') ?? [])].map(t),
      chips: [...(c?.querySelectorAll('.ls-chip') ?? [])].map((x) => ({ letter: t(x.querySelector('.orr-card')), name: t(x.querySelector('.orr-sel-name')), title: x.getAttribute('title') })),
      mismatches: [...(c?.querySelectorAll('.ls-mismatch-line') ?? [])].map(t),
      editable: (c?.querySelectorAll('input, select, textarea') ?? []).length,
    }
  }, card)

  // ✎: the draft form
  await tap(`${card} button[title="edit this server"]`)
  await page.waitFor(`${card} .ls-edit`, { timeout: 10000 })
  await page.sleep(500)
  await page.screenshot('2-card-edit')
  const form = await page.eval((sel) => {
    const f = document.querySelector(`${sel} .ls-edit`)
    return {
      inputs: [...(f?.querySelectorAll('input[aria-label]') ?? [])].map((i) => i.getAttribute('aria-label')),
      toggle: !!f && /offer this server.s models to new hires/.test(f.innerText),
      models: !!f?.querySelector('.ls-favs'),
    }
  }, card)

  // the browser over the whole list
  await tap(`${card} .ls-edit .ls-favs`)
  await page.waitFor(() => document.querySelectorAll('.ls-browser .orr-row').length >= 25, { timeout: 30000 })
  await page.sleep(600)
  await page.screenshot('3-browser-page-one')
  const view = () => page.eval(() => {
    const b = document.querySelector('.ls-browser')
    const t = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim()
    return {
      title: t(b?.querySelector('h3')),
      count: t(b?.querySelector('.ls-count')),
      pager: t(b?.querySelector('.orr-pager .dim')),
      names: [...(b?.querySelectorAll('.orr-row .orr-name b') ?? [])].map(t),
      offered: [...(b?.querySelectorAll('.orr-row button.ls-offer[aria-pressed="true"]') ?? [])].length,
      mismatch: t(b?.querySelector('.orr-row .ls-mismatch')),
      chips: [...(b?.querySelectorAll('.orr-selected .orr-sel-name') ?? [])].map(t),
    }
  })
  const pageOne = await view()
  const setValue = async (sel, value) => {
    await page.eval(({ sel, value }) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      return true
    }, { sel, value })
    await page.sleep(400)
  }
  await setValue('.ls-browser input[aria-label="search the server\'s models"]', 'model-29')
  await page.screenshot('4-browser-search')
  const searched = await view()
  await setValue('.ls-browser input[aria-label="search the server\'s models"]', '')
  await tap('.ls-browser input[aria-label="thinking only"]')
  await setValue('.ls-browser select[aria-label="trained window at least"]', '262144')
  await page.screenshot('5-browser-filters')
  const filtered = await view()
  await tap('.ls-browser input[aria-label="thinking only"]')
  await setValue('.ls-browser select[aria-label="trained window at least"]', '0')
  // offer one, withdraw one: the draft only
  await page.eval(() => {
    const row = [...document.querySelectorAll('.ls-browser .orr-row')].find((r) => (r.querySelector('b')?.innerText || '').trim() === 'model-000:7b')
    row?.querySelector('button.ls-offer')?.click()
    return true
  })
  await page.sleep(400)
  await tap('.ls-browser .orr-selected button[aria-label="withdraw qwen3.6-35b-a3b:latest"]')
  await page.sleep(400)
  await page.screenshot('6-browser-picks')
  const picked = await view()
  await tap('.ls-browser .orr-pager button', '^done$')
  await page.waitFor('.ls-browser', { timeout: 10000, gone: true }).catch(() => null)
  await page.sleep(400)
  await page.screenshot('7-card-edit-draft')
  const draftChips = await page.eval((sel) => [...document.querySelectorAll(`${sel} .ls-edit .ls-chip .orr-sel-name`)]
    .map((x) => (x.innerText || '').trim()), card)
  // Cancel drops the draft
  await tap(`${card} .ls-edit button`, '^Cancel$')
  await page.waitFor(`${card} .ls-edit`, { timeout: 10000, gone: true }).catch(() => null)
  await page.sleep(600)
  const afterCancel = await page.eval((sel) => [...document.querySelectorAll(`${sel} .ls-chip .orr-sel-name`)]
    .map((x) => (x.innerText || '').trim()), card)
  // ✎ again: a new seat price, Save
  await tap(`${card} button[title="edit this server"]`)
  await page.waitFor(`${card} .ls-edit`, { timeout: 10000 })
  await setValue(`${card} .ls-edit input[aria-label="seat price"]`, '2')
  await tap(`${card} .ls-edit button`, '^Save$')
  await page.waitFor(`${card} .ls-edit`, { timeout: 15000, gone: true }).catch(() => null)
  await page.sleep(800)
  await page.screenshot('8-card-saved')
  const saved = await page.eval((sel) => [...document.querySelectorAll(`${sel} .acct-provenance span`)]
    .map((x) => (x.innerText || '').trim()), card)
  return { summary, form, pageOne, searched, filtered, picked, draftChips, afterCancel, saved }
}
