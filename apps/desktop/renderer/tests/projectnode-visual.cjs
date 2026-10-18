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
  return { details, screenshots }
}
