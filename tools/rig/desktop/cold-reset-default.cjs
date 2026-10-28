// cold-reset-default.mjs's desk stage, on an org with no reset setting of its
// own. Open/close leaves untouched fields at their effective ON/25% default.
// Reopen, switch OFF (occupancy hidden), then ON, waiting for each real edit
// to auto-save. Reports UI and persisted values; the proof decides what passes.
module.exports = async (page, { org }) => {
  await page.waitFor('.sq.user')
  const open = async () => {
    await page.rightClick('.sq.user')
    await page.click({ selector: 'button.ctxmenu-item', text: 'Org settings' })
    await page.waitFor('#org-settings-tab-policies')
    await page.click('#org-settings-tab-policies')
    await page.waitFor('input[role="switch"][aria-label="Reset a session before a known-cold turn"]')
  }
  // Org settings has no footer Close (USER 2026-10-28 m3291e5890d55): Escape closes it.
  const close = async () => {
    await page.press('Escape')
    await page.waitFor('#org-settings-tab-policies', { gone: true })
  }
  // page.waitFor executes this in the renderer, so read its own fixture org.
  // Local React state and a toast cannot prove that the write reached the engine.
  const persisted = async () => {
    const slug = decodeURIComponent(location.pathname.split('/')[2])
    const response = await fetch(`/api/orgs/${encodeURIComponent(slug)}`)
    if (!response.ok) throw new Error(`read reset setting: HTTP ${response.status}`)
    const acc = (await response.json()).auto_cheap_compact
    const on = document.querySelector('input[role="switch"][aria-label="Reset a session before a known-cold turn"]')?.checked
    return acc?.enabled === on && acc?.occ === 0.25 && Object.keys(acc).length === 2 ? acc : null
  }
  await open()
  await page.screenshot('opened')
  await close()
  const untouched = (await page.api('GET', `/api/orgs/${encodeURIComponent(org)}`))?.auto_cheap_compact
  await open()
  const before = await page.eval(() => ({
    on: document.querySelector('input[role="switch"][aria-label="Reset a session before a known-cold turn"]')?.checked ?? null,
    occ: document.querySelector('input[aria-label="Cheap compaction context occupancy percent"]')?.value ?? null,
  }))
  // Exercise both explicit choices: a blind initial toggle now turns the
  // signed ON default OFF and would wait forever for its hidden field.
  await page.click('input[role="switch"][aria-label="Reset a session before a known-cold turn"]')
  await page.waitFor(() => !document.querySelector('input[aria-label="Cheap compaction context occupancy percent"]'))
  const savedOff = await page.waitFor(persisted, { timeout: 15000 })
  const off = await page.eval(() => ({
    on: document.querySelector('input[role="switch"][aria-label="Reset a session before a known-cold turn"]')?.checked ?? null,
    occ: document.querySelector('input[aria-label="Cheap compaction context occupancy percent"]')?.value ?? null,
  }))
  off.saved = savedOff
  await page.screenshot('reset-off')
  await page.click('input[role="switch"][aria-label="Reset a session before a known-cold turn"]')
  await page.waitFor('input[aria-label="Cheap compaction context occupancy percent"]')
  const savedOn = await page.waitFor(persisted, { timeout: 15000 })
  const shown = await page.eval(() => document.querySelector('input[aria-label="Cheap compaction context occupancy percent"]')?.value ?? null)
  await page.screenshot('reset-on')
  await close()
  return { untouched, before, off, shown, savedOn }
}
