// A first look at the canvas: screenshot, plus a summary of what the page shows.
module.exports = async (page, ctx) => {
  await page.waitFor('.sq.user', { timeout: 30000 })
  await page.sleep(1500)
  await page.screenshot('canvas')
  return page.eval(() => {
    const cards = [...document.querySelectorAll('.sq')].map((e) => ({
      cls: String(e.className).slice(0, 80),
      attrs: [...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`).slice(0, 6),
      text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    }))
    return { title: document.title, url: location.href, cards, bodyClass: document.body.className }
  })
}
