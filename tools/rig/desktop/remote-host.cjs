// tools/rig/desktop/remote-host.cjs: the window half of
// tools/rig/proofs/remote-host.mjs (docs/rust-engine/remote-org.md, "A
// hosting desktop's windows"). The real renderer bundle, in two windows, one
// after the other (`args.part`):
//
// `host`: a window of the HOSTING desktop ("PC-HOST", the run's second engine,
// a desktop's own) on the organization it shares. The proof plays the other
// computer and Windows, one step each time this script asks (args.control).
//
//   01  Org settings, Connections: the group Remote access, the switch off
//   02  a No at the administrator prompt: the switch stays off and says so
//   03  a Yes: the address, the computers, "Add a computer..."
//   04  Add a computer: the address, a one-time code, both in one line
//   05  the other computer used the line: it is in the list, connected
//   06  the chip "1 computer connected" on the status strip
//   07  its message reads "User · <its name>" on the hosting desktop
//   08  rules that went missing: "Windows Firewall is blocking this", Allow
//   09  App settings, Remote access: where it listens, the port, the organizations
//   10  Revoke asks first and says what goes
//
// `other`: a window of THIS desktop ("PC-SAM"), the computer that was let in.
//
//   11  Add a remote engine: one pasted line fills Address and Token
//   12  the hosting desktop in the list, under its computer's name
//   13  Connection details: "these organizations only"
//   14  App settings in the organization's window: whose computer it is
//   15  the organization is no longer shared: its window says so
//
// Input is CDP only, in this window only; the harness is muted and off the
// real clipboard (guards.cjs), so text goes in by insertion, as a paste does.
// The rig has no main process, so a minimal desktop bridge is planted before
// the page loads. Its two firewall calls are a recorder: nothing here asks
// Windows for anything, and no administrator prompt exists. `window.confirm`
// (a native box nobody could answer here) is recorded too, and answered Yes.
'use strict'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c)

const bridge = version => `
  (() => {
    const at = location.pathname
    const id = at.startsWith('/o/') ? { windowId: 'rig-org', kind: 'org', org: decodeURIComponent(at.slice(3)) } : { windowId: 'rig-homepage', kind: 'homepage' }
    const prefs = {}
    const firewall = window.__rigFirewall = { calls: [], answer: null }
    const prompt = what => new Promise(resolve => { firewall.calls.push(what); firewall.answer = result => { firewall.answer = null; resolve(result) } })
    window.__rigConfirms = []
    window.confirm = text => { window.__rigConfirms.push(String(text)); return true }
    window.orgtreeDesktop = {
      getAppVersion: async () => ${JSON.stringify(version)},
      getPreferences: async () => prefs,
      setPreferences: async (patch) => Object.assign(prefs, patch),
      onEvent: () => () => {},
      windowIdentity: id,
      getWindowIdentity: async () => id,
      requestOrg: async () => null,
      // App settings opens on Providers, which reads whether a sign-in is running: none is
      getProviderLoginStatus: async () => ({ phase: 'idle' }),
      onProviderLoginStatus: () => () => {},
      addRemoteAccessFirewallRule: (port, lan) => prompt({ add: [port, lan] }),
      removeRemoteAccessFirewallRule: () => prompt({ remove: true }),
    }
  })()`

