// three scenes (projectnode-visual.tsx); PROJECTNODE_VISUAL_NAME prefixes the
// file names so a before and an after run keep apart
module.exports = async (page) => {
  const prefix = process.env.PROJECTNODE_VISUAL_NAME || 'projectnode'
  const settle = () => page.eval(async () => {
    // two frames and a beat before every capture (team notes, round 439)
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250))))
  })
  await page.resize('1000x700')
  const screenshots = []
  const details = {}
  // PROJECTNODE_VISUAL_ONLY=slots: only the project-slots scenes (one quick capture)
  const only = process.env.PROJECTNODE_VISUAL_ONLY
  if (only === 'multi-slots') {
    await page.goto('/?scene=multi-slots')
    await page.waitFor('.project-slots-card', { timeout: 15000 })
    await page.eval(() => document.querySelector('.project-slots-card').click())
    await page.waitFor('.slot-quantity', { timeout: 15000 })
    await settle()
    details.slots = await page.eval(() => ({
      header: document.querySelector('.project-slots-card').textContent,
      headers: [...document.querySelectorAll('.slots-table thead th')].map(e => e.textContent),
      quantities: [...document.querySelectorAll('.slot-quantity')].map(e => e.textContent),
      width: document.querySelector('.slots-table').getBoundingClientRect().width,
    }))
    if (!details.slots.header.includes('2/3') || details.slots.quantities.slice(0, 3).join() !== '2,3,1') throw new Error('Wrong multi-slot projection')
    screenshots.push(await page.screenshot(`${prefix}-multi-slots-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=queue-badge: the REAL canvas, project site with an armed fair_queue listener: its node's
  // queue badge opens the project MAILBOX at the listeners folder (as the desk's queue card does), not the events
  // window (docket project-node-s-mail-listeners-badge-opens-the-pr)
  if (only === 'queue-badge') {
    await page.goto('/?scene=fairqueue')
    await page.waitFor('.sq.project', { timeout: 15000 })
    await page.eval(async () => {
      await new Promise((r) => setTimeout(r, 800))
      const fit = document.querySelector('.zoomhud button[title="Fit the whole org"]')
      if (fit) fit.click()
      await new Promise((r) => setTimeout(r, 1500))
    })
    await page.waitFor('.sq.project .project-queue-badge', { timeout: 15000 })
    await settle()
    details.node = await page.eval(() => {
      const b = document.querySelector('.sq.project .project-queue-badge')
      return { text: b.textContent, label: b.getAttribute('aria-label'), title: b.getAttribute('title') }
    })
    screenshots.push(await page.screenshot(`${prefix}-queue-badge-node-1000x700`))
    await page.eval(() => document.querySelector('.sq.project .project-queue-badge').click())
    await page.waitFor('.mail-folders', { timeout: 15000 })
    await settle()
    details.opened = await page.eval(() => ({
      folders: [...document.querySelectorAll('.mail-folders > button')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? ' *' : '')),
      heading: (document.querySelector('.mail-folders').closest('.panel, .modal, .pinwin, div')?.querySelector('h3')?.textContent ?? '').trim(),
      eventsWindow: [...document.querySelectorAll('h3')].some((h) => /· events/.test(h.textContent)),
    }))
    if (!details.opened.folders.some((f) => /^listeners.* \*$/.test(f))) throw new Error('the queue badge did not open the listeners folder: ' + JSON.stringify(details.opened))
    if (details.opened.eventsWindow) throw new Error('the events window opened')
    screenshots.push(await page.screenshot(`${prefix}-queue-badge-mailbox-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=popouts: the pinned agent sb's and project build's
  // desks popped out side by side (user 2026-10-18 11:47Z). A real pop-out is
  // its own OS window, which no screenshot of this one shows, so window.open
  // hands back two same-origin iframes laid side by side instead; the stubbed
  // native bridge lets the window controls render as in the app.
  if (only === 'popouts') {
    await page.goto('/?scene=hosts')
    await page.waitFor('.pinwin', { timeout: 15000 })
    await page.eval(async () => { await new Promise((r) => setTimeout(r, 1500)) })
    details.opened = await page.eval(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      window.orgtreeDesktop = { minimizePopout: async () => {}, toggleMaximizePopout: async () => {}, closePopout: async () => {},
        getPopoutState: async () => null, onEvent: () => () => {} }
      const frames = []
      window.open = () => {
        const f = document.createElement('iframe')
        f.style.cssText = `position:fixed;top:10px;left:${10 + frames.length * 495}px;width:485px;height:400px;border:1px solid #555;z-index:99999;background:#1e1e1e`
        document.body.appendChild(f)
        frames.push(f)
        return f.contentWindow
      }
      const out = []
      const click = async (sel) => {
        const b = document.querySelector(sel)
        out.push(sel + ': ' + (b ? 'clicked' : 'missing'))
        if (b) b.click()
        await wait(1500)
      }
      await click('.pinwin.prov-claude .cc-head-right .popout-button')
      await click('.pinwin.pin-project .cc-head-right .popout-button')
      // that opens the project desk and asks it to pop out; if it is still
      // centred here, its own pop-out button beside the tabs does the rest
      if (frames.length < 2) await click('.project-desk-modal .cc-head-right .popout-button')
      return out
    })
    await settle()
    details.popouts = await page.eval(() => [...document.querySelectorAll('iframe')].map((f) => {
      const d = f.contentDocument
      const top = d && d.querySelector('.cc-head-top')
      return {
        mounted: !!(d && d.querySelector('.popout-mount')),
        titleStrip: !!(d && d.querySelector('.modalpin-bar')),
        rows: top ? 1 : 0,
        name: top && [...top.querySelectorAll('.cc-head-left > .name, .cc-head-left > .cc-name')].map((n) => [n.textContent, getComputedStyle(n).display]),
        lastChild: top && top.lastElementChild && top.lastElementChild.className,
        controls: top && !!top.querySelector('.popout-window-controls'),
        headTop: top && Math.round(top.getBoundingClientRect().top),
      }
    }))
    screenshots.push(await page.screenshot(`${prefix}-popouts-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=hosts: the four desk hosts (user 2026-10-18
  // 11:14Z) — pinned agent and project, temporary agent and project — then
  // one page setting the shots side by side
  if (only === 'hosts') {
    const fs = require('fs')
    const openTemp = (sel) => page.eval(async (sel) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const card = document.querySelector(sel)
      if (!card) return 'no card ' + sel
      const r = card.getBoundingClientRect()
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }))
      await wait(300)
      const item = (label) => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].find((b) => b.textContent.trim().startsWith(label))
      const open = item('Open')
      if (!open) return 'no Open: ' + [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map((b) => b.textContent).join('|')
      open.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); open.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
      open.click()
      await wait(300)
      const deskItem = item('Desk')
      if (!deskItem) return 'no Desk: ' + [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map((b) => b.textContent).join('|')
      deskItem.click()
      await wait(900)
      return 'ok'
    }, sel)
    const headOf = () => page.eval(() => [...document.querySelectorAll('.tempdesk-panel, .pinwin')].map((p) => ({
      cls: p.className,
      bar: (p.querySelector('.tempdesk-head, .pinwin-title, .modalpin-bar') || {}).textContent,
      barTop: (p.querySelector('.tempdesk-head, .pinwin-title, .modalpin-bar') || { getBoundingClientRect: () => ({}) }).getBoundingClientRect().top,
      deskNameShown: [...p.querySelectorAll('.cc-head-left > .name, .cc-head-left > .cc-name')].some((n) => getComputedStyle(n).display !== 'none'),
      headTop: (p.querySelector('.cc-head') || { getBoundingClientRect: () => ({}) }).getBoundingClientRect().top,
      head: (p.querySelector('.cc-head-top') || {}).textContent,
    })))
    await page.goto('/?scene=hosts')
    await page.waitFor('.pinwin', { timeout: 15000 })
    await page.eval(async () => { await new Promise((r) => setTimeout(r, 1500)) })
    await settle()
    details.pinned = await headOf()
    const shots = []
    shots.push(await page.screenshot(`${prefix}-pinned-1000x700`))
    details.tempAgent = await openTemp('.sq[data-first-use-agent="sa"]')
    await settle()
    details.tempAgentHead = await headOf()
    shots.push(await page.screenshot(`${prefix}-temp-agent-1000x700`))
    await page.eval(async () => { document.querySelector('.tempdesk-close')?.click(); await new Promise((r) => setTimeout(r, 400)) })
    details.tempProject = await openTemp('.sq.project')
    await settle()
    details.tempProjectHead = await headOf()
    shots.push(await page.screenshot(`${prefix}-temp-project-1000x700`))
    screenshots.push(...shots)
    const urls = shots.map((s) => 'data:image/png;base64,' + fs.readFileSync(typeof s === 'string' ? s : s.file).toString('base64'))
    await page.eval((urls) => {
      document.body.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;background:#111;padding:6px">'
        + urls.map((u, i) => `<figure style="margin:0"><figcaption style="color:#ddd;font:12px sans-serif">${['pinned: agent sb (left), project build (right)', 'temporary: agent sa', 'temporary: project build'][i]}</figcaption><img src="${u}" style="width:100%"></figure>`).join('') + '</div>'
    }, urls)
    await page.eval(async () => { await new Promise((r) => setTimeout(r, 500)) })
    screenshots.push(await page.screenshot(`${prefix}-side-by-side-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=cardfix: sa's slot chip in its card's chip row on
  // the real canvas, then the overflowing project cards and the desk headers
  if (only === 'cardfix') {
    await page.goto('/?scene=slotlines')
    await page.waitFor('.sq.project', { timeout: 15000 })
    await page.eval(async () => {
      await new Promise((r) => setTimeout(r, 800))
      const fit = document.querySelector('.zoomhud button[title="Fit the whole org"]')
      if (fit) fit.click()
      await new Promise((r) => setTimeout(r, 1500))
    })
    await settle()
    details.card = await page.eval(() => ({
      inBadges: [...document.querySelectorAll('.sq-badges .chip.slot-hold')].map((c) => c.textContent),
      onStatusRow: [...document.querySelectorAll('.sq-meta .chip.slot-hold')].map((c) => c.textContent),
    }))
    screenshots.push(await page.screenshot(`${prefix}-slotlines-1000x700`))
    await page.goto('/?scene=cardfix')
    await page.waitFor('.sq.project', { timeout: 15000 })
    await page.eval(async () => { await new Promise((r) => setTimeout(r, 600)) })
    await settle()
    details.cardfix = await page.eval(() => ({
      projects: [...document.querySelectorAll('.sq.project')].map((sq) => {
        const box = sq.getBoundingClientRect()
        const line = sq.querySelector('.project-last-activity')
        const r = line ? line.getBoundingClientRect() : null
        const kids = line ? [...line.children].map((c) => c.getBoundingClientRect().right) : []
        return { text: sq.querySelector('.project-meta')?.textContent, cardRight: box.right,
          lineRight: r && r.right, childrenRight: kids, inside: !!r && Math.max(r.right, ...kids) <= box.right - 1 }
      }),
      desks: [...document.querySelectorAll('.cc-head')].map((h) => ({
        chips: [...h.querySelectorAll('.chip.slot-hold, .chip.slot-wait')].map((c) => [c.textContent, c.previousElementSibling?.textContent]),
      })),
    }))
    screenshots.push(await page.screenshot(`${prefix}-cardfix-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=attn: a project selected in the Attention desk
  // panel draws the project desk, never the agent desk (user 2026-10-18 14:36Z)
  if (only === 'attn') {
    await page.goto('/?scene=attn')
    await page.waitFor('.attn-desk', { timeout: 15000 })
    await page.eval(async () => { await new Promise((r) => setTimeout(r, 600)) })
    await settle()
    details.attn = await page.eval(() => ({
      projectDesk: !!document.querySelector('.attn-desk .project-desk'),
      agentDeskSlot: !!document.querySelector('.attn-desk [data-desk-slot]'),
      tabs: [...document.querySelectorAll('.attn-desk .cc-tabs button')].map((b) => b.textContent.trim()),
      header: document.querySelector('.attn-desk .cc-head')?.textContent ?? null,
    }))
    screenshots.push(await page.screenshot(`${prefix}-attn-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=deskjump: the project desk's jump cards on every
  // tab, the ↑ superior card on the up row under the header (21:05:53Z) and
  // the members' row above the message box, as on the agent desk (user
  // 2026-10-19 19:58Z); the deskinbox scene's full-size desk, every tab dark,
  // summary and inbox light
  if (only === 'deskjump') {
    const measure = () => page.eval(() => {
      const desk = document.querySelector('#desk-inbox .project-desk')
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }
      }
      const names = (el) => el ? [...el.querySelectorAll('.desk-nav-chip')].map((b) => b.getAttribute('data-copy-agent-name')) : []
      const navs = [...desk.querySelectorAll('.desk-nav')], up = desk.querySelector('.cc-head + .desk-nav')
      const members = navs.filter((n) => n !== up)[0] ?? null
      const row = box(members), composer = box(desk.querySelector('.project-composer'))
      const frame = box(document.querySelector('#desk-inbox'))
      return { tab: desk.querySelector('.cc-tabs button.on')?.getAttribute('data-tab') ?? null,
        up: names(up), headerJumps: desk.querySelectorAll('.cc-head .desk-nav-chip').length, rows: navs.length, down: names(members),
        row, composer, aboveComposer: !!row && !!composer && row.bottom <= composer.top + 1,
        insideFrame: !!row && row.top >= frame.top && row.bottom <= frame.bottom }
    })
    for (const theme of ['', '&theme=light']) {
      const name = theme ? 'light' : 'dark'
      await page.goto('/?scene=deskinbox' + theme)
      await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
      const tabs = await page.eval(() => [...document.querySelectorAll('#desk-inbox .cc-tabs button')].map((b) => b.getAttribute('data-tab')))
      details['deskjump-tabs-' + name] = tabs
      for (const tab of tabs) {
        if (theme && tab !== 'desk' && tab !== 'inbox') continue
        await page.eval(async (t) => {
          document.querySelector(`#desk-inbox .cc-tabs button[data-tab="${t}"]`).click()
          await new Promise((r) => setTimeout(r, 700))
        }, tab)
        await settle()
        details['deskjump-' + tab + '-' + name] = await measure()
        screenshots.push(await page.screenshot(`${prefix}-deskjump-${tab}-${name}-1000x700`))
      }
    }
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=instances: several windows of one kind (docket
  // several-instances-of-the-same-modal-team-slots-i, USER 2026-10-20
  // 17:24:20Z; readers 19:03:28Z). The scene loads today's single Team and
  // presentations records for lead (migrated: both come back pinned); the
  // capture opens dev1's and dev2's Team through their node menus (cascaded
  // 28 px from lead's), lead's team reader (beside its own reader) and a
  // document of dev1's (the team reader, which can show it, shows it). Each
  // shot records every window's box and what each reader shows. Dark and light.
  if (only === 'instances') {
    const windows = () => page.eval(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
      const teams = [...document.querySelectorAll('.team-panel')].map((p) => ({ who: p.getAttribute('aria-label'), box: box(p), pinned: p.classList.contains('modalpin-win') }))
      const readers = [...document.querySelectorAll('.gallery-agent')].map((s) => {
        const panel = s.closest('.settings')
        return { who: s.getAttribute('aria-label'), team: /and the agents under it/.test(s.querySelector('.desk-presented-head .dim')?.textContent ?? ''),
          shows: s.querySelector('.mailrow.on .mfrom')?.textContent ?? null, box: panel ? box(panel) : null,
          pinned: !!panel?.classList.contains('modalpin-win') }
      })
      const overlaps = []
      const all = [...teams, ...readers].filter((w) => w.box)
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const [a, b] = [all[i].box, all[j].box]
        if (a[0] === b[0] && a[1] === b[1]) overlaps.push([all[i].who, all[j].who])
      }
      return { teams, readers, samePlace: overlaps, pins: JSON.parse(localStorage.getItem('orgtree-modal-pins') ?? '{}') }
    })
    const act = (fn, ...args) => page.eval(async (f, a) => {
      const ok = window[f](...a)
      await new Promise((r) => setTimeout(r, 900))
      return ok
    }, fn, args)
    const out = {}
    for (const theme of ['', '&theme=light']) {
      const name = theme ? 'light' : 'dark'
      await page.goto('/?scene=instances' + theme)
      await page.waitFor('.team-panel', { timeout: 20000 })
      await page.sleep(1200)
      await settle()
      const run = { restored: await windows() }
      run.dev1 = await act('__miSelect', 'dev1', 'Team')
      run.dev2 = await act('__miSelect', 'dev2', 'Team')
      await settle()
      run.teams = await windows()
      screenshots.push(await page.screenshot(`${prefix}-instances-teams-${name}-1000x700`))
      run.teamReader = await act('__miSelect', 'lead', 'Team presentations')
      await settle()
      run.readers = await windows()
      screenshots.push(await page.screenshot(`${prefix}-instances-readers-${name}-1000x700`))
      await act('__miDoc', 'dv-1')
      await page.sleep(900)
      await settle()
      run.document = await windows()
      screenshots.push(await page.screenshot(`${prefix}-instances-document-${name}-1000x700`))
      out[name] = run
    }
    return { details: out, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=jumpscroll: a desk on the canvas whose jump rows
  // pass 8 rows of chips (docket desk-jump-cards-subordinate-and-superior-
  // scroll-b, user 2026-10-20 09:41Z-09:50Z): 91 reports and 9 watchdogs
  // (folded, then opened and scrolled by a real wheel to the "9 watchdogs"
  // chip), exactly 8 rows, 12 cards, and 16 and 60 project levels above
  // (the superior row folded and opened). `rows` measures each jump row;
  // `wheel` turns the real mouse wheel over one and records the row, every
  // scrolled ancestor and the canvas camera before and after.
  if (only === 'jumpscroll') {
    const DESK = '.sq.desk:not(.user) .desk-over'
    const open = async (q) => {
      await page.goto('/?scene=jumpscroll&' + q)
      await page.waitFor(DESK + ' .desk-nav', { timeout: 20000 })
      await page.sleep(1800)   // the focus glide lands
      await settle()
    }
    const rows = () => page.eval((sel) => [...document.querySelectorAll(sel + ' .desk-nav')].map((r) => {
      const box = r.getBoundingClientRect()
      // the canvas draws a desk scaled: rectangles are screen pixels, clientHeight layout pixels
      const k = r.offsetHeight ? box.height / r.offsetHeight : 1
      const tops = [...new Set([...r.children].map((c) => Math.round((c.getBoundingClientRect().top - box.top) / k + r.scrollTop)))].sort((a, b) => a - b)
      const s = getComputedStyle(r)
      return { scale: Math.round(k * 1000) / 1000, rows: tops.length, visible: tops.filter((t) => t < r.scrollTop + r.clientHeight - 1).length,
        clientHeight: r.clientHeight, scrollHeight: r.scrollHeight,
        pitch: tops.length > 1 ? tops[1] - tops[0] : null, overflowY: s.overflowY, maxHeight: s.maxHeight, overscroll: s.overscrollBehaviorY,
        background: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderLeftWidth, padding: s.padding,
        chips: r.querySelectorAll('.desk-nav-chip').length, fold: r.querySelector('[data-audience-fold]')?.textContent ?? null,
        first: r.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name') ?? null,
        last: ([...r.children].at(-1)?.textContent ?? '').trim().slice(0, 40) }
    }), DESK)
    const state = (i) => page.eval((sel, k) => {
      const r = document.querySelectorAll(sel + ' .desk-nav')[k]
      const scrolled = []
      for (let a = r.parentElement; a; a = a.parentElement) if (a.scrollTop || a.scrollLeft) scrolled.push(`${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]}:${a.scrollTop},${a.scrollLeft}`)
      return { row: Math.round(r.scrollTop), scrolled, camera: document.querySelector('.space')?.style.transform ?? null }
    }, DESK, i)
    const wheel = async (i, notches) => {
      const at = await page.eval((sel, k) => { const b = document.querySelectorAll(sel + ' .desk-nav')[k].getBoundingClientRect()
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + Math.min(b.height / 2, 60)) } }, DESK, i)
      const before = await state(i)
      for (let n = 0; n < notches; n++) {
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 120 })
        await page.sleep(120)
      }
      await page.sleep(500)
      const after = await state(i)
      return { notches, before, after, rowMoved: after.row !== before.row,
        onlyRowMoved: JSON.stringify(after.scrolled) === JSON.stringify(before.scrolled) && after.camera === before.camera }
    }
    const unfold = (i) => page.eval(async (sel, k) => {
      const f = document.querySelectorAll(sel + ' .desk-nav')[k].querySelector('[data-audience-fold]')
      if (f && f.getAttribute('aria-expanded') !== 'true') f.click()
      await new Promise((r) => setTimeout(r, 400))
      return !!f
    }, DESK, i)
    const out = {}
    // 91 reports and 9 watchdogs: folded, then opened, scrolled by the wheel, and at its end
    await open('down=91&up=3&dogs=9')
    out.many = { folded: await rows() }
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-91-folded-dark-1000x700`))
    out.many.unfolded = await unfold(1)
    await settle()
    out.many.open = await rows()
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-91-dark-1000x700`))
    out.many.wheel1 = await wheel(1, 1)
    out.many.wheelEnd = await wheel(1, 30)
    out.many.wheelPast = await wheel(1, 3)
    await settle()
    out.many.end = await rows()
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-91-end-dark-1000x700`))
    // how many cards fill exactly 8 rows at this width: the opened row without its cap (and so without a scrollbar)
    const eight = await page.eval((sel) => {
      const r = document.querySelectorAll(sel + ' .desk-nav')[1]
      r.style.maxHeight = 'none'; r.scrollTop = 0
      const box = r.getBoundingClientRect()
      const items = [...r.children]
      const tops = [...new Set(items.map((c) => Math.round(c.getBoundingClientRect().top - box.top)))].sort((a, b) => a - b)
      const n = tops.length > 8 ? items.filter((c) => Math.round(c.getBoundingClientRect().top - box.top) < tops[8]).filter((c) => c.querySelector('.desk-nav-chip')).length : null
      r.style.maxHeight = ''
      return { rowsUncapped: tops.length, cardsIn8: n }
    }, DESK)
    out.eight = { ...eight }
    if (eight.cardsIn8) {
      await open(`down=${eight.cardsIn8}&up=3`)
      await unfold(1)
      await settle()
      out.eight.open = await rows()
      screenshots.push(await page.screenshot(`${prefix}-jumpscroll-8rows-dark-1000x700`))
    }
    // twelve cards: under 8 rows, as before
    await open('down=12&up=3')
    out.few = await rows()
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-12-dark-1000x700`))
    // sixteen project levels above: the superior row folded (the superior stays), then opened
    await open('down=12&up=16')
    out.up16 = { folded: await rows() }
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-up16-folded-dark-1000x700`))
    out.up16.unfolded = await unfold(0)
    await settle()
    out.up16.open = await rows()
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-up16-open-dark-1000x700`))
    // sixty levels: the superior row opened past 8 rows scrolls too
    await open('down=12&up=60')
    await unfold(0)
    await settle()
    out.up60 = { open: await rows() }
    out.up60.wheel = await wheel(0, 2)
    screenshots.push(await page.screenshot(`${prefix}-jumpscroll-up60-open-dark-1000x700`))
    return { details: out, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=history: the desk's three tables with their
  // history (user 2026-10-20 06:22Z-06:42Z): the Mail tab's listeners in
  // ack mode (Working, Line, Dead Letter Line, Recently Finished) and in
  // round-robin (Line, Recently Delivered), the Listeners tab's Recently
  // Fired (an event's message folded, then opened), the Slots tab's
  // Watchdog column; dark and light. Then the user's narrow desks
  // (2026-10-20 08:59Z, 09:00Z) with long names, 890 and 740px wide; each
  // table's `fit` says whether it fits its pane, keeps its actions inside
  // it, keeps each chip inside its cell and each agent's name on one line,
  // keeps the whole text of every shortened cell in a tooltip, and wears
  // the shared header style.
  if (only === 'history') {
    const table = (sel) => page.eval((q) => {
      const t = document.querySelector(q)
      if (!t) return null
      const x = (el) => Math.round(el.getBoundingClientRect().left)
      const heads = [...t.querySelectorAll('thead th')]
      const rows = [...t.querySelectorAll('tbody tr.slot-row')]
      return {
        headers: heads.map((h) => h.textContent),
        cols: heads.map((h) => Math.round(h.getBoundingClientRect().width)),
        sections: [...t.querySelectorAll('tr.slot-section h4')].map((h) => h.textContent),
        rows: rows.map((r) => ({ cls: r.className, cells: [...r.children].map((c) => c.textContent),
          bg: getComputedStyle(r.children[1] ?? r.children[0]).backgroundColor,
          chip: r.querySelector('.watchdog-link')?.className ?? null,
          chipBorder: r.querySelector('.watchdog-link') ? getComputedStyle(r.querySelector('.watchdog-link')).borderTopColor : null })),
        // cells sit under their headers (a spanning message cell starts under its first column)
        aligned: rows.every((r) => { let i = 0; return [...r.children].every((c) => { const ok = !heads[i] || Math.abs(x(c) - x(heads[i])) < 1; i += c.colSpan || 1; return ok }) }),
        width: Math.round(t.getBoundingClientRect().width),
      }
    }, sel)
    const fit = (sel) => page.eval((q) => {
      const t = document.querySelector(q)
      if (!t) return null
      const pane = t.closest('.slots-table-scroll')
      const box = pane.getBoundingClientRect()
      const r = (el) => el.getBoundingClientRect()
      // an element's own words: its text without a tier letter or a chip's glyphs
      const own = (el) => { const c = el.cloneNode(true); c.querySelectorAll('.tier, .project-mark, .wd-glyph, .wd-once').forEach((x) => x.remove())
        return c.textContent.replace(/\s+/g, ' ').trim() }
      // reachable: a tooltip on it, inside its cell, or under it holds the whole text, or it unfolds (aria-expanded)
      const reachable = (el, text) => {
        const cell = el.closest('td, th')
        for (let a = el; a && cell.contains(a); a = a.parentElement) if ((a.title || '').includes(text) || a.hasAttribute('aria-expanded')) return true
        return [...el.querySelectorAll('[title], [aria-expanded]')].some((d) => (d.title || '').includes(text) || d.hasAttribute('aria-expanded'))
      }
      const rows = [...t.querySelectorAll('thead tr, tbody tr.slot-row')]
      const cut = [], spill = []
      for (const row of rows) for (const cell of row.children) {
        if (cell.scrollWidth > cell.clientWidth + 1 && getComputedStyle(cell).overflowX === 'visible') spill.push(own(cell))
        for (const el of [cell, ...cell.querySelectorAll('*')]) {
          if (getComputedStyle(el).overflowX === 'visible' || el.scrollWidth <= el.clientWidth + 1) continue
          const text = own(el)
          if (text && !reachable(el, text)) cut.push(text)
        }
      }
      const style = (el, props) => el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])) : null
      return {
        pane: Math.round(pane.clientWidth),
        overflow: Math.round(t.getBoundingClientRect().width - pane.clientWidth),
        actionsOut: [...t.querySelectorAll('td.slot-action button')].filter((b) => r(b).left < box.left - 0.5 || r(b).right > box.left + pane.clientWidth + 0.5)
          .map((b) => b.textContent),
        chipsOut: [...t.querySelectorAll('.listener-dog-cell .watchdog-link')].filter((c) => { const cell = c.closest('td')
          return r(c).right > r(cell).right - parseFloat(getComputedStyle(cell).paddingRight) + 0.5 }).map((c) => own(c)),
        wrapped: [...t.querySelectorAll('.slot-agent [data-copy-agent-name]')].filter((a) => r(a).height > 24).map((a) => own(a)),
        cut, spill,
        header: { row: style(t.querySelector('thead th'), ['fontSize', 'fontWeight', 'color', 'lineHeight', 'borderBottomWidth', 'borderBottomStyle',
          'borderBottomColor', 'borderTopWidth', 'paddingTop', 'paddingBottom']),
        heading: style(t.querySelector('tr.slot-section h4'), ['fontSize', 'fontWeight', 'color', 'lineHeight', 'marginTop', 'marginBottom']) },
      }
    }, sel)
    const checks = {}
    const judge = (label, f) => {
      checks[label] = f && { ...f, ok: f.overflow <= 0 && !f.actionsOut.length && !f.chipsOut.length && !f.wrapped.length && !f.cut.length && !f.spill.length }
    }
    const openTab = (tab) => page.eval(async (t) => {
      document.querySelector(`#desk-inbox .cc-tabs button[data-tab="${t}"]`).click()
      await new Promise((r) => setTimeout(r, 700))
    }, tab)
    const openMailListeners = () => page.eval(async () => {
      document.querySelector('#desk-inbox .cc-tabs button[data-tab="inbox"]').click()
      await new Promise((r) => setTimeout(r, 500));
      [...document.querySelectorAll('#desk-inbox .mail-folders button')].find((b) => b.textContent.startsWith('listeners')).click()
      await new Promise((r) => setTimeout(r, 900))
    })
    for (const theme of ['', '&theme=light']) {
      const name = theme ? 'light' : 'dark'
      await page.goto('/?scene=deskinbox&mode=history' + theme)
      await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
      await openMailListeners()
      await settle()
      details['mail-ack-' + name] = await table('#desk-inbox .mail-listeners-table')
      judge('mail-ack-' + name, await fit('#desk-inbox .mail-listeners-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-mail-ack-${name}-1000x700`))
      // its last rows: the taken-back and dead-lettered endings
      await page.eval(async () => {
        // whichever ancestor scrolls in this host (a base build has no history rows)
        const last = document.querySelector('#desk-inbox .mail-listeners-table tbody:last-child tr:last-child')
        if (last) last.scrollIntoView({ block: 'end' })
        await new Promise((r) => setTimeout(r, 300))
      })
      await settle()
      screenshots.push(await page.screenshot(`${prefix}-history-mail-ack-end-${name}-1000x700`))
      await openTab('listeners')
      await settle()
      details['fired-' + name] = await table('#desk-inbox .listeners-table')
      judge('fired-' + name, await fit('#desk-inbox .listeners-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-fired-${name}-1000x700`))
      if (theme) continue
      await page.eval(async () => {
        document.querySelector('#desk-inbox .listeners-table tr.fired-row.event .fired-message-text').click()
        await new Promise((r) => setTimeout(r, 400))
      })
      await settle()
      details['fired-open-' + name] = await table('#desk-inbox .listeners-table')
      screenshots.push(await page.screenshot(`${prefix}-history-fired-open-${name}-1000x700`))
      await openTab('slots')
      await settle()
      details['slots-' + name] = await table('#desk-inbox .project-slots .slots-table')
      judge('slots-' + name, await fit('#desk-inbox .project-slots .slots-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-slots-${name}-1000x700`))
    }
    await page.goto('/?scene=deskinbox&mode=historyrr')
    await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
    await openMailListeners()
    await settle()
    details['mail-rr-dark'] = await table('#desk-inbox .mail-listeners-table')
    judge('mail-rr-dark', await fit('#desk-inbox .mail-listeners-table'))
    screenshots.push(await page.screenshot(`${prefix}-history-mail-rr-dark-1000x700`))
    // the user's narrow desks, with long names: about 890px (their pane:
    // the 09:00Z screenshot is scaled about 0.83) and 740px
    for (const w of [890, 740]) {
      await page.resize(`${w + 20}x700`)
      await page.goto(`/?scene=deskinbox&mode=history&w=${w}&long=1`)
      await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
      await openMailListeners()
      await settle()
      details[`mail-ack-${w}`] = await table('#desk-inbox .mail-listeners-table')
      judge(`mail-ack-${w}`, await fit('#desk-inbox .mail-listeners-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-mail-ack-long-dark-${w + 20}x700`))
      if (w !== 740) continue
      await page.eval(async () => {
        const last = document.querySelector('#desk-inbox .mail-listeners-table tbody:last-child tr:last-child')
        if (last) last.scrollIntoView({ block: 'end' })
        await new Promise((r) => setTimeout(r, 300))
      })
      await settle()
      screenshots.push(await page.screenshot(`${prefix}-history-mail-ack-long-end-dark-${w + 20}x700`))
      await openTab('listeners')
      await settle()
      judge(`fired-${w}`, await fit('#desk-inbox .listeners-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-fired-long-dark-${w + 20}x700`))
      await openTab('slots')
      await settle()
      judge(`slots-${w}`, await fit('#desk-inbox .project-slots .slots-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-slots-long-dark-${w + 20}x700`))
      await page.goto(`/?scene=deskinbox&mode=historyrr&w=${w}&long=1`)
      await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
      await openMailListeners()
      await settle()
      judge(`mail-rr-${w}`, await fit('#desk-inbox .mail-listeners-table'))
      screenshots.push(await page.screenshot(`${prefix}-history-mail-rr-long-dark-${w + 20}x700`))
    }
    // one header style: every table's header row and section heading alike, per theme
    const same = (theme) => ['row', 'heading'].every((part) => {
      const seen = Object.entries(checks).filter(([k, v]) => v && (theme === 'light' ? k.endsWith('-light') : !k.endsWith('-light')))
        .map(([, v]) => JSON.stringify(v.header[part]))
      return seen.length > 0 && seen.every((s) => s === seen[0])
    })
    details.checks = checks
    details.headersAlike = { dark: same('dark'), light: same('light') }
    details.allFit = Object.values(checks).every((v) => v && v.ok)
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=listenerstable: the desk's event Listeners tab
  // as one slots-style table (user 2026-10-19 21:08Z-21:11Z), dark and
  // light, beside the Slots tab and the inbox's listeners folder it should
  // look like; then a project nobody listens to: both listeners views are
  // still there, empty (21:19Z)
  if (only === 'listenerstable') {
    const table = (sel) => page.eval((q) => {
      const t = document.querySelector(q)
      if (!t) return null
      const x = (el) => Math.round(el.getBoundingClientRect().left)
      const heads = [...t.querySelectorAll('thead th')]
      const rows = [...t.querySelectorAll('tbody tr.slot-row')]
      return {
        headers: heads.map((h) => h.textContent),
        sections: [...t.querySelectorAll('tr.slot-section h4')].map((h) => h.textContent),
        empties: [...t.querySelectorAll('td.slot-empty')].map((c) => c.textContent.slice(0, 60)),
        rows: rows.map((r) => ({ cells: [...r.children].map((c) => c.textContent),
          chip: r.querySelector('.watchdog-link')?.className ?? null,
          chipTitle: r.querySelector('.watchdog-link')?.getAttribute('title') ?? null,
          chipTag: r.querySelector('.watchdog-link')?.tagName ?? null,
          border: getComputedStyle(r.children[0]).borderBottomColor,
          opacity: [...r.children].map((c) => getComputedStyle(c).opacity) })),
        // every row's cells start under their header: one aligned table
        aligned: rows.every((r) => [...r.children].every((c, i) => !heads[i] || Math.abs(x(c) - x(heads[i])) < 1)),
        headerStyle: heads[0] ? (({ color, fontSize, fontWeight, borderBottomColor }) => ({ color, fontSize, fontWeight, borderBottomColor }))(getComputedStyle(heads[0])) : null,
      }
    }, sel)
    const openTab = (tab) => page.eval(async (t) => {
      document.querySelector(`#desk-inbox .cc-tabs button[data-tab="${t}"]`).click()
      await new Promise((r) => setTimeout(r, 700))
    }, tab)
    for (const theme of ['', '&theme=light']) {
      const name = theme ? 'light' : 'dark'
      await page.goto('/?scene=deskinbox&mode=lt' + theme)
      await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
      await openTab('listeners')
      await settle()
      details['listeners-' + name] = await table('#desk-inbox .listeners-table')
      screenshots.push(await page.screenshot(`${prefix}-listenerstable-${name}-1000x700`))
      if (theme) continue
      await openTab('slots')
      await settle()
      details['slots-' + name] = await table('#desk-inbox .project-slots .slots-table')
      screenshots.push(await page.screenshot(`${prefix}-listenerstable-slots-${name}-1000x700`))
      await page.eval(async () => {
        document.querySelector('#desk-inbox .project-queue-card').click()
        await new Promise((r) => setTimeout(r, 900))
      })
      await settle()
      details['maillisteners-' + name] = await table('#desk-inbox .mail-listeners-table')
      screenshots.push(await page.screenshot(`${prefix}-listenerstable-maillisteners-${name}-1000x700`))
    }
    await page.goto('/?scene=deskinbox&mode=empty')
    await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
    details['empty-tabs'] = await page.eval(() => [...document.querySelectorAll('#desk-inbox .cc-tabs button')].map((b) => b.textContent))
    await openTab('listeners')
    await settle()
    details['empty-listeners'] = await table('#desk-inbox .listeners-table')
    screenshots.push(await page.screenshot(`${prefix}-listenerstable-empty-dark-1000x700`))
    await openTab('inbox')
    await page.eval(async () => {
      [...document.querySelectorAll('#desk-inbox .mail-folders button')].find((b) => b.textContent.startsWith('listeners')).click()
      await new Promise((r) => setTimeout(r, 700))
    })
    await settle()
    details['empty-maillisteners'] = await table('#desk-inbox .mail-listeners-table')
    details['empty-folders'] = await page.eval(() => [...document.querySelectorAll('#desk-inbox .mail-folders button')].map((b) => b.textContent))
    screenshots.push(await page.screenshot(`${prefix}-listenerstable-empty-maillisteners-dark-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=listensetting: a project's event-listeners setting
  // (user 2026-10-20 10:50Z): the canvas lines on and switched off (every dog
  // disabled: no line), the desk off (no Listeners tab, the disabled chips)
  // and on (the tab), and the gear's Event listeners switch off, then on
  if (only === 'listensetting') {
    const lines = () => page.eval(() => [...document.querySelectorAll('.listener-line, .listener-watch-line')]
      .map((l) => (l.getAttribute('class') || '').replace(/\s+/g, ' ').trim()))
    for (const off of ['', '&off=1']) {
      const name = off ? 'off' : 'on'
      await page.goto('/?scene=unwired' + off)
      await page.waitFor('.sq.project', { timeout: 15000 })
      await page.eval(async () => { await new Promise((r) => setTimeout(r, 800)) })
      await settle()
      details['lines-' + name] = await lines()
      details['satellites-' + name] = await page.eval(() => [...document.querySelectorAll('.wd-chip.listener')]
        .map((c) => ({ cls: c.className, title: c.getAttribute('title') })))
      screenshots.push(await page.screenshot(`${prefix}-listensetting-canvas-${name}-1000x700`))
    }
    // &inbox=0: no listener on the inbox either, so the message box's yellow
    // note (rust-engine 5c44f2c) shows beside this setting's desk
    for (const [mode, inbox] of [['lsoff', ''], ['lson', ''], ['lsoff', '&inbox=0'], ['lson', '&inbox=0']]) {
      const key = mode + (inbox ? '-noinbox' : '')
      await page.goto('/?scene=deskinbox&mode=' + mode + inbox)
      await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
      details['tabs-' + key] = await page.eval(() => [...document.querySelectorAll('#desk-inbox .cc-tabs button[data-tab]')].map((b) => b.getAttribute('data-tab')))
      details['cyan-' + key] = await page.eval(() => [...document.querySelectorAll('#desk-inbox .project-listeners-card')].map((c) => c.textContent))
      if (mode === 'lson') {
        await page.eval(async () => {
          document.querySelector('#desk-inbox .cc-tabs button[data-tab="listeners"]').click()
          await new Promise((r) => setTimeout(r, 700))
        })
      } else if (!inbox) {
        details.chips = await page.eval(() => [...document.querySelectorAll('#ls-chips .wd-chip, #ls-chips .watchdog-link')]
          .map((c) => ({ cls: c.className, title: c.getAttribute('title'), glyph: c.querySelector('.wd-glyph')?.textContent,
            opacity: getComputedStyle(c).opacity })))
      }
      await settle()
      // where the note, the members' row, the box, the tabs and the table sit,
      // and whether any two of them overlap
      details['layout-' + key] = await page.eval(() => {
        const box = (e) => {
          if (!e) return null
          const r = e.getBoundingClientRect()
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }
        }
        const desk = document.querySelector('#desk-inbox .project-desk')
        const navs = [...desk.querySelectorAll('.desk-nav')]
        const parts = {
          tabs: box(desk.querySelector('.cc-tabs')),
          table: box(desk.querySelector('.listeners-table')),
          members: box(navs[navs.length - 1]),
          note: box(desk.querySelector('.inbox-no-listeners')),
          composer: box(desk.querySelector('.project-composer')),
        }
        const names = Object.keys(parts).filter((k) => parts[k])
        const overlaps = []
        for (let i = 0; i < names.length; i++) {
          for (let j = i + 1; j < names.length; j++) {
            const a = parts[names[i]], b = parts[names[j]]
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(names[i] + '/' + names[j])
          }
        }
        return { parts, overlaps, note: desk.querySelector('.inbox-no-listeners')?.textContent ?? null,
          placeholder: desk.querySelector('.project-composer textarea')?.getAttribute('placeholder') ?? null }
      })
      screenshots.push(await page.screenshot(`${prefix}-listensetting-desk-${mode.slice(2)}${inbox ? '-noinbox' : ''}-1000x700`))
    }
    await page.goto('/?scene=settings')
    // a base build has no switch: say so and keep the captures so far
    if (!(await page.waitFor('input[aria-label="Event listeners"]', { timeout: 15000 }).then(() => true, () => false))) {
      details.gear = 'no Event listeners switch'
      return { details, screenshots }
    }
    const gear = () => page.eval(() => {
      const sw = document.querySelector('input[aria-label="Event listeners"]')
      const row = sw.closest('.set-row')
      return { checked: sw.checked, state: row.querySelector('.set-state')?.textContent, hint: row.querySelector('.set-hint')?.textContent }
    })
    await page.eval(async () => {
      document.querySelector('input[aria-label="Event listeners"]').closest('.set-row').scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 300))
    })
    await settle()
    details['gear-off'] = await gear()
    screenshots.push(await page.screenshot(`${prefix}-listensetting-gear-off-1000x700`))
    await page.eval(async () => {
      document.querySelector('input[aria-label="Event listeners"]').click()
      await new Promise((r) => setTimeout(r, 300))
    })
    await settle()
    details['gear-on'] = await gear()
    screenshots.push(await page.screenshot(`${prefix}-listensetting-gear-on-1000x700`))
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=headercontrols: the project desk's header controls
  // (docket slots-tab-header-hold-n-slots-button-with-number, USER 2026-10-20
  // 16:35Z-16:58Z) on the Slots, Mail and Listeners tabs and the Register…
  // panel, without and with the user's own registrations, and the listeners
  // window; then a canvas hire's greyed placeholder and its in-place swap
  // (canvas-hire-keep-the-uninitialized-node-greyed-u, 16:45Z). Dark and light.
  // Each desk shot measures its header row: the controls end left of the
  // corner's buttons, in the same row, overlapping nothing.
  if (only === 'headercontrols') {
    const tab = (name) => page.eval(async (t) => {
      document.querySelector(`#desk-inbox .cc-tabs button[data-tab="${t}"]`).click()
      await new Promise((r) => setTimeout(r, 600))
    }, name)
    const type = (sel, value) => page.eval(async (s, v) => {
      const el = document.querySelector(s)
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 250))
    }, sel, value)
    const headerRow = () => page.eval(() => {
      const panel = document.querySelector('#desk-inbox .desk-tabpanel')
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } }
      const corner = box(panel?.querySelector('.panel-corner'))
      const items = [...(panel?.querySelectorAll('.desk-count, .register-trigger, .project-queue-purge') ?? [])]
        .filter((e) => !e.closest('.register-panel'))
        .map((e) => ({ cls: e.className, text: e.textContent, title: (e.matches('button') ? e : e.querySelector('button'))?.getAttribute('title'),
          disabled: e.matches('button') ? e.disabled : !!e.querySelector('button:disabled'),
          value: e.querySelector?.('input')?.value ?? null, max: e.querySelector?.('input')?.max ?? null, box: box(e) }))
      const mid = (b) => (b.top + b.bottom) / 2
      return { corner, items,
        leftOfCorner: !!corner && items.length > 0 && items.every((i) => i.box.right <= corner.left + 1),
        oneRow: !!corner && items.every((i) => Math.abs(mid(i.box) - mid(corner)) <= 8),
        overlap: items.some((a, i) => items.some((b, j) => i < j && a.box.left < b.box.right && b.box.left < a.box.right
          && a.box.top < b.box.bottom && b.box.top < a.box.bottom)) }
    })
    const registerPanel = () => page.eval(() => {
      const p = document.querySelector('.register-panel')
      if (!p) return null
      const r = p.getBoundingClientRect()
      return { box: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) },
        inWindow: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        rows: [...p.querySelectorAll('button')].map((b) => ({ action: b.dataset.action, text: b.textContent, disabled: b.disabled })),
        count: p.querySelector('input')?.value }
    })
    for (const theme of ['', '&theme=light']) {
      const name = theme ? 'light' : 'dark'
      for (const user of ['0', '1']) {
        const who = user === '1' ? 'registered' : 'fresh'
        await page.goto(`/?scene=headercontrols&user=${user}${theme}`)
        await page.waitFor('#desk-inbox .project-desk .cc-tabs', { timeout: 15000 })
        for (const [t, shot] of [['slots', 'slots'], ['inbox', 'mail'], ['listeners', 'listeners']]) {
          await tab(t)
          await settle()
          details[`row-${shot}-${who}-${name}`] = await headerRow()
          if (user === '0' || shot === 'listeners') screenshots.push(await page.screenshot(`${prefix}-hc-${shot}-${who}-${name}-1000x700`))
        }
        await page.eval(async () => {
          document.querySelector('#desk-inbox [data-action="register-menu"]').click()
          await new Promise((r) => setTimeout(r, 300))
        })
        await settle()
        details[`register-${who}-${name}`] = await registerPanel()
        screenshots.push(await page.screenshot(`${prefix}-hc-register-${who}-${name}-1000x700`))
        if (user === '1') {
          await type('.register-panel input[type="number"]', '3')
          await settle()
          details[`register-${who}-changed-${name}`] = await registerPanel()
          screenshots.push(await page.screenshot(`${prefix}-hc-register-${who}-changed-${name}-1000x700`))
        }
      }
      await page.goto('/?scene=hclmodal' + theme)
      await page.waitFor('[data-action="register-menu"]', { timeout: 15000 })
      await settle()
      details['window-' + name] = await page.eval(() => ({
        title: document.querySelector('h3')?.textContent,
        toolbar: [...document.querySelectorAll('[role="toolbar"] > *')].map((e) => e.className || e.tagName) }))
      screenshots.push(await page.screenshot(`${prefix}-hc-listeners-window-${name}-1000x700`))
      // the canvas hire: draft, name, Hire; the feed and the answer wait for __hcFeed and __hcAnswer
      await page.goto('/?scene=hire' + theme)
      await page.waitFor('.sq.user', { timeout: 15000 })
      await page.eval(async () => {
        await new Promise((r) => setTimeout(r, 900))
        document.querySelector('.sq.user button.t-sonnet').click()
        await new Promise((r) => setTimeout(r, 1500))
        const input = document.querySelector('.df-name')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'scout')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 250))
        document.querySelector('.df-foot button.primary').click()
        await new Promise((r) => setTimeout(r, 900))
      })
      await settle()
      details['hire-pending-' + name] = await page.eval(() => {
        const d = document.querySelector('.sq.draft')
        return d && { cls: d.className, inert: d.hasAttribute('inert'), busy: d.getAttribute('aria-busy'),
          tag: d.querySelector('.draft-tag')?.textContent, transform: d.style.transform,
          filter: getComputedStyle(d).filter, opacity: getComputedStyle(d).opacity }
      })
      screenshots.push(await page.screenshot(`${prefix}-hc-hire-pending-${name}-1000x700`))
      // the feed brings the card: it takes the placeholder's place (the answer,
      // which walks the camera to the new desk, comes after the shot)
      details['hire-swapped-' + name] = await page.eval(async () => {
        window.__hcFeed()
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400))))
        const card = [...document.querySelectorAll('.sq')].find((e) => e.querySelector('.name')?.textContent === 'scout')
        return { draft: !!document.querySelector('.sq.draft'), card: card ? card.style.transform : null,
          cls: card ? card.className : null }
      })
      await settle()
      screenshots.push(await page.screenshot(`${prefix}-hc-hire-swapped-${name}-1000x700`))
      details['hire-inplace-' + name] = details['hire-pending-' + name]?.transform === details['hire-swapped-' + name]?.card
      details['hire-after-answer-' + name] = await page.eval(async () => {
        window.__hcAnswer()
        await new Promise((r) => setTimeout(r, 300))
        const card = [...document.querySelectorAll('.sq')].find((e) => e.querySelector('.name')?.textContent === 'scout')
        return { draft: !!document.querySelector('.sq.draft'), card: card ? card.style.transform : null }
      })
    }
    return { details, screenshots }
  }
  // PROJECTNODE_VISUAL_ONLY=deskhead: the project desk's header cards in one
  // row at full desk width, outlined and filled, dark and light, each card's
  // computed colours beside its near-zoom badge's; then the inbox's
  // listeners folder (user 2026-10-19 19:02Z, 19:05Z, 19:15Z)
  if (only === 'deskhead') {
    for (const theme of ['', '&theme=light']) {
      const name = theme ? 'light' : 'dark'
      await page.goto('/?scene=deskhead' + theme)
      await page.waitFor('#desk-filled .project-desk .cc-head', { timeout: 15000 })
      await page.eval(async () => { await new Promise((r) => setTimeout(r, 500)) })
      await settle()
      details['deskhead-' + name] = await page.eval(() => {
        const paint = (el) => {
          if (!el) return null
          const s = getComputedStyle(el), r = el.getBoundingClientRect()
          return { text: el.textContent, color: s.color, background: s.backgroundColor, border: s.borderTopColor,
            top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }
        }
        const kinds = { listeners: ['.project-listeners-card', '.project-listeners-badge'],
          mail: ['.project-queue-card', '.project-queue-badge'], slots: ['.project-slots-card', '.project-slots-badge'] }
        const out = {}
        for (const set of ['outlined', 'filled']) {
          const desk = document.querySelector('#desk-' + set + ' .project-desk')
          const head = desk.querySelector('.cc-head')
          const rows = [...head.querySelectorAll('.cc-head-meta')].filter((r) => r.parentElement === head)
          const cards = {}, sameAsNear = {}
          for (const [kind, [cardSel, badgeSel]] of Object.entries(kinds)) {
            const card = paint(desk.querySelector('.cc-head ' + cardSel))
            const badge = paint(document.querySelector('#near-' + set + ' ' + badgeSel))
            cards[kind] = { card, badge }
            sameAsNear[kind] = !!card && !!badge && card.color === badge.color && card.background === badge.background
              && card.border === badge.border
          }
          // the ↑ superior is the agent desk's up row under the header, not a
          // header card (user 2026-10-19 21:05:53Z, 21:06:08Z)
          const up = paint(desk.querySelector('.cc-head + .desk-nav .desk-nav-chip'))
          const tops = [cards.listeners.card, cards.mail.card, cards.slots.card].filter(Boolean).map((c) => c.top + (c.bottom - c.top) / 2)
          out[set] = { metaRows: rows.length, cards, up, sameAsNear,
            oneLine: tops.length === 3 && Math.max(...tops) - Math.min(...tops) < 4,
            superiorInHeader: !!head.querySelector('.desk-nav-chip'),
            upRowUnderHeader: !!up && up.top >= Math.round(head.getBoundingClientRect().bottom) - 1 }
        }
        return out
      })
      screenshots.push(await page.screenshot(`${prefix}-deskhead-${name}-1000x700`))
    }
    const inbox = () => page.eval(() => ({
      tab: document.querySelector('#desk-inbox .cc-tabs button.on')?.textContent ?? null,
      folders: [...document.querySelectorAll('#desk-inbox .mail-folders button')].map((b) => b.textContent),
      open: document.querySelector('#desk-inbox .mail-folders button.on')?.textContent ?? null,
      headers: [...document.querySelectorAll('#desk-inbox .mail-listeners-table thead th')].map((h) => h.textContent),
      rows: [...document.querySelectorAll('#desk-inbox .mail-listeners-table tr.listener-row')].map((r) => ({
        cells: [...r.children].map((c) => c.textContent), holding: r.classList.contains('holding'),
        live: [...r.querySelectorAll('.slot-time.live')].map((s) => [s.textContent, getComputedStyle(s).color]),
        background: getComputedStyle(r.children[1]).backgroundColor })),
    }))
    for (const [mode, theme] of [['ack', ''], ['ack', '&theme=light'], ['rr', ''], ['rr', '&theme=light']]) {
      const name = mode + '-' + (theme ? 'light' : 'dark')
      await page.goto('/?scene=deskinbox' + (mode === 'rr' ? '&mode=rr' : '') + theme)
      await page.waitFor('#desk-inbox .project-queue-card', { timeout: 15000 })
      await page.eval(async () => {
        document.querySelector('#desk-inbox .project-queue-card').click()
        await new Promise((r) => setTimeout(r, 900))
      })
      await settle()
      details['inbox-' + name] = await inbox()
      screenshots.push(await page.screenshot(`${prefix}-inbox-listeners-${name}-1000x700`))
      if (name === 'ack-dark') {
        // the live times a few seconds on: they count up
        await page.eval(async () => { await new Promise((r) => setTimeout(r, 3000)) })
        await settle()
        details['inbox-ack-dark-3s-later'] = await inbox()
        screenshots.push(await page.screenshot(`${prefix}-inbox-listeners-ack-dark-3s-later-1000x700`))
        // the holder's mail link opens the mail in the inbox folder
        await page.eval(async () => {
          document.querySelector('#desk-inbox .listener-mail-link').click()
          await new Promise((r) => setTimeout(r, 900))
        })
        await settle()
        details['inbox-ack-dark-mail-link'] = await page.eval(() => ({
          open: document.querySelector('#desk-inbox .mail-folders button.on')?.textContent ?? null,
          selected: document.querySelector('#desk-inbox .mailrow.on')?.textContent ?? null,
        }))
        screenshots.push(await page.screenshot(`${prefix}-inbox-mail-link-opened-dark-1000x700`))
      }
    }
    return { details, screenshots }
  }
  if (only === 'slots') {
    await page.goto('/?scene=slotlines')
    await page.waitFor('.sq.project', { timeout: 15000 })
    await page.eval(async () => {
      await new Promise((r) => setTimeout(r, 800))
      const fit = document.querySelector('.zoomhud button[title="Fit the whole org"]')
      if (fit) fit.click()
      await new Promise((r) => setTimeout(r, 1500))
    })
    await settle()
    details.slotlines = await page.eval(() => ({
      lines: [...document.querySelectorAll('.edge.slot-line, .edge.fq-line, .edge.aud-line')].map((e) => ({
        cls: e.getAttribute('class'), probe: e.hasAttribute('data-glprobe'), d: e.getAttribute('d'),
        stroke: getComputedStyle(e).stroke, dash: getComputedStyle(e).strokeDasharray, width: getComputedStyle(e).strokeWidth })),
      badge: [...document.querySelectorAll('.project-slots-badge')].map((b) => [b.textContent, b.className,
        getComputedStyle(b).backgroundColor, getComputedStyle(b).color]),
      holds: [...document.querySelectorAll('.chip.slot-hold')].map((c) => c.textContent),
      waiters: [...document.querySelectorAll('.wd-chip.slot')].map((c) => c.textContent),
    }))
    screenshots.push(await page.screenshot(`${prefix}-slotlines-1000x700`))
    await page.goto('/?scene=slots')
    await page.waitFor('.project-slots-card', { timeout: 15000 })
    await page.eval(async () => {
      for (const b of document.querySelectorAll('.project-slots-card')) b.click()
      await new Promise((r) => setTimeout(r, 600))
    })
    await settle()
    details.slots = await page.eval(() => [...document.querySelectorAll('.slots-desk')].map((d) => ({
      card: d.querySelector('.project-slots-card')?.textContent,
      tab: d.querySelector('.cc-tabs button.on')?.textContent,
      lead: d.querySelector('.slots-lead')?.textContent,
      sections: [...d.querySelectorAll('.project-slots h4')].map((h) => h.textContent),
      rows: [...d.querySelectorAll('.project-slots .slot-row')].map((r) => r.textContent),
    })))
    screenshots.push(await page.screenshot(`${prefix}-slots-desk-1000x700`))
    await page.eval(() => { document.querySelector('.slots-desk button[data-action="force-release"]')?.click() })
    await settle()
    details.forceRelease = await page.eval(() => document.querySelector('.modal, [role="dialog"], [role="alertdialog"]')?.textContent ?? null)
    screenshots.push(await page.screenshot(`${prefix}-slots-force-1000x700`))
    return { details, screenshots }
  }

  await page.goto('/?scene=cards')
  await page.waitFor('.sq.project.mini', { timeout: 8000 })
  await settle()
  details.cards = await page.eval(() => {
    const mini = document.querySelector('.sq.project.mini')
    const icon = mini && mini.querySelector('.project-mini')
    const stripe = mini ? getComputedStyle(mini, '::before') : null
    const token = document.querySelector('.hsof button.project-token')
    const chip = document.querySelector('.sq.project.norm .project-activity .org-counts')
    return {
      stripeContent: stripe ? stripe.content : null,
      stripeDisplay: stripe ? stripe.display : null,
      iconFontSize: icon ? getComputedStyle(icon).fontSize : null,
      tokenBackground: token ? getComputedStyle(token).backgroundColor : null,
      tokenColor: token ? getComputedStyle(token).color : null,
      chip: chip ? chip.textContent : null,
    }
  })
  screenshots.push(await page.screenshot(`${prefix}-cards-1000x700`))

  for (const scene of ['row-end', 'between', 'fairqueue', 'fairqueue&theme=light']) {
    await page.goto(`/?scene=${scene}`)
    await page.waitFor('.sq.project', { timeout: 15000 })
    await page.eval(async () => {
      await new Promise((r) => setTimeout(r, 800))
      // fit the whole org, as the HUD button does, so every card is on screen
      const fit = document.querySelector('.zoomhud button[title="Fit the whole org"]')
      if (fit) fit.click()
      await new Promise((r) => setTimeout(r, 1500))
    })
    await settle()
    details[scene] = await page.eval(() => ({
      peerWires: [...document.querySelectorAll('path.peer, .edge.peer')].length,
      // the fair-queue lines (SVG paths, or the GL layer's style probes)
      fqLines: [...document.querySelectorAll('.edge.fq-line')].map((e) => ({
        cls: e.getAttribute('class'), probe: e.hasAttribute('data-glprobe'),
        stroke: getComputedStyle(e).stroke, dash: getComputedStyle(e).strokeDasharray,
        opacity: getComputedStyle(e).opacity })),
      cards: [...document.querySelectorAll('.sq')].map((el) => {
        const r = el.getBoundingClientRect()
        return [el.getAttribute('data-copy-agent-name') || el.className.split(' ').slice(0, 3).join('.'), Math.round(r.x), Math.round(r.y), Math.round(r.width)]
      }),
      viewport: (() => { const v = document.querySelector('.viewport'); const r = v && v.getBoundingClientRect(); return r ? [r.width, r.height] : null })(),
    }))
    screenshots.push(await page.screenshot(`${prefix}-${scene.replace('&theme=', '-')}-1000x700`))
  }
  await page.goto('/?scene=jumps')
  await page.waitFor('.desk-nav', { timeout: 15000 })
  await page.eval(async () => { await new Promise((r) => setTimeout(r, 800)) })
  await settle()
  details.jumps = await page.eval(() => [...document.querySelectorAll('main > div')].map((box) =>
    [...box.querySelectorAll('.desk-nav')].map((row) =>
      [...row.querySelectorAll('button.desk-nav-chip')].map((b) => b.textContent.trim()))))
  screenshots.push(await page.screenshot(`${prefix}-jumps-1000x700`))
  await page.goto('/?scene=activity')
  await page.waitFor('.sq.project.norm', { timeout: 15000 })
  await settle()
  details.activity = await page.eval(() => [...document.querySelectorAll('.sq.project')].map((sq) => ({
    activity: sq.querySelector('.project-last-activity') ? sq.querySelector('.project-last-activity').textContent : null,
    chip: sq.querySelector('.project-activity .org-counts') ? sq.querySelector('.project-activity .org-counts').textContent : null,
    hover: [...sq.querySelectorAll('.sq-actions button')].map((b) => b.className),
  })))
  screenshots.push(await page.screenshot(`${prefix}-activity-1000x700`))
  await page.goto('/?scene=presented')
  await page.waitFor('.sq.project.norm', { timeout: 15000 })
  await page.eval(async () => { await new Promise((r) => setTimeout(r, 1200)) })
  await settle()
  details.presented = await page.eval(() => ({
    chips: [...document.querySelectorAll('.sq.project .doc-chips .doc-chip')].map((c) => c.textContent.trim()),
    rows: [...document.querySelectorAll('.doc-gallery-row .l2')].map((r) => ({
      presenter: r.getAttribute('data-copy-agent-name'),
      link: !!r.querySelector('button.cc-name-jump') })),
  }))
  screenshots.push(await page.screenshot(`${prefix}-presented-1000x700`))
  // the description at rest, then a REAL click (CDP, trusted) into the middle
  // of "checklist" in the Markdown: the editor should open with the caret
  // there (user 2026-10-18 07:14Z)
  await page.goto('/?scene=desc')
  await page.waitFor('.project-description-md a', { timeout: 15000 })
  await settle()
  const rest = await page.eval(() => {
    const md = document.querySelector('.project-description-md')
    const cs = getComputedStyle(md)
    const link = md.querySelector('a').firstChild
    const r = document.createRange(); r.setStart(link, 12); r.setEnd(link, 13)   // "release chec|k"
    const b = r.getBoundingClientRect()
    const pop = document.querySelector('.cc-head button.popout-button')
    return { background: cs.backgroundColor, borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
      popout: pop ? [pop.getAttribute('aria-label'), pop.textContent] : null,
      x: Math.round(b.left + 1), y: Math.round(b.top + b.height / 2) }
  })
  screenshots.push(await page.screenshot(`${prefix}-desc-rest-1000x700`))
  await page.mouse('mouseMoved', rest.x, rest.y)
  await page.mouse('mousePressed', rest.x, rest.y)
  await page.mouse('mouseReleased', rest.x, rest.y)
  await settle()
  const edit = await page.eval(() => {
    const box = document.querySelector('textarea.project-description-edit')
    if (!box) return { open: false }
    const cs = getComputedStyle(box)
    return { open: true, focused: document.activeElement === box, caret: box.selectionStart, end: box.selectionEnd,
      before: box.value.slice(Math.max(0, box.selectionStart - 30), box.selectionStart),
      after: box.value.slice(box.selectionStart, box.selectionStart + 12),
      background: cs.backgroundColor, borderColor: cs.borderTopColor }
  })
  details.desc = { rest, edit }
  screenshots.push(await page.screenshot(`${prefix}-desc-editing-1000x700`))
  // a custom org theme (blue): the project window should follow it, the
  // Claude agent's keep its provider orange
  await page.goto('/?scene=desc')
  await page.waitFor('#pin-project', { timeout: 15000 })
  await page.eval(() => { document.documentElement.style.setProperty('--accent', '#3a8dde') })
  await settle()
  details.pinAccent = await page.eval(() => Object.fromEntries(['pin-project', 'pin-agent'].map((id) => {
    const el = document.getElementById(id)
    return [id, { accent: getComputedStyle(el).getPropertyValue('--accent').trim(), border: getComputedStyle(el).borderTopColor }]
  })))
  screenshots.push(await page.screenshot(`${prefix}-pinaccent-1000x700`))
  // boxes that must not overlap: [a, b] rects and their intersection area
  const overlap = (pairs) => page.eval((pairs) => pairs.map(([a, b]) => {
    const ra = document.querySelector(a)?.getBoundingClientRect(), rb = document.querySelector(b)?.getBoundingClientRect()
    if (!ra || !rb) return { a, b, missing: !ra ? a : b }
    const w = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left))
    const h = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top))
    const box = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
    return { a, b, ra: box(ra), rb: box(rb), area: Math.round(w * h) }
  }), pairs)
  await page.goto('/?scene=settings')
  await page.waitFor('.agent-settings-header-actions button', { timeout: 15000 })
  await settle()
  details.settings = await overlap([['.modalpin-bar', '.agent-settings-header-actions button']])
  screenshots.push(await page.screenshot(`${prefix}-settings-1000x700`))
  // the project desk modal against the canvas desk (user 2026-10-18 08:25Z):
  // the same tab and chip type, no settings-panel buttons
  const deskLook = () => page.eval(() => {
    const tab = document.querySelector('.project-desk .cc-tabs button')
    const name = document.querySelector('.project-desk .cc-head-left .name')
    const panel = document.querySelector('.project-desk-modal')
    const cs = (el) => el ? getComputedStyle(el) : null
    return { tabFont: cs(tab)?.fontSize, tabPad: cs(tab)?.padding, nameFont: cs(name)?.fontSize,
      panel: panel ? [...panel.classList] : null }
  })
  await page.goto('/?scene=desc')
  await page.waitFor('.project-desk .cc-tabs button', { timeout: 15000 })
  await settle()
  const canvasLook = await deskLook()
  await page.goto('/?scene=modal')
  await page.waitFor('.project-desk-modal .cc-tabs button', { timeout: 15000 })
  await settle()
  details.modal = { canvas: canvasLook, modal: await deskLook() }
  screenshots.push(await page.screenshot(`${prefix}-modal-1000x700`))
  await page.goto('/?scene=corner')
  await page.waitFor('.mail-transfers', { timeout: 15000 })
  await settle()
  details.corner = await overlap([['.panel-corner', '.mail-transfers']])
  screenshots.push(await page.screenshot(`${prefix}-corner-1000x700`))
  return { details, screenshots }
}
