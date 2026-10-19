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
          const up = paint(head.querySelector('.desk-nav-chip'))
          const tops = [cards.listeners.card, cards.mail.card, cards.slots.card, up].filter(Boolean).map((c) => c.top + (c.bottom - c.top) / 2)
          out[set] = { metaRows: rows.length, cards, up, sameAsNear,
            oneLine: tops.length === 4 && Math.max(...tops) - Math.min(...tops) < 4,
            superiorInBody: !!desk.querySelector('.desk-nav .desk-nav-chip') }
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
