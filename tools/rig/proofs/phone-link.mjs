// "Chat from your phone" (docket orgtree-4-1-chat-from-your-phone-linking-flow-or),
// engine side, through the real engine and the rig's fake Tailscale CLI
// (bin\tailscale.cmd, scripted through rig-home\rig-tailscale).
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { RIG_DIR } from '../lib.mjs'

export async function setup() {
  return { hub: true, fixture: { org: { name: 'My Org' },
    agents: [{ name: 'lead', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

export default async function (rig) {
  const p = new Proof('phone-link')
  const tsDir = path.join(rig.data, 'rig-home', 'rig-tailscale')
  // the slow facts (read once a minute): mains sleep after 30 min, Tailscale
  // not unattended, Hubchat installed on this PC
  const rigHome = path.join(rig.data, 'rig-home')
  fs.mkdirSync(path.join(rigHome, 'rig-power'), { recursive: true })
  fs.writeFileSync(path.join(rigHome, 'rig-power', 'ac-sleep-seconds'), '1800')
  fs.mkdirSync(tsDir, { recursive: true })
  fs.writeFileSync(path.join(tsDir, 'prefs.json'), JSON.stringify({ ForceDaemon: false }))
  fs.writeFileSync(path.join(rigHome, 'rig-hubchat-installed'), '')
  const cli = path.join(rig.dir, 'bin', 'tailscale.cmd')
  fs.mkdirSync(tsDir, { recursive: true })
  const status = v => {
    const f = path.join(tsDir, 'status.json')
    if (v === null) fs.rmSync(f, { force: true })
    else fs.writeFileSync(f, JSON.stringify(v))
  }
  // the engine reuses one reading for 2 s
  const phone = async () => { await sleep(2200); return rig.api('GET', '/api/desktop/phone') }
  const running = (extra = {}) => ({
    BackendState: 'Running',
    Self: { HostName: 'home-pc', DNSName: 'home-pc.tail1234.ts.net.', UserID: 7, TailscaleIPs: ['127.0.0.2', 'fd7a:115c:a1e0::2'],
            KeyExpiry: '2027-04-07T10:00:00Z', ...extra },
    User: { 7: { LoginName: 'alex@gmail.com' } },
    CurrentTailnet: { Name: 'alex@gmail.com' },
  })

  // ---- T: Tailscale on this PC
  fs.rmSync(cli)
  let s = await phone()
  p.check('T0: no Tailscale CLI → not installed', s.tailscale?.state === 'T0', s.tailscale)
  fs.copyFileSync(path.join(RIG_DIR, 'fake-tailscale.cmd'), cli)
  status(null)
  s = await phone()
  p.check('T1: CLI installed, its service not answering', s.tailscale?.state === 'T1' && s.tailscale.backend === 'NoDaemon' && /daemon/.test(s.tailscale.error || ''), s.tailscale)
  status({ BackendState: 'NeedsLogin', Self: { HostName: 'home-pc', TailscaleIPs: [] } })
  s = await phone()
  p.check('T1: signed out (NeedsLogin)', s.tailscale?.state === 'T1' && s.tailscale.backend === 'NeedsLogin' && !s.tailscale.account && !s.tailscale.ipv4, s.tailscale)
  status({ BackendState: 'Stopped', Self: { HostName: 'home-pc', TailscaleIPs: ['127.0.0.2'] } })
  s = await phone()
  p.check('T1: switched off (Stopped)', s.tailscale?.state === 'T1' && s.tailscale.backend === 'Stopped' && !s.tailscale.ipv4, s.tailscale)
  status(running())
  s = await phone()
  const t = s.tailscale || {}
  p.check('T2: signed in: account, PC name, address, key expiry', t.state === 'T2' && t.account === 'alex@gmail.com' && t.pc === 'home-pc'
    && t.ipv4 === '127.0.0.2' && t.dns === 'home-pc.tail1234.ts.net' && t.key_expiry === '2027-04-07T10:00:00Z', t)
  const calls = fs.readFileSync(path.join(tsDir, 'calls.log'), 'utf8').trim().split(/\r?\n/)
  p.check('only read-only Tailscale commands were run (status --json, debug prefs)', calls.length >= 4
    && calls.every(c => ['status --json', 'debug prefs'].includes(c.trim())), calls)

  // ---- A: phone access (the hub's relay-only door); the firewall rule is
  // the desktop's (behind its admin prompt): here a mock it would have written
  const fwDir = path.join(rig.data, 'rig-home', 'rig-firewall')
  fs.mkdirSync(fwDir, { recursive: true })
  const rule = v => v === null ? fs.rmSync(path.join(fwDir, 'rule.txt'), { force: true }) : fs.writeFileSync(path.join(fwDir, 'rule.txt'), v)
  const turnOn = (body) => rig.api('POST', '/api/desktop/phone/access', body).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e.message || e) }))
  const doorAnswers = async (host) => {
    try { const r = await fetch(`http://${host}:7371/healthz`, { signal: AbortSignal.timeout(3000) }); return r.status } catch { return 0 }
  }
  s = await phone()
  p.check('A0 at first: the door is closed, no firewall rule', s.access?.state === 'A0' && !s.access.door && !s.access.firewall && s.keep_awake === true, s.access)

  status({ BackendState: 'NeedsLogin', Self: { HostName: 'home-pc', TailscaleIPs: [] } })
  await sleep(2200)
  let r = await turnOn({ scope: 'tailnet' })
  p.check('Turn on is refused while Tailscale is not connected', !r.ok && /not connected/.test(r.e), r)

  status(running())
  await sleep(2200)
  rule('100.64.0.0/10,fd7a:115c:a1e0::/48')
  r = await turnOn({ scope: 'tailnet', keep_awake: false })
  s = r.v || {}
  const hosting = JSON.parse(fs.readFileSync(path.join(rig.data, 'mailhub-hosting.json'), 'utf8'))
  p.check('A1 for the Tailscale network, the door bound to the 100.x address only', r.ok && s.access?.state === 'A1'
    && s.access.scope === 'tailnet' && s.access.door === '127.0.0.2' && hosting.public_listener === true && hosting.public_scope === 'tailnet', { r, hosting })
  p.check('the rule read back is the one this scope wants', s.access?.firewall === '100.64.0.0/10,fd7a:115c:a1e0::/48'
    && s.access.firewall_wanted === s.access.firewall, s.access)
  p.check('keep-awake saved as chosen', JSON.parse(fs.readFileSync(path.join(rig.data, 'phone.json'), 'utf8')).keep_awake === false)
  p.check('the door answers on the Tailscale address and not on 127.0.0.1', (await doorAnswers('127.0.0.2')) > 0 && (await doorAnswers('127.0.0.1')) === 0)

  status(running({ TailscaleIPs: ['127.0.0.3'] }))
  s = await phone()
  s = await phone()
  p.check('Tailscale address moved: the hub restarts and the door follows it', s.access.door === '127.0.0.3' && (await doorAnswers('127.0.0.3')) > 0
    && (await doorAnswers('127.0.0.2')) === 0, s.access)

  status({ BackendState: 'NeedsLogin', Self: { HostName: 'home-pc', TailscaleIPs: [] } })
  s = await phone()
  s = await phone()
  p.check('Tailscale signed out: the door closes, waiting; the hub keeps running', !s.access.door && s.access.door_waiting === true
    && s.hub.running === true && (await doorAnswers('127.0.0.3')) === 0, s)

  status(running())
  s = await phone()
  s = await phone()
  p.check('Tailscale back: the door opens again', s.access.door === '127.0.0.2' && !s.access.door_waiting, s.access)

  await rig.api('PUT', '/api/desktop/hub', { public_scope: 'all' })
  s = await phone()
  p.check('A2: on for every network (the hub settings switch)', s.access.state === 'A2' && s.access.door === '127.0.0.1', s.access)
  r = await turnOn({ scope: 'tailnet' })
  p.check('Limit it to Tailscale: A2 → A1', r.ok && r.v.access.state === 'A1' && r.v.access.scope === 'tailnet' && r.v.access.door === '127.0.0.2', r)

  rule('LocalSubnet')
  r = await turnOn({ scope: 'lan' })
  p.check('Use my home Wi-Fi instead: A1 for the home network, the rule it wants is the local subnet', r.ok && r.v.access.scope === 'lan'
    && r.v.access.firewall_wanted === 'LocalSubnet' && r.v.access.state === 'A1', r)
  r = await turnOn({ scope: 'everyone' })
  p.check('an unknown scope is refused', !r.ok && /scope must be tailnet or lan/.test(r.e), r)
  rule('100.64.0.0/10,fd7a:115c:a1e0::/48')
  await turnOn({ scope: 'tailnet' })

  // ---- L: the setup code, the link, the trust note
  const org = rig.org
  const q = s => s.replace(/'/g, "''")
  const tryApi = (method, route, body) => rig.api(method, route, body).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e.message || e) }))
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(rig.data, 'phone.json'), 'utf8'))
  const orgState = () => rig.api('GET', `/api/desktop/phone?org=${encodeURIComponent(org)}`)
  r = await tryApi('POST', '/api/desktop/phone/code', { org })
  p.check('no setup code while the org is not on this computer\'s hub', !r.ok && /isn't connected to this computer's mail hub/.test(r.e), r)
  await rig.api('POST', `/api/orgs/${org}/settings`, { net_autoconnect: true })
  await rig.waitFor(() => rig.api('GET', `/api/orgs/${org}`).then(t => (t.net?.hubs ?? []).find(h => h.connected)), { what: 'the org to register on the rig hub', timeout: 90000 })
  const original = '# My Org\nWe research and summarize papers for Alex.\nKeep answers short; link sources.\n'
  await rig.api('PUT', `/api/orgs/${org}/orgmd`, { content: original })
  const orgmd = () => fs.readFileSync(path.join(rig.data, 'workspaces', org, 'org.md'), 'utf8')
  const orgAddress = rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${q(org)}'`).s

  const minted = await rig.api('POST', '/api/desktop/phone/code', { org })
  const u = new URL(minted.url)
  const qp = Object.fromEntries(u.searchParams)
  p.check('the setup QR link: hubchat://setup v1 with the door, org, names, Tailscale account, code and net', u.protocol === 'hubchat:' && u.host === 'setup'
    && qp.v === '1' && qp.hub === 'http://127.0.0.2:7371' && qp.org === orgAddress && qp.orgname === 'My Org' && qp.hubname === 'rig hub'
    && qp.pc === 'home-pc' && qp.ts === 'alex@gmail.com' && qp.net === 'tailscale' && qp.code === minted.code && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(minted.code), { url: minted.url })
  s = await orgState()
  p.check('the panel state shows the live code, not yet waiting', s.org?.code?.code === minted.code && s.org.code.waiting === false && s.link === null
    && s.download_url === 'https://github.com/Maurdekye/orgtree-hubchat/releases/latest/download/Hubchat-android.apk', s.org)

  // a scripted phone: Hubchat registers as a person through the door named in the QR
  const door = qp.hub
  const phoneCall = async (auth, method, route, body) => {
    const res = await fetch(door + route, { method, headers: { 'X-Org-Auth': `${auth.slug}:${auth.secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const crypto = await import('node:crypto')
  const alex = { slug: `alex.${crypto.randomBytes(3).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }
  const reg = await phoneCall(alex, 'POST', '/api/register', { slug: alex.slug, org_name: 'Alex Rivera', username: 'alex', blurb: '', kind: 'person' })
  p.check('the phone registers as a person through the Tailscale-only door', reg.status === 200 && reg.json?.ok === true, reg)
  s = await orgState()
  p.check('a person appearing after the code was shown: "Waiting for your phone…"', s.org?.code?.waiting === true && s.org.persons.some(x => x.address === alex.slug), s.org)
  const send = (auth, body) => phoneCall(auth, 'POST', '/api/send', { id: `ph-${crypto.randomBytes(6).toString('hex')}`, to: orgAddress, from: auth.slug,
    body, kind: 'message', sent_at: new Date().toISOString(), attachments: [] })
  const answers = async (auth, token) => rig.waitFor(async () => {
    const r = await phoneCall(auth, 'POST', '/api/poll?wait=5')
    const m = r.json?.messages?.find(m => m.body.includes(token))
    if (m) await phoneCall(auth, 'POST', '/api/ack', { ids: [m.id] })
    return m ?? null
  }, { what: `the phone to get "${token}"`, timeout: 60000 })
  const lower = minted.code.replace('-', '').toLowerCase()
  const sent = await send(alex, `Hi! This is Hubchat on my phone.\n\nSetup code: ${lower}\n`)
  const linked = await answers(alex, `Setup code: ${minted.code} linked`)
  p.check('the first message with the code: the org answers "Setup code: X linked" (final line)', sent.status === 200
    && linked.body.trimEnd().split('\n').pop() === `Setup code: ${minted.code} linked` && linked.from === orgAddress, linked.body)
  const rec = settingsFile().link
  p.check('the link record: org, address, the person\'s name, via the code', rec?.org === org && rec.address === alex.slug && rec.name === 'Alex Rivera' && rec.via === 'code', rec)
  const md = orgmd()
  p.check('the trust note is at the very top of org.md, marked, and the charter follows unchanged', md === '<!-- added by Connect your phone; Unlink removes it -->\n'
    + `@net:${alex.slug} is the user's account and carries their authority.\n<!-- end -->\n\n` + original, md)
  const inbound = await rig.waitFor(() => rig.one(`SELECT body FROM ot.org_inbox WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${q(org)}') AND dir = 'in' AND body LIKE 'Hi! This is Hubchat%'`),
    { what: 'the first message in the org inbox' })
  p.check('the first message still reaches the org (its agents read it)', !!inbound)
  const reply = rig.one(`SELECT by_name, body FROM ot.org_inbox WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${q(org)}') AND dir = 'out' AND body LIKE '%Setup code: ${minted.code} linked'`)
  p.check('the answer is in the org inbox as sent by orgtree', reply?.by_name === 'orgtree', reply)

  await send(alex, `again\nSetup code: ${minted.code}`)
  const replay = await answers(alex, `Setup code: ${minted.code} expired`)
  p.check('the same code again: "expired", the link unchanged', !!replay && settingsFile().link?.address === alex.slug, replay?.body)
  s = await orgState()
  r = await tryApi('POST', '/api/desktop/phone/code', { org })
  p.check('L1: linked, no live code, and no new setup code while a phone is linked', s.link?.address === alex.slug && !s.org.code
    && !s.org.persons.some(x => x.address === alex.slug) && !r.ok && /already linked/.test(r.e), { link: s.link, r })

  s = await rig.api('POST', '/api/desktop/phone/unlink')
  p.check('Unlink: the note leaves org.md byte for byte, the record is cleared', orgmd() === original && !settingsFile().link && s.link === null)
  s = await orgState()
  p.check('L2: the person is still on the hub, so the panel can ask "Is this you?"', s.org.persons.some(x => x.address === alex.slug && x.name === 'Alex Rivera'), s.org.persons)
  r = await tryApi('POST', '/api/desktop/phone/link', { org, address: 'nobody.000000' })
  p.check('"Yes, that\'s me" only for a person on this hub', !r.ok && /not a Hubchat person/.test(r.e), r)
  r = await tryApi('POST', '/api/desktop/phone/link', { org, address: alex.slug })
  p.check('"Yes, that\'s me": linked without a code, the note written', r.ok && r.v.link?.via === 'confirmed' && orgmd().startsWith('<!-- added by Connect your phone')
    && orgmd().includes(`@net:${alex.slug} is`), r.v?.link)
  await rig.api('POST', '/api/desktop/phone/unlink')
  p.check('Undo after "Is this you?" restores org.md exactly', orgmd() === original)

  // New code voids the old one; a code past its life is refused
  const first = await rig.api('POST', '/api/desktop/phone/code', { org })
  const second = await rig.api('POST', '/api/desktop/phone/code', { org })
  await send(alex, `Setup code: ${first.code}`)
  const voided = await answers(alex, `Setup code: ${first.code} expired`)
  p.check('New code: the earlier code answers "expired" and links nothing', !!voided && !settingsFile().link && first.code !== second.code)
  fs.writeFileSync(path.join(rig.data, 'rig-home', 'rig-phone-code-seconds'), '2')
  const brief = await rig.api('POST', '/api/desktop/phone/code', { org })
  await sleep(3000)
  s = await orgState()
  await send(alex, `Setup code: ${brief.code}`)
  const late = await answers(alex, `Setup code: ${brief.code} expired`)
  p.check('a code past its life: gone from the panel, answers "expired", links nothing', !s.org.code && !!late && !settingsFile().link)
  fs.rmSync(path.join(rig.data, 'rig-home', 'rig-phone-code-seconds'))
  const plain = await send(alex, 'just chatting, no code here')
  await sleep(4000)
  const extra = rig.sql(`SELECT 1 FROM ot.org_inbox WHERE dir = 'out' AND by_name = 'orgtree' AND body LIKE '%expired' AND at > now() - interval '4 seconds'`)
  p.check('a message without a code gets no automatic answer', plain.status === 200 && extra.length === 0, extra)

  // ---- the card (D1), its one dismissal, the warnings, H1, Sign in
  s = await orgState()
  p.check('no card before the user has written to an agent', s.card?.show === false && s.card.org === null, s.card)
  await rig.userMail('lead', 'PHONE-CARD first message')
  s = await rig.waitFor(async () => { const v = await orgState(); return v.card?.show ? v : null }, { what: 'the card to show after the first message' })
  const home = await rig.api('GET', '/api/desktop/phone')
  p.check('the first exchange with a live top-level agent shows the card, in the org window and on Home', s.card.org === org && home.card?.show === true && home.card.org === org, { org: s.card, home: home.card })
  await rig.api('POST', '/api/desktop/phone/link', { org, address: alex.slug })
  s = await orgState()
  p.check('a linked phone hides the card', s.card.show === false)
  await rig.api('POST', '/api/desktop/phone/unlink')
  s = await rig.api('POST', '/api/desktop/phone/dismiss')
  const again = await orgState()
  p.check('one dismissal hides both cards, and is kept', s.card.show === false && s.card.dismissed === true && again.card.show === false
    && settingsFile().card_dismissed === true, { home: s.card, org: again.card })
  s = await rig.waitFor(async () => { const v = await orgState(); return v.warnings?.unattended === false ? v : null }, { what: 'the slow facts', timeout: 90000 })
  p.check('warnings: sleep after 30 minutes on mains, key expiry, Tailscale not unattended', s.warnings.sleep_minutes === 30
    && s.warnings.key_expiry === '2027-04-07T10:00:00Z' && s.warnings.unattended === false, s.warnings)
  p.check('H1: Hubchat installed on this PC', s.hubchat_pc === true)
  p.check('the download QR and the setup QR are SVG images', /^<\?xml|^<svg/.test(s.download_qr || '') && (s.download_qr || '').includes('</svg>'))
  fs.writeFileSync(path.join(tsDir, 'login-url'), 'https://login.tailscale.com/a/abc123')
  r = await tryApi('POST', '/api/desktop/phone/tailscale-login')
  p.check('Sign in: the address Tailscale printed, for the browser', r.ok && r.v.url === 'https://login.tailscale.com/a/abc123', r)

  p.note('Tailscale is the rig fake (bin\\tailscale.cmd); the engine ran it through its real process path. The real Tailscale CLI was never run.')
  p.note('The firewall rule is a mock in rig mode (rig-home\\rig-firewall\\rule.txt, written here as the desktop\'s elevated step would); the desktop smoke covers the prompt. The 100.x address is played by 127.0.0.2/127.0.0.3, and a rig hub never binds 0.0.0.0.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
