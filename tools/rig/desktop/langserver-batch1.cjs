// The Language Server lane's fixes for the user's reports on 4.2.0-alpha.1
// (coordinator rulings 2026-10-10), as the user sees them. langserver-lane.mjs
// section 8 decides what passes.
// mode "chips": the canvas cards of agents on language-server models: each
//   chip's letter, tooltip and colours, and a screenshot. Then Quick chat's
//   model picker, once now and again (same page, no reload) until it lists
//   `want`: the proof offers that model once `quickchat-before.png` exists.
//   The picker is the hire chips (SpawnChips), one button per tier, each
//   named by its tooltip (`hire a <model> · <server> (-N)`), so those are
//   what it lists. It is the same picker wherever Quick chat sits: upward
//   from a v3 window's footer, downward from a header, as on this page (no
//   desktop bridge here, so Quick chat sits in the header).
// mode "loading": the agent's desk while its server loads the model: the
//   banner's words and a screenshot. The desk opens FIRST and says so with
//   `desk-open.png`; the proof sends the message that starts the load only
//   then, so a window that starts slowly cannot miss the load.
// args: { mode: 'chips', agents: [names], want: '<model id>' } | { mode: 'loading', agent }
module.exports = async (page, { args }) => {
  if (args.mode === 'loading') {
    const card = `[data-first-use-agent="${args.agent}"]`
    await page.waitFor(card, { timeout: 30000 })
    await page.sleep(800)
    await page.rightClick(card)
    await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
    await page.waitFor(`[placeholder^="message ${args.agent}"]`, { timeout: 30000 })
    await page.screenshot('desk-open')
    await page.waitFor(() => [...document.querySelectorAll('.slot-queued-warning[role="status"]')]
      .some((e) => /^Loading model on /.test((e.innerText || '').trim())), { timeout: 90000 })
    await page.sleep(500)
    const banner = await page.eval(() => [...document.querySelectorAll('.slot-queued-warning[role="status"]')]
      .map((e) => (e.innerText || '').trim()).find((t) => /^Loading model on /.test(t)) ?? null)
    await page.screenshot('desk-loading-model')
    return { banner }
  }

  for (const name of args.agents) await page.waitFor(`[data-first-use-agent="${name}"]`, { timeout: 30000 })
  await page.waitFor('[data-testid="quickchat"]', { timeout: 30000 })
  await page.sleep(1500)
  const chips = await page.eval((names) => Object.fromEntries(names.map((name) => {
    const card = document.querySelector(`[data-first-use-agent="${name}"]`)
    const chip = card?.querySelector('.tier')
    if (!chip) return [name, null]
    const cs = getComputedStyle(chip)
    return [name, { letter: (chip.innerText || '').trim(), title: chip.getAttribute('title'), tier: chip.className,
      color: cs.color, background: cs.backgroundColor }]
  })), args.agents)
  await page.screenshot('chips-canvas')

  // Quick chat's model picker, now; the proof offers `want` once this screenshot exists
  await page.eval(() => { window.__rigSamePage = 'yes'; return true })
  const POP = '.quickchat-pop.quickchat-pop-model'   // the open picker, not its fading copy (.quickchat-leaving)
  const menu = async () => {
    await page.click('.quickchat-model')
    await page.waitFor(`${POP} .hsof button`)
    await page.sleep(300)
    return page.eval((pop) => [...document.querySelectorAll(`${pop} .hsof button`)]
      .map((b) => (b.title || '').trim()), POP)
  }
  // the model button toggles its picker: make sure Escape closed it, so the
  // next click opens it again rather than closing it
  const shut = async () => {
    await page.press('Escape')
    await page.waitFor(POP, { gone: true, timeout: 5000 })
  }
  const before = await menu()
  await page.screenshot('quickchat-before')
  await shut()
  const t0 = Date.now()
  let after = null
  while (Date.now() - t0 < 90000) {
    await page.sleep(1500)
    const items = await menu()
    if (items.some((i) => i.includes(args.want))) {
      after = items
      await page.screenshot('quickchat-after')
      await shut()
      break
    }
    await shut()
  }
  const samePage = await page.eval(() => window.__rigSamePage === 'yes')
  return { chips, before, after, waited_ms: after ? Date.now() - t0 : null, samePage }
}
