// "↑ you: ..." (jump to your message) from a desk sitting at the bottom of a long transcript:
// the view must land on the user's message and STAY there while new entries arrive.
// args: { org, agent, token }  (token: text of the user's first message)
module.exports = async (page, { args }) => {
  const card = `[data-first-use-agent="${args.agent}"]`
  await page.waitFor(card)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor(() => document.querySelector('.msgs')?.textContent.includes('Paragraph 35.'))
  await page.sleep(800)
  const atBottom = () => page.eval(() => { const s = document.querySelector('.msgs'); return s.scrollHeight - s.clientHeight - s.scrollTop < 3 })
  const before = await atBottom()
  await page.waitFor('.pinuser', { timeout: 20000 })
  await page.screenshot('before-jump')
  await page.click('.pinuser')
  const visible = () => page.eval((token) => {
    const s = document.querySelector('.msgs')
    const row = [...s.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').includes(token))[0]
    if (!row) return { found: false }
    const r = row.getBoundingClientRect(), sr = s.getBoundingClientRect()
    return { found: true, inView: r.bottom > sr.top && r.top < sr.bottom, top: Math.round(s.scrollTop), bottomGap: Math.round(s.scrollHeight - s.clientHeight - s.scrollTop) }
  }, args.token)
  const samples = []
  // new entries arrive while the jump settles
  await page.api('POST', `/api/orgs/${args.org}/nodes/${args.agent}/message`, { text: 'PROOF-MORE: another entry', notice: false })
  for (let i = 0; i < 12; i++) { await page.sleep(200); samples.push(await visible()) }
  await page.screenshot('after-jump')
  return { before, samples }
}
