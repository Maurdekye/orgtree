// quick-chat-positions.mjs's second desktop stage: the whole flow from the
// Attention view, where the box is the only way to start a chat (user
// 2026-10-10 19:23Z) and calls itself "New chat" (19:25Z). Type, pick the
// model and the superior, attach a file, send; the agent is hired and its chat
// opens and is focused right there, in the Attention view's desk panel, with
// its reply. Position = Top (the default).
// args: { org, theme, prompt, superiorFilter, file: { name, text } }
module.exports = async (page, { args }) => {
  const bridge = `
  (() => {
    try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}
    try { localStorage.removeItem('orgtree-quickchat-position') } catch {}
    const id = { windowId: 'rig-org', kind: 'org', org: ${JSON.stringify(args.org)} }
    const prefs = { contrastTheme: ${JSON.stringify(args.theme)} }
    window.orgtreeDesktop = {
      getAppVersion: async () => '4.2.0-rig',
      getPreferences: async () => prefs,
      setPreferences: async (patch) => Object.assign(prefs, patch),
      onEvent: () => () => {},
      windowIdentity: id,
      getWindowIdentity: async () => id,
      requestOrg: async () => null,
    }
  })()`
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bridge })
  await page.resize('1600x900')
  await page.goto(`/o/${args.org}`)
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  const box = '[data-testid="quickchat"]'
  const label = () => page.eval(() => {
    const i = document.querySelector('[data-testid="quickchat"] input.quickchat-input')
    return { placeholder: i?.placeholder, title: i?.title, aria: i?.getAttribute('aria-label') }
  })
  const onCanvas = await label()
  // into the Attention view
  await page.eval(() => document.querySelector('.shell-header button[role="switch"][aria-label="Attention view"]')?.click())
  await page.sleep(1000)
  const view = () => page.eval(() => ({
    attention: document.querySelector('.shell-header button[role="switch"][aria-label="Attention view"]')?.getAttribute('aria-checked'),
    stageOn: !!document.querySelector('.attn-stage:not(.attn-stage-off)'),
  }))
  const inAttention = { view: await view(), label: await label() }
  await page.screenshot(`${args.theme}-attention-empty`)
  // type
  await page.click(`${box} .quickchat-input`)
  await page.type(args.prompt)
  await page.sleep(500)
  const preview = await page.eval(() => document.querySelector('[data-testid="quickchat"] .quickchat-model .quickchat-name')?.textContent ?? null)
  // the model: haiku from the hire chips
  await page.eval(() => document.querySelector('[data-testid="quickchat"] .quickchat-model').click())
  await page.waitFor('.quickchat-pop.quickchat-pop-model .hsof button.t-haiku', { timeout: 10000 })
  await page.sleep(300)
  await page.screenshot(`${args.theme}-attention-model-picker`)
  await page.eval(() => document.querySelector('.quickchat-pop.quickchat-pop-model .hsof button.t-haiku').click())
  await page.sleep(400)
  // the superior: filter + ArrowDown + Enter
  await page.eval(() => document.querySelector('[data-testid="quickchat"] .quickchat-superior').click())
  await page.waitFor('.quickchat-pop-superior .tray-row', { timeout: 10000 })
  await page.sleep(300)
  await page.type(args.superiorFilter)
  await page.sleep(300)
  await page.screenshot(`${args.theme}-attention-superior-picker`)
  await page.press('ArrowDown')
  await page.press('Enter')
  await page.sleep(400)
  // one attached file, the way the file picker hands it over
  await page.eval((f) => {
    const input = document.querySelector('[data-testid="quickchat"] [data-testid="quickchat-files"]')
    const dt = new DataTransfer()
    dt.items.add(new File([f.text], f.name, { type: 'text/plain' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, args.file)
  await page.sleep(400)
  const chosen = await page.eval(() => ({
    model: [...(document.querySelector('[data-testid="quickchat"] .quickchat-model .tier')?.classList ?? [])].find((c) => c.startsWith('t-')),
    superior: document.querySelector('[data-testid="quickchat"] .quickchat-superior .quickchat-label')?.textContent,
    files: document.querySelector('[data-testid="quickchat"] .quickchat-count')?.textContent ?? null,
  }))
  await page.screenshot(`${args.theme}-attention-ready`)
  // send
  await page.click(`${box} .quickchat-input`)
  await page.press('Enter')
  // the new agent's chat opens in the Attention view's desk panel, with its reply
  const name = preview
  let desk = null
  for (let i = 0; i < 40; i++) {
    await page.sleep(500)
    desk = await page.eval(({ name, prompt }) => {
      const slot = document.querySelector('.attn-slot-desk')
      const text = slot?.innerText ?? ''
      return { present: !!slot, hasName: text.includes(name), hasPrompt: text.includes(prompt), hasReply: /\bOK\.?/.test(text),
        focusInDesk: !!(slot && slot.contains(document.activeElement)) }
    }, { name, prompt: args.prompt })
    if (desk.present && desk.hasName && desk.hasReply) break
  }
  const after = { view: await view(), box: await page.eval(() => document.querySelector('[data-testid="quickchat"] input')?.value) }
  await page.screenshot(`${args.theme}-attention-after-send`)
  return { onCanvas, inAttention, preview, chosen, desk, after, errors: page.consoleErrors }
}
