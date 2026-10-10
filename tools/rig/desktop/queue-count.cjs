// alice's desk with her mail held: the separator reads 1, then 3 after two more.
module.exports = async (page, { args }) => {
  const r = {}
  await page.waitFor('[data-first-use-agent="alice"]', { timeout: 60000 })
  await page.rightClick('[data-first-use-agent="alice"]')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  const sep = () => page.eval(() => document.querySelector('.pending-divider')?.textContent?.trim() ?? null)
  await page.waitFor(() => !!document.querySelector('.pending-divider'), { timeout: 60000 })
  await page.sleep(500)
  const one = await sep()
  r.oneWaiting = one === '1 queued / undelivered'
  await page.screenshot('1-one')
  for (const t of ['WAITING two', 'WAITING three']) {
    await page.api('POST', `/api/orgs/${args.org}/nodes/alice/message`, { text: t, notice: false })
  }
  await page.waitFor(() => /^3 queued/.test(document.querySelector('.pending-divider')?.textContent ?? ''), { timeout: 20000 }).catch(() => null)
  const live = /^3 queued/.test((await sep()) ?? '')
  if (!live) {
    // the open desk has not redrawn its pending list; a fresh load shows what is stored
    await page.goto(`/o/${args.org}`)
    await page.waitFor('[data-first-use-agent="alice"]', { timeout: 60000 })
    await page.rightClick('[data-first-use-agent="alice"]')
    await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
    await page.waitFor(() => !!document.querySelector('.pending-divider'), { timeout: 60000 })
    await page.sleep(1500)
  }
  const three = await sep()
  r.threeWaiting = three === '3 queued / undelivered'
  await page.screenshot('2-three')
  r.liveUpdate = live
  r.detail = { one, three, liveUpdate: live, bubbles: await page.eval(() => document.querySelectorAll('.pending').length) }
  return r
}
