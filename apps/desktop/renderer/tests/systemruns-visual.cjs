module.exports = async page => {
  const results = []
  for (const theme of ['dark', 'light']) {
    await page.resize('1000x900'); await page.goto('/')
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), theme === 'light')
    await page.waitFor('.transcript-system-run')
    const read = () => page.eval(() => {
      const run = document.querySelector('.transcript-system-run')
      const summary = run.querySelector('summary'), cs = getComputedStyle(summary)
      const peer = document.querySelector('[data-mail-id="peer"]')
      return { open: run.open, summary: summary.innerText, height: run.getBoundingClientRect().height,
        peerY: peer.getBoundingClientRect().top, peerHidden: !!peer.closest('.transcript-system-run'),
        color: cs.color, background: cs.backgroundColor, edge: cs.borderLeftColor,
        count: run.querySelectorAll('.turn-mail,.event-card').length }
    })
    const initial = await read()
    if (initial.open || initial.peerHidden || !initial.summary.includes('3 system notices')) throw new Error(JSON.stringify(initial))
    await page.screenshot(`systemruns-${theme}-collapsed`)
    await page.eval(() => window.systemFixture.append())
    await page.waitFor({ selector: '.transcript-system-run > summary > .noticekind', text: '4 system notices' })
    const appended = await read()
    if (appended.open || Math.abs(appended.peerY - initial.peerY) > 1 || appended.count !== initial.count + 1)
      throw new Error('Collapsed append moved/lost content: ' + JSON.stringify({ initial, appended }))
    await page.eval(() => document.querySelector('.transcript-system-run > summary').focus())
    await page.press('Enter')
    await page.waitFor('.transcript-system-run[open]')
    const expanded = await read()
    if (!expanded.open || expanded.height <= appended.height) throw new Error('Keyboard disclosure did not expand')
    await page.screenshot(`systemruns-${theme}-expanded`)
    await page.press('Enter')
    const closed = await read()
    if (closed.open) throw new Error('Keyboard disclosure did not close')
    results.push({ theme, initial, appended, expanded, closed })
  }
  return results
}
