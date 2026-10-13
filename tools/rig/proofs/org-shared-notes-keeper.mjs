// Proof: the working cache keeper reads a warm CLI's copy of the org's shared
// notes, not the file as it is now (docket
// shared-org-wide-agents-md-every-agent-in-the-org; coordinator ruling (b): a
// CLI keeps the copy it started with). kip's CLI starts with the notes at V1;
// an agent's edit makes them V2; the keeper's disposable read of kip's prefix
// (a fork of his session) carries V1, the prefix his next turn on that warm CLI
// reads, and his CLI runs on. A `reminders: 3` run with working checkups off.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-shared-notes-keeper.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export async function setup() { return { reminders: 3 } }

const USAGE = { input_tokens: 40, cache_read_input_tokens: 21000, cache_creation_input_tokens: 0, output_tokens: 2,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

export default async function (rig) {
  const p = new Proof('org-shared-notes-keeper')
  rig.scenario({
    agents: { kip: { turns: [{ name: 'keepalive', match: 'prompt-cache keepalive', steps: [{ usage: USAGE, cost_usd: 0.001 }, { text: 'OK' }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.api('PUT', '/api/app-settings/runtime', { working_checkups_enabled: false, idle_docket_reminders_enabled: false })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const dir = path.join(rig.data, 'scratch', rig.org, '_shared')
  const file = path.join(dir, 'AGENTS.md')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, '# Shared\n\n- KEEPER-NOTES-V1\n')
  await rig.op({ op: 'hire', name: 'kip', parent: 'boss', tier: 'haiku', title: 'keeper agent' })
  await rig.userMail('kip', 'Hello kip, start a session.')
  await rig.waitTurns('kip', 1)
  const identity = () => fs.readFileSync(path.join(rig.data, 'scratch', rig.org, 'kip', '.orgtree-identity.md'), 'utf8')
  const starts = () => rig.fakeLog('kip').filter(l => l.kind === 'start')
  const first = starts().at(-1)
  p.check('kip: his CLI started with the notes at V1', identity().includes('KEEPER-NOTES-V1'))
  await rig.tool('kip', 'orgtree_status', { status: 'working', summary: 'on it' })
  fs.writeFileSync(file, '# Shared\n\n- KEEPER-NOTES-V2\n')
  // his last real request 55 minutes ago: due for the keeper (subscription interval 50 minutes)
  const id = rig.agentRow('kip').id
  rig.exec(`UPDATE ot.turns t SET started_at = now() - interval '55 minutes' - (t.ended_at - t.started_at), ended_at = now() - interval '55 minutes'
             WHERE t.agent_id = ${id} AND t.ended_at IS NOT NULL;
            UPDATE ot.agents SET extra = extra - 'cache_keepalive_at' WHERE id = ${id};`)
  const fork = await rig.waitFor(() => starts().find(l => l.forked_from), { what: 'the keeper\'s read of kip', timeout: 60000 }).catch(() => null)
  await rig.waitFor(() => rig.one(`SELECT extra->>'cache_keepalive_at' AS k FROM ot.agents WHERE id = ${id}`)?.k, { what: 'the keepalive to finish', timeout: 60000 }).catch(() => null)
  const read = identity()
  p.check('the keeper\'s read carries the warm CLI\'s copy (V1), not the file as it is now (V2)',
    !!fork && read.includes('KEEPER-NOTES-V1') && !read.includes('KEEPER-NOTES-V2'),
    { fork: !!fork, forked_from: fork?.forked_from, v1: read.includes('KEEPER-NOTES-V1'), v2: read.includes('KEEPER-NOTES-V2') })
  p.check('kip\'s warm CLI runs on: no respawn for the edit or the read', alive(first?.pid) && starts().filter(l => !l.forked_from).length === 1,
    { pid: first?.pid, alive: alive(first?.pid), starts: starts().map(s => ({ pid: s.pid, forked_from: s.forked_from ?? null })) })
  p.keep(rig, { agents: ['kip'] })
  return p.summary()
}
