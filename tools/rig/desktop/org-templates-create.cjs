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

module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE })
  await page.goto('/')
  await page.waitFor('.tp-cards .tp-card', { timeout: 30000 })
  await page.click('#shell-create-name')
  await page.type(args.name || 'Picked Team')
  await page.sleep(800)
  await page.click({ selector: '.tp-card .tp-name', text: `^${args.template.replace(/[()]/g, '\\$&')}$`, regex: true })
  await page.waitFor('.tp-preview table tbody tr', { timeout: 20000 })
  await page.sleep(1200)
  for (const [slot, tier] of Object.entries(args.overrides || {})) {
    // a native <select> popup cannot be driven; set it the way React reads it
    await page.eval((s, t) => {
      const el = document.querySelector(`select[aria-label="tier of ${s}"]`)
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      set.call(el, t)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, slot, tier)
    await page.sleep(700)
  }
  await page.sleep(1200)
  const read = () => page.eval(() => ({
    rows: [...document.querySelectorAll('.tp-preview tbody tr')].map((tr) => ({
      name: tr.querySelector('input')?.value,
      tier: tr.querySelector('select')?.value,
      blocked: tr.classList.contains('tp-blocked'),
      text: tr.innerText.replace(/\s+/g, ' ').trim(),
    })),
    top: document.querySelector('.tp-foot')?.innerText.replace(/\s+/g, ' ').trim(),
    kickoff: document.querySelector('.tp-kick input')?.checked ?? null,
    warn: [...document.querySelectorAll('.tp .ask-warn')].map((w) => w.innerText.trim()),
    createDisabled: [...document.querySelectorAll('button[type=submit]')].find((b) => /Create organization/.test(b.innerText))?.disabled,
  }))
  const before = await read()
  await page.screenshot(args.shot)
  let after = null
  if (args.create && !before.createDisabled) {
    await page.click({ selector: 'button[type=submit]', text: 'Create organization' })
    await page.sleep(4000)
    after = await page.eval(() => ({
      error: document.querySelector('.shell-create-error')?.innerText ?? null,
      bridge: window.__rigBridgeCalls,
    }))
    await page.screenshot(`${args.shot}-after`)
  }
  return { before, after }
}
