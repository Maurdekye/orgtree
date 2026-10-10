// The Create organization window with a Starting layout picked. The rig has no
// desktop bridge, so a minimal one is planted before the page loads with the
// window identity "create" (the v3 shell's creation window); every other
// bridge call resolves to null.
// args: { shot, name, template, overrides?: {slot: tier}, create?: bool }
const BRIDGE = `
  (() => {
    const known = {
      windowIdentity: { windowId: 'rig-create', kind: 'create' },
      requestOrg: () => Promise.resolve(null),
      // the native side would bind this window to the new org; the rig keeps it here
      bindCreatedOrg: () => Promise.resolve({ action: 'pending' }),
      getWindowIdentity: () => Promise.resolve({ windowId: 'rig-create', kind: 'create' }),
    }
    window.__rigBridgeCalls = []
    window.orgtreeDesktop = new Proxy(known, {
      get(t, k) {
        if (k in t) return t[k]
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined
        return (...a) => { window.__rigBridgeCalls.push(k); return Promise.resolve(null) }
      },
    })
  })()`

// signin-checking: the Create window opened while the engine's first sign-in
// check is still running. The picker must say it is checking (never "needs a
// sign-in"), keep Create disabled, and fill in by itself once the check lands.
module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE })
  await page.goto('/')
  await page.waitFor('.tp-list .tp-row', { timeout: 30000 })
  await page.click('#shell-create-name')
  await page.type(args.name || 'Checking Team')
  await page.click({ selector: '.tp-row .tp-name', text: `^${args.template.replace(/[()]/g, '\$&')}$`, regex: true })
  await page.waitFor('.tp-preview table tbody tr', { timeout: 20000 })
  const read = () => page.eval(() => ({
    at: Date.now(),
    checking: document.querySelector('.tp-checking')?.innerText.trim() ?? null,
    rows: [...document.querySelectorAll('.tp-preview tbody tr')].map((tr) => ({
      tier: tr.querySelector('select')?.value,
      placeholder: tr.querySelector('select option[value=""]')?.innerText.trim() ?? null,
      text: tr.innerText.replace(/\s+/g, ' ').trim(),
    })),
    warn: [...document.querySelectorAll('.tp .ask-warn')].map((w) => w.innerText.trim()),
    createDisabled: [...document.querySelectorAll('button[type=submit]')].find((b) => /Create organization/.test(b.innerText))?.disabled,
  }))
  const during = await read()
  await page.screenshot(`${args.shot}-during`)
  // the picker asks again by itself; nothing here reloads it
  await page.waitFor(() => !document.querySelector('.tp-checking') && document.querySelector('.tp-preview tbody tr select')?.value,
    { timeout: 40000 })
  await page.sleep(500)
  const after = await read()
  await page.screenshot(`${args.shot}-after`)
  return { during, after }
}
