// Proof (REAL APP, Session 0, headless engine + offscreen Electron): attract mode focuses anything needing attention at once.
// @item:orgtree/attract-mode-only-canvas-interaction-interrupts-i, points p-r (USER 2026-11-03 m0962694602bd "if anything
// needing attention appears, it is immediately focused with zero delay"); scope @coordinator-opus mcd6bfb242dc4 / mf51f03ee2b88.
//
// Why a docket attention flag and not a question: user-facing questions are refused while attract runs (points s-v), so a
// question cannot arrive in that build. The flag is raised with the engine's own tool (rig.tool boss orgtree_work attention:true).
//
// Run (needs a renderer bundle; the rig refuses a headless run; about 6 minutes):
//   node tools/rig/rig.mjs run tools/rig/proofs/attract-attention.mjs --ui auto
// Phase 1 (flag): Start after = 0; attract dwells on an ordinary target (an unread mail -> the inbox, or a changed ticket -> the
//   docket); the page waits until an attract-OPENED panel is on screen right after a step began, then asks this script to
//   raise the flag on ticket F. PASS facts: within one tree poll the docket shows F; that is before the previous dwell could
//   have ended (< 8 s after the previous step began, the shortest dwell); an inbox attract had opened is closed; arrival ->
//   shown latency is recorded.
// Phase 2 (pinned desk): agent bea's desk is pinned (a pin seeded in localStorage, as pin-resize.cjs does) and bea says '@user ...'
//   (rig.userMail triggers a scripted turn). PASS facts: bea's pinned window is untouched (still there, same rect), no second
//   desk was opened, and bea's card is inside the viewport (the whole-org fit has the node in view); the zoom HUD reading is
//   recorded before and after. bea's pinned desk is seeded on its Inbox tab, because a desk showing its chat acknowledges a new
//   @user mention at once (desk.tsx), which would remove it before it could arrive as attention. The page is told to start observing only after the mention is in the org tree (measured), and
//   observes for 30 s after that; bea's CLI is warmed first (a cold one took ~49 s).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

