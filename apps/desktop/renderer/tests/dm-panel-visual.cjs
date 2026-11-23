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
      parent: r.dataset.dmParent ?? null, fold: r.querySelector('.dm-fold')?.getAttribute('aria-expanded') ?? null,
      losing: r.classList.contains('losing'), chip: text(r.querySelector('.dm-av .letter-chip')) || null,
      // a project's own mark: its colour, and the icon it draws
      mark: (() => { const m = r.querySelector('.dm-av .project-mark'); return m ? { color: getComputedStyle(m).color, d: m.querySelector('svg path')?.getAttribute('d') ?? null } : null })(),
      preview: text(r.querySelector('.dm-row-prev')), selected: r.classList.contains('sel'),
      request: r.classList.contains('request'), requestBadge: !!r.querySelector('.dm-badge-request'), background: getComputedStyle(r).backgroundColor,
      closable: !!r.querySelector('.dm-row-close'), closeTitle: r.querySelector('.dm-row-close')?.getAttribute('title') ?? null,
      box: box(r) }))
    const head = document.querySelector('.dm-head')
    const close = head?.querySelector('.dm-close')
    const scroller = document.querySelector('.dm-timeline')
    const view = scroller ? scroller.getBoundingClientRect() : null
    const bubbles = [...document.querySelectorAll('.dm-msg[data-dm-entry]')].filter(m => !m.classList.contains('dm-ask')).map(m => {
      const b = m.querySelector('.dm-bubble'), cs = getComputedStyle(b), r = b.getBoundingClientRect(), edge = getComputedStyle(b, '::before')
      return { id: m.dataset.dmEntry, out: m.classList.contains('out'), unread: m.classList.contains('unread'), box: box(b),
        inView: !!view && r.bottom > view.top && r.top < view.bottom,
        background: cs.backgroundColor, color: cs.color, borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
        label: text(m.querySelector('.dm-kind:not(.dm-kind-megaphone)')) || null, notice: b.classList.contains('notice'),
        // a project's thread: the agent a bubble is from or to, where the user's message stands, the megaphone mark
        via: m.dataset.dmVia ?? null, viaText: text(m.querySelector('.dm-via')) || null, job: text(m.querySelector('.dm-job')) || null,
        megaphone: text(m.querySelector('.dm-kind-megaphone')) || null,
        // a notice's border is a layer over the bubble's edge: its colour, and the mask that cuts it to dashes
        edge: edge.content === 'none' ? null : { background: edge.backgroundColor, mask: (edge.maskImage || edge.webkitMaskImage || '').slice(0, 400) },
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
      strip: document.querySelectorAll('.dm-requests').length, chatBackground: (() => { const c = document.querySelector('.dm-conv'); return c ? getComputedStyle(c).backgroundColor : null })(),
      rows, list: box(document.querySelector('.dm-list')),
      head: head ? { peer: head.dataset.dmPeer, name: text(head.querySelector('.dm-who-name, .dm-who-l1')), badges: [...head.querySelectorAll('.dm-who-l1 .badge')].map(text),
        // each chip's box: what "the same spacing, padding and shape" is measured by
        badgeBoxes: [...head.querySelectorAll('.dm-who-l1 .badge')].map(b => { const cs = getComputedStyle(b); return { text: text(b), padding: cs.padding, radius: cs.borderRadius,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, borderShown: cs.borderTopColor !== 'rgba(0, 0, 0, 0)', display: cs.display, gap: cs.columnGap, font: cs.fontSize, h: Math.round(b.getBoundingClientRect().height) } }),
        link: (() => { const l = head.querySelector('.dm-who-name .ref-chip'); return l ? { tag: l.tagName, cls: l.className, agent: l.getAttribute('data-copy-agent-name') } : null })(),
        gear: head.querySelector('.dm-gear')?.getAttribute('aria-label') ?? null,
        via: text(head.querySelector('.dm-via-projects')) || null,
        viaLink: (() => { const l = head.querySelector('.dm-via-projects .ref-chip'); const m = l?.querySelector('.project-mark')
          return l ? { project: l.getAttribute('data-copy-agent-name'), tag: l.tagName, color: m ? getComputedStyle(m).color : null } : null })(),
        chip: text(head.querySelector('.dm-av .letter-chip')) || null,
        status: text(head.querySelector('.dm-who-l2')), closeDisabled: close ? close.disabled : null, closeTitle: close?.getAttribute('title') ?? null,
        closeLabel: close?.getAttribute('aria-label') ?? null, box: box(head) } : null,
      timeline: scroller ? { ...box(scroller), scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
      days: [...document.querySelectorAll('.dm-day')].map(text), newmark: text(document.querySelector('.dm-newmark')) || null,
      bubbles, asks: [...document.querySelectorAll('.dm-msg.dm-ask')].map(a => ({ key: a.dataset.dmEntry, open: a.classList.contains('open'), box: box(a) })),
      composer: box(document.querySelector('.dm-compose .mail-reply textarea')), sendLabel: text(document.querySelector('.dm-compose .mail-reply-send')) || null,
      controls: { effort: (() => { const e = document.querySelector('.dm-compose .mail-reply-controls .cc-eff'); return e ? { label: text(e), box: box(e) } : null })(),
        fast: (() => { const f = document.querySelector('.dm-compose .mail-reply-controls .cc-fast'); return f ? { label: f.getAttribute('aria-label'), box: box(f) } : null })() },
      audreq: (() => { const c = document.querySelector('.dm-audreq'); return c ? { peer: c.dataset.dmRequest, text: text(c), buttons: [...c.querySelectorAll('button')].map(text), box: box(c.querySelector('.dm-bubble')) } : null })(),
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
    // the time steps aside while the close control shows in its corner
    time: await page.eval(() => { const r = document.querySelector('.dm-row[data-dm-chat="worker"]'); const t = r.querySelector('.dm-row-l1 .mtime'), x = r.querySelector('.dm-row-close')
      return { time: t ? getComputedStyle(t).visibility : null, close: x ? getComputedStyle(x).display : null } }),
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
  v.system = { tags: await page.eval(() => [...document.querySelectorAll('.dm-via-system')].map(e => (e.textContent || '').replace(/\s+/g, ' ').replace(/^S(?=System)/, 'S ').trim())),
    head: system.head, nowrite: system.nowrite, rowClosable: row(system, '@system')?.closable, ids: system.bubbles.map(b => b.id), bell: system.bell }
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

  // ---- 10b. AUDIENCE REQUESTS ARE CHATS (USER 2026-11-23 mae2b1aa37a9b):
  // marked and first in the list; denied or approved in the chat; writing approves
  await openChat('drafter')
  const asked = await snap()
  v.audreq = { rows: asked.rows.filter(r => r.request).map(r => ({ peer: r.peer, preview: r.preview, badge: r.requestBadge, background: r.background, box: r.box })),
    plainRow: row(asked, 'lead')?.background, first: asked.rows.slice(0, 2).map(r => r.peer), strip: asked.strip, card: asked.audreq,
    closeTitle: asked.head?.closeTitle, sendsBefore: (await posted('/audiences$')).length }
  await shot('21a-audience-request-is-a-chat')
  await page.eval(() => window.__dm.theme('light'))
  await page.sleep(300)
  await shot('21b-light-audience-request')
  await page.eval(() => window.__dm.theme('charcoal'))
  await page.sleep(300)
  await page.click('.dm-audreq .dm-request-acts button:not(.primary)')
  await until('the request to be denied', async () => (await posted('/audiences$')).length === 4)
  await until('its chat to leave the list', async () => !row(await snap(), 'drafter'))
  v.audreq.denied = { rows: (await snap()).rows.map(r => r.peer), open: (await snap()).head?.peer ?? null }
  await shot('21c-request-denied-its-chat-is-gone')
  await openChat('scout')
  await page.click('.dm-compose .mail-reply textarea')
  await page.type('Yes, report the nightly check to me here.')
  await shot('21d-writing-to-a-request-approves-it')
  await page.click('.dm-compose .mail-reply-send')
  await until('the audience to be granted', async () => (await posted('/audiences$')).length === 5)
  await until('the message to be sent', async () => (await posted('/nodes/scout/message$')).length === 1)
  await until('the request to leave the chat', async () => { const s = await snap(); return !s.audreq && s.bubbles.some(b => b.out) && s.head?.badges.some(b => /audience/.test(b)) })
  const approved = await snap()
  v.audreq.approved = { head: approved.head, row: row(approved, 'scout'), card: approved.audreq, bubbles: approved.bubbles.map(b => ({ out: b.out, text: b.text })) }
  await shot('21e-request-approved-by-writing')

  // ---- 10c. the chat header's link and gear; the message box's fast mode and effort
  await openChat('solo')
  const box = await snap()
  v.agentbox = { head: box.head, controls: box.controls, composer: box.composer }
  await page.click('.dm-compose .mail-reply-controls .cc-eff')
  await page.waitFor('.dm-compose .eff-pop')
  v.agentbox.effortTrack = await page.eval(() => { const t = document.querySelector('.dm-compose .eff-pop [role="slider"]'); const r = t?.getBoundingClientRect()
    return t ? { text: t.getAttribute('aria-valuetext'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })
  await shot('21f-message-box-fast-mode-and-effort')
  await page.press('Escape')
  await page.waitFor('.dm-compose .eff-pop', { gone: true })
  await page.click('.dm-head .dm-gear')
  v.agentbox.settings = await page.eval(() => window.__dm.settings.slice())
  await page.click('.dm-head .dm-who-name .ref-chip')
  v.agentbox.focused = await page.eval(() => window.__dm.focused.slice())
  await page.hover('.dm-head .dm-gear')
  await shot('21g-chat-header-agent-link-and-settings-gear')

  // ---- 10d. A PROJECT'S CHAT IS ONE THREAD (USER 2026-11-23 mb52269db6058)
  await openChat('crew')
  const crew = await snap()
  v.project = { head: crew.head, bubbles: crew.bubbles.map(b => ({ id: b.id, out: b.out, via: b.via, viaText: b.viaText, job: b.job, megaphone: b.megaphone, background: b.background, box: b.box })) }
  await shot('21h-project-chat-is-one-thread')
  await page.eval(() => window.__dm.theme('light'))
  await page.sleep(300)
  v.project.light = (await snap()).bubbles.map(b => ({ id: b.id, background: b.background }))
  await shot('21i-light-project-chat')
  await page.eval(() => window.__dm.theme('charcoal'))
  await page.sleep(300)
  // Reply on the member's answer writes to that member
  await page.hover({ selector: '[data-dm-entry="ca1"] .dm-bubble', scroll: true })
  await page.click('[data-dm-entry="ca1"] .dm-actions button[aria-label="Reply"]')
  await page.waitFor('.dm-replybar')
  v.project.replyPlaceholder = (await snap()).placeholder
  await page.click('.dm-compose .mail-reply textarea')
  await page.type('Thanks. Send the corrected report when it is ready.')
  await page.click('.dm-compose .mail-reply-send')
  await until('the reply to reach the member', async () => (await posted('/nodes/member/message$')).length === 1)
  await until('the reply to show in the project chat', async () => (await snap()).bubbles.some(b => b.id === 'sent-4' && b.out && b.via === 'member'))
  await shot('21j-reply-to-a-member-stays-in-the-thread')
  // Reply on the user's own message is a follow-up: to the project, which hands it to the holder
  await page.hover({ selector: '[data-dm-entry="cj1"] .dm-bubble', scroll: true })
  await page.click('[data-dm-entry="cj1"] .dm-actions button[aria-label="Follow up on this message"]')
  await page.waitFor('.dm-replybar')
  v.project.followPlaceholder = (await snap()).placeholder
  await page.click('.dm-compose .mail-reply textarea')
  await page.type('And the totals on page 2, please.')
  await page.click('.dm-compose .mail-reply-send')
  await until('the follow-up to reach the project', async () => (await posted('/nodes/crew/message$')).length === 1)
  await until('the follow-up to show in the thread', async () => (await snap()).bubbles.some(b => b.id === 'sent-5' && b.out))
  const threaded = await snap()
  v.project.after = threaded.bubbles.map(b => ({ id: b.id, out: b.out, via: b.via, job: b.job, megaphone: b.megaphone, text: b.text.slice(0, 60) }))
  await shot('21k-follow-up-on-my-own-message')
  // each member's chat has its copy of the megaphone send, and not the queue's copies
  await openChat('mate')
  const mate = await snap()
  v.project.mate = mate.bubbles.map(b => ({ id: b.id, megaphone: b.megaphone, job: b.job }))
  v.project.mateMark = await page.eval(() => !!document.querySelector('.dm-kind-megaphone .project-mark'))
  await shot('21l-a-members-chat-has-its-megaphone-copy')

  // ---- 10e. AUDIENCES THROUGH A PROJECT (USER 2026-11-23 m0ca89ba635fd)
  const marked = async () => (await snap()).rows.filter(r => r.losing).map(r => r.peer)
  // the group: clerk sits under desk; the docket's arrow folds it, and a folded row counts what it hides
  const grouped = await snap()
  v.group = { desk: row(grouped, 'desk'), clerk: row(grouped, 'clerk') }
  await shot('21m0-agents-under-their-project')
  await page.click('.dm-row[data-dm-chat="desk"] .dm-fold')
  await until('the group to fold', async () => !row(await snap(), 'clerk'))
  v.group.folded = { rows: (await snap()).rows.map(r => r.peer), fold: row(await snap(), 'desk')?.fold }
  await shot('21m1-the-group-folded')
  await page.click('.dm-row[data-dm-chat="desk"] .dm-fold')
  await until('the group to unfold', async () => !!row(await snap(), 'clerk'))
  await openChat('clerk')
  const clerk = await snap()
  v.via = { clerk: clerk.head, desk: row(clerk, 'desk'), crew: row(clerk, 'crew') }
  await shot('21m-audience-via-a-project')
  await openChat('runner')
  v.via.runner = (await snap()).head
  await shot('21n-own-audience-and-via-a-project')
  // the first close revokes runner's own grant: nobody else is affected, nothing is asked
  await page.hover('.dm-head .dm-close')
  v.via.firstHover = await marked()
  await page.click('.dm-head .dm-close')
  await until('runner\'s own grant to be revoked', async () => (await posted('/audiences$')).length === 6)
  await until('the label to say via the project only', async () => (await snap()).head?.via === 'via desk')
  v.via.afterFirst = { head: (await snap()).head, confirms: (await snap()).confirms }
  // the second close is the project's: it marks who loses the audience, and asks
  await page.hover('.dm-row[data-dm-chat="lead"]')
  await page.hover('.dm-head .dm-close')
  await until('the rows that lose the audience to be marked', async () => (await marked()).length > 0)
  v.via.secondHover = await marked()
  await shot('21o-closing-a-projects-audience-marks-who-loses-it')
  await page.click('.dm-head .dm-close')
  await page.waitFor('.confirm-box[role="dialog"]')
  v.via.dialog = await page.eval(() => { const d = document.querySelector('.confirm-box[role="dialog"]'); const t = e => (e ? e.textContent || '' : '').replace(/\s+/g, ' ').trim()
    return { title: t(d.querySelector('h3')), body: t(d.querySelector('.confirm-body')), buttons: [...d.querySelectorAll('button')].map(t) } })
  v.via.revokedBeforeAnswer = (await posted('/audiences$')).length
  await shot('21o2-the-apps-own-confirmation')
  await page.click('.confirm-box[role="dialog"] button.danger')
  await until('the project\'s grant to be revoked', async () => (await posted('/audiences$')).length === 7)
  await until('the chats that came through it to leave', async () => !row(await snap(), 'desk') && !row(await snap(), 'runner'))
  const gone = await snap()
  v.via.afterSecond = { confirms: gone.confirms, asked: await page.eval(() => window.__dm.asked.slice()), rows: gone.rows.map(r => r.peer), open: gone.head?.peer ?? null }
  await shot('21p-the-projects-audience-is-revoked')

  // ---- 10f. A ROW'S MENU, AND THE SYSTEM'S CHIP (USER 2026-11-23 mf47548121ae5)
  const menuOf = async (peer) => {
    await page.rightClick(`.dm-row[data-dm-chat="${peer}"] .dm-row-prev`)
    await page.waitFor('.ctxmenu')
    const labels = await page.eval(() => { const menus = [...document.querySelectorAll('.ctxmenu')].filter(m => !m.parentElement?.closest('.ctxmenu'))
      const menu = menus[menus.length - 1]
      return [...menu.children].filter(c => !c.matches('[role="separator"]')).map(c => ((c.querySelector('[role="menuitem"]') ?? c).textContent || '').trim()) })
    return labels
  }
  v.menu = { agent: await menuOf('lead') }
  await shot('21q-a-chat-rows-menu-agent')
  await page.press('Escape')
  await page.waitFor('.ctxmenu', { gone: true })
  v.menu.project = await menuOf('crew')
  await shot('21r-a-chat-rows-menu-project')
  await page.press('Escape')
  await page.waitFor('.ctxmenu', { gone: true })
  v.menu.system = await menuOf('@system')
  await page.press('Escape')
  await page.waitFor('.ctxmenu', { gone: true })
  v.menu.systemChip = row(await snap(), '@system')?.chip ?? null

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
  v.end = { confirms: end.confirms, toasts: end.toasts, rows: end.rows.map(r => r.peer), hasFocus: end.hasFocus,
    opened: await page.eval(() => window.__dm.opened.slice()) }
  v.calls = (await calls()).map(c => ({ method: c.method, path: c.path, body: c.body }))
  return v
}
