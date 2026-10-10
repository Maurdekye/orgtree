// Proof: Quick chat's position is an App settings › Display option, and the
// box works end to end from the Attention view (docket
// quick-chat-the-superior-selector-looks-and-works, user 2026-10-10 19:23Z,
// 19:24Z, 19:25Z).
//   - Top is the default; Top / Bottom / None are chosen in the settings panel
//     and apply at once; Bottom survives a reload.
//   - Top: the box is centred in the header, the header's empty sides stay a
//     window drag region, the model picker opens downward. Bottom: in the
//     footer, the header's gap is a drag region, the picker opens upward.
//     None: no box anywhere. Screenshots of each at several widths.
//   - Attention view: the box says "New chat"; type, pick a model and a
//     superior, attach a file, send; the agent is hired as chosen, the file
//     rides its first mail, it can answer the user, and its chat opens in the
//     Attention view's desk panel with its reply — the view stays Attention.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/quick-chat-positions.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIDTHS = [1600, 1100, 900]
const PROMPT = 'Changelog: write the changelog for the attached notes'
const FILE = { name: 'changes.txt', text: 'fixed the footer' }

export default async function (rig) {
  const p = new Proof('quick-chat-positions')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  const out = path.join(p.dir, 'charcoal')

  // ------------------------------------------------------------ the setting
  const r = await runDesktop(rig, path.join(here, '../desktop/quick-chat-positions.cjs'),
    { preset: '1600x900', out, timeout: 300000, args: { org: rig.org, theme: 'charcoal', widths: WIDTHS } })
  p.check('the positions script ran', r.ok, r.ok ? undefined : r)
  const v = r.value ?? {}
  p.check('never set: Quick chat is in the header (Top is the default)', v.initial?.at === 'top', v.initial)
  const top = v.positions?.top, bottom = v.positions?.bottom, none = v.positions?.none
  p.check('the Display row offers Top, Bottom and None, Top selected by default',
    top?.row?.before === 'top' && JSON.stringify(top.row.options) === '["top=Top","bottom=Bottom","none=None"]', top?.row)
  p.check('None\'s hint says it is hidden everywhere, the Attention view included',
    /hidden everywhere/.test(none?.row?.hint ?? '') && /Attention view/.test(none?.row?.hint ?? ''), none?.row?.hint)
  for (const [pos, data] of [['top', top], ['bottom', bottom], ['none', none]]) {
    for (const w of data?.widths ?? []) {
      p.check(`${pos} at ${w.win}px: the box is ${pos === 'none' ? 'nowhere' : `in the ${pos === 'top' ? 'header' : 'footer'}`}`, w.at === pos, w)
      p.check(`${pos} at ${w.win}px: the header stays a window drag region — ${w.drag.draggableW}px of it drags (${w.drag.emptyW}px of that empty), only the controls opt out`,
        w.drag.regions.every((x) => x === 'drag') && w.drag.draggableW > 0 && (w.inputRegion === null || w.inputRegion === 'no-drag'), w.drag)
    }
  }
  const fullAt = (data) => (data?.widths ?? []).find((w) => w.win === 1600)?.boxW
  p.check('Top and Bottom both give the box its 960px at 1600px', fullAt(top) === 960 && fullAt(bottom) === 960, { top: fullAt(top), bottom: fullAt(bottom) })
  p.check('the footer only grows for Bottom (35px), the header keeps its height',
    (bottom?.widths ?? []).every((w) => w.footerH === 35) && (top?.widths ?? []).every((w) => w.footerH < 35)
      && new Set([...(top?.widths ?? []), ...(bottom?.widths ?? []), ...(none?.widths ?? [])].map((w) => w.headerH)).size === 1,
    { top: top?.widths?.map((w) => [w.headerH, w.footerH]), bottom: bottom?.widths?.map((w) => [w.headerH, w.footerH]), none: none?.widths?.map((w) => [w.headerH, w.footerH]) })
  p.check('Top: the model picker opens downward, below the header', top?.picker && top.picker.popTop >= top.picker.barBottom && top.picker.popBottom <= top.picker.vh, top?.picker)
  p.check('Bottom: the model picker opens upward, above the footer', bottom?.picker && bottom.picker.popBottom <= bottom.picker.barTop && bottom.picker.popTop >= 0, bottom?.picker)
  p.check('the choice is kept: Bottom survives a reload', v.afterReload?.at === 'bottom', v.afterReload)
  // the rig's own Electron CSP notice is the environment talking, not the app
  const real = (errs) => (errs ?? []).filter((e) => !/Electron Security Warning/.test(e))
  p.check('no console errors (positions)', !real(v.errors).length, real(v.errors))

  // ------------------------------------------------------- the Attention view
  const a = await runDesktop(rig, path.join(here, '../desktop/quick-chat-attention.cjs'),
    { preset: '1600x900', out, timeout: 240000,
      args: { org: rig.org, theme: 'charcoal', prompt: PROMPT, superiorFilter: 'car', file: FILE } })
  p.check('the Attention script ran', a.ok, a.ok ? undefined : a)
  const t = a.value ?? {}
  p.check('on the canvas the box is "Quick chat"', /^Quick chat — /.test(t.onCanvas?.placeholder ?? '') && /^Quick chat — /.test(t.onCanvas?.title ?? ''), t.onCanvas)
  p.check('in the Attention view it is "New chat" (tooltip, placeholder, label)',
    t.inAttention?.view?.attention === 'true' && /^New chat — /.test(t.inAttention.label?.title ?? '')
      && /^New chat — /.test(t.inAttention.label?.placeholder ?? '') && t.inAttention.label?.aria === 'New chat message', t.inAttention)
  p.check('the name preview stops at the colon', t.preview === 'changelog', t.preview)
  p.check('model, superior and one file chosen there', t.chosen?.model === 't-haiku' && t.chosen?.superior === 'carol' && t.chosen?.files === '1', t.chosen)
  const name = t.preview || 'changelog'
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.agents WHERE name = '${name}'`).length === 1, { what: `${name} to be hired`, timeout: 30000 }).catch(() => {})
  const [agent] = rig.sql(`SELECT a.tier, b.name AS parent FROM ot.agents a LEFT JOIN ot.agents b ON b.id = a.parent_id WHERE a.name = '${name}'`)
  p.check(`hired as chosen: ${name}, haiku, under carol`, agent?.tier === 'haiku' && agent?.parent === 'carol', agent)
  const mail = rig.sql(`SELECT m.body, m.attachments::text AS att FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                        WHERE a.name = '${name}' AND m.sender = '@user' ORDER BY m.created_at`)
  let att = []
  try { att = JSON.parse(mail[0]?.att ?? '[]') } catch { /* checked below */ }
  p.check('its first mail is the whole prompt with the file', mail[0]?.body === PROMPT && att.map((x) => x.name).join() === FILE.name, mail)
  const aud = rig.sql(`SELECT 1 FROM ot.audiences WHERE grantee = '${name}' AND grantor = '@user' AND revoked_at IS NULL`)
  p.check('it holds a user audience', aud.length === 1, aud)
  p.check('its chat opens in the Attention view\'s desk panel, with the prompt and its reply', t.desk?.present && t.desk.hasName && t.desk.hasPrompt && t.desk.hasReply, t.desk)
  p.check('the window stays in the Attention view (not sent to the canvas), the box cleared',
    t.after?.view?.attention === 'true' && t.after.view.stageOn && t.after.box === '', t.after)
  p.check('no console errors (Attention)', !real(t.errors).length, real(t.errors))
  return p.summary()
}
