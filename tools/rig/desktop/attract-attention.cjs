// Page script for tools/rig/proofs/attract-attention.mjs (see its header). Runs in the rig's offscreen Electron.
// args: { flagTitle, flags: { ready, seeded, raise, raised, mention, mentioned } } - flag files shared with the proof.
// Browser mode here (no desktop bridge), so attract's two preferences are localStorage keys (attract/pref.ts), applied with the
// stores' own events. NO input is sent after attract is enabled: only the enabling itself and the two reloads before it.
const fs = require('node:fs')

module.exports = async (page, { org, args }) => {
  const sleep = (ms) => page.sleep(ms)
  // which panels are on screen, from the ORDINARY (unpinned) panels' real DOM (canvas/modalpin.tsx PinFrame: an `.overlay`
  // around a panel div; the docket's panel classes are 'settings wide docket-modal', the inbox's 'settings wide' with the h3 'Your inbox')
  const state = () => page.eval(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0
    const open = []
    if ([...document.querySelectorAll('.overlay .docket-modal.settings')].some(shown)) open.push('docket')
    if ([...document.querySelectorAll('.overlay .settings')].filter(shown).some((el) => /^\s*Your inbox/i.test(el.querySelector('h3')?.textContent || ''))) open.push('inbox')
    const ticket = document.querySelector('.docket-pane-head b')?.textContent ?? null
    const vp = document.querySelector('.viewport')?.getBoundingClientRect()
    const card = document.querySelector('[data-copy-agent-name="bea"]')?.getBoundingClientRect()
    const pin = document.querySelector('.pinwin[data-id="bea"]')?.getBoundingClientRect()
    const box = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null)
    return {
      open, ticket, running: localStorage.getItem('orgtree-attract-mode') === '1',
      zoom: document.querySelector('.zoomhud')?.textContent?.trim() ?? null,
      vp: box(vp), card: box(card), pin: box(pin), desks: document.querySelectorAll('.desk-over').length,
    }
  })

  // ---- setup: bea's desk pinned (the seed pin-resize.cjs uses), then a clean load
  const pinKey = `orgtree-pins-${org}`
  await page.waitFor('.viewport', { timeout: 60000 })
  await page.eval((k) => localStorage.setItem(k, JSON.stringify([{ id: 'bea', rect: { x: 100, y: 100, w: 520, h: 360 }, z: 0, snap: null }])), pinKey)
  await page.goto(`/o/${org}`)
  await page.waitFor('.pinwin[data-id="bea"]', { timeout: 60000 })
  await page.waitFor('.viewport', { timeout: 60000 })
  await sleep(2500)
  const pinned = await state()
  page.log('bea pinned', pinned.pin)
  await page.screenshot('01-bea-pinned')
  fs.writeFileSync(args.flags.ready, new Date().toISOString())
  const endSeed = Date.now() + 120000
  while (!fs.existsSync(args.flags.seeded)) {
    if (Date.now() > endSeed) throw new Error('the proof did not touch the tickets in 120 s')
    await sleep(250)
  }
  await sleep(2500) // the tree and docket polls pick the new updated_at up

  // ---- enable attract mode with Start after = 0 (no input is sent from here on)
  const enabledAt = Date.now()
  await page.eval(() => {
    localStorage.setItem('orgtree-attract-idle', '0')
    window.dispatchEvent(new Event('orgtree:attract-idle-stored'))
    localStorage.setItem('orgtree-attract-mode', '1')
    window.dispatchEvent(new Event('orgtree:attract-stored'))
  })

  const samples = []
  let sig = '', lastChangeAt = Date.now(), moves = 0
  const sample = async () => {
    const s = await state()
    const now = Date.now()
    samples.push({ t: now - enabledAt, open: s.open, ticket: s.ticket, zoom: s.zoom })
    const next = JSON.stringify([s.open.slice().sort(), s.ticket])
    if (next !== sig) { if (sig !== '') { moves++; lastChangeAt = now } sig = next }
    return s
  }

  // ---- phase 1: wait for an attract-opened panel right after a step began, then ask for the flag
  const phase1 = { armed: false }
  const end1 = Date.now() + 240000
  while (Date.now() < end1) {
    const before = samples.at(-1)
    const s = await sample()
    const panel = s.open.includes('inbox') || (s.open.includes('docket') && s.ticket !== args.flagTitle)
    if (moves >= 1 && panel && Date.now() - lastChangeAt < 2000) {
      phase1.armed = true
      phase1.prevStartAt = lastChangeAt
      phase1.prevOpen = s.open.slice()
      phase1.prevTicket = s.ticket
      fs.writeFileSync(args.flags.raise, new Date().toISOString())
      void before
      break
    }
    await sleep(250)
  }
  if (phase1.armed) {
    await page.screenshot('02-before-flag')
    const endRaised = Date.now() + 60000
    while (!fs.existsSync(args.flags.raised) && Date.now() < endRaised) { await sample(); await sleep(100) }
    const raised = fs.existsSync(args.flags.raised) ? JSON.parse(fs.readFileSync(args.flags.raised, 'utf8')) : null
    phase1.raisedOk = !!raised?.ok
    phase1.raisedAt = raised?.at ?? null
    // sample fast until the docket shows the flagged ticket
    const endShown = Date.now() + 45000
    while (Date.now() < endShown) {
      const s = await sample()
      if (s.ticket === args.flagTitle && s.open.includes('docket')) { phase1.shownAt = Date.now(); phase1.shownOpen = s.open.slice(); break }
      await sleep(100)
    }
    if (phase1.shownAt != null) {
      phase1.latencyMs = phase1.raisedAt != null ? phase1.shownAt - phase1.raisedAt : null
      phase1.sincePrevStartMs = phase1.shownAt - phase1.prevStartAt
      await page.screenshot('03-flag-shown')
      await sleep(1800)
      const after = await sample()
      phase1.inboxClosedAfter = !after.open.includes('inbox')
      phase1.openAfter = after.open.slice()
    }
  }

  // ---- phase 2: bea (pinned) says @user; attract should fit the whole org with her in view, leave her window alone
  const phase2 = {}
  const before2 = await state()
  phase2.before = { pin: before2.pin, zoom: before2.zoom, card: before2.card, desks: before2.desks }
  fs.writeFileSync(args.flags.mention, new Date().toISOString())
  const endM = Date.now() + 90000
  while (!fs.existsSync(args.flags.mentioned) && Date.now() < endM) { await sample(); await sleep(250) }
  const zooms = []
  const end2 = Date.now() + 50000
  while (Date.now() < end2) {
    const s = await sample()
    zooms.push({ t: Date.now(), zoom: s.zoom })
    await sleep(500)
  }
  const after2 = await state()
  await page.screenshot('04-after-mention')
  const near = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= 2)
  phase2.after = { pin: after2.pin, zoom: after2.zoom, card: after2.card, desks: after2.desks, vp: after2.vp }
  phase2.pinSame = near(before2.pin, after2.pin)
  phase2.cardInView = !!after2.card && !!after2.vp && after2.card.x >= after2.vp.x - 1 && after2.card.y >= after2.vp.y - 1
    && after2.card.x + after2.card.w <= after2.vp.x + after2.vp.w + 1 && after2.card.y + after2.card.h <= after2.vp.y + after2.vp.h + 1
  phase2.extraDesk = after2.desks > before2.desks
  phase2.zoomSeries = [...new Set(zooms.map((z) => z.zoom))]

  return { samples, moves, phase1, phase2, stillRunning: (await state()).running }
}
