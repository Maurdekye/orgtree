// quick-chat.mjs's desktop stage: the header's Quick chat box as the user
// uses it. Reads the three buttons with no history, changes each inline
// (superior, effort, model from args), types the message and presses Enter,
// then reports which desk is in focus. The proof decides what passes.
// args: { superior, effort, model, message }
module.exports = async (page, { args }) => {
  await page.waitFor('[data-testid="quickchat"]', { timeout: 30000 })
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  const buttons = () => page.eval(() =>
    [...document.querySelectorAll('.quickchat-btn')].map(b => b.textContent.trim()))
  const initial = await buttons()
  await page.screenshot('1-header-no-history')
  const choose = async (button, label, shot) => {
    await page.click(button)
    await page.waitFor('.ctxmenu[role="menu"]')
    await page.sleep(300)
    if (shot) await page.screenshot(shot)
    const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')]
      .map(b => (b.innerText || '').trim()))
    await page.click({ selector: '.ctxmenu button.ctxmenu-item', text: `^${label}( ✓)?$`, regex: true })
    await page.sleep(300)
    return items
  }
  const superiorItems = await choose('.quickchat-superior', args.superior, '2-superior-menu')
  const effortItems = await choose('.quickchat-effort', args.effort, '3-effort-menu')
  const modelItems = await choose('.quickchat-model', args.model, '4-model-menu')
  const chosen = await buttons()
  await page.click('.quickchat-input')
  await page.type(args.message)
  await page.screenshot('5-typed')
  await page.press('Enter')
  // focused: a desk header naming the new agent is on screen
  const focused = await page.waitFor(() => {
    const heads = [...document.querySelectorAll('.cc-head')].filter(e => e.getBoundingClientRect().width > 0)
    return heads.map(e => (e.innerText || '').trim().replace(/\s+/g, ' ')).find(t => t.length) || null
  }, { timeout: 20000 }).catch(() => null)
  await page.sleep(2500)
  await page.screenshot('6-focused')
  const after = await page.eval(() => ({
    input: document.querySelector('.quickchat-input')?.value ?? null,
    buttons: [...document.querySelectorAll('.quickchat-btn')].map(b => b.textContent.trim()),
    heads: [...document.querySelectorAll('.cc-head')].filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160)),
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
  }))
  return { initial, superiorItems, effortItems, modelItems, chosen, focused, after, errors: page.consoleErrors }
}
