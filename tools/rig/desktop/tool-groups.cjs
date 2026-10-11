module.exports = async (page, { args }) => {
  const open = async name => {
    await page.goto(`/o/${args.org}`)
    await page.waitFor(`[data-copy-agent-name="${name}"]`)
    await page.rightClick(`[data-copy-agent-name="${name}"]`)
    await page.hover({selector:'button.ctxmenu-item',text:'^Open',regex:true})
    await page.click({selector:'button.ctxmenu-item',text:'desk',regex:true})
    await page.click(`button[aria-label="settings for ${name}"]`)
    await page.click({selector:'[role="tab"]',text:'^Scope$',regex:true})
    await page.waitFor('input[aria-label="Docket work"]')
  }
  const snapshot = () => page.eval(() => Array.from(document.querySelectorAll('input[role="switch"]'))
    .map(e => ({label:e.getAttribute('aria-label'),checked:e.checked,disabled:e.disabled})))
  await open('boss')
  const before = await snapshot()
  await page.click('input[aria-label="Docket work"]')
  await page.screenshot('scope-docket-off')
  await page.click({selector:'button',text:'^save$',regex:true,scroll:true})
  await page.waitFor('input[aria-label="Docket work"]',{gone:true})
  await open('boss')
  const saved = await snapshot()
  await open('alice')
  const inherited = await snapshot()
  await page.screenshot('scope-inherited')
  return {before,saved,inherited}
}
