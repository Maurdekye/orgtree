// tools/rig/desktop/remote-org.cjs: the window half of
// tools/rig/proofs/remote-org.mjs (docs/rust-engine/remote-org.md). The real
// renderer bundle runs against the run's engine ("this computer"), which
// relays to a second, standalone rig engine. Three stages, one per window:
//
//   add     on `/`: Add a remote engine... with the address, the token and a
//           name, typed through CDP; then the list with its marks
//   window  on `/o/<alias>`: the remote organization used like a local one,
//           then an outage, a restart of the remote engine and a revoked
//           token, all under the SAME open window. The proof makes each of
//           those happen when this script asks for it (args.control)
//   local   on `/o/<local>`: a local organization beside it, as before
//
// Input is CDP only, in this window only; the harness is muted and off the
// real clipboard (guards.cjs). The token is typed into a password field and
// is never logged or returned.
//
// The rig has no main process, so no desktop bridge: without one the page is
// the plain browser layout, which has no status strip and so no connection
// chip. A minimal bridge is planted before the page loads (as
// quick-chat-header.cjs does, shaped like the renderer's tests/shellbridge.tsx),
// with the identity the desktop's main gives such a window: "homepage" for the
// list, "org" with the organization's alias for the other two. A remote
// organization's window has no other identity than its alias; main adds
// X-Orgtree-Remote for it, and the rig's harness does the same (main.cjs).
'use strict'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c)

/** listeners return an unsubscribe, reads return a value, anything else is absent */
const bridge = (identity, version) => `
  (() => {
    const id = ${JSON.stringify(identity)}
    const prefs = {}
    window.orgtreeDesktop = {
      getAppVersion: async () => ${JSON.stringify(version)},
      getPreferences: async () => prefs,
      setPreferences: async (patch) => Object.assign(prefs, patch),
      onEvent: () => () => {},
      windowIdentity: id,
      getWindowIdentity: async () => id,
      requestOrg: async () => null,
    }
  })()`

