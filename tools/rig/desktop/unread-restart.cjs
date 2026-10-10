// Read marks across a restart: phase 'open' opens the first of three NEW cards;
// phase 'check' (a new Electron run on the SAME profile, after the engine restarted)
// finds that card still read and the other two still NEW.
module.exports = async (page, { args }) => {
  const card = '[data-first-use-agent="rhea"]'
  const marks = sel => [...document.querySelectorAll(sel)].map(e => e.dataset.docUnread || '')
  await page.waitFor(card)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.desk-docs .doc-badge')
  const seen = await page.eval(marks, '.desk-docs .doc-badge')
  if (args.phase === 'open') {
    if (seen.some(m => m !== 'new')) throw Error('expected all new: ' + seen)
    await page.click('.desk-docs .doc-badge')
    await page.waitFor(() => document.querySelector('.gallery-modal')?.textContent.includes('Unique report body'))
    await page.press('Escape')
    await page.waitFor('.gallery-modal', { gone: true })
    // the localStorage write is debounced before it reaches disk: let it land
    await page.sleep(1500)
    const after = await page.eval(marks, '.desk-docs .doc-badge')
    return { seen, after, stored: await page.eval(() => Object.keys(localStorage).filter(k => k.includes('docs-viewed')).map(k => [k, localStorage.getItem(k)])) }
  }
  const stored = await page.eval(() => Object.keys(localStorage).filter(k => k.includes('docs-viewed')).map(k => [k, localStorage.getItem(k)]))
  const ids = await page.eval(() => [...document.querySelectorAll('.desk-docs .doc-badge')].map(e => e.title))
  await page.screenshot('unread-restart-check')
  if (seen[0] !== '' || seen.slice(1).some(m => m !== 'new')) throw Error('after restart: ' + JSON.stringify({ seen, stored, ids }))
  return { seen, stored, ids }
}
