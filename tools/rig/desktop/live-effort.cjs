// live-effort.mjs's desk stage: the agent's turn is running. Boss retools her
// effort to max (the rig's tool route, as boss's CLI would), then the user
// sets low with the composer's effort dots. Reports what the desk shows after
// each (next-turn effort cards, the effort button) and the toast; the proof
// decides what passes.
module.exports = async (page, { args }) => {
  const card = `[data-first-use-agent="${args.agent}"]`
  await page.waitFor(card)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.cc-head')
  await page.waitFor('.cc-send.stop', { timeout: 30000 })
  const read = () => page.eval(() => ({
    next: [...document.querySelectorAll('[data-next-turn="effort"]')].filter(e => e.getBoundingClientRect().width > 0)
      .map(e => ({ text: e.textContent, title: e.title })),
    button: document.querySelector('.cc-eff')?.textContent ?? null,
  }))
  const before = await read()
  await page.screenshot('before')
  const retool = await page.api('POST', '/api/rig/tool',
    { org: args.org, agent: args.boss, tool: 'orgtree_retool', args: { node: args.agent, effort: 'max' } })
  await page.waitFor(() => document.querySelector('.cc-eff')?.textContent === 'max', { timeout: 10000 }).catch(() => null)
  await page.sleep(1500)
  const afterRetool = await read()
  await page.screenshot('after-retool')
  await page.click('.cc-eff')
  await page.click('.eff-pop .eff-dot[title="low"]')
  const toast = await page.waitFor(() => [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    .find(t => t.includes('thinking effort: low')) || null, { timeout: 10000 })
  await page.sleep(1500)
  const afterComposer = await read()
  await page.screenshot('after-composer')
  return { before, retool, afterRetool, toast, afterComposer }
}
