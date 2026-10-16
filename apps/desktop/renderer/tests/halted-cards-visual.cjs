module.exports = async (page) => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.sq-far-icon.halted')
  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
    return {
      cards: [...document.querySelectorAll('.sq')].map(card => ({
        state: card.classList.contains('halted') ? 'halted' : 'idle',
        zoom: card.getAttribute('data-zoom'),
        icon: card.querySelector('.sq-far-icon')?.className.baseVal
          ?? card.querySelector('.sq-far-icon')?.getAttribute('class'),
        label: card.querySelector('.sq-far-status > span:last-child, .sq-halt-status > span')?.textContent?.trim() ?? null,
        rect: (() => { const r = card.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })(),
      })),
      viewport: { width: innerWidth, height: innerHeight },
    }
  })
  if (details.cards.length !== 4 || details.cards[0].label !== 'Halted'
      || details.cards[2].label !== 'Halted'
      || details.cards.some((card, i) => card.zoom !== (i < 2 ? 'mini' : 'norm'))) {
    throw new Error(`Halted/idle card capture fixture is incomplete: ${JSON.stringify(details)}`)
  }
  const dark = await page.screenshot('halted-card-dark-1000x700')
  await page.eval(async () => {
    document.documentElement.classList.add('contrast-light')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
  })
  const light = await page.screenshot('halted-card-light-1000x700')
  return { details, screenshots: [dark, light] }
}
