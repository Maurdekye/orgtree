// The canvas hire-token row on the user's card: screenshot and the letters it shows.
module.exports = async (page) => {
  await page.waitFor('.sq.user', { timeout: 30000 })
  await page.sleep(2500)
  const tokens = await page.eval(() => [...document.querySelectorAll('.sq.user button, .sq.user [class*="tier"], .sq.user [class*="hire"]')]
    .map((e) => ({ cls: String(e.className).slice(0, 60), text: (e.innerText || '').trim().slice(0, 12), title: e.getAttribute('title') || '' }))
    .filter((t) => t.text && t.text.length <= 2))
  await page.screenshot('hire-tokens')
  return { tokens }
}
