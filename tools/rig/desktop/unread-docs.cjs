// Unread presented documents: every card starts NEW, the one clicked clears,
// the others stay highlighted; the node chips on the canvas follow the same state.
module.exports = async (page, { args }) => {
  const card = '[data-first-use-agent="rhea"]'
  const marks = sel => [...document.querySelectorAll(sel)].map(e => e.dataset.docUnread || '')
  await page.waitFor(card)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.desk-docs .doc-badge')
  const before = await page.eval(marks, '.desk-docs .doc-badge')
  if (!before.length || before.some(m => m !== 'new')) throw Error('expected all new: ' + before)
  await page.screenshot('unread-header-before')
  await page.click('.desk-docs .doc-badge')
  await page.waitFor(() => document.querySelector('.gallery-modal')?.textContent.includes('Unique report body'))
  await page.press('Escape')
  await page.waitFor('.gallery-modal', { gone: true })
  const after = await page.eval(marks, '.desk-docs .doc-badge')
  if (after[0] !== '' || after.slice(1).some(m => m !== 'new')) throw Error('expected first cleared: ' + after)
  await page.screenshot('unread-header-after')
  for (let n = 0; n < 8; n++) {
    await page.click('button[title="zoom out"]')
    await page.sleep(350)
    if (await page.eval(() => !!document.querySelector('.doc-chips button.doc-chip'))) break
  }
  await page.waitFor('.doc-chips button.doc-chip')
  const chips = await page.eval(marks, '.doc-chips button.doc-chip')
  if (chips[0] !== '' || chips.slice(1).some(m => m !== 'new')) throw Error('chips: ' + chips)
  await page.screenshot('unread-node-chips')
  // a replace of the card the user already opened turns it UPDATED (duller),
  // and opening it clears it again; the unopened ones stay NEW
  await page.click('button[title="zoom in"]')
  for (let n = 0; n < 8; n++) {
    await page.sleep(350)
    if (await page.eval(() => !!document.querySelector('.desk-docs .doc-badge'))) break
    await page.click('button[title="zoom in"]')
  }
  await page.waitFor('.desk-docs .doc-badge')
  const list = await page.api('GET', `/api/orgs/${args.org}/documents?node=rhea`)
  const opened = list.documents.find(d => d.title === 'Report 3')
  const rep = await page.api('POST', '/api/rig/tool', { org: args.org, agent: 'rhea', tool: 'orgtree_present',
    args: { replaces: opened.id, title: 'Report 3 v2', body: '# Report 3 v2' + String.fromCharCode(10,10) + 'Unique report body 3 v2.' } })
  if (!rep.ok) throw Error(rep.text)
  await page.waitFor(() => [...document.querySelectorAll('.desk-docs .doc-badge')].some(e => e.dataset.docUnread === 'updated'), { timeout: 30000 })
  const updated = await page.eval(marks, '.desk-docs .doc-badge')
  if (updated[0] !== 'updated' || updated.slice(1).some(m => m !== 'new')) throw Error('updated: ' + updated)
  await page.screenshot('unread-header-updated')
  await page.click('.desk-docs .doc-badge')
  await page.waitFor(() => document.querySelector('.gallery-modal')?.textContent.includes('Unique report body 3 v2'))
  await page.press('Escape')
  await page.waitFor('.gallery-modal', { gone: true })
  const cleared = await page.eval(marks, '.desk-docs .doc-badge')
  if (cleared[0] !== '' || cleared.slice(1).some(m => m !== 'new')) throw Error('cleared: ' + cleared)
  return { before, after, chips, updated, cleared }
}
