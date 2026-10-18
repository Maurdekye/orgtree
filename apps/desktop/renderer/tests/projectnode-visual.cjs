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
