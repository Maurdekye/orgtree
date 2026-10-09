// tools/rig/desktop/phone-link.cjs — "Chat from your phone" in the real
// renderer (proofs/phone-link-desktop.mjs runs it): the org window's card,
// the panel through T0 → T2, the firewall prompt's No and Yes (the desktop
// bridge's addPhoneFirewallRule is stubbed: the rig has no main process), the
// download code, Next, the setup code, a scripted phone (register through
// the door, then the first message with the code): "Waiting for your
// phone…", "Linked", App settings › Mail hub, Unlink → "Is this you?".
// Each state is a screenshot (the README's linking pictures come from here).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

module.exports = async (page, { org, args }) => {
  const seen = {}
  const status = v => fs.writeFileSync(path.join(args.tsDir, 'status.json'), JSON.stringify(v))
  const textIn = (sel, s) => () => (document.querySelector(sel)?.textContent || '').includes(s)
  const waitText = (sel, s, timeout = 30000) => page.waitFor(new Function(`return (${textIn.toString()})(${JSON.stringify(sel)}, ${JSON.stringify(s)})()`), { timeout })

  // the org window's card (the bar is met: a first message to a live top-level agent)
  await page.waitFor('.phone-card.in-org', { timeout: 60000 })
  await page.screenshot('01-card-org')
  seen.card = await page.eval(() => document.querySelector('.phone-card.in-org').textContent)
  await page.click({ selector: '.phone-card button', text: 'Connect your phone' })
  await page.waitFor('.phone-panel')
  await waitText('.phone-panel', 'Install Tailscale on this PC.')
  await page.screenshot('02-panel-tailscale-missing')

  // Tailscale signs in on this PC: the page updates by itself
  fs.copyFileSync(args.cliSrc, args.cliDst)
  status(args.running)
  await waitText('.phone-panel', 'Tailscale network.')
  await waitText('.phone-panel', 'Let your phone reach this PC.')
  await page.screenshot('03-panel-phone-access')

  // the prompt's No, then Yes (the stub stands in for main's UAC step)
  await page.eval(() => {
    window.__fw = []
    window.orgtreeDesktop = Object.assign(window.orgtreeDesktop || {}, {
      addPhoneFirewallRule: async scope => {
        window.__fw.push(scope)
        return window.__fw.length === 1 ? { ok: false, declined: true, error: 'Nothing changed: phone access stays as it was.' } : { ok: true }
      },
    })
  })
  await page.click({ selector: '.phone-panel button', text: 'Turn on phone access' })
  await waitText('.phone-panel', 'Nothing changed: phone access stays as it was.')
  await page.screenshot('04-prompt-declined')
  fs.writeFileSync(path.join(args.fwDir, 'rule.txt'), '100.64.0.0/10,fd7a:115c:a1e0::/48')
  await page.click({ selector: '.phone-panel button', text: 'Turn on phone access' })
  await waitText('.phone-panel', 'Phone access is on, for your Tailscale network only.')
  seen.fw = await page.eval(() => window.__fw)
  // drop the stub again: a partial bridge makes the rest of the app believe
  // it runs in the desktop shell (it would call onEvent and crash)
  await page.eval(() => { if (Object.keys(window.orgtreeDesktop || {}).length === 1) delete window.orgtreeDesktop })
  await page.screenshot('05-download-code')

  // one code at a time: Next swaps in the setup code
  await page.click({ selector: '.phone-panel button', text: 'I have Hubchat on my phone → Next' })
  await waitText('.phone-panel', 'Scan setup code')
  await page.waitFor('.phone-panel .phone-qrbox svg')
  await page.screenshot('06-setup-code')
  const st = await page.api('GET', `/api/desktop/phone?org=${encodeURIComponent(org)}`)
  const u = new URL(st.org.code.url)
  const door = u.searchParams.get('hub'), orgAddress = u.searchParams.get('org'), code = st.org.code.code
  seen.url = st.org.code.url
  // back and forth
  await page.click({ selector: '.phone-panel button', text: '← Back to the download code' })
  await waitText('.phone-panel', 'Scan to get Hubchat')
  await page.click({ selector: '.phone-panel button', text: 'I have Hubchat on my phone → Next' })
  await waitText('.phone-panel', 'Scan setup code')

  // the phone: Hubchat registers through the door, then sends the code
  const alex = { slug: `alex.${crypto.randomBytes(3).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }
  const call = async (method, route, body) => {
    const r = await fetch(door + route, { method, headers: { 'X-Org-Auth': `${alex.slug}:${alex.secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  const reg = await call('POST', '/api/register', { slug: alex.slug, org_name: 'Alex Rivera', username: 'alex', blurb: '', kind: 'person' })
  if (reg.status !== 200) throw Error('the phone could not register through the door: ' + JSON.stringify(reg))
  await waitText('.phone-panel', 'Waiting for your phone…')
  await page.screenshot('07-waiting')
  await call('POST', '/api/send', { id: `ph-${crypto.randomBytes(6).toString('hex')}`, to: orgAddress, from: alex.slug,
    body: `Hi! This is Hubchat on my phone.\n\nSetup code: ${code}`, kind: 'message', sent_at: new Date().toISOString(), attachments: [] })
  await waitText('.phone-panel', 'Linked: Alex Rivera', 60000)
  await waitText('.phone-panel', 'charter now says this address is you and carries your authority.')
  await page.screenshot('08-linked')
  await page.click({ selector: '.phone-panel button', text: 'Done' })
  await page.waitFor('.phone-panel', { gone: true })
  // well inside the card's own 15 s read: the panel's change event did it
  seen.cardAfterLink = await page.waitFor('.phone-card', { gone: true, timeout: 3000 }).then(() => false, () => true)

  // App settings › Mail hub: the group, linked
  await page.click('header.orgbar button.iconbtn')
  await page.click('button[title="App settings"]')
  await page.click({ selector: '[role="tab"]', text: 'Mail hub' })
  await waitText('.phone-settings', 'Linked: Alex Rivera')
  await page.screenshot('09-settings-linked')
  await page.click({ selector: '.phone-settings button', text: 'Manage' })
  await waitText('.phone-panel', 'Add another device:')
  await page.screenshot('10-manage-linked')
  await page.click({ selector: '.phone-panel button', text: 'Unlink' })
  await waitText('.phone-panel', 'Is this you?')
  await page.screenshot('11-is-this-you')
  return { ...seen, phone: alex.slug }
}
