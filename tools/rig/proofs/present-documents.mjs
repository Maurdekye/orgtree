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
// Run: node tools/rig/rig.mjs run tools/rig/proofs/present-documents.mjs

import fs from 'node:fs'

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
    && present.includes('a .md file\'s text goes here') && present.includes('send the document to your superior'), { present })
  p.check('nova is served orgtree_send_file as only for a file wanted AS A FILE, never for a document to read',
    sendFile.includes('a file the user wants AS A FILE') && sendFile.includes('Never for a document they are meant to read')
    && !sendFile.includes('whenever the user asks for a file'), { sendFile })

  const big = await rig.tool('boss', 'orgtree_present', { title: 'Long report', body: 'x'.repeat(64 * 1024 + 1) })
  p.check('a markdown body over 64 KB is refused with "shorter or split", not "send it as a file"',
    !big.ok && /split it across several cards/.test(big.text ?? '') && !/send it as a file/.test(big.text ?? ''), { text: big.text })

  p.keep(rig, { agents: ['nova', 'boss'] })
  return p.summary()
}
