// The page script of dm-panel-visual.mjs: walks the user's mailbox panel as
// chats through every ruling of the 4.7.0 revamp, in the rig's guarded
// offscreen window, and returns what it measured. Clicks, keys and text are
// CDP input to this window only; the "engine" is the driver's fake one.
//
// The walk starts with the window INACTIVE (an offscreen window never has the
// user), so the first screens show unread counts that seeing a chat would
// clear; step 3 gives the window the user (CDP focus emulation) and from
// there every chat is read as it is seen, as on a real desktop.
'use strict'

module.exports = async (page) => {
  const v = { themes: {}, read: {}, shots: [] }
  const shot = async (name) => { await page.screenshot(name); v.shots.push(name) }
  const calls = () => page.api('GET', '/__calls')
  const posted = async (re) => (await calls()).filter(c => c.method === 'POST' && new RegExp(re).test(c.path))
  const until = async (what, fn, timeout = 15000) => {
    const end = Date.now() + timeout
    for (;;) {
      const got = await fn()
      if (got) return got
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await page.sleep(150)
    }
  }

  /** everything the panel shows, as numbers and strings */
  const snap = () => page.eval(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const text = (e) => (e ? (e.textContent || '') : '').replace(/\s+/g, ' ').trim()
    const badge = (r) => { const b = r.querySelector('.dm-badge:not(.dm-badge-asks)'); return b ? text(b) : null }
    const rows = [...document.querySelectorAll('.dm-row')].map(r => ({
      peer: r.dataset.dmChat, name: text(r.querySelector('.dm-row-name')), unread: badge(r),
      asks: r.querySelector('.dm-badge-asks') ? text(r.querySelector('.dm-badge-asks')) : null,
      preview: text(r.querySelector('.dm-row-prev')), selected: r.classList.contains('sel'),
      closable: !!r.querySelector('.dm-row-close'), closeTitle: r.querySelector('.dm-row-close')?.getAttribute('title') ?? null,
      box: box(r) }))
    const head = document.querySelector('.dm-head')
    const close = head?.querySelector('.dm-close')
    const scroller = document.querySelector('.dm-timeline')
    const view = scroller ? scroller.getBoundingClientRect() : null
    const bubbles = [...document.querySelectorAll('.dm-msg[data-dm-entry]')].filter(m => !m.classList.contains('dm-ask')).map(m => {
      const b = m.querySelector('.dm-bubble'), cs = getComputedStyle(b), r = b.getBoundingClientRect()
      return { id: m.dataset.dmEntry, out: m.classList.contains('out'), unread: m.classList.contains('unread'), box: box(b),
        inView: !!view && r.bottom > view.top && r.top < view.bottom,
        background: cs.backgroundColor, color: cs.color, borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
        label: text(m.querySelector('.dm-kind:not(.dm-kind-notice)')) || null, notice: !!m.querySelector('.dm-kind-notice'),
        files: [...m.querySelectorAll('.attach-row > *')].map(a => text(a).replace(/\s*\d+ KB$/, '') || a.getAttribute('title') || a.querySelector('img')?.getAttribute('alt') || a.className),
        reply: text(m.querySelector('.mail-reply-quote, .reply-quote, .mail-inreply')) || null,
        time: text(m.querySelector('.dm-meta time')), text: text(m.querySelector('.dm-bubble')).slice(0, 90) }
    })
    // an icon is told by the path it draws: a production bundle carries no test ids
    const drawn = (sel) => document.querySelector(sel)?.getAttribute('d') ?? null
    return {
      hasFocus: document.hasFocus(), visibility: document.visibilityState,
      theme: [...document.documentElement.classList].filter(c => c.startsWith('contrast-')).join(' ') || 'contrast-charcoal (default)',
      title: text(document.querySelector('.settings h3')), titleIcon: drawn('.settings h3 svg path'),
      bellIcon: drawn('.dm-probe-bar svg path'), bell: text(document.querySelector('.dm-probe-bar button, .dm-probe-bar .bell, .dm-probe-bar [role=button]')),
      bellTitle: document.querySelector('.dm-probe-bar button')?.getAttribute('title') ?? null,
      classicBox: (() => { const c = document.querySelector('input[aria-label="Classic mailbox"]'); return c ? { checked: c.checked, box: box(c) } : null })(),
      requests: [...document.querySelectorAll('.dm-requests .hist-row')].map(text),
      rows, list: box(document.querySelector('.dm-list')),
      head: head ? { peer: head.dataset.dmPeer, name: text(head.querySelector('.dm-who-name, .dm-who-l1')), badges: [...head.querySelectorAll('.dm-who-l1 .badge')].map(text),
        status: text(head.querySelector('.dm-who-l2')), closeDisabled: close ? close.disabled : null, closeTitle: close?.getAttribute('title') ?? null,
        closeLabel: close?.getAttribute('aria-label') ?? null, box: box(head) } : null,
      timeline: scroller ? { ...box(scroller), scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
      days: [...document.querySelectorAll('.dm-day')].map(text), newmark: text(document.querySelector('.dm-newmark')) || null,
      bubbles, asks: [...document.querySelectorAll('.dm-msg.dm-ask')].map(a => ({ key: a.dataset.dmEntry, open: a.classList.contains('open'), box: box(a) })),
      composer: box(document.querySelector('.dm-compose .mail-reply textarea')), sendLabel: text(document.querySelector('.dm-compose .mail-reply-send')) || null,
      placeholder: document.querySelector('.dm-compose .mail-reply textarea')?.getAttribute('placeholder') ?? null,
      nowrite: text(document.querySelector('.dm-nowrite')) || null, none: text(document.querySelector('.dm-none b')) || null,
      start: text(document.querySelector('.dm-start')) || null,
      mailer: (() => { const m = document.querySelector('.mailer.dm'); return m ? { narrow: m.classList.contains('narrow-list'), open: m.classList.contains('narrow-list-open'), ...box(m) } : null })(),
      confirms: window.__dm.confirms, toasts: window.__dm.toasts.slice(),
    }
  })
  const row = (s, peer) => s.rows.find(r => r.peer === peer) ?? null
  const openChat = async (peer) => {
    await page.click(`.dm-row[data-dm-chat="${peer}"]`)
    await until(`the chat of ${peer}`, async () => (await snap()).head?.peer === peer)
  }

  // ---------------------------------------------------------------- 0. start
  await page.resize('1440x1000')
  await page.waitFor('.dm-row')
  await until('the panel to open on the chat holding the oldest unread mail', async () => (await snap()).head?.peer === 'worker')
  v.start = await snap()

  // ------------------------------------- 1. the list and a chat, in each theme
  for (const theme of ['charcoal', 'light', 'solarized-light', 'obsidian-black']) {
    await page.eval((id) => window.__dm.theme(id), theme)
    await page.sleep(350)
    v.themes[theme] = await snap()
    await shot(`01-chats-${theme}`)
  }
  await page.eval(() => window.__dm.theme('charcoal'))
  await page.sleep(300)
  // the older half of the chat, when the newest half filled the pane
  if (v.themes.charcoal.timeline.scrollHeight > v.themes.charcoal.timeline.clientHeight + 4) {
    await page.eval(() => { document.querySelector('.dm-timeline').scrollTop = 0 })
    await page.sleep(250)
    v.top = await snap()
    await shot('01b-chats-charcoal-earlier-messages')
  }

  // ---------------- 2. seeing a chat reads it, once the window has the user
  // (before any input: CDP input itself focuses the window, measured in run 3)
  const before = await snap()
  v.read.inactive = { hasFocus: before.hasFocus, visibility: before.visibility, badge: row(before, 'worker')?.unread ?? null,
    bell: before.bell, reads: (await posted('/inbox/read$')).map(c => c.body.ids) }
  await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.eval(() => { window.dispatchEvent(new Event('focus')) })
  await until('the open chat to be read', async () => (await posted('/inbox/read$')).length === 1)
  await until('its unread count to go', async () => row(await snap(), 'worker')?.unread == null)
  const after = await snap()
  v.read.active = { hasFocus: after.hasFocus, visibility: after.visibility, badge: row(after, 'worker')?.unread ?? null, bell: after.bell,
    newmark: after.newmark, reads: (await posted('/inbox/read$')).map(c => c.body.ids) }
  await shot('02-window-active-chat-read-new-mark-stays')

  // --------------------------------------------- 3. a bubble's own controls
  await page.hover({ selector: '[data-dm-entry="w3"] .dm-bubble', scroll: true })
  v.hover = await page.eval(() => [...document.querySelectorAll('[data-dm-entry="w3"] .dm-actions button')]
    .filter(b => b.getBoundingClientRect().width > 0).map(b => b.getAttribute('aria-label')))
  await shot('03-bubble-hover-reply-and-copy')

  // ------------- 4. a top-level agent: cannot be closed; a request, per tab
  await openChat('lead')
  const lead = await snap()
  v.lead = { ...lead.head, rowClosable: row(lead, 'lead')?.closable, asksBadge: row(lead, 'lead')?.asks }
  const askState = () => page.eval(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const text = (e) => (e ? (e.textContent || '') : '').replace(/\s+/g, ' ').trim()
    const tabs = [...document.querySelectorAll('.dm-ask .ask-message[data-ask-tab]')]
    return { kinds: tabs.map(x => text(x.querySelector('.ask-message-kind'))), headers: tabs.map(x => text(x.querySelector('.answered-chip')) || null),
      decided: tabs.map(x => x.classList.contains('done')), boxes: tabs.map(box),
      freeResponse: tabs.map(x => !!x.querySelector('.ask-free-response-input')),
      other: tabs.map(x => [...x.querySelectorAll('.ask-row-body b')].some(b => b.textContent === 'Other')),
      submits: document.querySelectorAll('.dm-ask .ask-submit').length, submitText: text(document.querySelector('.dm-ask .ask-submit')),
      submitDisabled: document.querySelector('.dm-ask .ask-submit')?.disabled ?? null,
      skipAll: !!document.querySelector('.dm-ask .ask-skip-all'), tabstrip: !!document.querySelector('.dm-ask .ask-tabstrip'),
      cards: [...document.querySelectorAll('.dm-ask')].map(a => ({ open: a.classList.contains('open'), text: text(a).slice(0, 260) })) }
  })
  v.request = await askState()
  await shot('04-top-level-chat-cannot-close-request-one-bubble-per-tab')
  // each control is brought into the pane before its click, as a reader scrolls to it
  await page.click({ selector: '.dm-ask .ask-message[data-ask-tab="0"] .ask-row-pick', index: 0, scroll: true })
  await page.click({ selector: '.dm-ask .ask-message[data-ask-tab="1"] .ask-free-response-input', scroll: true })
  await page.type('the classic switch')
  await page.click({ selector: '.dm-ask .ask-message[data-ask-tab="2"] button.ask-row', index: 0, scroll: true })
  v.request.afterAnswers = await askState()
  await shot('05-request-every-tab-decided-one-submit')
  await page.click({ selector: '.dm-ask .ask-submit', scroll: true })
  const batch = await until('the request to be submitted', async () => (await posted('/nodes/lead/batch$'))[0])
  v.request.posted = batch.body
  await page.sleep(400)
  v.request.submitted = await askState()
  v.request.badgeAfterSubmit = row(await snap(), 'lead')?.asks ?? null
  await shot('06-request-submitted')
  // the engine's next tree lists it as resolved, with what was submitted
  await page.eval((answer) => window.__dm.answered(answer), { answers: batch.body.answers, scope: batch.body.scope })
  await page.sleep(500)
  v.request.resolved = await askState()
  await shot('07-request-resolved-in-the-chat-history')

  // ------------------------------ 5. writing: a reply, then a new message
  await openChat('worker')
  const worker = await snap()
  v.worker = { header: worker.head, row: row(worker, 'worker') }
  await page.hover({ selector: '[data-dm-entry="w3"] .dm-bubble', scroll: true })
  await page.click('[data-dm-entry="w3"] .dm-actions button[aria-label="Reply"]')
  await page.waitFor('.dm-replybar')
  await page.click('.dm-compose .mail-reply textarea')
  await page.type('Tuesday 10:00 works.')
  const replying = await snap()
  v.reply = { bar: await page.eval(() => [...document.querySelectorAll('.dm-replybar-text')].map(e => e.textContent.trim())),
    sendLabel: replying.sendLabel, placeholder: replying.placeholder }
  await shot('08-reply-to-a-message')
  await page.click('.dm-compose .mail-reply-send')
  await until('the reply to be sent', async () => (await posted('/nodes/worker/message$')).length === 1)
  await until('the reply to show as the newest bubble', async () => (await snap()).bubbles.some(b => b.id === 'sent-1'))
  const replied = await snap()
  v.reply.after = { ids: replied.bubbles.map(b => b.id), last: replied.bubbles[replied.bubbles.length - 1], sendLabel: replied.sendLabel, placeholder: replied.placeholder }
  v.reply.barGone = await page.eval(() => !document.querySelector('.dm-replybar'))
  await shot('09-reply-sent')
  // the reply carries what it answers; that quote leads back to the original, in this chat
  v.reply.quote = await page.eval(() => { const q = document.querySelector('[data-dm-entry="sent-1"] .reply-preview')
    return q ? { role: q.getAttribute('role'), text: (q.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) } : null })
  await page.click({ selector: '[data-dm-entry="sent-1"] .reply-preview blockquote', scroll: true })
  await until('the original to be shown', async () => page.eval(() => document.querySelector('[data-dm-entry="w3"]')?.classList.contains('flash') === true))
  v.reply.quote.opened = await page.eval(() => window.__dm.opened.slice())
  v.reply.quote.flashed = await page.eval(() => [...document.querySelectorAll('.dm-msg.flash')].map(m => m.dataset.dmEntry))
  await shot('09b-the-reply-quote-shows-the-original')
  await page.click('.dm-compose .mail-reply textarea')
  await page.type('Also send me the list of addresses that bounced.')
  v.message = { sendLabel: (await snap()).sendLabel }
  await page.click('.dm-compose .mail-reply-send')
  await until('the new message to be sent', async () => (await posted('/nodes/worker/message$')).length === 2)
  await until('the new message to show', async () => (await snap()).bubbles.some(b => b.id === 'sent-2'))
  const written = await snap()
  v.message.after = { ids: written.bubbles.map(b => b.id), last: written.bubbles[written.bubbles.length - 1] }
  v.message.posts = (await posted('/nodes/worker/message$')).map(c => c.body)
  await shot('10-new-message-sent')

  // ---- 6. a top-level agent WITH a grant: close revokes it, the chat stays
  await openChat('solo')
  const soloBefore = await snap()
  await shot('11-top-level-agent-with-an-audience-grant')
  await page.click('.dm-head .dm-close')
  await until('the grant to be revoked', async () => (await posted('/audiences$')).length === 1)
  await until('the close control to say the chat stays', async () => (await snap()).head?.closeDisabled === true)
  const soloAfter = await snap()
  v.solo = { before: soloBefore.head, after: soloAfter.head, stillListed: !!row(soloAfter, 'solo'), stillOpen: soloAfter.head?.peer === 'solo', confirms: soloAfter.confirms }
  await shot('12-its-grant-is-revoked-and-the-chat-stays')

  // ------------- 7. an audience chat: close revokes exactly that grant, at once
  await page.hover('.dm-row[data-dm-chat="worker"]')
  const hovered = await snap()
  v.workerClose = { title: row(hovered, 'worker')?.closeTitle, closable: row(hovered, 'worker')?.closable,
    others: hovered.rows.filter(r => r.closable).map(r => r.peer) }
  await shot('13-audience-chat-close-control-on-its-row')
  await page.click('.dm-row[data-dm-chat="worker"] .dm-row-close')
  await until('the grant to be revoked', async () => (await posted('/audiences$')).length === 2)
  await until('the chat to leave the list', async () => !row(await snap(), 'worker'))
  const closed = await snap()
  v.workerClose.listedAfter = !!row(closed, 'worker')
  v.workerClose.rows = closed.rows.map(r => r.peer)
  v.workerClose.confirms = closed.confirms
  await shot('14-audience-chat-closed-without-a-confirmation')

  // ------------------------------------- 8. New chat: the agents list itself
  await page.click('.dm-list-head .dm-new')
  await page.waitFor('.dm-newchat .tray-row')
  const picker = () => page.eval(() => {
    const text = (e) => (e ? (e.textContent || '') : '').replace(/\s+/g, ' ').trim()
    const frame = document.querySelector('.dm-newchat')
    const active = frame.querySelector('input[aria-label="Only active agents"]')
    return { title: text(frame.querySelector('.modalpin-name')) || null,
      rows: [...frame.querySelectorAll('.tray-row')].map(r => r.dataset.dmPick), open: [...frame.querySelectorAll('.tray-row[data-dm-open="yes"]')].map(r => r.dataset.dmPick),
      off: [...frame.querySelectorAll('.tray-row.off')].map(r => r.dataset.dmPick),
      filter: !!frame.querySelector('input.tray-filter'), archivedToggle: text(frame.querySelector('.tray-arch')) || null,
      active: active ? { checked: active.checked } : null,
      empty: text(frame.querySelector('.team-empty')) || null, hint: text(frame.querySelector('.dm-newchat-hint')) }
  })
  v.picker = await picker()
  await shot('15-new-chat-is-the-agents-list')
  await page.click('.dm-newchat .tray-arch')
  v.picker.withArchived = await picker()
  await shot('16-new-chat-archived-agents-shown')
  await page.click('.dm-newchat .tray-arch')
  await page.click('.dm-newchat input[aria-label="Only active agents"]')
  v.picker.activeOnly = await picker()
  await shot('17-new-chat-active-agents-only')
  await page.click('.dm-newchat input[aria-label="Only active agents"]')
  await page.click('.dm-newchat input.tray-filter')
  await page.type('help')
  v.picker.filtered = await picker()
  await shot('18-new-chat-filtered')
  await page.click('.dm-newchat .tray-row[data-dm-pick="helper"] .tray-main')
  await until('the audience to be granted', async () => (await posted('/audiences$')).length === 3)
  await until('the new chat to open', async () => (await snap()).head?.peer === 'helper')
  const helper = await snap()
  v.picker.opened = helper.head
  v.picker.closedAfterPick = await page.eval(() => !document.querySelector('.dm-newchat'))
  v.picker.listed = helper.rows.map(r => r.peer)
  v.picker.start = helper.start
  await shot('19-new-chat-opened-with-an-audience')

  // ----------------------------------------- 9. Orgtree's own mail, one chat
  v.read.system = { badgeBefore: row(await snap(), '@system')?.unread ?? null }
  await openChat('@system')
  await until('the system chat to be read', async () => (await posted('/inbox/read$')).some(c => c.body.ids.includes('sys1')))
  await until('its unread count to go', async () => row(await snap(), '@system')?.unread == null)
  const system = await snap()
  v.read.system.badgeAfter = row(system, '@system')?.unread ?? null
  v.read.reads = (await posted('/inbox/read$')).map(c => c.body.ids)
  v.system = { head: system.head, nowrite: system.nowrite, rowClosable: row(system, '@system')?.closable, ids: system.bubbles.map(b => b.id), bell: system.bell }
  await shot('20-orgtree-chat-system-mail')

  // -------------------------- 10. a top-level agent under a project, and search
  await openChat('member')
  v.member = (await snap()).head
  await page.click('.dm-search')
  await page.type('so')
  v.search = { query: 'so', rows: (await snap()).rows.map(r => r.peer) }
  await shot('21-search-chats')
  for (let i = 0; i < 2; i++) await page.press('Backspace')
  v.search.cleared = (await snap()).rows.map(r => r.peer)

  // ------------------------------------------------ 11. a narrow panel
  await page.resize('760x900')
  await until('the list to collapse', async () => (await snap()).mailer?.narrow === true)
  const narrow = await snap()
  v.narrow = { collapsed: narrow.mailer.narrow, mailer: narrow.mailer,
    rail: await page.eval(() => { const r = document.querySelector('.mailer.dm .mailer-listtoggle').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }),
    label: await page.eval(() => document.querySelector('.mailer.dm .mailer-listtoggle').getAttribute('aria-label')) }
  await shot('22-narrow-panel-list-behind-its-control')
  await page.click('.mailer.dm .mailer-listtoggle')
  await until('the list overlay', async () => (await snap()).mailer?.open === true)
  await shot('23-narrow-panel-list-open')
  await page.click('.dm-row[data-dm-chat="lead"]')
  await until('the chat to open', async () => (await snap()).head?.peer === 'lead')
  v.narrow.closedOnPick = (await snap()).mailer.open === false
  await shot('24-narrow-panel-chat')
  await page.resize('1440x1000')
  await until('the list to return', async () => (await snap()).mailer?.narrow === false)

  // ------------------- 12. the classic mailbox, from the title bar, and back
  await page.click('input[aria-label="Classic mailbox"]')
  await page.waitFor('.mail-folders')
  await page.sleep(400)
  const classic = await snap()
  v.classic = { bellIcon: classic.bellIcon, title: classic.title, titleIcon: classic.titleIcon, checked: classic.classicBox?.checked,
    folders: await page.eval(() => !!document.querySelector('.mail-folders')), mailrows: await page.eval(() => document.querySelectorAll('.mailrow').length),
    chats: await page.eval(() => !!document.querySelector('.dm-list')), stored: await page.eval(() => window.localStorage.getItem('orgtree-classic-mailbox')) }
  await shot('25-classic-mailbox-and-its-mail-icon')
  await page.click('input[aria-label="Classic mailbox"]')
  await page.waitFor('.dm-list')
  await page.sleep(400)
  const back = await snap()
  v.back = { bellIcon: back.bellIcon, title: back.title, titleIcon: back.titleIcon, checked: back.classicBox?.checked,
    chats: await page.eval(() => !!document.querySelector('.dm-list')), stored: await page.eval(() => window.localStorage.getItem('orgtree-classic-mailbox')),
    rows: back.rows.map(r => r.peer) }
  await shot('26-back-to-the-chats')

  // -------------------------------------- 13. the same states in the light theme
  await page.eval(() => window.__dm.theme('light'))
  await openChat('lead')
  await shot('27-light-resolved-request')
  await openChat('helper')
  await shot('28-light-empty-chat')
  await page.click('.dm-list-head .dm-new')
  await page.waitFor('.dm-newchat .tray-row')
  await shot('29-light-new-chat')
  await page.press('Escape')
  await page.waitFor('.dm-newchat', { gone: true })
  await page.eval(() => window.__dm.theme('charcoal'))

  const end = await snap()
  v.end = { confirms: end.confirms, toasts: end.toasts, rows: end.rows.map(r => r.peer), hasFocus: end.hasFocus }
  v.calls = (await calls()).map(c => ({ method: c.method, path: c.path, body: c.body }))
  return v
}