module.exports = async (page, { args }) => {
  const sleep = page.sleep
  const identity = args.stage === 'add' ? { windowId: 'rig-homepage', kind: 'homepage' } : { windowId: 'rig-org', kind: 'org', org: args.org }
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bridge(identity, args.version) })
  await page.goto(args.stage === 'add' ? '/' : `/o/${args.org}`)
  /** after the next two frames: a capture must show what the DOM says */
  const paint = () => page.eval(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))
  const shot = async name => { await paint(); await sleep(200); return page.screenshot(name) }
  const card = name => `[data-copy-agent-name="${name}"]`
  const cards = () => page.eval(() => [...document.querySelectorAll('[data-copy-agent-name]')].map(e => e.getAttribute('data-copy-agent-name'))
    .filter((n, i, all) => all.indexOf(n) === i))
  const toasts = () => page.eval(() => [...document.querySelectorAll('.toasts .toast')].map(t => (t.innerText || '').trim()))
  const text = selector => page.eval(s => { const e = document.querySelector(s); return e ? (e.innerText || '').trim() : null }, selector)
  const chip = () => page.eval(() => {
    const c = document.querySelector('.chip.remote-chip')
    return c ? { text: (c.innerText || '').trim(), tone: ['ok', 'warn', 'bad'].find(t => c.classList.contains(t)) ?? null, title: c.getAttribute('title') } : null
  })
  const dimmed = () => page.eval(() => !!document.querySelector('main.solo.remote-away'))
  const until = async (what, fn, timeout = 30000, ...rest) => {
    const end = Date.now() + timeout
    let last
    for (;;) {
      last = await page.eval(fn, ...rest)
      if (last) return last
      if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`)
      await sleep(150)
    }
  }
  /** the proof does one thing to the engines (cut, restore, ...) and says what it saw */
  const ask = async step => {
    const res = await fetch(args.control + step, { method: 'POST', signal: AbortSignal.timeout(180000) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`the proof's step ${step} failed: ${body.error ?? res.status}`)
    page.log('step', step, body)
    return body
  }
  const menu = async (name, path) => {
    await page.rightClick(card(name))
    await page.waitFor('.ctxmenu[role="menu"]')
    for (let i = 0; i < path.length; i++) {
      const item = { selector: 'button.ctxmenu-item', text: `^${escapeRe(path[i])}( ▸)?$`, regex: true }
      if (i < path.length - 1) { await page.hover(item); await sleep(350) } else await page.click(item)
    }
  }
  const composer = 'textarea[data-first-use-chat]'
  const say = async words => {
    await page.click(composer)
    await page.type(words)
    await page.press('Enter')
  }

  // ------------------------------------------------------------------ add
  if (args.stage === 'add') {
    await page.waitFor('.org-remote-add', { timeout: 40000 })
    await sleep(800)
    const homepage = await page.eval(() => !!document.querySelector('.shell-homepage .shell-homepage-list'))
    const before = await page.eval(() => [...document.querySelectorAll('.org')].map(r => (r.querySelector('.org-name-text')?.innerText || '').trim()))
    await shot('01-homepage-before')
    await page.click('.org-remote-add')
    await page.waitFor('input[aria-label="Engine address"]')
    await page.click('input[aria-label="Engine address"]')
    await page.type(args.address)
    await page.click('input[aria-label="Engine token"]')
    await page.type(args.token)
    await page.click('input[aria-label="Engine name"]')
    await page.type(args.name)
    const tokenFieldType = await page.eval(() => document.querySelector('input[aria-label="Engine token"]').type)
    // the field holds it (that is its job); nothing else on the page may show it
    const tokenOnPage = await page.eval(t => (document.body.innerText || '').includes(t), args.token)
    await shot('02-add-dialog')
    await page.click({ selector: '.remote-add button', text: 'Connect' })
    let error = null
    try { await page.waitFor('.org-remote-head', { timeout: 40000 }) } catch (e) { error = (await text('.remote-add-error')) ?? String(e.message) }
    if (error) { await shot('02-add-refused'); return { error, homepage, before, tokenFieldType, tokenOnPage } }
    await until('both remote organizations in the list', () => document.querySelectorAll('.org.org-remote').length >= 2, 30000)
    await until('the dialog to close', () => !document.querySelector('input[aria-label="Engine address"]'), 10000)
    await sleep(600)
    const rows = await page.eval(() => [...document.querySelectorAll('.org')].map(r => ({
      name: (r.querySelector('.org-name-text')?.innerText || '').trim(),
      remote: r.classList.contains('org-remote'), away: r.classList.contains('org-remote-away'),
      mark: !!r.querySelector('.org-remote-mark'), title: r.getAttribute('title') ?? r.querySelector('.org-name')?.getAttribute('title') ?? null,
    })))
    const head = await text('.org-remote-head .org-remote-head-name')
    const headState = await text('.org-remote-head .org-remote-head-state')
    await shot('03-list-with-remote-engine')
    return { homepage, before, rows, head, headState, tokenFieldType, tokenOnPage }
  }

  // ------------------------------------------------------------------ local
  if (args.stage === 'local') {
    await page.waitFor(card('boss'), { timeout: 40000 })
    await sleep(1200)
    const out = { title: await page.eval(() => document.title), cards: await cards(), chip: !!(await chip()),
      shell: await page.eval(() => !!document.querySelector('.shell-statusbar-chips')),
      banner: await page.eval(() => !!document.querySelector('.remote-banner')), dimmed: await dimmed() }
    out.stamp = await page.eval(async () => (await fetch(location.pathname.replace(/^\/o\//, '/api/orgs/'))).headers.get('X-Orgtree-Instance'))
    await menu('boss', ['Focus'])
    await page.waitFor(composer, { timeout: 20000 })
    await sleep(600)
    await say('hello from the local organization')
    out.answered = !!(await until('the local agent to answer', () => /hello from the local organization[\s\S]*OK\./.test(document.body.innerText || ''), 60000).catch(() => false))
    await shot('40-local-organization')
    return out
  }

  // ------------------------------------------------------------------ window
  const R = {}
  await page.waitFor(card('lead'), { timeout: 40000 })
  await sleep(1500)
  R.opened = { title: await page.eval(() => document.title), cards: await cards(), url: await page.eval(() => location.pathname),
    shell: await page.eval(() => !!document.querySelector('.shell-statusbar-chips')), version: await text('.shell-version') }
  R.chip = await chip()
  // a mark that only a reload removes
  await page.eval(() => { window.__sameWindow = true })
  await shot('10-remote-organization-window')

  // the chip opens Connection details
  await page.click('.chip.remote-chip')
  await page.waitFor('.remote-details')
  R.details = await page.eval(() => Object.fromEntries([...document.querySelectorAll('.remote-details .set-row')].map(row => {
    const control = row.querySelector('.set-control')
    return [(row.querySelector('.set-label')?.innerText || '').trim(), (control?.querySelector('input')?.value ?? control?.innerText ?? '').trim()]
  })))
  await shot('11-connection-details')
  await page.click({ selector: '.remote-details button', text: 'Close' })
  await page.waitFor('.remote-details', { gone: true })

  // a message from the desk, answered in a stream
  await menu('lead', ['Focus'])
  await page.waitFor(composer, { timeout: 20000 })
  await sleep(800)
  await say('stream please')
  const lengths = new Set()
  const streamEnd = Date.now() + 90000
  let final = false
  while (Date.now() < streamEnd && !final) {
    const seen = await page.eval(whole => {
      const all = document.body.innerText || ''
      const at = all.lastIndexOf(whole.slice(0, 24))
      if (at < 0) return 0
      let n = 0
      while (n < whole.length && all[at + n] === whole[n]) n++
      return n
    }, args.streamed)
    if (seen > 0) lengths.add(seen)
    final = seen === args.streamed.length
    if (!final) await sleep(120)
  }
  R.stream = { final, partials: [...lengths].filter(n => n < args.streamed.length).length, lengths: [...lengths].slice(0, 12) }
  await shot('12-desk-streamed-answer')

  // the desk's own tabs, then the user's inbox
  R.tabs = {}
  const tab = async name => {
    await page.click(`.cc-tabs [data-tab="${name}"]`)
    await sleep(900)
    return page.eval(() => document.querySelector('.cc-tabs .on')?.getAttribute('data-tab') ?? null)
  }
  const shows = (what, words) => until(what, w => ((document.body.innerText || '').includes(w) ? w : null), 20000, words).catch(() => '')
  await tab('docket')
  R.tabs.docket = await shows('the docket tab to list the item', 'Far smoke item')
  await shot('13-desk-docket')
  await tab('presented')
  R.tabs.presented = await shows('the presentations tab to list the document', 'Far report')
  await shot('14-desk-presentations')
  R.tabs.inbox = (await tab('inbox')) === 'inbox'
  await shot('15-desk-mail')
  await tab('chat')

  // an agent's question: it shows on the desk and in the user's inbox, and is answered on the desk
  await page.waitFor(composer, { timeout: 20000 })
  await say('ask me a question')
  R.ask = { asked: false, answered: false }
  const live = '.askcard:not(.nulled)'
  await page.waitFor(`${live} button.ask-row-pick`, { timeout: 30000 })
  R.ask.asked = true
  R.ask.question = await text(`${live} .ask-q`)
  R.ask.options = await page.eval(s => [...document.querySelectorAll(`${s} .ask-option-label`)].map(e => (e.innerText || '').trim()), live)
  await shot('16-question-on-the-desk')
  await page.click('button.ask-bell')
  R.tabs.userInbox = !!(await page.waitFor('.mailer-list', { timeout: 20000 }).catch(() => null))
  R.tabs.userInboxRows = await until('the question in the inbox', () => {
    const rows = [...document.querySelectorAll('.mailer-list .mailrow')].map(r => (r.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160))
    return rows.length ? rows : null
  }, 20000).catch(() => [])
  await shot('17-user-inbox-with-the-question')
  await page.press('Escape')
  await until('the inbox to close', () => !document.querySelector('.mailer-list'), 10000)
  await sleep(400)
  // the option's label is the innermost element with that text; a click on it is a click on its pick button
  await page.click({ selector: `${live} button.ask-row-pick .ask-option-label`, text: 'Blue' })
  await sleep(300)
  R.ask.picked = await page.eval(s => [...document.querySelectorAll(`${s} .ask-row.on .ask-option-label`)].map(e => (e.innerText || '').trim()), live)
  await page.click(`${live} button.ask-submit`)
  R.ask.answered = !!(await until('the question to be answered', s => !document.querySelector(`${s} button.ask-submit`), 30000, live).catch(() => false))
  await sleep(800)
  await shot('18-question-answered')

  // hire and retire from the canvas (back at the whole organization first)
  R.hire = { hired: false, retired: false }
  await page.click('button[title^="fit the whole org"]')
  await sleep(1200)
  await menu('lead', ['Hire a subordinate', 'haiku'])
  await page.waitFor('.sq.draft', { timeout: 15000 })
  await sleep(800)
  await page.click('.sq.draft input.df-name')
  await page.type('relayed')
  await sleep(300)
  await shot('19-hire-draft')
  await page.click({ selector: '.sq.draft button.primary', text: 'hire' })
  R.hire.hired = !!(await page.waitFor(card('relayed'), { timeout: 30000 }).catch(() => null))
  if (!R.hire.hired) R.hire.toasts = await toasts()
  await sleep(1500)
  await shot('19b-hired')
  if (R.hire.hired) {
    await menu('relayed', ['Retire…'])
    await page.waitFor({ selector: 'button', text: '^retire$', regex: true }, { timeout: 10000 })
    await page.click({ selector: 'button', text: '^retire$', regex: true })
    R.hire.retired = !!(await until('the retirement to be said', () => [...document.querySelectorAll('.toasts .toast')].some(t => /relayed retired/.test(t.innerText || '')), 30000)
      .catch(() => false))
    await sleep(800)
    R.hire.cardsAfter = await cards()
    await shot('19c-retired')
  }

  // ---------------------------------------------------------------- outage
  await menu('lead', ['Focus'])
  await page.waitFor(composer, { timeout: 20000 })
  await sleep(800)
  const cut = await ask('cut')
  R.offline = { sentence: cut.sentence }
  R.offline.banner = await until('the offline banner', () => document.querySelector('.remote-banner .remote-banner-text')?.innerText || null, 20000)
  R.offline.dimmed = await dimmed()
  R.offline.chip = (await chip())?.text ?? null
  await shot('20-offline-banner-and-dimmed-canvas')
  // a send while it is away: the text must stay where it was typed
  R.offline.typed = 'kept while the remote engine is away'
  await say(R.offline.typed)
  await until('the refusal to be shown', s => [...document.querySelectorAll('.toasts .toast')].some(t => (t.innerText || '').includes(s)), 10000, args.offline)
    .catch(() => null)
  await sleep(400)
  R.offline.toasts = await toasts()
  R.offline.draft = await page.eval(s => document.querySelector(s)?.value ?? null, composer)
  R.offline.ghosts = await page.eval(() => document.querySelectorAll('.pendghost').length)
  await shot('21-offline-send-refused-draft-kept')
  // any other change from this window gets the same answer from the engine
  R.offline.hire = await page.eval(async () => {
    const r = await fetch(location.pathname.replace(/^\/o\//, '/api/orgs/') + '/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'hire', name: 'never', tier: 'haiku', parent: 'lead' }) })
    const body = await r.json().catch(() => ({}))
    return { status: r.status, detail: body.detail ?? null }
  })

  // -------------------------------------------------------------- recovery
  await ask('restore')
  R.recovered = {}
  R.recovered.banner = await until('the banner to go by itself', () => {
    const b = document.querySelector('.remote-banner')
    return !b || b.classList.contains('ok') ? 'gone' : null
  }, 60000)
  R.recovered.reconnectedNote = await text('.remote-banner.ok')
  R.recovered.dimmed = await dimmed()
  R.recovered.reloaded = !(await page.eval(() => window.__sameWindow === true))
  R.recovered.draftStillThere = (await page.eval(s => document.querySelector(s)?.value ?? null, composer)) === R.offline.typed
  await shot('22-reconnected-draft-still-there')
  await page.click(composer)
  await page.press('Enter')
  R.recovered.sent = !!(await until('the kept draft to be sent and answered', typed => {
    const all = document.body.innerText || ''
    const at = all.lastIndexOf(typed)
    return document.querySelector('textarea[data-first-use-chat]')?.value === '' && at >= 0 && /OK\./.test(all.slice(at))
  }, 60000, R.offline.typed).catch(() => false))
  await shot('23-kept-draft-sent-after-reconnect')

  // ------------------------------------------- the remote engine restarts
  R.restart = {}
  await ask('far-stop')
  R.restart.offlineBanner = !!(await until('the offline banner again', () => /is offline since/.test(document.querySelector('.remote-banner .remote-banner-text')?.innerText || ''), 30000).catch(() => false))
  await shot('30-remote-engine-stopped')
  await ask('far-start')
  // its boot id is new: the window reloads itself and comes back live
  R.restart.reloaded = !!(await until('the window to reload', () => window.__sameWindow !== true && !!document.querySelector('[data-copy-agent-name="lead"]'), 90000).catch(() => false))
  await sleep(2500)
  R.restart.cards = await cards()
  R.restart.chip = (await chip())?.tone ?? null
  R.restart.banner = await text('.remote-banner .remote-banner-text')
  await shot('31-after-remote-engine-restart')

  // ------------------------------------------------- the token is revoked
  R.revoked = {}
  await ask('revoke')
  R.revoked.banner = await until('the sign-in banner', () => {
    const t = document.querySelector('.remote-banner .remote-banner-text')?.innerText || ''
    return /no longer accepts/.test(t) ? t : null
  }, 60000).catch(() => null)
  R.revoked.action = await text('.remote-banner button')
  R.revoked.chip = (await chip())?.text ?? null
  await shot('32-token-revoked-sign-in-banner')
  await page.click('.remote-banner button')
  await page.waitFor('input[aria-label="Engine token"]', { timeout: 10000 })
  await page.click('input[aria-label="Engine token"]')
  await page.type(args.token)
  await shot('33-replace-token-dialog')
  await page.click({ selector: '.remote-add button', text: 'Connect' })
  R.revoked.after = await until('the connection to return with the new token', () => {
    const c = document.querySelector('.chip.remote-chip')
    return c && c.classList.contains('ok') && !document.querySelector('.remote-banner:not(.ok)') ? 'ok' : null
  }, 60000).catch(() => null)
  await sleep(1200)
  await shot('34-connected-again-with-new-token')
  return R
}
