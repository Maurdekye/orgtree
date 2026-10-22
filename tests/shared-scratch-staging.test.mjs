import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import proof, { scratchStaging } from '../tools/rig/proofs/shared-scratch-folder.mjs'

const output = process.env.SHARED_SCRATCH_CONTROL_OUTPUT
assert.match(output?.replaceAll('\\', '/') ?? '', /^C:\/orgtree-build\/epic-combo-sol\/shared-scratch1\/controls$/i)
fs.mkdirSync(output, { recursive: true })
const originalBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff])
test('old empty-directory removal fails on the signed initializer header', () => {
  const dir = path.join(output, 'old-rmdir-control')
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Shared standing notes for this organization\n')
  assert.throws(() => fs.rmdirSync(dir), { code: 'ENOTEMPTY' })
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Shared standing notes for this organization\n')
})
for (const [name, notes] of [['absent', null], ['empty', Buffer.alloc(0)],
  ['header', Buffer.from('# Shared standing notes for this team\n')], ['custom', originalBytes]]) {
  test(`exact restore of ${name} workspace after initialized directory, junction and file staging`, () => {
    const root = path.join(output, name), dir = path.join(root, 'workspace'), outside = path.join(root, 'outside')
    fs.mkdirSync(root); fs.mkdirSync(outside)
    if (notes !== null) {
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'AGENTS.md'), notes)
      fs.mkdirSync(path.join(dir, 'nested')); fs.writeFileSync(path.join(dir, 'nested', 'binary'), originalBytes)
    }
    const staging = scratchStaging(); staging.stage(dir)
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Shared standing notes for this team\n')
    staging.park(dir)
    fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir'); staging.park(dir)
    fs.writeFileSync(dir, 'not a directory')
    const restored = staging.restore()
    assert.deepEqual(restored.errors, []); assert.equal(restored.restored.length, 1)
    assert.deepEqual(restored.restored[0].after, restored.restored[0].before)
    assert.equal(fs.existsSync(dir), notes !== null)
    if (notes !== null) {
      assert.deepEqual(fs.readFileSync(path.join(dir, 'AGENTS.md')), notes)
      assert.deepEqual(fs.readFileSync(path.join(dir, 'nested', 'binary')), originalBytes)
    }
    assert.deepEqual(fs.readdirSync(outside), [])
    assert.equal(restored.parked.length, 3)
    assert(fs.lstatSync(restored.parked[1].path).isSymbolicLink())
    fs.writeFileSync(path.join(root, 'restoration.json'), JSON.stringify(restored, null, 2))
  })
}

async function failureControl(name, damageBackup = false, missingSource = false) {
  const data = path.join(output, name), org = 'control-org', root = path.join(data, 'scratch', org)
  const team = path.join(root, '_teams', '17'), shared = path.join(root, '_shared')
  for (const dir of [team, shared]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'AGENTS.md'), originalBytes) }
  const previousEvidence = process.env.ORGTREE_RIG_EVIDENCE_HOME
  process.env.ORGTREE_RIG_EVIDENCE_HOME = path.join(data, 'durable')
  let result
  try { result = await proof({ data, org, run: { engineSource: missingSource ? path.join(data, 'absent.exe') : import.meta.filename },
    one: () => ({ id: 17 }),
    api: async () => {
      if (damageBackup) fs.renameSync(team + '-proof-original', team + '-injected-backup-hold')
      throw new Error('primary folder lookup failure')
    },
  }) } finally {
    if (previousEvidence === undefined) delete process.env.ORGTREE_RIG_EVIDENCE_HOME
    else process.env.ORGTREE_RIG_EVIDENCE_HOME = previousEvidence
  }
  const saved = JSON.parse(fs.readFileSync(path.join(result.evidence, 'result.json'), 'utf8'))
  assert.equal(saved.passed, false)
  assert(saved.checks.some(c => !c.ok && (missingSource ? c.detail.error.includes('ENOENT') : c.detail.error === 'primary folder lookup failure')))
  if (damageBackup) {
    assert.equal(saved.checks.length, 2)
    assert(saved.checks.some(c => c.what === 'shared-scratch-folder cleanup failed' && !c.ok))
    assert.deepEqual(fs.readFileSync(path.join(shared, 'AGENTS.md')), originalBytes)
    // The deliberately hidden backup remains intact; repair only our injected
    // obstruction after verifying both durable errors and independent restore.
    fs.renameSync(team + '-injected-backup-hold', team)
  } else assert.equal(saved.checks.length, 1)
  for (const dir of [team, shared]) assert.deepEqual(fs.readFileSync(path.join(dir, 'AGENTS.md')), originalBytes)
  fs.writeFileSync(path.join(data, 'negative-result.json'), JSON.stringify(saved, null, 2))
}
test('primary error is durable and original bytes restore on failure', () => failureControl('primary'))
test('cleanup error cannot mask primary error or stop the other workspace restore', () => failureControl('primary-and-cleanup', true))
test('setup failure before staging is a durable named FAIL', () => failureControl('setup', false, true))
