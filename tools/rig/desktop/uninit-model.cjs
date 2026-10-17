module.exports = async (page, { args }) => {
  const frames = async () => {
    await page.eval(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.sleep(150)
  }
  await page.goto(`/o/${args.org}`)
  await page.waitFor('.sq.user button.t-haiku', { timeout: 30000 })
  await page.eval(() => document.querySelector('.sq.user button.t-haiku').click())
  await page.waitFor('.df-name')
  await page.sleep(1500)
  await page.eval(() => {
    for (const [selector, text, proto] of [['.df-name', 'selected-sol', HTMLInputElement.prototype],
      ['.df-charter', 'Keep this charter when choosing a new model.', HTMLTextAreaElement.prototype]]) {
      const el = document.querySelector(selector)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await frames(); await page.screenshot('01-uninitialized')
  const hasIcon = await page.eval(() => !!document.querySelector('.df-head button.tier'))
  if (!hasIcon) return { hasIcon, reason: 'model icon is not an actionable control' }
  await page.click('.df-head button.tier')
  await page.waitFor('.draft-model-picker .hsof')
  await frames(); await page.screenshot('02-model-picker')
  const before = await page.api('GET', `/api/orgs/${args.org}`)
  await page.click('.draft-model-picker .hsof button.t-sol')
  await page.waitFor('.df-head button.t-sol')
  const staged = await page.eval(() => ({
    name: document.querySelector('.df-name').value, charter: document.querySelector('.df-charter').value,
    openai: document.querySelector('.sq.draft').classList.contains('prov-openai'),
  }))
  await frames(); await page.screenshot('03-selected-sol')
  await page.click('.df-foot button.primary')
  await page.waitFor('[data-copy-agent-name="selected-sol"]', { timeout: 15000 })
  return { hasIcon, before, staged }
}
