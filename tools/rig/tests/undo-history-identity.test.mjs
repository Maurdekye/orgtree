// Replay the proof's actual retire/undo block with synthetic SQL row orders.
// No engine, PostgreSQL, provider or window is started.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const file = 'tools/rig/proofs/undo-history.mjs'
const source = (process.env.UNDO_IDENTITY_PROOF_REF
  ? execFileSync('git', ['show', `${process.env.UNDO_IDENTITY_PROOF_REF}:${file}`], {cwd: repo, encoding: 'utf8'})
  : fs.readFileSync(new URL('../proofs/undo-history.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const start = source.indexOf('  // ---- 4. retire a team and undo it')
const end = source.indexOf('  // ---- 5. retool', start)
assert(start >= 0 && end > start)
const execute = new (Object.getPrototypeOf(async function() {}).constructor)(
  'rig', 'p', 'orgId', 'tree', 'op', 'row', 'undo', 'redo', `let r;\n${source.slice(start, end)}`)
const alice = {id: 2, name: 'alice'}, bob = {id: 3, name: 'bob'}
const identityCheck = '4. the same records came back'

async function replay(before, after, {wrongTree = false} = {}) {
  const checks = [], queries = []
  let live = true, restored = false
  const rig = {sql(query) {
    assert.match(query, /^SELECT id, name FROM ot\.agents WHERE org_id=42 AND name IN \('alice','bob'\)(?: ORDER BY id)?$/)
    assert(queries.length < 2, 'exactly two identity reads')
    const rows = structuredClone(queries.length === 0 ? before : after)
    queries.push(query)
    // Model only the explicit SQL ordering contract. Unordered reads retain
    // their supplied physical order, which may differ across UPDATEs.
    return query.endsWith(' ORDER BY id') ? rows.sort((a, b) => a.id - b.id) : rows
  }}
  const retire = async () => {
    live = false
    return {ok: true, json: {history_entry: {id: 7, kind: 'retire', label: 'Retire alice and its team'}}}
  }
  await execute(rig, {check: (what, ok, detail) => checks.push({what, ok, detail})}, 42,
    () => live ? (wrongTree && restored ? 'wrong-parent-or-slot' : 'original-tree') : 'retired-tree',
    async request => {assert.deepEqual(request, {op: 'retire', node: 'alice'}); return retire()},
    () => ({state: live ? 'live' : 'archived'}),
    async id => {assert.equal(id, 7); live = true; restored = true; return {ok: true}},
    async id => {assert.equal(id, 7); return retire()})
  assert.equal(queries.length, 2)
  assert.equal(checks.length, 6)
  return checks
}

function identity(checks) {
  const found = checks.filter(c => c.what === identityCheck)
  assert.equal(found.length, 1)
  return found[0]
}

test('reversed pre-undo SQL rows retain strict record identity', async () => {
  const checks = await replay([bob, alice], [alice, bob])
  assert.equal(identity(checks).ok, true)
  assert(checks.every(c => c.ok), JSON.stringify(checks))
})
test('reversed post-undo SQL rows retain strict record identity', async () => {
  const checks = await replay([alice, bob], [bob, alice])
  assert.equal(identity(checks).ok, true)
  assert(checks.every(c => c.ok), JSON.stringify(checks))
})
test('already ordered identity remains green', async () => {
  assert((await replay([alice, bob], [alice, bob])).every(c => c.ok))
})
test('missing, duplicate, extra, changed-id and changed-name records still fail', async () => {
  for (const after of [[alice], [alice, alice], [alice, bob, bob],
    [alice, {...bob, id: 30}], [alice, {...bob, name: 'namesake'}]]) {
    const checks = await replay([alice, bob], after)
    assert.equal(identity(checks).ok, false, JSON.stringify(after))
    assert(checks.filter(c => c.what !== identityCheck).every(c => c.ok))
  }
})
test('identity equality never bypasses the separate tree and placement guards', async () => {
  const checks = await replay([alice, bob], [alice, bob], {wrongTree: true})
  assert.equal(identity(checks).ok, true)
  assert.deepEqual(checks.filter(c => !c.ok).map(c => c.what), [
    '4. undo rehires exactly the team, each under its parent in its place',
    '4. and undo brings it back once more',
  ])
})
