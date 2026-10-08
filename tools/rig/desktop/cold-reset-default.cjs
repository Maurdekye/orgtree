// cold-reset-default.mjs's desk stage, on an org with no reset setting of its
// own. The Org settings panel is opened from the eye's context menu and saved
// untouched. Then it is opened again, the reset switched on, and the
// occupancy it shows is read before cancelling. Reports what it saw; the
// proof decides what passes.
module.exports = async (page) => {
  await page.waitFor('.sq.user')
  const open = async () => {
    await page.rightClick('.sq.user')
    await page.click({ selector: 'button.ctxmenu-item', text: 'Org settings' })
    await page.waitFor('#org-settings-tab-policies')
  }
  const toastSaved = () => [...document.querySelectorAll('.toast')].some((t) => /settings saved/.test(t.textContent))
  await open()
  await page.screenshot('opened')
  await page.click({ selector: 'button.primary', text: 'save', scroll: true })
  await page.waitFor(toastSaved, { timeout: 15000 })
  await page.sleep(1000)
  await open()
  await page.click('#org-settings-tab-policies')
  await page.waitFor('input[role="switch"][aria-label="reset a session before a known-cold turn"]')
  const before = await page.eval(() => ({
    on: document.querySelector('input[role="switch"][aria-label="reset a session before a known-cold turn"]')?.checked ?? null,
    occ: document.querySelector('input[aria-label="cheap compaction context occupancy percent"]')?.value ?? null,
  }))
  await page.click('input[role="switch"][aria-label="reset a session before a known-cold turn"]')
  await page.waitFor('input[aria-label="cheap compaction context occupancy percent"]')
  const shown = await page.eval(() => document.querySelector('input[aria-label="cheap compaction context occupancy percent"]')?.value ?? null)
  await page.screenshot('reset-on')
  await page.click({ selector: 'button', text: 'cancel', scroll: true })
  return { before, shown }
}
