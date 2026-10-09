// "Chat from your phone": how often the org window asks the engine about
// the phone while the panel is closed (review point 3). Counts the page's own
// requests to /api/desktop/phone* (Resource Timing) for `args.seconds` with
// the card showing, then again after the card is dismissed.
module.exports = async function (page, args) {
  const seconds = args.seconds || 60
  await page.waitFor('.phone-card.in-org', { timeout: 120000 })
  const count = async () => {
    await page.eval(() => { performance.setResourceTimingBufferSize(20000); performance.clearResourceTimings() })
    await new Promise(r => setTimeout(r, seconds * 1000))
    return page.eval(() => {
      const names = performance.getEntriesByType('resource').map(e => new URL(e.name).pathname)
      return {
        panel_state: names.filter(n => n === '/api/desktop/phone').length,
        card: names.filter(n => n === '/api/desktop/phone/card').length,
        all_requests: names.length,
      }
    })
  }
  const showing = await count()
  await page.screenshot('poll-card-showing')
  await page.click({ selector: '.phone-card button', text: '✕' })
  await page.waitFor('.phone-card', { gone: true, timeout: 15000 })
  const dismissed = await count()
  return { seconds, showing, dismissed }
}
