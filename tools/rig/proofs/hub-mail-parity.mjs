// Focused engine proof: transport stays offline; no hub peer or identity.
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Hub mail parity' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('hub-mail-parity')
  const hub = (op, args = {}) => rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op, ...args })
  const receipts = () => hub('receipts')
  const mail = id => rig.one(`SELECT uid,state,turn_id,kind,net_hub FROM ot.mail WHERE net_id='${id}' ORDER BY id LIMIT 1`)
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })

  for (const kind of ['message', 'question', 'request', 'decision', 'status']) {
    const payload = await hub('outgoing', { kind })
    p.check(`outgoing ${kind}: persisted spool kind reaches the exact HTTP payload`,
      payload.kind === kind && payload.body === 'payload proof' && payload.to === 'peer.rig', payload)
  }

  await rig.op({ op: 'halt', node: 'rhea' })
  await hub('inbound', { id: 'held', body: 'HUB-HELD' })
  const held = mail('held')
  p.check('inbound holder mail retains exact hub identity and legacy message kind',
    held?.state === 'pending' && held.net_hub === 'rig-hub' && held.kind === 'message', held)
  await rig.api('POST', `/api/orgs/${rig.org}/org_inbox/read`, {})
  p.check('human reading the inbox queues no hub read receipt', (await receipts()).length === 0)
  const duplicate = await hub('inbound', { id: 'held', body: 'HUB-HELD' })
  p.check('duplicate inbound does not fan out another holder copy', !duplicate.fresh &&
    rig.sql("SELECT id FROM ot.mail WHERE net_id='held'").length === 1)

  await rig.op({ op: 'unhalt', node: 'rhea' })
  await rig.waitFor(() => mail('held')?.state === 'delivered', { what: 'agent consumes held hub mail', timeout: 30000 })
  p.check('positive agent consumption queues the original hub read receipt',
    (await receipts()).some(r => r.id === 'held' && r.hub === 'rig-hub' && r.state === 'read'))
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'held turn ends', timeout: 30000 })

  rig.scenario({ agents: { rhea: { turns: [
    { name: 'refused', match: 'HUB-REFUSE', once: true, steps: [{ start_error: 'refused before acceptance' }] },
  ] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await hub('inbound', { id: 'refused', body: 'HUB-REFUSE' })
  await rig.waitFor(() => rig.fakeLog('rhea').some(l => l.kind === 'turn' && l.script === 'refused'),
    { what: 'provider refuses start', timeout: 30000 })
  await rig.waitFor(() => mail('refused')?.state === 'pending' && mail('refused').turn_id === null,
    { what: 'refused mail returns to queue', timeout: 30000 })
  p.check('refused turn queues no read receipt', !(await receipts()).some(r => r.id === 'refused'))
  await rig.userMail('rhea', 'Try the held request again.')
  await rig.waitFor(() => mail('refused')?.state === 'delivered', { what: 'retry consumes mail', timeout: 30000 })
  p.check('later confirmed retry queues read, without marking the human inbox read',
    (await receipts()).some(r => r.id === 'refused') &&
    rig.one("SELECT read FROM ot.org_inbox WHERE net_id='refused' AND dir='in'").read === false)

  p.note('Measured storage-to-wire payload builder and real fake-CLI consumption boundary. No live/local hub HTTP delivery, registration or listener was used.')
  p.keep(rig, { agents: ['rhea'], grep: /mail|acknowledge|note_read|hub/ })
  return p.summary()
}
