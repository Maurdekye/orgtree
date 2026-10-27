// Antigravity tool rows are counted from the native step real histories store.
// A synthetic conversation history in the rig home holds generic tool steps in the shape
// measured on real Antigravity histories (2026-10-27, ten conversations, 2,291 tool steps:
// field 1 = 132, tool name 5 -> 4 -> 2, result text 140 -> 2 -> 1; CortexStep.view_file
// (14) never occurs). Raw stream events play the tools through the real actor, with the
// stream carrying no output text for most of them, as the real CLI does for file reads.
// No inference, live data or live login is used.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-tool-counts.mjs
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

const SESSION = '12345678-1234-4321-8765-123456789abc'

const varint = n => { const out = []; while (n >= 128) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return Buffer.from(out) }
const field = (f, data) => Buffer.concat([varint(f * 8 + 2), varint(data.length), data])
const int = (f, n) => Buffer.concat([varint(f * 8), varint(n)])
const text = s => Buffer.from(s, 'utf8')
// A completed generic tool step as AGY stores it; `content` null is an error / media-only result.
const step = (kind, name, content) => Buffer.concat([
  int(1, kind), int(4, 3),
  field(5, Buffer.concat([int(3, 2), field(4, Buffer.concat([field(1, Buffer.alloc(12)), field(2, text(name)), field(3, text('{"AbsolutePath":"synthetic.txt"}'))])), int(11, 1417)])),
  field(140, Buffer.concat([
    field(1, Buffer.concat([field(1, text('Path')), field(2, text('synthetic.txt'))])),
    field(2, Buffer.concat([...(content === null ? [] : [field(1, text(content))]),
      field(3, Buffer.concat([field(5, text('Analyzed')), field(6, text('description')), field(7, text('files'))]))])),
  ])),
])

const READ = 'Showing lines 1-3 of 3\n1: alpha\n2: beta\n3: gamma\n'.repeat(300)
const VIEW = 'File Path: `file:///synthetic.txt`\nTotal Lines: 3\n1: alpha\n2: beta\n3: gamma\n'
const OUTPUT = 'a line of command output that the stream never carried\n'.repeat(120)
const STREAM = 'from the stream'
// index: [native step type, native tool name, native text, stream tool name, stream result]
const steps = {
  1: [132, 'read_file', READ, 'read_file'],
  2: [132, 'view_file', VIEW, 'view_file'],
  3: [132, 'run_command', OUTPUT, 'run_command'],
  4: [132, 'run_command', OUTPUT, 'run_command', STREAM],
  5: [132, 'read_file', null, 'read_file'],
  6: [132, 'run_command', OUTPUT, 'read_file'],
  7: [15, 'read_file', READ, 'read_file'],
}
const tool = (index, state, [, , , name, result]) => ({ raw: {
  event: 'step_update', step_update: {
    step_index: index, step_type: 'tool', state, conversation_id: SESSION, tool_name: name,
    tool_info: { parameters: { AbsolutePath: 'synthetic.txt' }, ...(state === 'DONE' && result ? { result } : {}) },
  },
} })

export default async function (rig) {
  const p = new Proof('agy-tool-counts')
  const name = 'counted'
  const dir = path.join(rig.data, 'rig-home', '.gemini', 'antigravity-cli', 'conversations')
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, `${SESSION}.db`))
  db.exec('CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))')
  const insert = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)')
  for (const [index, [kind, tool_name, content]] of Object.entries(steps)) insert.run(Number(index), kind, step(kind, tool_name, content))
  db.close()

  rig.scenario({ agents: { [name]: { turns: [{ name: 'counted', match: 'COUNT-START', once: true, steps: [
    { raw: { event: 'init', conversation_id: SESSION, init: { cwd: rig.data, tools: [] } } },
    ...Object.entries(steps).flatMap(([index, s]) => [tool(Number(index), 'ACTIVE', s), tool(Number(index), 'DONE', s)]),
    { text: 'COUNTS-FINISHED' },
  ] }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: SEED_SETTLE_TIMEOUT })
  await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: 'Tool count proof' })
  await rig.userMail(name, 'COUNT-START: play the synthetic tool stream.')
  await rig.waitTurns(name, 1)
  const chat = await rig.waitFor(async () => {
    const c = await rig.api('GET', `/api/orgs/${rig.org}/nodes/${name}/chat?last=80`)
    return !c.busy && c.messages.some(row => (row.text ?? '').includes('COUNTS-FINISHED')) && c
  }, { what: 'the synthetic stream finished', timeout: 60000 })
  const chips = chat.messages.flatMap(row => row.tools ?? [])
  const chip = index => chips.find(c => c.id === `agy-step-${index}`)
  p.file('chips.json', chips)

  p.check('every tool reached the real actor and completed', Object.keys(steps).every(i => chip(i)?.ended_at), chips.map(c => c.id))
  p.check('read_file counts the text the model was given (~ estimate, thousands of tokens)',
    chip(1)?.output_tokens > 1500 && chip(1).output_tokens_estimated === true, chip(1))
  p.check('view_file counts its text too', chip(2)?.output_tokens > 10 && chip(2).output_tokens < 100 && chip(2).output_tokens_estimated === true, chip(2))
  p.check('a tool whose stream carried no output is counted from its native step',
    chip(3)?.output_tokens > 500 && chip(3).output_tokens_estimated === true, chip(3))
  p.check('a stream that carries output keeps it: the large native text is not used',
    chip(4)?.output_tokens > 0 && chip(4).output_tokens < 20, chip(4))
  p.check('a read with no result text has no count', !!chip(5) && !Object.hasOwn(chip(5), 'output_tokens'), chip(5))
  p.check('a read row never takes the text of a step that is another tool',
    !!chip(6) && !Object.hasOwn(chip(6), 'output_tokens'), chip(6))
  p.check('only a generic tool step is a read', !!chip(7) && !Object.hasOwn(chip(7), 'output_tokens'), chip(7))
  p.note('Synthetic history in the real stored shape plus raw stream events through the real actor; no inference or live data.')
  return p.summary()
}
