import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('shell-error-output')
  p.note('engine provenance', { engine: rig.run.engineSource,
    sha256: createHash('sha256').update(fs.readFileSync(rig.run.engineSource)).digest('hex') })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed idle' })
  const long = 'FIRST\n' + 'synthetic error\n'.repeat(500) + 'LONG_END_MARKER'
  const huge = 'x'.repeat(1024 * 1024 - 1) + 'éOVER_CAP_MARKER'
  const calls = [['long', 'Bash'], ['huge', 'PowerShell'], ['ok', 'Bash'], ['other', 'Read']]
  rig.scenario({ agents: { boss: { turns: [{ match: 'SHELL-OUTPUT-PROOF', steps: [
    { raw: { type: 'assistant', message: { id: 'output-row', role: 'assistant',
      content: calls.map(([id, name]) => ({ type: 'tool_use', id, name, input: { command: 'synthetic' } })) } } },
    { sleep_ms: 300 },
    { raw: { type: 'user', message: { content: calls.map(([id]) => ({ type: 'tool_result', tool_use_id: id,
      is_error: id !== 'ok', content: id === 'long' ? long : id === 'huge' ? huge : id === 'ok' ? 'SUCCESS_OUTPUT' : 'OTHER_ERROR' })) } } },
    { text: 'SHELL-OUTPUT-DONE' },
  ] }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.userMail('boss', 'SHELL-OUTPUT-PROOF')
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/boss/chat?last=80`)
  await rig.waitFor(async () => { const c = await chat(); return !c.busy && c.messages.some(m => m.text?.includes('SHELL-OUTPUT-DONE')) }, { what: 'shell results settled', timeout: 30000 })
  const c = await chat(), chips = c.messages.flatMap(m => m.tools ?? [])
  const get = id => chips.find(t => t.id === id)
  const route = (id, node = 'boss', org = rig.org) => `/api/orgs/${org}/nodes/${node}/tooloutput/${get(id).output_seq}/${id}`
  p.check('long and capped failed shell results expose bounded lookup identities', ['long', 'huge'].every(id => typeof get(id)?.output_seq === 'number'))
  p.check('chat never carries private full failed output', !JSON.stringify(c).includes('LONG_END_MARKER') && !JSON.stringify(c).includes('OVER_CAP_MARKER')
    && chips.every(t => !('failed_shell_output' in t)))
  const beforeRead = rig.engineLog().split(/\r?\n/).length
  const retained = await rig.api('GET', route('long'))
  p.check('authenticated indexed lookup returns exact long failed output', retained.output === long && !retained.truncated)
  const capped = await rig.api('GET', route('huge'))
  p.check('one MiB byte cap is UTF8 safe and explicitly marked', Buffer.byteLength(capped.output) === 1024 * 1024 - 1 && capped.truncated === true && !capped.output.includes('OVER_CAP_MARKER'))
  const input = await rig.api('GET', route('long').replace('/tooloutput/', '/toolinput/'))
  p.check('result amendment preserves full input alongside separate output', input.input.command === 'synthetic')
  p.check('successful shell and other tool stay on original clipped path', !get('ok').output_seq && !get('other').output_seq && get('ok').result === 'SUCCESS_OUTPUT' && get('other').error === 'OTHER_ERROR')
  p.check('unknown tool on a real call row is refused', await rig.api('GET', route('long').replace('/long', '/absent')).then(() => false, e => e.status === 404))
  const other = await rig.api('POST', '/api/orgs', { name: 'Shell Other Org', dirs: [], net_autoconnect: false })
  p.check('org/node identity cannot cross into another org', await rig.api('GET', route('long', 'boss', other.slug)).then(() => false, e => e.status === 404))
  p.check('unauthenticated full output lookup refused', [401, 403].includes((await fetch(rig.url + route('long'))).status))
  const afterRead = rig.engineLog().split(/\r?\n/).slice(beforeRead).join('\n')
  p.check('on-demand route does not serialize full output in new HTTP logs', !afterRead.includes('LONG_END_MARKER'))
  // The same row also retains the capped 1 MiB call. Keep psql's JSON result
  // bounded instead of exceeding the rig's default spawnSync output buffer.
  const row = rig.one("SELECT body::text LIKE '%LONG_END_MARKER%' AS body_has_marker, octet_length(tool_inputs -> 'long' -> 'failed_shell_output' ->> 'output') AS retained_bytes, md5(tool_inputs -> 'long' -> 'failed_shell_output' ->> 'output') AS retained_md5 FROM ot.convo WHERE body @? '$.tools[*].id ? (@ == \"long\")' LIMIT 1")
  p.check('durable row keeps output off body and exact in retained call', row?.body_has_marker === false
    && row.retained_bytes === Buffer.byteLength(long) && row.retained_md5 === createHash('md5').update(long).digest('hex'))
  p.file('receipt.json', { call: get('long'), cappedBytes: Buffer.byteLength(capped.output), capped: capped.truncated, durableProjection: row })
  p.keep(rig, { agents: ['boss'] })
  p.note('Synthetic provider outputs only; no actual shell command/provider/live data. Existing old clipped history cannot regain bytes never retained.')
  return p.summary()
}
