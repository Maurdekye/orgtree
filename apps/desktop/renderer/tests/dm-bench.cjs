// The page script of dm-bench.mjs: opens the long chat, types, lets the
// organization's tree change, scrolls back, and returns what each cost. Clicks
// and keys are CDP input to this window only.
'use strict'

module.exports = async (page) => {
  const v = {}
  const until = async (what, fn, timeout = 60000) => {
    const end = Date.now() + timeout
    for (;;) {
      const got = await fn()
      if (got) return got
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await page.sleep(100)
    }
  }
  /** React's own time for the commits since `from` (an index into the profiler's list) */
  const since = (from) => page.eval((i) => { const c = window.__bench.commits.slice(i); return { commits: c.length, ms: Math.round(c.reduce((s, x) => s + x.ms, 0) * 10) / 10, max: Math.round(Math.max(0, ...c.map(x => x.ms)) * 10) / 10 } }, from)
  const mark = () => page.eval(() => window.__bench.commits.length)
  const quiet = async () => { let n = await mark(); for (;;) { await page.sleep(400); const m = await mark(); if (m === n) return; n = m } }
  const dom = () => page.eval(() => { const t = document.querySelector('.dm-timeline'); return { bubbles: document.querySelectorAll('.dm-msg').length, nodes: t ? t.querySelectorAll('*').length : 0,
    drawn: t?.dataset.dmDrawn ? Number(t.dataset.dmDrawn) : null, loaded: t?.dataset.dmLoaded ? Number(t.dataset.dmLoaded) : null } })
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
  const round = (x) => Math.round(x * 10) / 10

  await page.resize('1440x1000')
  await page.waitFor('.dm-row')
  await quiet()

  // ------------------------------------------------------------ opening the chat
  let from = await mark()
  await page.eval(() => {
    window.__open = { at: performance.now(), shown: 0 }
    const watch = new MutationObserver(() => { if (document.querySelector('.dm-msg')) { window.__open.shown = performance.now(); watch.disconnect() } })
    watch.observe(document.body, { childList: true, subtree: true })
    document.querySelector('.dm-row[data-dm-chat="worker"]').click()
  })
  await until('the chat', async () => page.eval(() => window.__open.shown > 0))
  await quiet()
  v.open = { wallMs: round(await page.eval(() => window.__open.shown - window.__open.at)), react: await since(from), ...(await dom()) }
  await page.screenshot('bench-01-the-chat-open')

  // ------------------------------------------------------------------- typing
  await page.eval(() => {
    window.__keys = []
    const ta = document.querySelector('.dm-compose textarea')
    let at = 0
    window.addEventListener('input', () => { at = performance.now() }, true)
    ta.addEventListener('input', () => { const began = at; setTimeout(() => window.__keys.push(performance.now() - began), 0) })
  })
  await page.click('.dm-compose textarea')
  await quiet()
  from = await mark()
  const text = 'the quick brown fox jumps over it'
  for (const ch of text) { await page.type(ch); await page.sleep(40) }
  await quiet()
  const keys = await page.eval(() => window.__keys.slice())
  const typed = await since(from)
  v.typing = { keys: keys.length, medianMs: round(median(keys)), maxMs: round(Math.max(0, ...keys)), reactPerKeyMs: round(typed.ms / Math.max(1, keys.length)), commits: typed.commits }

  // ------------------------------- the organization changes: a new tree, ten times
  const treeTicks = async () => {
    const ticks = []
    for (let i = 0; i < 10; i++) {
      from = await mark()
      const wall = await page.eval(() => new Promise((resolve) => { const t = performance.now(); window.__bench.tick(); setTimeout(() => resolve(performance.now() - t), 0) }))
      await page.sleep(150)
      ticks.push({ wall, react: (await since(from)).ms })
    }
    return { medianWallMs: round(median(ticks.map(t => t.wall))), maxWallMs: round(Math.max(...ticks.map(t => t.wall))), medianReactMs: round(median(ticks.map(t => t.react))), ...(await dom()) }
  }
  v.treeTick = await treeTicks()

  // ------------------------------------------------------------- scrolling back
  const steps = []
  for (let i = 0; i < 6; i++) {
    const before = await dom()
    from = await mark()
    const wall = await page.eval(() => new Promise((resolve) => {
      const el = document.querySelector('.dm-timeline'), t = performance.now()
      el.scrollTop = 200
      // the next two frames: the scroll, and what it drew
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t)))
    }))
    await quiet()
    const after = await dom()
    steps.push({ wall: round(wall), react: (await since(from)).ms, bubbles: after.bubbles })
    if (after.bubbles === before.bubbles) break
  }
  v.scroll = { steps, medianWallMs: round(median(steps.map(s => s.wall))), maxWallMs: round(Math.max(...steps.map(s => s.wall))), end: await dom() }
  // the same ten tree changes with the scroll-back drawn
  v.treeTickScrolledBack = await treeTicks()
  await page.screenshot('bench-02-scrolled-back')
  v.end = await page.eval(() => ({ closed: window.__bench.closed, toasts: window.__bench.toasts.slice(0, 5), commits: window.__bench.commits.length }))
  return v
}