export default async function (rig) {
  const p = new Proof('attract-attention')
  rig.scenario({
    agents: { bea: { turns: [{ name: 'warm', match: 'PROOF-WARM', once: true, steps: [{ text: 'warm.' }] }, { name: 'mention', match: 'PROOF-MENTION', once: true, steps: [{ text: '@user please look at this when you can: the proof wants your attention.' }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.op({ op: 'hire', name: 'bea', parent: 'boss', tier: 'haiku', title: 'Mention agent' })
  // a cold fake CLI took ~49 s to answer the first time (measured by the first real run): warm bea's now, before the proof is timed
  await rig.userMail('bea', 'PROOF-WARM: hello')
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'bea warm-up turn', timeout: 180000 })
  const created = []
  const make = async (title) => {
    const made = await rig.tool('boss', 'orgtree_work', { action: 'create', kind: 'code', title,
      objective: `Problem: ${title}. Solution: none, it only exists for the attract attention proof.` })
    if (!made?.ok || !made?.json?.slug) throw new Error('create failed: ' + JSON.stringify(made))
    return made.json.slug
  }
  const ordinary = [await make('Attention proof ordinary 1'), await make('Attention proof ordinary 2')]
  const flagTitle = 'Attention proof flagged ticket'
  const flagSlug = await make(flagTitle)
  created.push(...ordinary, flagSlug)
  // one unread, NON-urgent mail to the user: an ordinary inbox target for attract
  await rig.tool('boss', 'orgtree_message', { to: 'user', body: 'attract attention proof: an ordinary unread mail' })

  const evidence = path.join(rigHome(), 'evidence', 'attract-attention-' + Date.now())
  const out = path.join(evidence, 'desktop')
  fs.mkdirSync(out, { recursive: true })
  const f = n => path.join(out, n)
  const flags = { ready: f('ready.flag'), seeded: f('seeded.flag'), raise: f('raise.flag'), raised: f('raised.flag'),
    mention: f('mention.flag'), mentioned: f('mentioned.flag') }
  const desk = runDesktop(rig, path.join(here, '../desktop/attract-attention.cjs'),
    { preset: '1400x900', args: { flagTitle, flags }, out, timeout: 14 * 60 * 1000 })
  let pending = true
  desk.finally(() => { pending = false })
  const waitFor = async (file, ms) => { const end = Date.now() + ms; while (pending && !fs.existsSync(file) && Date.now() < end) await sleep(250); return fs.existsSync(file) }

  p.check('the page pinned bea and is ready', await waitFor(flags.ready, 120000), 'ready.flag')
  // the ordinary tickets change AFTER the page's last input, so attract counts them as new
  for (const slug of ordinary) await rig.tool('boss', 'orgtree_work', { action: 'update', slug, status: 'in_progress', working_on_next: ['changed after the last input'] })
  fs.writeFileSync(flags.seeded, new Date().toISOString())
  // phase 1: the page asks for the flag when an attract-opened panel is on screen
  if (await waitFor(flags.raise, 260000)) {
    const r = await rig.tool('boss', 'orgtree_work', { action: 'update', slug: flagSlug, attention: true, attention_reason: 'attract attention proof: look at this now' })
    fs.writeFileSync(flags.raised, JSON.stringify({ at: Date.now(), ok: !!r?.ok, raw: r }))
  }
  // phase 2: the page asks for bea's mention; the page is only told once the mention is REALLY in the org's tree (user_mention),
  // so an unchanged pin and card cannot pass without an arrival
  let mention = { at: null, inTree: false, waitedMs: 0 }
  if (await waitFor(flags.mention, 200000)) {
    const sent = Date.now()
    await rig.userMail('bea', 'PROOF-MENTION: say @user')
    const end = Date.now() + 240000
    while (Date.now() < end) {
      const t = await rig.api('GET', `/api/orgs/${rig.org}?view=delta`).catch(() => null)
      const text = typeof t === 'string' ? t : JSON.stringify(t ?? '')
      if (text.includes('user_mention') && text.includes('please look at this when you can')) { mention = { at: Date.now(), inTree: true, waitedMs: Date.now() - sent }; break }
      await sleep(1000)
    }
    fs.writeFileSync(flags.mentioned, JSON.stringify({ ...mention, sentAt: sent }))
  }
  const r = await desk
  fs.writeFileSync(path.join(evidence, 'desktop-result.json'), JSON.stringify(r, null, 2))
  const v = r.value ?? {}
  const knownCsp = e => String(e).includes('Electron Security Warning (Insecure Content-Security-Policy)')
  p.check('the desktop script ran to its end', r.ok !== false && Array.isArray(v.samples) && v.samples.length > 20, JSON.stringify(r).slice(0, 400))
  p.check('guards: muted, clipboard stub on, no unexpected console errors', r.guards?.muted === true && r.guards?.clipboardStub === true
    && (r.consoleErrors ?? []).filter(e => !knownCsp(e)).length === 0, JSON.stringify({ guards: r.guards, errors: (r.consoleErrors ?? []).filter(e => !knownCsp(e)) }))
  const a = v.phase1 ?? {}
  p.check('phase 1: an attract-opened panel was on screen right after a step began (the dwell to interrupt)', !!a.armed, a)
  p.check('phase 1: the docket shows the flagged ticket (it was raised while attract dwelled elsewhere)', a.shownAt != null, a)
  p.check('phase 1: within one tree poll (<= 12 s) of the flag being raised', a.latencyMs != null && a.latencyMs <= 12000, a.latencyMs)
  p.check('phase 1: the previous dwell was cut short (shown < 8 s after the previous step began, the shortest dwell)', a.sincePrevStartMs != null && a.sincePrevStartMs < 8000, a.sincePrevStartMs)
  p.check('phase 1: an attract-opened inbox from the previous step is closed (or none was open)', a.inboxClosedAfter === true || a.prevOpen?.includes('inbox') === false, a)
  p.check('phase 0: the pinned desk of bea is not showing its chat (so it cannot acknowledge the mention)', v.phase0?.chatVisible === false, v.phase0)
  const b = v.phase2 ?? {}
  p.check('phase 2: the @user mention of bea really reached the org tree (user_mention) before the observation window', mention.inTree === true, mention)
  p.check('phase 2: bea\'s pinned desk window is untouched (still there, same rect)', b.pinSame === true, b)
  p.check('phase 2: bea\'s card is inside the viewport (the whole-org fit has the node in view)', b.cardInView === true, b)
  p.check('phase 2: no second desk for bea was opened by attract', b.extraDesk === false, b)
  p.keep(rig, { agents: ['boss', 'bea'], grep: /work|message|mention/i })
  return p.summary()
}
