// Proof: documents the user reads are presented, files are sent (user rule
//   2026-10-09, decision 57).
//   nova (a new hire) runs her first turn. The instructions her CLI is
//   launched with lead with the rule: anything the user is meant to read
//   (report, plan, any .md) goes through orgtree_present, even when they ask
//   for it to be "sent", and orgtree_send_file is only for what they want as
//   a file. The old lead ("WHEN THE USER ASKS FOR A FILE ... orgtree_send_file",
//   present "only when they wanted to READ") is gone. Kept: a path is not a
//   delivery, images show as the picture, the angle-bracket link guidance,
//   and agents without a user audience send documents to their superior.
//   The tool list her CLI is served carries the same rule in the
//   orgtree_present and orgtree_send_file descriptions. boss (top level)
//   has the same instructions, and a markdown body over 64 KB is refused
//   with a pointer to a shorter or split document, not to a file.
//   A .md file as `path` (decision 58): the instructions and the
//   orgtree_present description say so. boss presents report.md from his
//   folder and the user reads back exactly its text (multi-byte characters
//   included); `replaces` with a path updates the same card; a byte-order
//   mark is dropped; a file of exactly 64 KB is presented and one byte more
//   is refused, as is a file that is not UTF-8 text, a .txt, a folder named
//   .md and a .md outside his folders. nova (no user audience) is refused
//   a .md path too.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/present-documents.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('present-documents')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'nova', parent: 'boss', tier: 'haiku', title: 'New hire' })
  for (const name of ['nova', 'boss']) {
    const turns = rig.turns(name).length
    await rig.userMail(name, `Hello ${name}.`)
    await rig.waitTurns(name, turns + 1)
  }

  // the instructions file each CLI was launched with (--append-system-prompt-file)
  const identity = name => {
    const args = rig.fakeLog(name).filter(l => l.kind === 'start').at(-1)?.args ?? []
    const at = args.indexOf('--append-system-prompt-file')
    const file = at >= 0 ? args[at + 1] : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const nova = identity('nova')
  const boss = identity('boss')
  const around = (text, needle) => {
    const i = text.indexOf(needle)
    return i < 0 ? null : text.slice(Math.max(0, i - 80), i + 220)
  }
  const RULE = 'DOCUMENTS ARE PRESENTED, FILES ARE SENT'
  const READ = 'Anything the user is meant to READ themselves — a report, plan, proposal, write-up, summary, any .md — '
    + 'goes through orgtree_present, ALWAYS, never as a download card, even when they ask you to \'send\' it'
  const FILES = 'orgtree_send_file is ONLY for what they want AS A FILE — an installer, log, export, image or archive'
  p.check('nova: her instructions lead with the rule — anything she means the user to read goes through orgtree_present, even when asked to "send" it',
    nova.includes(RULE) && nova.includes(READ), { at: around(nova, RULE) ?? around(nova, 'orgtree_present'), bytes: nova.length })
  p.check('nova: orgtree_send_file is only for files wanted as files, and that comes after the presenting rule',
    nova.includes(FILES) && nova.indexOf(READ) >= 0 && nova.indexOf(READ) < nova.indexOf(FILES), { at: around(nova, 'orgtree_send_file') })
  const OLD = ['WHEN THE USER ASKS FOR A FILE', 'Use orgtree_present instead only when they wanted to READ']
  p.check('nova: the old send-file lead is gone', OLD.every(s => !nova.includes(s)), OLD.filter(s => nova.includes(s)))
  const KEPT = {
    superior: 'everyone else sends the document to their superior instead',
    notDelivery: 'a path is not a delivery',
    picture: 'appears in the chat AS THE PICTURE',
    relative: 'RELATIVE image paths resolve against your own working folder',
    angle: 'write it as a markdown link with the target in ANGLE BRACKETS',
    reveal: 'CLICKING IT REVEALS THE FILE IN THE OS FILE MANAGER',
  }
  const missing = Object.entries(KEPT).filter(([, s]) => !nova.includes(s)).map(([k]) => k)
  p.check('nova: kept — documents go to the superior without a user audience, a path is not a delivery, images, links', missing.length === 0 && nova.length > 0, { missing })
  p.check('boss (top level): the same rule in his instructions', boss.includes(READ) && boss.includes(FILES) && OLD.every(s => !boss.includes(s)),
    { at: around(boss, 'orgtree_present') })

  // the tool list nova's CLI was served (the engine's reply to its tools/list)
  const served = rig.fakeLog('nova').filter(l => l.kind === 'recv')
    .map(l => l.line?.response?.response?.mcp_response?.result?.tools).find(Array.isArray) ?? []
  const desc = name => served.find(t => t.name === name)?.description ?? ''
  const present = desc('orgtree_present')
  const sendFile = desc('orgtree_send_file')
  p.check('nova is served orgtree_present as ALWAYS for anything the user reads (report, plan, any .md), never a download card',
    present.includes('Present anything the user is meant to read themselves') && present.includes('ALWAYS this, never a download card')
    && present.includes('send the document to your superior'), { present })
  p.check('nova is served orgtree_send_file as only for a file wanted AS A FILE, never for a document to read',
    sendFile.includes('a file the user wants AS A FILE') && sendFile.includes('Never for a document they are meant to read')
    && !sendFile.includes('whenever the user asks for a file'), { sendFile })

  const big = await rig.tool('boss', 'orgtree_present', { title: 'Long report', body: 'x'.repeat(64 * 1024 + 1) })
  p.check('a markdown body over 64 KB is refused with "shorter or split", not "send it as a file"',
    !big.ok && /split it across several cards/.test(big.text ?? '') && !/send it as a file/.test(big.text ?? ''), { text: big.text })

  // ---------------------------------------------------------------- a .md file as path (decision 58)
  p.check('nova: her instructions say a .md file goes to orgtree_present as `path`',
    nova.includes('(non-blocking; pass a .md file as `path`, or the markdown as `body`)'), { at: around(nova, '(non-blocking') })
  p.check('nova is served orgtree_present with `path` taking a .md file (read as the markdown, 64 KB max) or an .html mockup',
    present.includes('or `path` a .md file (read as the markdown, 64 KB max) or a self-contained .html mockup'), { present })
  const scratch = name => path.join(rig.data, 'scratch', rig.org, name)
  const put = (name, file, content) => {
    fs.mkdirSync(scratch(name), { recursive: true })
    fs.writeFileSync(path.join(scratch(name), file), content)
  }
  const idOf = text => (text ?? '').match(/\(id (d[0-9a-z]+)/)?.[1]
  const row = uid => rig.one(`SELECT uid, title, format, body FROM ot.documents WHERE uid = '${uid}'`)
  const readBack = uid => rig.api('GET', `/api/orgs/${rig.org}/documents/${uid}`).then(j => j?.body ?? j?.document?.body, e => `error: ${e.message}`)
  const report = '# Weekly report\n\nTotals: 12 €, all ✓ — see below.\n\n- one\n- two\n'
  put('boss', 'report.md', report)
  const md = await rig.tool('boss', 'orgtree_present', { title: 'Weekly report', path: 'report.md' })
  const mdId = idOf(md.text)
  const mdRow = mdId && row(mdId)
  const mdRead = mdId && await readBack(mdId)
  p.check('boss presents report.md by path: a markdown card whose text the user reads back exactly (multi-byte characters included)',
    md.ok && mdRow?.format === 'markdown' && mdRow?.body === report && mdRead === report, { text: md.text, format: mdRow?.format, same: mdRead === report })
  const revised = '# Weekly report\n\nRevised: 13 €.\n'
  put('boss', 'report.md', revised)
  const re = await rig.tool('boss', 'orgtree_present', { title: 'Weekly report, revised', path: 'report.md', replaces: mdId })
  const reRows = rig.sql(`SELECT uid, title, body FROM ot.documents WHERE node_name = 'boss' AND title LIKE 'Weekly report%'`)
  p.check('boss: `replaces` with a .md path updates the same card with the file\'s new text',
    re.ok && reRows.length === 1 && reRows[0].uid === mdId && reRows[0].title === 'Weekly report, revised' && reRows[0].body === revised,
    { text: re.text, rows: reRows.map(r => ({ uid: r.uid, title: r.title, same: r.body === revised })) })
  put('boss', 'bom.md', '﻿# With a byte-order mark\n')
  const bom = await rig.tool('boss', 'orgtree_present', { title: 'BOM', path: 'bom.md' })
  const bomBody = idOf(bom.text) && row(idOf(bom.text))?.body
  p.check('boss: a leading byte-order mark is dropped, so the heading stays a heading', bom.ok && bomBody === '# With a byte-order mark\n',
    { text: bom.text, body: JSON.stringify(bomBody) })
  put('boss', 'edge.md', 'x'.repeat(64 * 1024))
  put('boss', 'over.md', 'x'.repeat(64 * 1024 + 1))
  const edge = await rig.tool('boss', 'orgtree_present', { title: 'Exactly 64 KB', path: 'edge.md' })
  const over = await rig.tool('boss', 'orgtree_present', { title: 'Over 64 KB', path: 'over.md' })
  p.check('boss: a .md of exactly 64 KB is presented; one byte more is refused with "shorter or split"',
    edge.ok && row(idOf(edge.text))?.body?.length === 64 * 1024 && !over.ok && /over the 64 KB markdown limit/.test(over.text ?? '')
    && /split it across several cards/.test(over.text ?? ''), { edge: edge.text, over: over.text })
  put('boss', 'latin1.md', Buffer.from([0x23, 0x20, 0xe9, 0x74, 0xe9, 0x0a]))
  put('boss', 'notes.txt', '# Not markdown by name\n')
  fs.mkdirSync(path.join(scratch('boss'), 'folder.md'), { recursive: true })
  const outside = path.join(rig.data, 'rig-outside')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Not for agents\n')
  put('nova', 'mine.md', '# Nova\'s notes\n')
  const refusals = {
    notUtf8: await rig.tool('boss', 'orgtree_present', { title: 'Latin-1', path: 'latin1.md' }),
    txt: await rig.tool('boss', 'orgtree_present', { title: 'Text', path: 'notes.txt' }),
    folder: await rig.tool('boss', 'orgtree_present', { title: 'Folder', path: 'folder.md' }),
    outside: await rig.tool('boss', 'orgtree_present', { title: 'Outside', path: path.join(outside, 'secret.md') }),
    noAudience: await rig.tool('nova', 'orgtree_present', { title: 'Nova', path: 'mine.md' }),
  }
  const said = Object.fromEntries(Object.entries(refusals).map(([k, r]) => [k, r.ok ? 'ok' : (r.text ?? '').slice(0, 110)]))
  p.check('refused: a .md that is not UTF-8, a .txt, a folder named .md, a .md outside his folders, and nova without a user audience',
    Object.values(refusals).every(r => !r.ok) && /not UTF-8 text/.test(said.notUtf8) && /\.md document or a \.html\/\.htm mockup/.test(said.txt)
    && /not a file/.test(said.folder) && /outside your working folder/.test(said.outside) && /needs a user audience/.test(said.noAudience), said)
  const stray = rig.sql(`SELECT title FROM ot.documents WHERE title IN ('Over 64 KB', 'Latin-1', 'Text', 'Folder', 'Outside', 'Nova')`)
  p.check('nothing refused was presented', stray.length === 0, stray)

  p.keep(rig, { agents: ['nova', 'boss'] })
  return p.summary()
}
