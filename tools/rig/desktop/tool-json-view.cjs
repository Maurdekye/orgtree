// alice's desk: expand a nested-input tool, a large-output tool, toggle Raw.
module.exports = async (page) => {
  const r = {}
  await page.waitFor('.sq.user', { timeout: 30000 })
  await page.rightClick('[data-first-use-agent="alice"]')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.tchip .tline')
  const chip = name => ({ selector: '.tchip .tline', text: '^\W*' + name + ' ', regex: true })
  await page.click(chip('Task'))
  await page.waitFor('.toolinput .sj .sj-key')
  r.nestedKeys = await page.eval(() => [...document.querySelectorAll('.toolinput .sj-key')].map(k => k.textContent).join(',') .includes('filters'))
  r.textBlock = await page.eval(() => !!document.querySelector('.toolinput .sj-text'))
  r.outputStructured = await page.eval(() => !!document.querySelector('.respre-json .sj .sj-key'))
  await page.screenshot('nested-input')
  await page.click({ selector: '.toolinput .sj-raw' })
  r.rawShown = await page.eval(() => /"filters"/.test(document.querySelector('.toolinput .sj-rawpre')?.textContent ?? ''))
  await page.screenshot('raw-toggle')
  await page.click({ selector: '.toolinput .sj-raw' })
  await page.click(chip('Grep'))
  await page.waitFor('.respre-json .sj .sj-key')
  r.largeCollapsed = await page.eval(() => {
    const b = [...document.querySelectorAll('.respre-json .sj')].find(x => x.querySelector('.sj-key')?.textContent === 'items')
    if (!b) return false
    const keys = [...b.querySelectorAll('.sj-key')].map(k => k.textContent)
    return keys.length > 50 && !keys.includes('i') && /truncated/.test(b.textContent)
  })
  await page.screenshot('large-output')
  await page.click(chip('Read'))
  await page.waitFor('.respre')
  r.plainUnchanged = await page.eval(() => [...document.querySelectorAll('pre.respre')].some(p => p.textContent.includes('PLAIN TEXT RESULT')))
  return r
}
