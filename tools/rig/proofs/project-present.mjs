// Real-tool regression: project members need no user audience for that
// project's gallery, while all other presentation authority stays bounded.
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('project-present')
  const hire = (name, parent, grant = 0) => rig.op({op:'hire', name, parent, tier:'haiku', grant, charter:'Synthetic presentation permission fixture.'})
  await hire('boss', 'user', 40)
  await hire('manager', 'boss', 20)
  await rig.op({op:'create_project', name:'website', parent:'manager'})
  await hire('member', 'website')
  await rig.op({op:'create_project', name:'nested', parent:'website'})
  await hire('nested-member', 'nested')
  await hire('outsider', 'boss')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, {what:'fixture agents idle', timeout:60000})
  const call = (who, title, project, extra = {}) => rig.tool(who, 'orgtree_present', {title, body:'# Synthetic document', ...(project === undefined ? {} : {project}), ...extra})
  const count = title => rig.one(`SELECT count(*)::int AS n FROM ot.documents WHERE title = '${title}'`).n
  const audiences = rig.sql("SELECT grantee FROM ot.audiences WHERE grantee IN ('member','nested-member','manager','outsider') AND grantor = '@user' AND revoked_at IS NULL AND NOT paused")
  p.check('fixture has no user audience for the scoped callers', audiences.length === 0, audiences)
  for (const [who, project, title] of [['member','website','direct-member'], ['nested-member','website','nested-to-outer'], ['nested-member','nested','nested-to-own']]) {
    const result = await call(who,title,project)
    const doc = rig.one(`SELECT node_name, presented_by FROM ot.documents WHERE title = '${title}'`)
    p.check(title + ' presents without a user audience', result.ok && doc?.node_name === project && doc?.presented_by === who, {result,doc})
  }
  const original = rig.one("SELECT uid FROM ot.documents WHERE title = 'direct-member'")
  const replaced = await call('member','member-revised','website',{replaces:original?.uid ?? 'missing-red-document'})
  p.check('member replaces the project card without a user audience', replaced.ok && count('direct-member') === 0 && count('member-revised') === 1, replaced)
  for (const [who, project, title] of [['member',undefined,'no-project'], ['member','   ','blank-project'], ['outsider','website','outside-project'], ['manager','website','ancestor-no-audience']]) {
    const result = await call(who,title,project)
    p.check(title + ' stays refused and writes no document', !result.ok && count(title) === 0, result)
  }
  await rig.api('POST',`/api/orgs/${rig.org}/audiences`,{action:'grant',node:'manager',reason:'Synthetic existing audience control'})
  const above = await call('manager','ancestor-with-audience','website')
  const personal = await call('manager','personal-with-audience')
  p.check('ancestor with a user audience retains project presentation access', above.ok && count('ancestor-with-audience') === 1, above)
  p.check('user audience retains personal presentation access', personal.ok && count('personal-with-audience') === 1, personal)
  await rig.api('POST',`/api/orgs/${rig.org}/audiences`,{action:'grant',node:'outsider',reason:'Synthetic reach control'})
  const unrelated = await call('outsider','outside-even-with-audience','website')
  p.check('user audience does not bypass unrelated project reach', !unrelated.ok && count('outside-even-with-audience') === 0, unrelated)
  return p.summary()
}
