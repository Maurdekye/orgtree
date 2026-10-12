// Engine-local isolation only: no live hub, provider, or message is used.
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('org-inbox-isolation')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns', timeout: 60000 })
  const A = rig.org
  const B = (await rig.api('POST', '/api/orgs', { name: 'Isolation peer', dirs: [], net_autoconnect: false })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', grant: 5 }, { org: B })
  await rig.op({ op: 'halt', nodes: ['boss', 'alice'] })
  await rig.op({ op: 'halt', nodes: ['zoe'] }, { org: B })
  const id = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug='${slug}'`).id
  const rows = () => rig.sql('SELECT uid,org_id,body FROM ot.org_inbox ORDER BY id')
  const send = (org, who, to, body) => rig.tool(who, 'orgtree_message', { to, body }, { org })
  const attempt = (method, url, body) => rig.api(method, url, body).then(value => ({ ok: true, value }),
    e => ({ ok: false, status: e.status }))
  const set = value => rig.api('POST', `/api/orgs/${A}/settings`, { org_inbox_enabled: value })
  const body = 'ISOLATION retained outside message'
  p.check('enabled local incoming control', (await send(B, 'zoe', `@org:${A}`, body)).ok)
  const held = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${id(A)} AND body='${body}' AND recipient_name='boss'`)
  const retained = rows()
  const audiences = rig.sql(`SELECT grantee,revoked_at FROM ot.audiences WHERE org_id=${id(A)} ORDER BY id`)
  p.check('enabled history exposes accepted record', JSON.stringify(await rig.api('GET', `/api/orgs/${A}/org_inbox`)).includes(body))
  await set(false)
  for (const [label, org, who, to] of [
    ['outgoing local', A, 'boss', `@org:${B}`], ['incoming local', B, 'zoe', `@org:${A}`],
    ['outgoing network', A, 'boss', '@net:uncontacted-fixture'],
  ]) {
    const result = await send(org, who, to, `ISOLATION refused ${label}`)
    p.check(`${label} fails before admission`, !result.ok && /disabled/i.test(result.text ?? ''), result.text)
  }
  const ui = await attempt('POST', `/api/orgs/${A}/org_inbox/send`, { to: `@org:${B}`, body: 'ISOLATION refused UI' })
  p.check('human outgoing route refuses', !ui.ok && ui.status === 403, ui)
  p.check('refused attempts created no durable records', JSON.stringify(rows()) === JSON.stringify(retained))
  for (const route of ['org_inbox', 'history/org-mail', 'org_inbox/staging', 'transfers', 'org_inbox/upload_limit?to=@net:uncontacted-fixture']) {
    const result = await attempt('GET', `/api/orgs/${A}/${route}`)
    p.check(`disabled read denied: ${route}`, !result.ok && result.status === 403, result)
  }
  p.check('history collection hidden', !(await rig.api('GET', `/api/orgs/${A}/history`)).collections.some(x => x.id === 'org-mail'))
  p.check('agent history hides outside copy', !JSON.stringify(await rig.api('GET', `/api/orgs/${A}/history/node-mail?node=boss`)).includes(body))
  const inbox = await rig.tool('boss', 'orgtree_inbox', { action: 'list' })
  p.check('agent inbox list hides outside copy', inbox.ok && !inbox.text.includes(body))
  const fetched = await rig.tool('boss', 'orgtree_inbox', { action: 'fetch', message_ids: [held.uid] })
  p.check('agent fetch cannot expose known outside id', !String(fetched.text).includes(body))
  p.check('same-org agent mail still sends', (await send(A, 'boss', 'alice', 'ISOLATION internal control')).ok)
  p.check('agent-to-user mail still sends', (await send(A, 'boss', 'user', 'ISOLATION user control')).ok)
  await rig.userMail('boss', 'ISOLATION human internal control')
  const internal = await rig.tool('boss', 'orgtree_inbox', { action: 'list' })
  p.check('user-to-agent mail remains readable', internal.ok && internal.text.includes('ISOLATION human internal control'))
  await rig.op({ op: 'unhalt', nodes: ['boss'] })
  await rig.waitFor(() => rig.one("SELECT state FROM ot.mail WHERE body='ISOLATION human internal control'")?.state === 'delivered',
    { what: 'actor consumes internal control while isolated', timeout: 15000 })
  p.check('automatic actor consumes internal mail but leaves retained outside mail pending',
    rig.one(`SELECT state FROM ot.mail WHERE uid='${held.uid}'`).state === 'pending' &&
    !JSON.stringify(rig.fakeLog('boss')).includes(body))
  await rig.op({ op: 'halt', nodes: ['boss'] })
  p.check('audiences retained', JSON.stringify(audiences) === JSON.stringify(rig.sql(`SELECT grantee,revoked_at FROM ot.audiences WHERE org_id=${id(A)} ORDER BY id`)))
  await set(true)
  p.check('re-enable restores retained history', JSON.stringify(await rig.api('GET', `/api/orgs/${A}/org_inbox`)).includes(body))
  p.check('re-enable restores known agent mail', (await rig.tool('boss', 'orgtree_inbox', { action: 'fetch', message_ids: [held.uid] })).text.includes(body))
  p.check('failed sends never resurrected', !rows().some(x => x.body.startsWith('ISOLATION refused')))
  p.check('new local send succeeds after re-enable', (await send(A, 'boss', `@org:${B}`, 'ISOLATION resumed new send')).ok)
  for (let round = 0; round < 4; round++) {
    await set(true)
    const forward = `ISOLATION race ${round} forward`
    const reverse = `ISOLATION race ${round} reverse`
    const results = await Promise.all([send(A, 'boss', `@org:${B}`, forward), send(B, 'zoe', `@org:${A}`, reverse), set(false)])
    for (const [i, message] of [forward, reverse].entries()) {
      const stored = rig.sql(`SELECT id FROM ot.org_inbox WHERE body='${message}'`)
      const copies = rig.sql(`SELECT id FROM ot.mail WHERE body='${message}' AND sender LIKE '@org:%'`)
      p.check(`concurrent disable round ${round} direction ${i} publishes both records and copy or nothing`,
        results[i].ok ? stored.length === 2 && copies.length === 1 : stored.length === 0 && copies.length === 0,
        { accepted: results[i].ok, rows: stored.length, copies: copies.length })
    }
  }
  await set(true)
  p.keep(rig, { agents: ['boss', 'alice'], grep: /org_inbox|isolation|ERROR/ })
  return p.summary()
}
