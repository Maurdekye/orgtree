// Run: node tools/rig/rig.mjs run tools/rig/proofs/frozen-display.mjs --recover --ui <bundle>
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { RIG_DIR } from '../lib.mjs'

const migration = '0020_clear_legacy_limit_locks'
const limited = reset => ({ once: true, match: 'PROOF-FREEZE', steps: [
  { rate_limit: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: reset } } },
  { error: { message: "You've hit your usage limit. Try again later.", codexErrorInfo: 'usageLimitExceeded' } },
] })

export default async function (rig) {
  const p = new Proof('frozen-display')
  const seat = name => rig.one(`SELECT frozen, halt, limit_locked FROM ot.agents
    WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}') AND name = '${name}'`)
  const reset = Math.floor(Date.now() / 1000) + 45
  rig.scenario({ agents: {
    kim: { turns: [limited(reset)] }, hana: { turns: [limited(reset + 7200)] },
  }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  for (const name of ['kim', 'hana']) {
    await rig.op({ op: 'hire', parent: 'boss', name, tier: 'luna', account_fallback: false })
    await rig.userMail(name, 'PROOF-FREEZE: preserve this request.')
    await rig.waitFor(() => rig.agentRow(name)?.frozen, { what: `${name} usage freeze`, timeout: 30000 })
    const n = seat(name)
    p.check(`${name}: usage freeze never acquires legacy lock`, n.frozen.limit && !n.limit_locked && !n.halt,
      { frozen: n.frozen, limit_locked: n.limit_locked, halt: n.halt })
  }
  await rig.tool('boss', 'orgtree_halt', { node: 'alice' })
  await rig.tool('bob', 'orgtree_status', { status: 'working', summary: 'Waiting between turns.' })
  rig.exec("UPDATE ot.agents SET frozen = (SELECT frozen FROM ot.agents WHERE name = 'hana') WHERE name = 'alice';")

  // Rehearse an upgrade with stale flags on both frozen and explicitly halted seats.
  // Removing the receipt is only in this disposable rig database.
  rig.exec(`UPDATE ot.agents SET limit_locked = true WHERE name IN ('kim','alice');
    DELETE FROM public.ot_migrations WHERE name = '${migration}';`)
  const held = rig.agentRow('kim').frozen
  const halt = rig.agentRow('alice').halt
  await rig.restart()
  const migrated = seat('kim')
  p.check('numbered migration clears stale flags while preserving freeze and halt',
    !migrated.limit_locked && JSON.stringify(migrated.frozen) === JSON.stringify(held)
    && !seat('alice').limit_locked && JSON.stringify(rig.agentRow('alice').halt) === JSON.stringify(halt)
    && !!rig.one(`SELECT name FROM public.ot_migrations WHERE name = '${migration}'`))

  const desktop = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'frozen-display.cjs'),
    { preset: '1600x1200', out: path.join(p.dir, 'desktop') })
  p.file('desktop-result.json', desktop)
  p.check('offscreen desktop proof completes', desktop.ok, desktop.error)
  if (desktop.ok) {
    const { near, far, list } = desktop.value
    p.check('near card says Frozen and carries snowflake', /^Frozen/.test(near.text) && near.snowflake, near)
    p.check('near card keeps explicit halt precedence over a coexisting freeze', /^Halted/.test(near.halted), near.halted)
    p.check('far icons distinguish frozen and halted', far.frozen && far.halted, far)
    p.check('list has Frozen, Halted, Working and Idle text', /Frozen/.test(list.kim) && !/halted/i.test(list.kim)
      && /Halted/.test(list.alice) && /Working/.test(list.bob) && /Idle/.test(list.carol), list)
  }

  const unstick = await rig.tool('boss', 'orgtree_unstick', { node: 'hana' })
  await rig.waitTurns('hana', 2, { timeout: 30000 })
  p.check('manual unstick releases and resumes the held request', unstick.ok && !rig.agentRow('hana').frozen
    && rig.fakeLog('hana').some(l => l.kind === 'turn' && /Your hold was released/.test(l.prompt)
      && /PROOF-FREEZE/.test(l.prompt)))

  // Wait for the real fake-provider reset plus the engine's 60s grace.
  // No resume action or deadline rewrite is used for kim.
  await rig.waitTurns('kim', 2, { timeout: 120000 })
  p.check('reset timer releases freeze and automatically replays request', !rig.agentRow('kim').frozen
    && !seat('kim').limit_locked && rig.fakeLog('kim').some(l => l.kind === 'turn'
      && /Your usage limit has reset/.test(l.prompt) && /PROOF-FREEZE/.test(l.prompt)))
  p.check('automatic wake respects reset grace', Date.now() / 1000 >= reset + 60,
    { after_reset_s: Math.floor(Date.now() / 1000) - reset })
  p.check('explicit halt survives freeze recovery', !!rig.agentRow('alice').halt)
  p.keep(rig, { agents: ['kim','hana'], grep: /freeze|released|scheduled|0020/ })
  return p.summary()
}
