// tools/rig/desktop/run-on-startup.cjs — App settings › Runtime › Desktop's
// "run on boot" switch (it was "run on startup") in the real renderer (proofs/run-on-startup.mjs runs
// it). The rig has no main process, so a bridge is planted once the app has
// loaded (the panel reads it when it mounts; every other call resolves to
// null): its setPreferences stands in for main's change, which on an
// all-users Windows installation goes through a Windows permission prompt. The
// first change is declined (main's error), the second is accepted. Each state
// is a screenshot.
//
// A bridge planted after load has no window identity, so it must not claim the
// v3 native-window model either. nativeWindows() (renderer src/desktop.ts) is
// `requestOrg`, and App reads it at every render: answering it bound the window
// to no organization once the panel opened, so the canvas went blank (already
// at v4.3.3) and, since App settings opens per organization (b0aa671), the
// panel closed too (4.4.0 hardening, 2026-10-22). The three members other desk
// scripts plant to make a v3 window are absent here.
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
    const v3Window = ['requestOrg', 'windowIdentity', 'getWindowIdentity']
    window.orgtreeDesktop = new Proxy(known, {
      get(t, k) {
        if (k in t) return t[k]
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON' || v3Window.includes(k)) return undefined
        return () => Promise.resolve(null)
      },
    })
  })
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'runtime' } })))
  const SWITCH = 'input[aria-label="Run on boot"]'
  await page.waitFor(SWITCH, { timeout: 20000 })
  await page.sleep(500)
  const read = () => page.eval(() => {
    const input = document.querySelector('input[aria-label="Run on boot"]')
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
  await page.waitFor(() => !document.querySelector('input[aria-label="Run on boot"]')?.checked, { timeout: 10000 })
  await page.sleep(300)
  const off = await read()
  await page.screenshot('03-run-on-boot-off')
  const writes = await page.eval(() => window.__writes)
  await page.eval(() => { delete window.orgtreeDesktop })
  return { before, declined, off, writes }
}
