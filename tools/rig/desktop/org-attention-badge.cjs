module.exports = async (page, { args }) => {
  // the rig browser draws the v2 header: the org list lives in the drawer
  await page.waitFor('.orgbar .iconbtn', { timeout: 60000 })
  const open = async () => {
    await page.click('.orgbar .iconbtn')
    await page.waitFor('.drawer .org', { timeout: 15000 })
    await page.sleep(500)
  }
  const rows = () => page.eval(() => [...document.querySelectorAll('aside.drawer .org')].map(r => ({
    name: r.querySelector('.org-name-text')?.textContent, cls: r.className,
    badge: r.querySelector('.org-attn-badge')?.textContent ?? null, spinner: !!r.querySelector('.cc-spin') })))
  await open()
  const r1 = await rows()
  await page.screenshot('1-dark')
  const rig = r1.find(r => r.name === 'Rig Org'), calm = r1.find(r => r.name === 'Calm Org')
  const out = {
    rigRowLit: !!rig?.cls.includes('attn'), rigBadge3: rig?.badge === '3', rigNoSpinner: rig && !rig.spinner,
    calmRowPlain: !!calm && !calm.cls.includes('attn'), calmNoBadge: !!calm && calm.badge === null,
  }
  await page.press('Escape')
  await page.eval(() => { document.documentElement.classList.add('contrast-light') })
  await page.sleep(400)
  await open()
  const r2 = await rows()
  await page.screenshot('2-light')
  out.lightThemeBadge = r2.find(r => r.name === 'Rig Org')?.badge === '3'
  // resolve one item from outside: the number drops without reopening
  await page.api('POST', '/api/rig/tool', { org: args.org, agent: 'alice', tool: 'orgtree_work',
    args: { action: 'update', slug: 'attention-ticket', done_so_far: ['x'], working_on_next: ['y'], attention: false } })
  await page.waitFor(() => [...document.querySelectorAll('.org-attn-badge')].some(b => b.textContent === '2'), { timeout: 20000 }).catch(() => null)
  const r3 = await rows()
  await page.screenshot('3-after-clear')
  out.liveDrop2 = r3.find(r => r.name === 'Rig Org')?.badge === '2'
  out.detail = { r1, r2, r3 }
  return out
}