module.exports = async (page, { args }) => {
  const sleep = page.sleep
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bridge(args.version) })
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
  /** the proof does one thing as the other computer, or as Windows, and says what it did */
  const ask = async (step, value) => {
    const res = await fetch(args.control + step, { method: 'POST', body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(180000) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`the proof's step ${step} failed: ${body.error ?? res.status}`)
    page.log('step', step, body)
    return body
  }
  const text = selector => page.eval(s => { const e = document.querySelector(s); return e ? (e.innerText || '').replace(/\s+/g, ' ').trim() : null }, selector)
  const gone = (what, selector, timeout = 8000) => until(what, s => !document.querySelector(s), timeout, selector)
  /** a centred panel leaves on Escape; its own close button is the second way out */
  const closePanel = async (what, selector) => {
    await page.press('Escape')
    if (await gone(what, selector, 4000).catch(() => false)) return true
    await page.click('button[aria-label="close this window"]').catch(() => {})
    return gone(what, selector, 8000)
  }
  const menu = async (target, path) => {
    await page.rightClick(target)
    await page.waitFor('.ctxmenu[role="menu"]')
    for (let i = 0; i < path.length; i++) {
      const item = { selector: 'button.ctxmenu-item', text: `^${escapeRe(path[i])}( ▸)?$`, regex: true }
      if (i < path.length - 1) { await page.hover(item); await sleep(350) } else await page.click(item)
    }
  }
  const openAppSettings = tab => page.eval(t => { window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: t } })); return true }, tab)
  const R = { part: args.part }

  // =================================================================== this desktop, the computer that was let in
  if (args.part === 'other') {
    await page.goto('/')
    await page.waitFor('.org-remote-add', { timeout: 40000 })
    await sleep(800)
    // ---------------------------------------------------------------- 11 one pasted line
    await page.click('.org-remote-add')
    await page.waitFor('input[aria-label="Engine address"]')
    await page.click('input[aria-label="Engine address"]')
    await page.type(args.line)
    R.pasted = await tried('both fields filled from the one line', () => {
      const address = document.querySelector('input[aria-label="Engine address"]'), token = document.querySelector('input[aria-label="Engine token"]')
      return address && token && token.value ? { address: address.value, token: token.value.length, tokenType: token.type } : null
    }, 5000)
    await shot('11-one-line-fills-both-fields')
    // ---------------------------------------------------------------- 12 the hosting desktop in the list
    await page.click({ selector: '.remote-add button', text: 'Connect' })
    try { await page.waitFor('.org-remote-head', { timeout: 60000 }) } catch (e) { R.addError = (await text('.remote-add-error')) ?? String(e.message) }
    await tried('the dialog to close', () => !document.querySelector('input[aria-label="Engine address"]'), 10000)
    R.rows = await tried('the shared organization under the heading', () => { const rows = [...document.querySelectorAll('.org.org-remote .org-name-text')].map(e => (e.innerText || '').trim()); return rows.length ? rows : null }, 30000)
    R.head = await text('.org-remote-head .org-remote-head-name')
    await shot('12-hosting-desktop-in-the-list')
    // ---------------------------------------------------------------- 13 Connection details
    R.signedIn = await attempt('Connection details', async () => {
      await menu('.org-remote-head', ['Connection details'])
      await page.waitFor('.remote-details', { timeout: 15000 })
      return until('the row of this computer\'s token', () => [...document.querySelectorAll('.remote-details .set-row')].map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).find(t => t.startsWith('Signed in as')) ?? null, 10000)
    })
    await shot('13-connection-details-these-organizations-only')
    await page.click({ selector: '.remote-details button', text: '^Close$', regex: true }).catch(() => {})
    await gone('Connection details to close', '.remote-details').catch(() => {})
    // ---------------------------------------------------------------- 14 the organization's window: whose settings these are
    await page.goto(`/o/${args.lab}`)
    await page.waitFor(card('lead'), { timeout: 60000 })
    await sleep(1500)
    R.title = await page.eval(() => document.title)
    R.note = await attempt('the note of App settings', async () => {
      await openAppSettings('providers')
      return until('the note about whose settings these are', () => (document.querySelector('.settings-remote-note')?.innerText || '').replace(/\s+/g, ' ').trim() || null, 20000)
    })
    await shot('14-settings-of-somebodys-own-computer')
    await attempt('App settings to close', () => closePanel('App settings to close', '.settings-remote-note'))
    // ---------------------------------------------------------------- 15 no longer shared
    R.stopped = await attempt('the hosting desktop to stop sharing', () => ask('host-stops-sharing'))
    R.banner = await tried('the banner of an organization that is no longer shared', () => {
      const said = (document.querySelector('.remote-banner .remote-banner-text')?.innerText || '').trim()
      return /no longer shares this organization\.$/.test(said) ? said : null
    }, 90000)
    await shot('15-no-longer-shared')
    return R
  }

  // =================================================================== the hosting desktop
  const tab = '#org-settings-panel-mailserver'
  const toggle = { selector: `${tab} .set-label`, text: '^Let other computers open this organization$', regex: true }
  const switchOf = `${tab} input[aria-label="Let other computers open this organization"]`
  /** The whole group in view. It grows downward when the switch goes on, and a click does not scroll:
   *  a button below the fold would be clicked where nothing is. */
  const showGroup = async () => {
    await page.eval(s => { document.querySelector(s)?.closest('.set-group')?.scrollIntoView({ block: 'end' }); return true }, switchOf)
    await sleep(300)
  }
  const openConnections = async () => {
    await page.eval(org => { window.dispatchEvent(new window.CustomEvent('orgtree:open-settings-at', { detail: { scope: 'org', org, target: { tab: 'mailserver', field: '' } } })); return true }, args.org)
    await page.waitFor(switchOf, { timeout: 30000 })
    await showGroup()
    await sleep(300)
  }
  /** what the group Remote access of the open Connections tab shows */
  const group = () => page.eval(s => {
    const said = e => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim()
    const input = document.querySelector(`${s} input[aria-label="Let other computers open this organization"]`)
    const g = input?.closest('.set-group')
    if (!g) return null
    return {
      checked: input.checked,
      hint: said(input.closest('.set-row')?.querySelector('.set-hint')),
      rows: [...g.querySelectorAll('.set-row > .set-label, .set-block > .set-label')].map(said),
      address: said(g.querySelector('.set-row .chip.mono')) || null,
      note: said(g.querySelector('.remote-access-note')) || null,
      trouble: said(g.querySelector('.remote-access-door')) || null,
      computers: [...g.querySelectorAll('ul[aria-label="Computers that can open this organization"] li .remote-computer-text')].map(said),
      labels: [...g.querySelectorAll('ul[aria-label="Computers that can open this organization"] li .remote-computer-text > [data-streamer-field="external"]')].map(said),
    }
  }, tab)
  /** the administrator prompt is "open": what the app asked the desktop for */
  const prompted = () => until('the desktop to be asked for the firewall rules', () => typeof window.__rigFirewall?.answer === 'function' ? window.__rigFirewall.calls[window.__rigFirewall.calls.length - 1] : null, 20000)
  const answer = result => page.eval(r => { window.__rigFirewall.answer(r); return true }, result)
  const toast = (what, pattern, timeout = 10000) => tried(what, source => [...document.querySelectorAll('.toasts .toast')].map(e => (e.innerText || '').trim()).find(t => new RegExp(source).test(t)) ?? null, timeout, pattern.source)

  await page.goto(`/o/${args.org}`)
  await page.waitFor(card('lead'), { timeout: 60000 })
  await sleep(1500)
  R.title = await page.eval(() => document.title)

  // ------------------------------------------------------------------ 01 the group, off
  await openConnections()
  R.off = await group()
  await shot('01-remote-access-off')

  // ------------------------------------------------------------------ 02 a No at the prompt
  R.declined = await attempt('a declined prompt', async () => {
    await page.click(toggle)
    const asked = await prompted()
    await answer({ ok: false, declined: true, error: 'Nothing changed: Windows Firewall stays as it was.' })
    await until('the sentence of the declined prompt', s => !!document.querySelector(`${s} .remote-access-note`), 15000, tab)
    await showGroup()
    const g = await group()
    return { asked, checked: g.checked, note: g.note }
  })
  await shot('02-prompt-declined-switch-stays-off')

  // ------------------------------------------------------------------ 03 a Yes: on
  R.on = await attempt('the switch to go on', async () => {
    await page.click(toggle)
    const asked = await prompted()
    await ask('windows-yes')
    await answer({ ok: true })
    const said = await toast('the toast of the switch', /can now open this organization/)
    await until('the switch on with its computers', s => {
      const input = document.querySelector(`${s} input[aria-label="Let other computers open this organization"]`)
      return !!input?.checked && !!input.closest('.set-group')?.querySelector('ul.remote-computers li')
    }, 20000, tab)
    await showGroup()
    return { ...(await group()), asked, toast: typeof said === 'string' ? said : null }
  })
  await shot('03-remote-access-on')

  // ------------------------------------------------------------------ 04 Add a computer
  const dialog = '.remote-add[aria-label="Add a computer"]'
  R.add = await attempt('Add a computer', async () => {
    await showGroup()
    await page.click({ selector: `${tab} button.primary`, text: '^Add a computer\\.\\.\\.$', regex: true })
    await page.waitFor(dialog, { timeout: 15000 })
    return until('the code in the dialog', s => {
      const box = document.querySelector(s)
      const said = e => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim()
      const row = label => [...(box?.querySelectorAll('.set-row') ?? [])].find(r => said(r.querySelector('.set-label')) === label)
      const code = row('One-time code')?.querySelector('.chip.mono')
      const both = row('Both in one line')?.querySelector('.chip.mono')
      return code && both ? { address: said(row('Address')?.querySelector('.chip.mono')), code: said(code), masked: code.getAttribute('data-streamer-field'), hint: said(row('One-time code')?.querySelector('.set-hint')),
        line: said(both), rows: [...box.querySelectorAll('.set-row > .set-label, .set-block > .set-label')].map(said) } : null
    }, 20000, dialog)
  })
  await shot('04-add-a-computer')

  // ------------------------------------------------------------------ 05, 06 the other computer used the line
  R.added = R.add?.line ? await attempt('the other computer to add this one', () => ask('other-adds', { line: R.add.line })) : { error: 'no line was shown' }
  await page.click({ selector: `${dialog} button`, text: '^Done$', regex: true }).catch(() => {})
  await gone('the dialog to close', dialog).catch(() => {})
  R.listed = await attempt('the other computer in the list, connected', async () => {
    await until('the other computer in the list, connected', (s, me) => [...document.querySelectorAll(`${s} ul[aria-label="Computers that can open this organization"] li .remote-computer-text`)]
      .some(e => { const t = (e.innerText || '').replace(/\s+/g, ' ').trim(); return t.startsWith(me) && / · connected( since .+)?$/.test(t) }), 40000, tab, args.me)
    await showGroup()
    return (await group()).computers
  })
  await shot('05-computer-connected')
  R.chip = await tried('the chip on the status strip', () => { const c = document.querySelector('.chip.shared-chip'); return c ? { text: (c.innerText || '').trim(), title: c.getAttribute('title') } : null }, 20000)
  await attempt('the organization settings to close', () => closePanel('the organization settings to close', tab))
  await shot('06-chip-one-computer-connected')

  // ------------------------------------------------------------------ 07 whose message it is
  R.sent = await attempt('the other computer to send', () => ask('other-sends'))
  R.theirs = await attempt('its message under its name', async () => {
    await menu(card('lead'), ['Focus'])
    await page.waitFor('textarea[data-first-use-chat]', { timeout: 20000 })
    // this part's own message (the engines' part left one from the same computer in the same desk)
    return until('its message under its name', said => {
      const mail = [...document.querySelectorAll('.turn-mail')].find(m => (m.innerText || '').includes(said))
      return mail ? (mail.querySelector('.event-actor')?.textContent || '').trim() || null : null
    }, 120000, args.said)
  })
  await shot('07-message-from-the-other-computer')

  // ------------------------------------------------------------------ 08 the rules went missing
  R.blocked = await attempt('the blocked door and Allow', async () => {
    const forgot = await ask('windows-forgets')
    await openConnections()
    const blocking = (s) => [...document.querySelectorAll(`${s} .set-row > .set-label`)].some(e => (e.textContent || '').trim() === 'Windows Firewall is blocking this')
    await until('"Windows Firewall is blocking this"', blocking, 30000, tab)
    await showGroup()
    await shot('08-windows-firewall-is-blocking-this')
    await page.click({ selector: `${tab} button`, text: '^Allow$', regex: true })
    const asked = await prompted()
    await ask('windows-yes')
    await answer({ ok: true })
    const cleared = await until('the row to go', s => ![...document.querySelectorAll(`${s} .set-row > .set-label`)].some(e => (e.textContent || '').trim() === 'Windows Firewall is blocking this'), 30000, tab)
    return { row: true, read: forgot.firewall ?? null, asked, cleared }
  })
  await attempt('the organization settings to close', () => closePanel('the organization settings to close', tab))

  // ------------------------------------------------------------------ 09 App settings, Remote access
  const pageOf = '#app-settings-panel-remoteaccess'
  R.page = await attempt('the App settings page', async () => {
    // the ask opens App settings on its first tab (it lands on a few named ones only); the page is one click further
    await openAppSettings('remoteaccess')
    await page.waitFor('#app-settings-tab-remoteaccess', { timeout: 30000 })
    await page.eval(() => { document.querySelector('#app-settings-tab-remoteaccess')?.scrollIntoView({ block: 'center', inline: 'center' }); return true })
    await page.click('#app-settings-tab-remoteaccess')
    await page.waitFor(`${pageOf} input[role="switch"][aria-label="Tailscale"]`, { timeout: 30000 })
    await sleep(800)
    return page.eval(s => {
      const panel = document.querySelector(s)
      const said = e => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim()
      const row = label => [...panel.querySelectorAll('.set-row')].find(r => said(r.querySelector('.set-label')) === label)
      const orgs = [...panel.querySelectorAll('.set-group')].find(g => said(g.querySelector('.set-group-head')).startsWith('Organizations other computers can open'))
      const stop = panel.querySelector('button.danger')
      return {
        subtitle: said(panel.querySelector('.set-group-subtitle')),
        listens: ['Tailscale', 'This private network', 'This computer only']
          .filter(label => panel.querySelector(`input[role="switch"][aria-label="${label}"]`)?.checked).join(' + ') || null,
        port: panel.querySelector('input[aria-label="Remote access port"]')?.value ?? null,
        now: said(row('Now')?.querySelector('.chip:not(.mono)')),
        addresses: [...(row('Now')?.querySelectorAll('.chip.mono') ?? [])].map(said),
        orgs: [...(orgs?.querySelectorAll('.set-row') ?? [])].map(said).filter(t => !t.startsWith('Stop all remote access')),
        stop: !!stop && !stop.disabled && said(stop) === 'Stop all remote access',
        rows: [...panel.querySelectorAll('.set-row > .set-label')].map(said),
        tab: said(document.querySelector('#app-settings-tab-remoteaccess')),
      }
    }, pageOf)
  })
  await shot('09-app-settings-remote-access')
  await attempt('App settings to close', () => closePanel('App settings to close', pageOf))

  // ------------------------------------------------------------------ 10 Revoke
  R.revoke = await attempt('Revoke', async () => {
    await openConnections()
    const at = (await group()).labels.indexOf(args.dana)
    if (at < 0) throw new Error(`${args.dana} is not in the list`)
    await page.click({ selector: `${tab} ul[aria-label="Computers that can open this organization"] li button`, text: '^Revoke$', regex: true, index: at })
    await page.waitFor('.confirm-box', { timeout: 10000 })
    const said = await text('.confirm-box')
    await shot('10-revoke-asks-first')
    await page.click({ selector: '.confirm-box button', text: '^Revoke$', regex: true })
    const told = await toast('the toast of the revocation', /was revoked/)
    await until('the computer to leave the list', (s, dana) => ![...document.querySelectorAll(`${s} ul.remote-computers li .remote-computer-text`)].some(e => (e.innerText || '').trim().startsWith(dana)), 20000, tab, args.dana)
    return { text: said, toast: typeof told === 'string' ? told : null, left: (await group()).labels }
  })

  // ------------------------------------------------------------------ switching off while a computer is connected
  R.switchedOff = await attempt('the switch to go off', async () => {
    await showGroup()
    await page.click(toggle)
    await until('the switch off', s => document.querySelector(`${s} input[aria-label="Let other computers open this organization"]`)?.checked === false, 20000, tab)
    return { asked: await page.eval(() => window.__rigConfirms[window.__rigConfirms.length - 1] ?? null), checked: (await group()).checked }
  })
  return R
}
