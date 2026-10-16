// tools/rig/desktop/run-on-startup.cjs — App settings › Runtime › Desktop's
// "run on boot" switch (it was "run on startup") in the real renderer (proofs/run-on-startup.mjs runs
// it). The rig has no main process, so a bridge is planted once the app has
// loaded (the panel reads it when it mounts; every other call resolves to
// null): its setPreferences stands in for main's change, which on an
// all-users Windows installation goes through a Windows permission prompt. The
// first change is declined (main's error), the second is accepted. Each state
// is a screenshot.
module.exports = async (page, { args }) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 60000 })
  await page.eval(() => {
    let prefs = { startAtLogin: true, exitOnClose: false, automaticUpdates: true, routineNotifications: false, notificationsEnabled: true }
    window.__decline = true
    window.__writes = []
    const known = {
      getPreferences: async () => prefs,
      setPreferences: async patch => {
        window.__writes.push(patch)
        if ('startAtLogin' in patch && window.__decline) throw new Error('Windows did not give permission, so Orgtree still runs on boot.')
        prefs = { ...prefs, ...patch }
        return prefs
      },
      onEvent: () => () => {},
      getUpdateCapability: async () => ({ unattendedInstall: true, installDirectory: 'C:\\Program Files\\Orgtree' }),
      getRunAsAdministrator: async () => ({ available: true, enabled: false }),
      getStartupKind: async () => 'boot',
    }
    window.orgtreeDesktop = new Proxy(known, {
      get(t, k) {
        if (k in t) return t[k]
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined
        return () => Promise.resolve(null)
      },
    })
  })
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'runtime' } })))
  const SWITCH = 'input[aria-label="run on boot"]'
  await page.waitFor(SWITCH, { timeout: 20000 })
  await page.sleep(500)
  const read = () => page.eval(() => {
    const input = document.querySelector('input[aria-label="run on boot"]')
    const row = input?.closest('.set-row')
    return {
      checked: !!input?.checked,
      label: row?.querySelector('.set-label')?.textContent ?? null,
      hint: row?.parentElement?.textContent ?? '',
      alert: [...document.querySelectorAll('[role="alert"]')].map(a => a.textContent.trim()).join(' | '),
      oldLabel: [...document.querySelectorAll('input[role="switch"]')].some(i => /start at login|run on startup/i.test(i.getAttribute('aria-label') || '')),
      engineChoice: !!document.querySelector('select[aria-label="Where the background engine starts"]'),
    }
  })
  const before = await read()
  await page.screenshot('01-run-on-boot-on')

  await page.click(SWITCH)
  await page.waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(a => a.textContent.includes('Windows did not give permission')), { timeout: 10000 })
  await page.sleep(300)
  const declined = await read()
  await page.screenshot('02-permission-declined')

  await page.eval(() => { window.__decline = false })
  await page.click(SWITCH)
  await page.waitFor(() => !document.querySelector('input[aria-label="run on boot"]')?.checked, { timeout: 10000 })
  await page.sleep(300)
  const off = await read()
  await page.screenshot('03-run-on-boot-off')
  const writes = await page.eval(() => window.__writes)
  await page.eval(() => { delete window.orgtreeDesktop })
  return { before, declined, off, writes }
}
