// projectbunch-ring-visual.cjs: circular-chart scenes of projectbunch-visual.tsx
// (user 2026-10-20 09:08Z). Run with projectbunch-visual.mjs's capture argument.
// Reports measured world spacing instead of failing on it, so the same script
// records the base revision's spread ring and the fix's dense arc.
module.exports = async page => {
  await page.resize('1000x700')
  const screenshots = [], details = {}
  const teams = {
    'ring-whole': [Array.from({ length: 25 }, (_, i) => `bs-${i}`)],
    'ring-split': [Array.from({ length: 25 }, (_, i) => `bs-${i}`)],
    'ring-busy': [Array.from({ length: 12 }, (_, i) => `left-${i}`), Array.from({ length: 12 }, (_, i) => `right-${i}`)],
  }
  for (const scene of Object.keys(teams)) {
    await page.goto('/?scene=' + scene)
    await page.waitFor('.sq.project')
    await page.eval(async () => {
      await new Promise(resolve => setTimeout(resolve, 2500))
      await new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => setTimeout(resolve, 300))))
    })
    // Cards are translated in world pixels inside the scaled canvas space.
    const seen = await page.eval(() => {
      const world = el => {
        const m = /translate\(\s*(-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)/.exec(el.style.transform || '')
        return m ? { x: Number(m[1]), y: Number(m[2]) } : null
      }
      const cards = {}
      for (const el of document.querySelectorAll('.sq[data-copy-agent-name]')) {
        const p = world(el)
        if (p) cards[el.getAttribute('data-copy-agent-name')] = p
      }
      const eye = document.querySelector('.sq.user')
      return { cards, eye: eye && world(eye) }
    })
    const centre = p => ({ x: p.x + 62, y: p.y + 62 })
    const chords = ids => ids.slice(1).map((id, i) => {
      const a = seen.cards[ids[i]], b = seen.cards[id]
      if (!a || !b) throw new Error(`${scene}: ${!a ? ids[i] : id} was not rendered`)
      return Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y)
    })
    const spacing = teams[scene].flatMap(chords)
    const names = Object.keys(seen.cards).sort((p, q) => seen.cards[p].x - seen.cards[q].x)
    const overlaps = []
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length && seen.cards[names[j]].x - seen.cards[names[i]].x < 124; j++)
        if (Math.abs(seen.cards[names[j]].y - seen.cards[names[i]].y) < 124) overlaps.push([names[i], names[j]])
    const ring = seen.eye && seen.cards[teams[scene][0][0]] && Math.hypot(
      centre(seen.cards[teams[scene][0][0]]).x - centre(seen.eye).x, centre(seen.cards[teams[scene][0][0]]).y - centre(seen.eye).y)
    details[scene] = { cards: names.length, eye: !!seen.eye, ring,
      spacing: { min: Math.min(...spacing), max: Math.max(...spacing) }, overlaps }
    screenshots.push(await page.screenshot('project-bunch-' + scene))
  }
  return { details, screenshots }
}
