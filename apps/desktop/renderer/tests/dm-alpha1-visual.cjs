// The page script of dm-alpha1-visual.mjs: walks the user's chats through the
// points of the 4.7.0-alpha.1 feedback in the rig's guarded offscreen window
// and returns what it measured. Clicks, keys and text are CDP input to this
// window only; the "engine" is the driver's fake one.
'use strict'

module.exports = async (page) => {
  const v = { shots: [] }
  const shot = async (name) => { await page.screenshot(name); v.shots.push(name) }
  const asked = () => page.api('GET', '/__calls')
  const until = async (what, fn, timeout = 15000) => {
    const end = Date.now() + timeout
    for (;;) {
      const got = await fn()
      if (got) return got
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await page.sleep(120)
    }
  }
  const headPeer = () => page.eval(() => document.querySelector('.dm-head')?.getAttribute('data-dm-peer') ?? null)
  const openChat = async (peer) => {
    await page.click(`.dm-row[data-dm-chat="${peer}"]`)
    await until(`the chat of ${peer}`, async () => (await headPeer()) === peer)
    await page.sleep(250)
  }
  const timeline = () => page.eval(() => {
    const el = document.querySelector('.dm-timeline')
    return { top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight, drawn: Number(el.dataset.dmDrawn), loaded: Number(el.dataset.dmLoaded),
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 4 }
  })

  await page.resize('1440x1000')
  await page.waitFor('.dm-row')
  await page.sleep(400)
  /** the panel, its two panes and its title row, wherever the panel is shown */
  const frame = () => page.eval(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const panel = document.querySelector('.settings.dm-panel'), mailer = document.querySelector('.mailer.dm'), cs = getComputedStyle(panel)
    return { window: { w: window.innerWidth, h: window.innerHeight }, panel: box(panel), mailer: box(mailer), border: parseFloat(cs.borderLeftWidth),
      mailerBorder: getComputedStyle(mailer).borderTopWidth, panelPadding: cs.padding, bar: box(panel.querySelector(':scope > .modalpin-bar')),
      title: (() => { const h = panel.querySelector(':scope > h3'); return h && getComputedStyle(h).display !== 'none' ? box(h) : null })(),
      classes: panel.className, controls: [...panel.querySelectorAll(':scope > .modalpin-bar button, :scope > .modalpin-bar input')].map(b => b.getAttribute('aria-label') || b.getAttribute('title') || b.type) }
  })
  v.modal = await frame()

  // ------------------------------------------------------------ 1. the list
  v.list = await page.eval(() => ({ rows: [...document.querySelectorAll('.dm-row')].map(r => r.dataset.dmChat),
    text: document.querySelector('.dm-list').textContent }))
  await shot('01-the-list-has-only-agents-that-can-be-written-to')

  // --------------------------------- 9, 14. a long chat: the window and lazy pages
  await openChat('worker')
  v.older = { atOpen: { ...(await timeline()), pages: (await asked()).pages.slice() }, steps: [],
    button: await page.eval(() => !!document.querySelector('.dm-timeline button.dm-older') || /Load older/.test(document.querySelector('.dm-timeline').textContent)) }
  await shot('06a-a-long-chat-opens-on-its-newest-fifty')
  for (let step = 0; step < 14; step++) {
    const before = await timeline()
    // the reader scrolls up to 300px from the top: note the message cut by the top edge there
    const mark = await page.eval(() => {
      const el = document.querySelector('.dm-timeline')
      el.scrollTop = 300
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll('[data-dm-entry]')].find(r => r.getBoundingClientRect().bottom > top)
      return { id: row.dataset.dmEntry, off: row.getBoundingClientRect().top - top }
    })
    await until('older messages to come in', async () => { const t = await timeline(); return t.drawn > before.drawn || t.loaded > before.loaded }, 8000).catch(() => null)
    await page.sleep(450)
    const after = await timeline()
    const drift = await page.eval((m) => {
      const el = document.querySelector('.dm-timeline'), row = [...el.querySelectorAll('[data-dm-entry]')].find(r => r.dataset.dmEntry === m.id)
      return row ? Math.round((row.getBoundingClientRect().top - el.getBoundingClientRect().top - m.off) * 10) / 10 : null
    }, mark)
    v.older.steps.push({ drawn: after.drawn, loaded: after.loaded, pages: new Set((await asked()).pages.map(p => p.split(':')[1])).size, drift, mark: mark.id, top: after.top })
    if (step === 1) await shot('06b-scrolled-back-older-messages-came-in-place')
    if (after.drawn === before.drawn && after.loaded === before.loaded) break
  }
  await shot('06c-after-several-pages')
  v.older.most = Math.max(...v.older.steps.map(s => s.drawn))
  await page.eval(() => { const el = document.querySelector('.dm-timeline'); el.scrollTop = el.scrollHeight })
  await page.sleep(600)
  v.older.trimmed = await timeline()
  await shot('06d-back-at-the-newest-message')

  await openChat('quoter')
  await shot('01b-the-modal-the-chats-fill-it-under-its-title-row')

  // ----------------------------------- 2. the message box, beside the desk's own
  await page.eval(() => window.__dm.deskBox(true))
  await page.waitFor('.alpha1-desk .cc-composer .cc-send')
  await page.sleep(500)
  v.box = await page.eval(() => {
    const px = (n) => Math.round(n * 10) / 10
    const measure = (box) => {
      const outer = box.getBoundingClientRect()
      const part = (el, own) => {
        if (!el) return null
        const cs = getComputedStyle(el), r = el.getBoundingClientRect()
        const style = { fontSize: cs.fontSize, lineHeight: cs.lineHeight, padding: cs.padding, radius: cs.borderRadius, borderWidth: cs.borderTopWidth,
          borderStyle: cs.borderTopStyle, display: cs.display, alignItems: cs.alignItems, gap: cs.gap, flexDirection: cs.flexDirection, alignSelf: cs.alignSelf }
        return { style, box: { w: px(r.width), h: px(r.height) },
          at: own ? {} : el.tagName === 'TEXTAREA' ? { fromLeft: px(r.left - outer.left), fromTop: px(r.top - outer.top) }
            : { fromRight: px(outer.right - r.right), fromBottom: px(outer.bottom - r.bottom) } }
      }
      const parts = { box: part(box, true), stack: part(box.querySelector('.cc-btnstack')), bell: part(box.querySelector('.cc-notice-toggle')),
        attach: part(box.querySelector('.cc-attach')), textarea: part(box.querySelector('textarea')), controls: part(box.querySelector('.cc-controls')),
        fastRow: part(box.querySelector('.cc-fast-row')), fast: part(box.querySelector('.cc-fast')), primaryRow: part(box.querySelector('.cc-primary-row')),
        effort: part(box.querySelector('.cc-eff')), send: part(box.querySelector('.cc-send')) }
      // the bell and the paperclip hang on the left edge
      for (const k of ['stack', 'bell', 'attach']) { const el = box.querySelector(k === 'stack' ? '.cc-btnstack' : k === 'bell' ? '.cc-notice-toggle' : '.cc-attach'), r = el.getBoundingClientRect()
        parts[k].at = { fromLeft: px(r.left - outer.left), fromBottom: px(outer.bottom - r.bottom) } }
      return { order: [...box.querySelectorAll('button, textarea')].map(e => e.tagName === 'TEXTAREA' ? 'text' : e.classList[0]), parts, w: px(outer.width), h: px(outer.height) }
    }
    return { chat: measure(document.querySelector('.dm-compose .cc-composer')), desk: measure(document.querySelector('.alpha1-desk .cc-composer')) }
  })
  await shot('02-the-message-box-beside-the-desks-own')
  await page.eval(() => window.__dm.deskBox(false))
  await page.sleep(200)

  // ------------------------------------------------------------ 3. drafts
  await page.click('.dm-compose textarea')
  await page.type('half a thought for quoter')
  await shot('03a-a-draft-in-one-chat')
  await openChat('sparse')
  v.draft = { other: await page.eval(() => document.querySelector('.dm-compose textarea').value) }
  await openChat('quoter')
  v.draft.back = await page.eval(() => document.querySelector('.dm-compose textarea').value)
  await shot('03b-the-draft-is-there-on-return')

  // ---------------------------------------------- 6, 7. quotes find their original
  v.quotes = {}
  for (const [bubble, original] of [['u1', 'q1'], ['q2', 'u1'], ['u3', 'q2']]) {
    const sel = `[data-dm-entry="${bubble}"] .reply-preview`
    const q = await page.eval((s) => { const e = document.querySelector(s); return e ? { role: e.getAttribute('role'), text: (e.textContent || '').replace(/\s+/g, ' ').trim() } : null }, sel)
    if (q) {
      await page.click({ selector: `${sel} blockquote`, scroll: true })
      await until(`the original of ${bubble}`, async () => page.eval((id) => document.querySelector(`[data-dm-entry="${id}"]`)?.classList.contains('flash') === true, original))
      await page.sleep(350)
      q.flashed = await page.eval(() => [...document.querySelectorAll('.dm-msg.flash')].map(m => m.dataset.dmEntry))
      q.inView = await page.eval((id) => { const s = document.querySelector('.dm-timeline').getBoundingClientRect(), r = document.querySelector(`[data-dm-entry="${id}"] .dm-bubble`).getBoundingClientRect()
        return r.bottom > s.top && r.top < s.bottom }, original)
      if (bubble === 'q2') await shot('04-a-quote-shows-its-original-in-the-chat')
    }
    v.quotes[bubble] = q
  }
  v.quotes.contextFolds = await page.eval(() => document.querySelectorAll('.dm-timeline details.event-context').length)
  v.quotes.opened = await page.eval(() => window.__dm.opened.slice())

  // ------------------------------------------------------- 8. the bubble's padding
  await page.eval(() => { const el = document.querySelector('.dm-timeline'); el.scrollTop = el.scrollHeight })
  await page.sleep(300)
  v.padding = await page.eval(() => {
    const px = (n) => Math.round(n * 10) / 10
    const out = {}
    for (const id of ['q1', 'u1', 'q2', 'u2', 'u3', 'u4', 'u5']) {
      const b = document.querySelector(`[data-dm-entry="${id}"] .dm-bubble`)
      const cs = getComputedStyle(b), r = b.getBoundingClientRect(), border = parseFloat(cs.borderTopWidth)
      // the first line of the message's own text, as it is drawn
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim()
        && !n.parentElement.closest('.dm-sr, .reply-preview, .dm-meta, .attach-row, .dm-labels, .dm-via') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
      const node = walker.nextNode(), range = document.createRange()
      range.selectNodeContents(node)
      const line = range.getClientRects()[0], quote = b.querySelector(':scope > .reply-preview')?.getBoundingClientRect() ?? null
      const meta = b.querySelector('.dm-meta').getBoundingClientRect()
      out[id] = { typed: !!b.querySelector('.event-body'), textTop: px(line.top - r.top - border), textLeft: px(line.left - r.left - border),
        quoteTop: quote ? px(quote.top - r.top - border) : null, quoteLeft: quote ? px(quote.left - r.left - border) : null,
        quoteRight: quote ? px(r.right - border - quote.right) : null,
        // from the time down to the bubble's bottom edge
        timeBottom: px(r.bottom - border - meta.bottom),
        padTop: parseFloat(cs.paddingTop), padLeft: parseFloat(cs.paddingLeft), padBottom: parseFloat(cs.paddingBottom) }
    }
    return out
  })
  await shot('05-bubble-padding-with-and-without-a-quote-and-files')

  // ---------------------------------- 17. the one check mark; 5. typing
  Object.assign(v, await page.eval(() => {
    const px = n => Math.round(n * 10) / 10
    const rows = [...document.querySelectorAll('.dm-msg[data-dm-entry]')]
    const out = rows.filter(r => r.classList.contains('out'))
    const tickBox = {}
    for (const r of out) {
      const tick = r.querySelector('.dm-meta .dm-tick'); if (!tick) continue
      tickBox[r.dataset.dmEntry] = { afterTime: tick.previousElementSibling?.tagName === 'TIME', metaHeight: px(r.querySelector('.dm-meta').getBoundingClientRect().height) }
    }
    return { receipts: Object.fromEntries(out.map(r => [r.dataset.dmEntry, r.querySelector('.dm-meta .dm-tick')?.className ?? null])),
      receiptsIn: document.querySelectorAll('.dm-msg.in .dm-tick').length, tickBox,
      metaPlain: px(document.querySelector('.dm-msg.in .dm-meta').getBoundingClientRect().height) }
  }))
  v.typing = { before: await page.eval(() => document.querySelectorAll('.dm-typing-row, .dm-row-typing').length) }
  await page.eval(() => window.__dm.typing('quoter'))
  await until('the typing row to show', async () => page.eval(() => !!document.querySelector('.dm-timeline .dm-typing-row')))
  await page.sleep(350)
  Object.assign(v.typing, await page.eval(() => {
    const row = document.querySelector('.dm-timeline .dm-typing-row'), view = document.querySelector('.dm-timeline').getBoundingClientRect(), r = row.getBoundingClientRect()
    return { rows: [...document.querySelectorAll('.dm-row-typing')].map(el => el.closest('.dm-row').dataset.dmChat),
      dots: row.querySelectorAll('.dm-typing-dots i').length, text: row.textContent,
      underLast: !!row.previousElementSibling?.matches('.dm-msg') && r.bottom <= view.bottom + 1 && r.top >= view.top }
  }))
  await shot('05b-typing-dots-and-the-check-marks')
  await page.eval(() => window.__dm.typing(null))
  await page.sleep(250)
  v.typing.after = await page.eval(() => document.querySelectorAll('.dm-typing-row, .dm-row-typing').length)

  // ---------------------------------- 19. a whole card inside a bubble, in both bubble colours
  await page.eval(() => { const el = document.querySelector('.dm-timeline'); el.scrollTop = el.scrollHeight })
  await page.sleep(250)
  v.cards = await page.eval(() => {
    const px = n => Math.round(n * 10) / 10, out = {}
    for (const id of ['ans0', 'ans1']) {
      const bubble = document.querySelector(`[data-dm-entry="${id}"] .dm-bubble`)
      if (!bubble) { out[id] = null; continue }
      const r = bubble.getBoundingClientRect(), border = parseFloat(getComputedStyle(bubble).borderTopWidth)
      // the outermost thing the bubble holds that draws its own box: the card
      const card = bubble.querySelector('.event-card, .answered-card, .event-body > *, .mailer-body > *')
      const k = card?.getBoundingClientRect(), meta = bubble.querySelector('.dm-meta').getBoundingClientRect()
      out[id] = { typed: bubble.classList.contains('typed'), card: card ? card.className : null,
        top: k ? px(k.top - r.top - border) : null, left: k ? px(k.left - r.left - border) : null,
        right: k ? px(r.right - border - k.right) : null, toTime: k ? px(meta.top - k.bottom) : null }
    }
    return out
  })
  await shot('05c-a-whole-card-in-each-bubble-colour')

  // ---------------------------------- 9. a chat that does not fill its view when it opens
  await openChat('sparse')
  await page.sleep(1500)
  const fill = await timeline()
  v.fill = { drawn: fill.drawn, overflows: fill.height > fill.client + 1, historyEnded: new Set((await asked()).pages.map(p => p.split(':')[1])).size >= 4, atBottom: fill.atBottom }
  await shot('07-a-short-chat-loaded-older-mail-by-itself')

  // ------------------------------------------------ 11. no "sent to" line
  await openChat('worker')
  await page.click('.dm-compose textarea')
  await page.type('Thanks, that is all for today.')
  await page.click('.dm-compose .mail-reply-send')
  await until('the message to be sent', async () => (await asked()).calls.some(c => /\/nodes\/worker\/message$/.test(c.path)))
  await until('the message to show', async () => page.eval(() => !!document.querySelector('[data-dm-entry="sent-1"]')))
  await page.sleep(300)
  v.sentLine = { state: await page.eval(() => document.querySelector('.dm-compose .mail-reply-state')?.textContent ?? null), bubble: true }
  await shot('08-sent-and-nothing-under-the-box')

  // ------------------------------------------ 15. the bubble's menu
  const menuId = await page.eval(() => { const rows = [...document.querySelectorAll('.dm-msg.in[data-dm-entry]')]; return rows[rows.length - 1].dataset.dmEntry })
  await page.eval((id) => { const b = document.querySelector(`[data-dm-entry="${id}"] .dm-bubble`), r = b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10, button: 2 })) }, menuId)
  await page.sleep(300)
  v.menu = { id: menuId, items: await page.eval(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(i => (i.textContent || '').trim())) }
  await shot('09-a-bubbles-menu-view-in-the-agents-inbox')
  await page.eval(() => { [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(i => /View in @/.test(i.textContent || ''))?.click() })
  await page.sleep(200)
  v.menu.opened = await page.eval(() => window.__dm.opened.slice())

  // ------------------------------------------------ 12, 13. New chat sweeps out
  const sweep = () => page.eval(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const rowsOf = (root) => Object.fromEntries([...root.querySelectorAll('.tray-row')].map(r => {
      const name = r.querySelector('.tray-name'), cs = getComputedStyle(r), ns = getComputedStyle(name)
      return [name.textContent.trim(), { style: { rowFont: cs.fontSize, padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom}`, nameFont: ns.fontSize, nameFamily: ns.fontFamily.split(',')[0], nameWeight: ns.fontWeight, gap: cs.gap },
        indent: Math.round(parseFloat(cs.paddingLeft)), h: Math.round(r.getBoundingClientRect().height), nameCut: name.scrollWidth > name.clientWidth + 1 }]
    }))
    const el = document.querySelector('.dm-list > .dm-newchat'), tray = el?.querySelector('.tray'), ref = document.querySelector('.alpha1-list .tray-panel')
    return el ? { box: box(el), column: box(document.querySelector('.dm-list')), panel: box(document.querySelector('.settings.dm-panel')),
      headPeer: document.querySelector('.dm-head')?.getAttribute('data-dm-peer') ?? null, overlays: document.querySelectorAll('.overlay').length,
      windowBar: !!el.querySelector('.modalpin-bar'), scrolls: tray ? getComputedStyle(tray).overflowY === 'auto' && tray.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1 : false,
      rows: rowsOf(el), reference: ref ? rowsOf(ref) : {}, closed: window.__dm.closed } : null
  })
  const gone = async () => { await page.waitFor('.dm-newchat', { gone: true }); return { gone: true, closed: await page.eval(() => window.__dm.closed), headPeer: await headPeer() } }
  await page.click('.dm-list-head .dm-new')
  await page.waitFor('.dm-newchat .tray-row')
  await page.eval(() => window.__dm.canvasList(true))
  await page.waitFor('.alpha1-list .tray-row')
  await page.sleep(450)
  v.sweep = await sweep()
  await shot('10-new-chat-sweeps-over-the-chat-list-beside-the-canvas-list')
  await page.eval(() => window.__dm.canvasList(false))
  await page.press('Escape')
  v.sweep.afterEscape = await gone()
  await page.click('.dm-list-head .dm-new')
  await page.waitFor('.dm-newchat .tray-row')
  await page.sleep(300)
  await page.click('.dm-newchat .dm-newchat-close')
  v.sweep.afterClose = await gone()
  await page.click('.dm-list-head .dm-new')
  await page.waitFor('.dm-newchat .tray-row')
  await page.sleep(300)
  await page.click('.dm-newchat .tray-row[data-dm-pick="build-sol"] .tray-main')
  await until('the picked chat', async () => (await headPeer()) === 'build-sol')
  v.sweep.afterPick = await gone()
  await shot('11-picking-an-agent-opens-its-chat')

  // ---------------- 10. pinned: the app's own pin, where this page can hold one
  await openChat('quoter')
  await page.click('.settings.dm-panel > .modalpin-bar button[aria-label="pin this to the window"]')
  v.pinned = { real: await until('the pinned window', async () => page.eval(() => !!document.querySelector('.settings.dm-panel.modalpin-win')), 2500).catch(() => false) }
  if (v.pinned.real) {
    await page.sleep(400)
    Object.assign(v.pinned, await frame())
    await shot('12a-pinned-the-chats-fill-the-window')
    await page.click('.settings.dm-panel > .modalpin-bar button[aria-label="unpin this window"]')
    await until('the modal again', async () => page.eval(() => !document.querySelector('.settings.dm-panel.modalpin-win')))
    await page.sleep(300)
  }

  // ---------------- 10. the popped-out layout: the frame's own classes (see the driver's header)
  await page.eval(() => {
    const overlay = document.querySelector('.overlay'), panel = overlay.querySelector('.settings.dm-panel')
    let mount = overlay.parentElement
    while (mount.parentElement && mount.parentElement !== document.body) mount = mount.parentElement
    mount.classList.add('popout-mount'); overlay.classList.add('overlay-detached'); panel.classList.add('modalpin-detached')
    panel.querySelector(':scope > .modalpin-bar')?.classList.add('detached')
  })
  await page.sleep(500)
  v.popout = await frame()
  await shot('12b-popped-out-layout-the-chats-fill-the-window')
  await page.click('.dm-list-head .dm-new')
  await page.waitFor('.dm-newchat .tray-row')
  await page.sleep(400)
  v.popout.sweep = await sweep()
  await shot('13-popped-out-layout-new-chat-is-the-same-sweep')
  await page.click('.dm-newchat .dm-newchat-close')
  await gone()

  v.end = await page.eval(() => ({ confirms: window.__dm.confirms, closed: window.__dm.closed, toasts: window.__dm.toasts.slice() }))
  v.pages = (await asked()).pages
  return v
}
