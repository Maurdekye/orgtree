// Real renderer: status at normal/far zoom and in the Agents list.
module.exports = async (page) => {
  const card = '.sq[data-copy-agent-name="kim"]'
  await page.waitFor(card, { timeout: 30000 })
  await page.sleep(800)
  for (let i = 0; i < 16; i++) {
    if (await page.eval(sel => document.querySelector(sel)?.classList.contains('norm'), card)) break
    await page.click('.zoomhud button[title="zoom in"]')
    await page.sleep(200)
  }
  await page.waitFor(`${card}.norm`)
  const near = await page.eval(sel => {
    const e = document.querySelector(sel)
    return { text: e.querySelector('.sq-workstate')?.textContent,
      snowflake: !!e.querySelector('.badge.frozen svg'),
      halted: document.querySelector('.sq[data-copy-agent-name="alice"] .sq-workstate')?.textContent }
  }, card)
  await page.screenshot('frozen-near')
  for (let i = 0; i < 20; i++) {
    if (await page.eval(sel => document.querySelector(sel)?.classList.contains('mini'), card)) break
    await page.click('.zoomhud button[title="zoom out"]')
    await page.sleep(200)
  }
  await page.waitFor(`${card}.mini`)
  const far = await page.eval(() => ({
    frozen: !!document.querySelector('.sq[data-copy-agent-name="kim"] .sq-far-icon.frozen'),
    halted: !!document.querySelector('.sq[data-copy-agent-name="alice"] .sq-far-icon.halted'),
  }))
  await page.screenshot('frozen-far')
  await page.click('.tray-toggle')
  await page.waitFor('.tray .tray-row')
  await page.sleep(300)
  const list = await page.eval(() => Object.fromEntries([...document.querySelectorAll('.tray-row')]
    .map(e => [e.getAttribute('data-copy-agent-name'), e.querySelector('.tray-main')?.textContent])))
  await page.screenshot('frozen-agents-list')
  return { near, far, list }
}
