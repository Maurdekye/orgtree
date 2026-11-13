// tools/rig/desktop/remote-people.cjs: the window half of
// tools/rig/proofs/remote-people.mjs (docs/rust-engine/remote-org.md, "Several
// people on one organization"). The real renderer bundle runs against the
// run's engine ("this computer", Sam's desktop), which relays to a second,
// standalone rig engine. A second computer ("Dana") uses the same
// organization there through its own client token: the proof plays her, and
// does one thing as her each time this script asks (args.control).
//
// One window on `/o/<org>`, and what it shows of the other person:
//
//   01  a message she sent reads "User · <her name>", this desktop's own "User"
//   02  the agent's mail list says "@user · <her name>"
//   03  a question she answered: the answer in the transcript is hers
//   04  the same request in the user's inbox says who settled it and when
//   05  the organization's record says "User · <her name>", and "you"
//   06  Connection details: the name shown to others, who else is connected
//   07  that name, changed here
//   08  a text being edited here that she changes underneath says so
//   09  Save is refused and says who changed it and when; nothing is lost
//   10  her version, to look at
//   11  undoing her change asks first
//   12  a setting she set first: the row goes back and a toast offers "Use mine"
//   13  org.md she saved meanwhile: the same notice in its editor
//   14  the History tab says "by <her name>"
//
// Input is CDP only, in this window only; the harness is muted and off the
// real clipboard (guards.cjs). The rig has no main process, so a minimal
// desktop bridge is planted before the page loads, as remote-org.cjs does.
'use strict'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c)

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
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bridge({ windowId: 'rig-org', kind: 'org', org: args.org }, args.version) })
  await page.goto(`/o/${args.org}`)
  const paint = () => page.eval(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))
  const shot = async name => { await paint(); await sleep(200); return page.screenshot(name) }
  const card = name => `[data-copy-agent-name="${name}"]`
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
  let missed = 0
  /** A step that must not end the script: what it found, or why it did not, with what the window showed instead. */
  const attempt = async (what, run) => {
    try { return await run() } catch (e) {
      const seen = await page.eval(() => (document.body.innerText || '').replace(/\s+\n/g, '\n').slice(-1500)).catch(() => null)
      page.log('missed', what, String(e.message), seen)
      await page.screenshot(`missed-${String(++missed).padStart(2, '0')}`).catch(() => {})
      return { error: String(e.message) }
    }
  }
  const tried = (what, fn, timeout, ...rest) => attempt(what, () => until(what, fn, timeout, ...rest))
  /** the proof does one thing as the other computer and says what it did */
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
  const say = async words => { await page.click(composer); await page.type(words); await page.press('Enter') }
  /** focus a field and select what it holds, so typing replaces it */
  const selectAll = selector => page.eval(s => { const e = document.querySelector(s); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); e.select?.(); return true }, selector)
  const openSettings = detail => page.eval(d => { window.dispatchEvent(new window.CustomEvent('orgtree:open-settings-at', { detail: d })); return true }, detail)
  const into = selector => page.eval(s => { document.querySelector(s)?.scrollIntoView({ block: 'center' }); return true }, selector)
  const gone = (what, selector, timeout = 8000) => until(what, s => !document.querySelector(s), timeout, selector)
  /** a centred panel leaves on Escape; its own close button is the second way out */
  const closePanel = async (what, selector) => {
    await page.press('Escape')
    if (await gone(what, selector, 4000).catch(() => false)) return true
    await page.click('button[aria-label="close this window"]').catch(() => {})
    return gone(what, selector, 8000)
  }
  const R = { her: args.her }

  await page.waitFor(card('lead'), { timeout: 40000 })
  await sleep(1500)
  R.title = await page.eval(() => document.title)

  // ------------------------------------------------------------------ 01 whose message it is
  await ask('dana-message')
  await menu('lead', ['Focus'])
  await page.waitFor(composer, { timeout: 20000 })
  await sleep(800)
  R.theirs = await tried('her message under her name', her => [...document.querySelectorAll('.turn-mail .event-actor')].map(e => (e.textContent || '').trim()).find(t => t === `User · ${her}`) ?? null, 90000, args.her)
  await say('a message from this computer')
  // its delivered card, not the queued one above the composer: the far agent has taken it
  R.mine = await tried('this computer\'s own message, delivered', () => {
    const row = [...document.querySelectorAll('.turn-mail')].find(e => (e.textContent || '').includes('a message from this computer') && !e.closest('.pending'))
    const head = row?.querySelector('.event-actor')
    return head ? (head.textContent || '').trim() : null
  }, 120000)
  R.queued = await tried('nothing left queued', () => !document.querySelector('.pending-divider, .pending'), 30000)
  R.tooltip = await page.eval(() => document.querySelector('.event-actor .user-via [data-streamer-field="external"]')?.getAttribute('title') ?? null)
  await shot('01-message-by-someone-else')

  // ------------------------------------------------------------------ 02 the agent's mail list
  R.listed = await attempt('her mail in the agent\'s list', async () => {
    await page.click({ selector: 'button', text: '^mail( \\d+)?$', regex: true })
    const row = await until('her mail in the list under her name', her => [...document.querySelectorAll('.mailrow')]
      .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).find(t => t.includes(`@user · ${her}`)) ?? null, 20000, args.her)
    return row.slice(0, 200)
  })
  await shot('02-mail-list-by-someone-else')
  await page.click({ selector: 'button', text: '^chat$', regex: true }).catch(() => {})
  await page.waitFor(composer, { timeout: 20000 })

  // ------------------------------------------------------------------ 03 who answered the question
  R.asked = await ask('dana-answers')
  R.answer = await tried('the answer in the transcript under her name', her =>
    [...document.querySelectorAll('[data-event-variant^="answer."] .event-actor')].map(e => (e.textContent || '').trim()).find(t => t === `User · ${her}`) ?? null, 120000, args.her)
  await page.eval(() => { const all = [...document.querySelectorAll('[data-event-variant^="answer."]')]; all[all.length - 1]?.scrollIntoView({ block: 'center' }); return true })
  await sleep(600)
  await shot('03-question-answered-by-someone-else')

  // ------------------------------------------------------------------ 04, 05 the user's inbox and the organization's record
  R.settled = await attempt('the settled request in the inbox', async () => {
    await page.click('button.ask-bell')
    await page.waitFor('.mail-folders', { timeout: 15000 })
    await until('the rows of the inbox', () => document.querySelectorAll('.mailer-list .mailrow').length > 0, 20000)
    const rows = await page.eval(() => document.querySelectorAll('.mailer-list .mailrow').length)
    const tags = []
    for (let i = 0; i < Math.min(rows, 12); i++) {
      // at this width the list is a drawer that closes when a row is picked
      if (await page.eval(() => document.querySelector('button.mailer-listtoggle')?.getAttribute('aria-expanded') === 'false')) await page.click('button.mailer-listtoggle', { after: 400 })
      await page.click({ selector: '.mailer-list .mailrow', index: i, scroll: true }, { after: 450 })
      const tag = await page.eval(() => [...document.querySelectorAll('.askcard.nulled .ask-null-tag')].map(e => (e.textContent || '').trim()).join(' | '))
      tags.push(tag)
      if (tag.includes(`by ${args.her}`)) return { tag, rows, at: i }
    }
    throw new Error(`no settled request names her; the rows said: ${JSON.stringify(tags)}`)
  })
  await shot('04-inbox-request-settled-by-someone-else')
  R.record = await attempt('the organization\'s record', async () => {
    await page.click({ selector: '.mail-folders button', text: '^record', regex: true })
    await until('her action in the record', her => [...document.querySelectorAll('.rec-row .rec-actor')].some(e => (e.textContent || '').trim() === `User · ${her}`), 20000, args.her)
    return page.eval(() => [...new Set([...document.querySelectorAll('.rec-row .rec-actor')].map(e => (e.textContent || '').trim()))])
  })
  await shot('05-organization-record')
  R.inboxClosed = await attempt('the inbox to close', () => closePanel('the inbox to close', '.mail-folders'))

  // ------------------------------------------------------------------ 06, 07 Connection details
  await ask('dana-stays')
  await page.click('.chip.remote-chip')
  await page.waitFor('.remote-details', { timeout: 15000 })
  R.people = await tried('the other computer among those connected', () => {
    const rows = [...document.querySelectorAll('.remote-people li')].map(e => (e.textContent || '').trim())
    return rows.length ? rows : null
  }, 30000)
  R.shownAs = await page.eval(() => document.querySelector('input[aria-label="Name shown to others"]')?.value ?? null)
  R.rows = await page.eval(() => [...document.querySelectorAll('.remote-details .set-row .set-label')].map(e => (e.textContent || '').trim()))
  R.signedIn = await page.eval(() => [...document.querySelectorAll('.remote-details .set-row')].map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).find(t => t.startsWith('Signed in as')) ?? null)
  await shot('06-connection-details-people')
  await selectAll('input[aria-label="Name shown to others"]')
  await page.type(args.rename)
  await page.press('Tab')
  R.renamed = await tried('the new name in the field', name => { const i = document.querySelector('input[aria-label="Name shown to others"]'); return i && i.value === name && !i.disabled ? name : null }, 20000, args.rename)
  await sleep(500)
  await shot('07-shown-to-others-as')
  await page.click({ selector: '.remote-details button', text: '^Close$', regex: true })
  await gone('Connection details to close', '.remote-details')
  await ask('dana-leaves')

  // ------------------------------------------------------------------ 08 to 10 the agent settings form
  await openSettings({ scope: 'agent', org: args.org, agentId: 'scout', target: { tab: 'charter', field: '' } })
  await page.waitFor('textarea.charterbox', { timeout: 20000 })
  await sleep(600)
  await selectAll('textarea.charterbox')
  await page.type(args.mine)
  R.typed = await page.eval(() => document.querySelector('textarea.charterbox')?.value ?? null)
  await ask('dana-charter')
  R.under = await tried('the line under the text', () => (document.querySelector('.save-conflict-under')?.textContent || '').trim() || null, 20000)
  await into('.save-conflict-under')
  await shot('08-changed-while-editing')
  await page.eval(() => { [...document.querySelectorAll('button.primary')].find(b => (b.textContent || '').trim() === 'Save')?.scrollIntoView({ block: 'center' }); return true })
  await sleep(300)
  await page.click({ selector: 'button.primary', text: '^Save$', regex: true })
  R.notice = await tried('the notice of the refused save', () => (document.querySelector('.save-conflict-what')?.textContent || '').trim() || null, 20000)
  R.kept = await page.eval(() => document.querySelector('textarea.charterbox')?.value ?? null)
  R.choices = await page.eval(() => [...document.querySelectorAll('.save-conflict button')].map(b => (b.textContent || '').trim()))
  await into('.save-conflict')
  await shot('09-save-refused-notice')
  await page.click({ selector: '.save-conflict button', text: '^See their version$', regex: true })
  R.theirVersion = await tried('her version', () => (document.querySelector('.save-conflict-theirs')?.textContent || '') || null, 10000)
  R.theirLabel = await page.eval(() => (document.querySelector('.save-conflict-theirs')?.previousElementSibling?.textContent || '').trim() || null)
  await into('.save-conflict')
  await shot('10-their-version')
  await page.click({ selector: '.save-conflict button', text: '^Save mine anyway$', regex: true })
  R.formClosed = await tried('the form to close after the save', () => !document.querySelector('textarea.charterbox'), 20000)
  R.stored = (await ask('charter')).charter ?? null

  // ------------------------------------------------------------------ 11 undoing her change asks first
  await ask('dana-team')
  await sleep(1500)
  await page.eval(() => { document.activeElement?.blur?.(); return true })
  await page.press('z', { modifiers: 2 })
  const question = /This was .+'s change\. Undo it\?/
  R.undo = await tried('the question before undoing her change', source => {
    const t = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal')].map(e => (e.textContent || '').trim()).find(s => new RegExp(source).test(s))
    return t ? new RegExp(source).exec(t)[0] : null
  }, 15000, question.source)
  await shot('11-undo-asks-first')
  // the dialog's own way out; nothing may stay open over what follows
  R.undoClosed = await attempt('the undo question to close', async () => {
    await page.click({ selector: 'button', text: '^cancel$', regex: true, flags: 'i' })
    return until('the undo question to close', source => !new RegExp(source).test(document.body.textContent || ''), 8000, question.source)
  })
  R.afterCancel = (await ask('scout')).team ?? null

  // ------------------------------------------------------------------ 12 a setting she set first
  await openSettings({ scope: 'org', org: args.org, target: { tab: 'basic', field: '' } })
  await page.waitFor('input[aria-label="Top-level grant cap"]', { timeout: 20000 })
  await sleep(600)
  await selectAll('input[aria-label="Top-level grant cap"]')
  await page.type(String(args.myCap))
  // the row saves a moment after the last keystroke: she sets it first
  await ask('dana-cap')
  R.useMine = await tried('the toast that offers Use mine', () => {
    const t = [...document.querySelectorAll('.toasts .toast')].find(e => /Your change was not saved/.test(e.innerText || ''))
    return t ? { text: (t.innerText || '').trim(), action: [...t.querySelectorAll('button')].map(b => (b.textContent || '').trim()) } : null
  }, 20000)
  R.capShown = await tried('the row back on what is stored', cap => document.querySelector('input[aria-label="Top-level grant cap"]')?.value === String(cap) ? cap : null, 15000, args.herCap)
  await shot('12-setting-set-first-use-mine')

  // ------------------------------------------------------------------ 13 org.md she saved meanwhile
  await into('textarea[aria-label="org.md"]')
  await until('org.md in its editor', () => { const e = document.querySelector('textarea[aria-label="org.md"]'); return e && !e.disabled }, 20000)
  await selectAll('textarea[aria-label="org.md"]')
  await page.type(args.myOrgMd)
  await ask('dana-orgmd')
  await into('button[aria-label="Save organization charter"]')
  await sleep(300)
  await page.click('button[aria-label="Save organization charter"]')
  const orgmdNotice = () => {
    const n = [...document.querySelectorAll('.save-conflict')].find(e => /org\.md/.test(e.textContent || ''))
    return n ? { what: (n.querySelector('.save-conflict-what')?.textContent || '').trim(), choices: [...n.querySelectorAll('button')].map(b => (b.textContent || '').trim()) } : null
  }
  R.orgmd = await tried('the notice in the org.md editor', orgmdNotice, 20000)
  R.orgmdKept = await page.eval(() => document.querySelector('textarea[aria-label="org.md"]')?.value ?? null)
  await page.eval(() => { [...document.querySelectorAll('.save-conflict')].find(e => /org\.md/.test(e.textContent || ''))?.scrollIntoView({ block: 'center' }); return true })
  await shot('13-orgmd-saved-meanwhile')

  // ------------------------------------------------------------------ 14 the History tab
  R.history = await attempt('the History tab', async () => {
    await page.eval(() => { document.querySelector('#org-settings-tab-history')?.scrollIntoView({ block: 'center' }); return true })
    await page.click('#org-settings-tab-history')
    // the tab opens on another collection; a native select is set from the page, as its change event would
    await until('the collections of the History tab', () => [...document.querySelectorAll('select[aria-label="History records"] option')].some(o => o.value === 'events'), 20000)
    await page.eval(() => {
      const select = document.querySelector('select[aria-label="History records"]')
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, 'events')
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
      return select.value
    })
    const row = await until('a record by her', her => [...document.querySelectorAll('#org-settings-panel-history summary')]
      .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).find(t => t.includes(`· by ${her} ·`)) ?? null, 30000, args.her)
    await page.eval(her => { [...document.querySelectorAll('#org-settings-panel-history summary')].find(e => (e.innerText || '').includes(`· by ${her} ·`))?.scrollIntoView({ block: 'center' }); return true }, args.her)
    return row.slice(0, 200)
  })
  await shot('14-history-by-someone-else')
  return R
}
