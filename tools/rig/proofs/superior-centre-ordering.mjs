// Real admission regression: tutorial Centre sequence, no real CLIs or live data.
import { Proof } from '../proof.mjs'

export function setup() { return { fixture: { org: { name: 'Superior Centre regression' }, agents: [] } } }
export default async function (rig) {
  const p = new Proof('superior-centre-ordering')
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const hire = (name, parent, extra = {}) => rig.op({ op: 'hire', name, tier: 'sol', grant: parent ? 0 : 80,
    charter: 'Synthetic insertion regression.', ...(parent ? { parent } : {}), ...extra })
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const rows = () => rig.sql(`SELECT name,parent_id,sibling_order,scope,seat::float8,grant_credits::float8 FROM ot.agents WHERE org_id=${org} AND state='live' ORDER BY sibling_order,id`)
  const order = parent => {
    return rig.sql(`SELECT name FROM ot.agents WHERE org_id=${org} AND state='live' AND parent_id=(SELECT id FROM ot.agents WHERE org_id=${org} AND name='${parent}') ORDER BY sibling_order,id`).map(n => n.name)
  }
  const tree = () => rig.api('GET', `/api/orgs/${rig.org}`)
  await hire('lead')
  await hire('designer', 'lead', { user_position: 'centre' })
  await hire('web-dev', 'lead', { user_position: 'centre' })
  await hire('tester', 'lead', { user_position: 'centre' })
  await hire('copywriter', 'lead')
  await rig.op({ op: 'reorder', node: 'copywriter', after: 'tester' })
  p.check('tutorial Centre and right-strip sequence produces a non-last anchor', same(order('lead'), ['designer', 'tester', 'copywriter', 'web-dev']))
  // Retain a descendant too: insertion must carry the complete moved subtree.
  await hire('copy-assistant', 'copywriter')
  const before = rows(), anchor = before.find(n => n.name === 'copywriter')
  p.file('before-tree.json', await tree())
  const result = await hire('content-lead', 'lead', { above: 'copywriter' })
  const after = rows(), manager = after.find(n => n.name === 'content-lead')
  p.file('after-tree.json', await tree())
  p.file('admission.json', { before, after, result })
  p.check('superior insertion keeps the anchor ordinal and reports its original index',
    same(order('lead'), ['designer', 'tester', 'content-lead', 'web-dev']) && manager.sibling_order === anchor.sibling_order && result.index === 2,
    { order: order('lead'), anchorOrder: anchor.sibling_order, managerOrder: manager.sibling_order, index: result.index })
  p.check('the moved anchor and its descendants remain below the new manager',
    same(order('content-lead'), ['copywriter']) && same(order('copywriter'), ['copy-assistant']))
  p.check('neighbour ordinals and scopes remain unchanged', ['designer', 'tester', 'web-dev'].every(name =>
    same(before.find(n => n.name === name), after.find(n => n.name === name))))
  // Explicit agent-tool index remains stronger than the implied anchor slot.
  const explicit = await hire('explicit-manager', 'lead', { above: 'tester', index: 0, user_position: 'centre' })
  p.check('an explicit index still selects the superior position', explicit.index === 0 && order('lead')[0] === 'explicit-manager' && same(order('explicit-manager'), ['tester']))
  const project = await rig.op({ op: 'create_project', name: 'design-project', above: 'designer' })
  p.check('project-above retains the same ordinal replacement semantics', order('lead')[1] === 'design-project' && same(order('design-project'), ['designer']), project)
  return p.summary()
}
