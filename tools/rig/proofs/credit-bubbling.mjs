// Proof: credit cost bubbling is app-wide and governs only the USER's own actions (USER 2026-10-22 14:30Z):
//   agents ALWAYS bubble: a hire, a reallocation and a rehire below a poor descendant raise the chain up to the
//     acting agent's own allocation, whatever the stale per-org values say (they are retired: stored nowhere);
//   the user's own hire / reallocation bubbles only while the two app-wide Runtime switches are ON (default ON);
//   an agent still cannot draw from outside its allocation, and nothing is ever overdrawn.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/credit-bubbling.mjs
import { Proof } from '../proof.mjs'

export async function setup() { return { fixture: { org: { name: 'Credit bubbling' }, agents: [{ name: 'boss', tier: 'sol', grant: 1000 }] } } }

export default async function (rig) {
  const p = new Proof('credit-bubbling')
  rig.scenario({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const op = body => rig.op(body).then(value => ({ ok: true, value }), e => ({ ok: false, error: String(e.body?.detail ?? e.message) }))
  const tool = (agent, name, args) => rig.tool(agent, name, args)
  const runtime = body => rig.api('PUT', '/api/app-settings/runtime', body).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.body?.detail ?? e.message) }))
  const grant = n => rig.one(`SELECT grant_credits::float8 AS g FROM ot.agents WHERE name = '${n}' AND state = 'live'`)?.g
  const overdrawn = () => rig.sql(`SELECT a.name FROM ot.agents a WHERE a.state = 'live' AND a.grant_credits - coalesce((SELECT sum(c.seat + c.grant_credits) FROM ot.agents c WHERE c.parent_id = a.id AND c.state = 'live'), 0) < -1e-6`).map(r => r.name)
  const hireTool = (caller, name, parent, g) => tool(caller, 'orgtree_hire', { name, parent, tier: 'haiku', grant: g, charter: 'Credit proof.', index: 0 })

  // boss (1000) > pm (20) > dev (5): pm has far fewer free credits than the hires below need
  await op({ op: 'hire', name: 'pm', parent: 'boss', tier: 'haiku', grant: 20 })
  await op({ op: 'hire', name: 'dev', parent: 'pm', tier: 'haiku', grant: 5 })

  // 1. the two switches are app-wide Runtime settings, ON by default
  const rt0 = await rig.api('GET', '/api/app-settings/runtime')
  p.check('the app-wide credit bubbling switches exist and default to ON',
    rt0.credit_bubble_hire_enabled === true && rt0.credit_bubble_alloc_enabled === true, { rt0 })

  // 2. a stale per-org OFF changes nothing for an agent (retired: accepted and ignored)
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { cascade_hire: false, cascade_alloc: false }).catch(() => null)
  const pm0 = grant('pm')
  const agentHire = await hireTool('boss', 'kid-a', 'pm', 60)
  p.check('an agent hire below a poor descendant bubbles the cost up even with the old per-org switch OFF',
    agentHire.ok === true && grant('pm') > pm0 && grant('pm') >= 60, { agentHire, pm: [pm0, grant('pm')] })
  const dev0 = grant('dev')
  const agentRealloc = await tool('boss', 'orgtree_reallocate', { node: 'dev', delta: 200 })
  p.check('an agent reallocation below a poor descendant bubbles the cost up even with the old per-org switch OFF',
    agentRealloc.ok === true && grant('dev') === dev0 + 200, { agentRealloc, dev: [dev0, grant('dev')] })

  // 3. the agent's own allocation is still the floor
  const poor = await hireTool('pm', 'kid-b', 'dev', 5000)
  p.check('an agent cannot bubble past its own allocation (the floor stands)', poor.ok === false && overdrawn().length === 0, { poor, over: overdrawn() })
  p.check('an agent cannot draw from outside its allocation',
    (await hireTool('dev', 'kid-c', 'pm', 10)).ok === false && overdrawn().length === 0)

  // 4. the user's switches (app-wide): OFF refuses the user's bubbling, ON allows it
  const off = await runtime({ credit_bubble_hire_enabled: false, credit_bubble_alloc_enabled: false })
  p.check('the switches save app-wide', off.ok && off.v.credit_bubble_hire_enabled === false && off.v.credit_bubble_alloc_enabled === false, { off })
  const tree = await rig.api('GET', `/api/orgs/${rig.org}`).catch(() => null)
  p.check('the org tree carries the app-wide values (the desk limits read them)',
    tree?.cascade_hire === false && tree?.cascade_alloc === false, { hire: tree?.cascade_hire, alloc: tree?.cascade_alloc })
  const pm1 = grant('pm')
  const userHire = await op({ op: 'hire', name: 'kid-d', parent: 'pm', tier: 'haiku', grant: pm1 + 100 })
  p.check('the user hire below a poor descendant is refused with the app-wide switch OFF', userHire.ok === false && /insufficient credits/.test(userHire.error ?? ''), { userHire })
  const userRealloc = await op({ op: 'reallocate', node: 'dev', delta: pm1 + 100 })
  p.check('the user reallocation below a poor descendant is refused with the app-wide switch OFF', userRealloc.ok === false && /insufficient credits/.test(userRealloc.error ?? ''), { userRealloc })
  const agentWhileOff = await hireTool('boss', 'kid-e', 'pm', pm1 + 100)
  p.check('an agent still bubbles while the user switches are OFF', agentWhileOff.ok === true, { agentWhileOff })
  const on = await runtime({ credit_bubble_hire_enabled: true, credit_bubble_alloc_enabled: true })
  const pm2 = grant('pm')
  const userHireOn = await op({ op: 'hire', name: 'kid-f', parent: 'pm', tier: 'haiku', grant: pm2 + 100 })
  p.check('the user hire bubbles again once the switch is ON', on.ok && userHireOn.ok === true && grant('pm') > pm2, { on, userHireOn })
  p.check('no agent is overdrawn at the end', overdrawn().length === 0, overdrawn())
  return p.summary()
}
