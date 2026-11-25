// The user's chats while an agent writes to the user (proofs/dm-typing-ui.mjs): opens the inbox (the chats
// panel), writes <out>/ready, then samples every 100 ms which chat rows show the "typing…" preview
// (.dm-row-typing) until the proof writes <out>/done. Returns the samples and screenshots on and off.
const fs = require('fs'), path = require('path')
module.exports = async (page, { out }) => {
  const inbox = await page.eval(() => {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const r = b.getBoundingClientRect(), label = [b.getAttribute('title'), b.getAttribute('aria-label')].join(' ')
      if (r.width && r.height && /your inbox/i.test(label)) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return null
  })
  if (!inbox) throw new Error('no inbox button')
  await page.mouse('mousePressed', inbox.x, inbox.y); await page.mouse('mouseReleased', inbox.x, inbox.y)
  await page.waitFor('.dm-list-rows', { timeout: 30000 })
  fs.writeFileSync(path.join(out, 'ready'), String(Date.now()))
  const samples = []
  let shotOn = false, until = Date.now() + 150000
  while (!fs.existsSync(path.join(out, 'done')) && Date.now() < until) {
    const rows = await page.eval(() => [...document.querySelectorAll('.dm-list-rows .dm-row-typing')]
      .map(t => (t.closest('[role="listitem"], .dm-row')?.querySelector('.dm-row-name')?.textContent || '?').trim()))
    samples.push({ at: Date.now(), typing: rows })
    if (rows.length && !shotOn) { shotOn = true; await page.screenshot('typing-on') }
    await page.sleep(100)
  }
  await page.screenshot('typing-off')
  return { samples }
}
