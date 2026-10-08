module.exports = async page => {
  await page.waitFor('[data-first-use-agent="rhea"]')
  await page.rightClick('[data-first-use-agent="rhea"]')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor(() => document.querySelector('.msgs')?.textContent.includes('Paragraph 35.'))
  await page.eval(() => document.querySelector('.msgs').focus())
  for (let i = 0; i < 10; i++) await page.press('ArrowUp')
  await page.waitFor('.jumpbottom')
  await page.sleep(400)

  const measure = () => {
    const s = document.querySelector('.msgs')
    const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    return { transcript: rect(s), scrollHeight: s.scrollHeight, scrollTop: s.scrollTop,
      lastRow: rect(s.lastElementChild), chips: rect([...document.querySelectorAll('.desk-nav')].at(-1)),
      composer: rect(document.querySelector('.cc-composer')) }
  }
  const shown = await page.eval(measure)
  const overlay = await page.eval(() => {
    const b = document.querySelector('.jumpbottom'), s = document.querySelector('.msgs')
    const r = b.getBoundingClientRect(), sr = s.getBoundingClientRect()
    return { position: getComputedStyle(b).position, outsideScroller: !s.contains(b),
      insideTranscript: r.top >= sr.top && r.bottom <= sr.bottom,
      clickable: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b,
      aboveChips: r.bottom <= [...document.querySelectorAll('.desk-nav')].at(-1).getBoundingClientRect().top,
      aboveComposer: r.bottom <= document.querySelector('.cc-composer').getBoundingClientRect().top }
  })
  if (overlay.position !== 'absolute' || Object.values(overlay).some(v => v === false)) throw Error(JSON.stringify(overlay))
  await page.screenshot('jump-shown')
  // Compare at the exact same scroll offset, so scrolling cannot mask layout movement.
  await page.eval(() => { document.querySelector('.jumpbottom').style.display = 'none' })
  const hidden = await page.eval(measure)
  await page.screenshot('jump-hidden-same-scroll')
  if (JSON.stringify(shown) !== JSON.stringify(hidden)) throw Error(JSON.stringify({ shown, hidden }))
  await page.eval(() => { document.querySelector('.jumpbottom').style.display = '' })
  await page.click('.jumpbottom')
  await page.waitFor('.jumpbottom', { gone: true })
  await page.waitFor(() => { const s = document.querySelector('.msgs'); return s.scrollHeight - s.clientHeight - s.scrollTop < 3 })
  const afterJump = await page.eval(measure)
  for (const key of ['transcript', 'chips', 'composer']) {
    if (JSON.stringify(shown[key]) !== JSON.stringify(afterJump[key])) throw Error(`Jump changed ${key}`)
  }
  await page.screenshot('jump-clicked-bottom')
  return { shown, hidden, afterJump, overlay, clickReachedBottom: true }
}
