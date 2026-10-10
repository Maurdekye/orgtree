// Proof: Quick chat as one composer row in the v3 footer (docket
// quick-chat-the-superior-selector-looks-and-works, user 2026-10-10).
//   - one row: every control inside the one box, in the footer (user
//     18:48Z), the pickers overlaid above it; the header has no Quick chat and
//     its empty stretch stays a drag region; the Attention view keeps it;
//   - the model control is the model's id icon alone, then the icon plus the
//     name the agent will get, and that is the name it gets;
//   - the superior picker is the Agents List: the same rows in the same order
//     as the list on screen, with id icons, "top level" first; filter, arrow
//     and Enter pick;
//   - the model picker is the hire chips, the chosen one marked;
//   - two attached files show as a count badge with a pop-over list, and
//     arrive with the hired agent's first mail (uploaded, byte-identical).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/quick-chat-composer.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROMPT = 'Summarise the attached release notes'
const FILES = [{ name: 'notes-a.txt', text: 'first file' }, { name: 'notes-b.txt', text: 'second file' }]

export default async function (rig) {
  const p = new Proof('quick-chat-composer')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'zulu', parent: null, tier: 'haiku', grant: 0 })
  await rig.op({ op: 'hire', name: 'able', parent: 'boss', tier: 'haiku', grant: 0 })
  const r = await runDesktop(rig, path.join(here, '../desktop/quick-chat-composer.cjs'),
    { preset: '1600x900', out: path.join(p.dir, 'charcoal'), timeout: 240000,
      args: { org: rig.org, theme: 'charcoal', size: '1600x900', prompt: PROMPT, files: FILES } })
  p.check('the desktop script ran', r.ok, r.ok ? undefined : r)
  const v = r.value ?? {}
  for (const [when, l] of [['empty', v.empty?.layout], ['typed', v.typed?.layout], ['two files', v.withFiles]]) {
    p.check(`${when}: one row inside one box, inside the footer`,
      l && l.insideBox && l.boxH <= l.headerH && new Set(l.parts.map(x => Math.round((x.top + x.bottom) / 2))).size <= 2, l)
  }
  p.check('empty prompt: the model control is the id icon alone', v.empty?.model?.icon && v.empty.model.name === null, v.empty?.model)
  p.check('typed prompt: the id icon plus the name preview', v.typed?.model?.icon && !!v.typed.model.name, v.typed?.model)
  const same = JSON.stringify(v.lists?.picker) === JSON.stringify(v.lists?.list)
  p.check('the superior picker lists the Agents List rows in its order', same && (v.lists?.picker?.length ?? 0) >= 3, v.lists)
  p.check('"top level" heads the picker; rows carry id icons', v.lists?.top?.startsWith('top level') && v.lists.icons === v.lists.picker.length, v.lists)
  p.check('the superior picker opens upward, above the footer and on screen', v.lists && v.lists.popBottom <= v.lists.footerTop && v.lists.popTop >= 0, v.lists)
  p.check('filter + ArrowDown + Enter picked carol', v.picked === 'carol', v.picked)
  p.check('the model picker is the hire chips, the chosen tier marked',
    (v.chips?.length ?? 0) >= 3 && v.chips.filter(c => c.sel).length === 1, v.chips)
  const L = v.look ?? {}
  p.check('50% wider than alpha.3: the footer slot is 960px and the box fills it in a 1600px window', L.slotBasis === '960px' && L.boxW === 960, L)
  p.check('the model (with the new name) comes before the superior', JSON.stringify(L.order?.slice(0, 2)) === '["model","superior"]', L.order)
  p.check('the id icon is the cards’ rounded-square tier badge, not a circle', L.radius === '4px', L.radius)
  p.check('its letter is centred both ways (within 1px)', Math.abs(L.dx) <= 1 && Math.abs(L.dy) <= 1, { dx: L.dx, dy: L.dy })
  const S = v.strip ?? {}
  p.check('the model pop-out has no background, border or shadow', /rgba\(0, 0, 0, 0\)|transparent/.test(S.bg) && S.border === 'none' && S.shadow === 'none', S)
  p.check('it hangs centred under the model button (within 1px)', Math.abs(S.popMid - S.btnMid) <= 1, S)
  p.check('a symmetric pyramid: every family row shares one centre, widest first',
    (S.rows?.length ?? 0) >= 1 && S.rows.every(r => Math.abs(r.mid - S.rows[0].mid) <= 1) && S.rows.every((r, i) => i === 0 || r.n <= S.rows[i - 1].n), S.rows)
  p.check('the model chips open upward, above their button and on screen, widest row nearest it',
    S.popBottom <= S.btnTop && S.popTop >= 0 && S.rows.every((r, i) => i === 0 || r.top < S.rows[i - 1].top), S)
  p.check('the chips are the canvas hire tokens (same round chip)', S.chipRadius === '50%', S.chipRadius)
  p.check('it fades in (opacity below 1 on its first frames, 1 once open)', v.fadeIn !== null && v.fadeIn < 1 && S.opacity === 1, { first: v.fadeIn, open: S.opacity })
  p.check('it fades out after a pick: a leaving copy below opacity 1, then gone', v.fadeOut?.leaving && v.fadeOut.opacity < 1 && !v.fadeOut.picker && v.gone, { ...v.fadeOut, gone: v.gone })
  const W = v.wander ?? {}
  p.check('the chips stay open with the pointer 60px above them and 60px to their side', W.at60 === true && W.at60side === true, W)
  p.check('100px away they close, fading out (a leaving copy below opacity 1, then gone)',
    W.left100 && !W.left100.picker && W.left100.leaving && W.left100.opacity < 1 && W.goneAfter, W)
  const T = v.topLevel ?? {}
  const sameRow = (a, b) => a && b && a.weight === b.weight && a.color === b.color && a.size === b.size && a.family === b.family && a.h === b.h
  p.check('"top level" is an option row: the agent rows’ weight, colour, size and height', sameRow(T.top?.rest, T.agent?.rest), T)
  p.check('...the user’s eye where an agent’s chip sits, the chip’s width', T.top?.rest?.eye && T.top.rest.chipW === T.agent?.rest?.chipW, T.top?.rest)
  p.check('...the same hover background as an agent row', T.top?.hover?.bg === T.agent?.hover?.bg && T.top.hover.bg !== T.top.rest.bg, { top: T.top?.hover?.bg, agent: T.agent?.hover?.bg, rest: T.top?.rest?.bg })
  p.check('...and the same selected highlight (arrow keys)', T.top?.selRow?.sel && T.agent?.selRow?.sel && T.top.selRow.bg === T.agent.selRow.bg, { top: T.top?.selRow, agent: T.agent?.selRow })
  for (const s of v.sweep ?? []) {
    p.check(`at ${s.win}px: full width (960) unless neither side has free space left; never overlapping`,
      !s.overlap && (s.quick === 960 || (s.startFree <= 1 && s.endFree <= 1)), s)
  }
  for (const s of v.sweep ?? []) {
    p.check(`at ${s.win}px: the header has no Quick chat; its empty stretch (${s.header?.emptyW}px) is a drag region`,
      s.header && !s.header.quick && s.header.drag === 'drag' && s.header.emptyW > 0, s.header)
    p.check(`at ${s.win}px: the footer holds the box on one row, only as tall as the row needs (${s.footerH}px for a ${s.boxH}px box)`,
      s.boxInFooter && s.footerH <= s.boxH + 8, { footerH: s.footerH, boxH: s.boxH })
  }
  p.check('the Attention view keeps Quick chat in the footer (none in the header)', v.attention?.on === 'true' && v.attention.quick && !v.attention.headerQuick, v.attention)
  const slide = (v.sweep ?? []).find(s => s.quick === 960 && Math.min(s.startFree, s.endFree) <= 1 && Math.max(s.startFree, s.endFree) > 1)
  p.check('between: one side out of free space, the other not — the box keeps 960 and slides off-centre', !!slide && Math.abs(slide.offCentre) >= 1, v.sweep)
  p.check('a chip pick becomes the model (haiku)', v.afterModel?.icon === 't-haiku', v.afterModel)
  p.check('two files: a count badge of 2', v.count === '2', v.count)
  p.check('the attachments pop-over lists both files', JSON.stringify(v.fileList) === JSON.stringify(FILES.map(f => f.name)), v.fileList)
  p.check('after Enter the box and the files clear', v.after?.value === '' && v.after?.count === null, v.after)
  const name = v.name
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.agents WHERE name = '${name}'`).length === 1,
    { what: `${name} to be hired`, timeout: 30000 }).catch(() => {})
  const [agent] = rig.sql(`SELECT a.tier, b.name AS parent, a.scratch_dir FROM ot.agents a LEFT JOIN ot.agents b ON b.id = a.parent_id WHERE a.name = '${name}'`)
  p.check(`the agent is hired under the preview's name (${name}), haiku, under carol`,
    agent && agent.tier === 'haiku' && agent.parent === 'carol', agent)
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id WHERE a.name = '${name}' AND m.sender = '@user'`).length >= 1,
    { what: 'its first mail', timeout: 30000 }).catch(() => {})
  const mail = rig.sql(`SELECT m.body, m.sender, m.attachments::text AS att FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                         WHERE a.name = '${name}' AND m.sender = '@user' ORDER BY m.created_at`)
  p.check('its first mail from the user is the prompt', mail[0]?.body === PROMPT && mail[0]?.sender === '@user', mail)
  // the user who started it can be answered: a user audience from the hire,
  // before its first turn (user 2026-10-10)
  const aud = rig.sql(`SELECT au.granted_at::text AS at, (SELECT min(t.started_at)::text FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}') AS first_turn,
                        au.granted_at <= coalesce((SELECT min(t.started_at) FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}'), now()) AS before
                        FROM ot.audiences au WHERE au.grantee = '${name}' AND au.grantor = '@user' AND au.revoked_at IS NULL`)
  p.check('it holds a user audience from the hire, granted before its first turn', aud.length === 1 && aud[0].before === true, aud)
  const reply = await rig.tool(name, 'orgtree_message', { to: 'user', body: 'QC-REPLY: hello, I am on it' })
  const toUser = rig.sql(`SELECT state, recipient_kind FROM ot.mail WHERE sender = '${name}' AND body LIKE 'QC-REPLY%'`)
  p.check('its reply to the user is accepted and lands in the user’s inbox', reply.ok && toUser.length === 1 && toUser[0].recipient_kind === 'user', { text: reply.text, toUser })
  let att = []
  try { att = JSON.parse(mail[0]?.att ?? '[]') } catch { /* checked below */ }
  p.check('the first mail carries both files', JSON.stringify(att.map(a => a.name)) === JSON.stringify(FILES.map(f => f.name)), att)
  // uploads land where the desk composer's do (data\uploads\<org>\<agent>)
  const found = FILES.map(f => {
    const a = att.find(x => x.name === f.name)
    try { return !!a && fs.readFileSync(a.path, 'utf8') === f.text } catch { return false }
  })
  p.check('both uploaded files are on disk, byte-identical', found.every(Boolean), { found, paths: att.map(a => a.path) })
  const errors = (v.errors ?? []).filter(e => !/Electron Security Warning/.test(String(e)))
  p.check('no console errors', !errors.length, errors)
  return p.summary()
}

