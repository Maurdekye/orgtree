// Hubchat question cards from an agent (docket
// hubchat-question-messages-carry-preset-answers-y; Hubchat's
// docs/question-cards.md): orgtree_message options become a numbered list in
// the body, which every client reads, and Hubchat's meta in the hub payload.
// The run hosts a mail hub with the `meta` feature (ORGTREE_RIG_HUB_BIN or
// --hub <orgtree-mailhub.exe>); the real sender delivers each card to a person
// registered over HTTP, as Hubchat registers one, and the proof reads what
// that person's client receives.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/question-options.mjs
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'

export function setup(flags) {
  return { hub: flags.hub ?? true, fixture: { org: { name: 'Question options' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('question-options')
  const A = rig.org
  const hub = rig.hubUrl
  const call = async (method, route, who, body) => {
    const res = await fetch(hub + route, {
      method, headers: { 'X-Org-Auth': `${who.slug}:${who.secret}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  await rig.waitFor(async () => (await rig.api('GET', '/api/desktop/hub')).status?.healthy || null, { what: 'the hosted hub to answer', timeout: 120000 })
  const health = await (await fetch(`${hub}/healthz`)).json()
  p.check('the hosted hub lists the meta feature', (health.features ?? []).includes('meta'), { version: health.version, features: health.features })
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  await rig.waitFor(async () => ((await rig.api('GET', `/api/orgs/${A}`)).net?.hubs ?? []).some(h => h.connected) || null,
    { what: 'the org to connect to the hosted hub', timeout: 90000 })
  const pat = { slug: `pat.person.${crypto.randomBytes(3).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }
  const reg = await call('POST', '/api/register', pat, { slug: pat.slug, org_name: 'Pat Example', username: 'pat', kind: 'person' })
  p.check('a person registers on the hub over HTTP, as Hubchat does', reg.status === 200, reg.status)
  // what Pat's client receives (the hub's queued mail for Pat)
  const received = (body, what) => rig.waitFor(async () => {
    const r = await call('POST', '/api/poll?wait=5', pat)
    return r.json?.messages?.find(m => m.body === body) ?? null
  }, { what, timeout: 60000 })
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  const question = 'Which channel should rc4 go to?'
  const send = args => rig.tool('rhea', 'orgtree_message', { to: `@net:${pat.slug}`, body: question, kind: 'question', ...args })
  const last = () => rig.one(`SELECT id, body, kind FROM ot.org_inbox WHERE dir='out' ORDER BY id DESC LIMIT 1`)
  const payload = (kind, body) => rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op: 'outgoing', kind, body })

  const one = await send({ options: [' Beta ', 'Stable', 'Hold it back'] })
  const row = last()
  const list = `${question}\n\nPick one:\n1. Beta\n2. Stable\n3. Hold it back`
  p.check('the agent tool queues the question with its options as a numbered list', one.ok && row?.kind === 'question' && row.body === list, { one, row })
  const sent = await payload('question', row.body)
  p.check('the hub payload carries the options as meta, with the list as the plain-text part',
    same(sent.meta?.question?.options, ['Beta', 'Stable', 'Hold it back']) && sent.meta.question.multiple === false &&
    sent.meta.fallback[0] === question.length && sent.meta.fallback[1] === Buffer.byteLength(list) && sent.body === list, sent)
  const got = await received(list, 'Pat to receive the card')
  p.check('over the hub, Pat\'s client gets kind question, the list in the body and the same meta',
    got.kind === 'question' && same(got.meta?.question?.options, ['Beta', 'Stable', 'Hold it back']) && got.meta.question.multiple === false &&
    same(got.meta.fallback, [question.length, Buffer.byteLength(list)]), got)

  const many = await send({ options: ['Monday', 'Tuesday', 'Wednesday'], multiple: true, body: 'Which days work?' })
  const manyRow = last()
  const manySent = await payload('question', manyRow.body)
  p.check('multiple: "Pick one or more", and meta says so', many.ok && manyRow.body.includes('\n\nPick one or more:\n1. Monday') && manySent.meta?.question?.multiple === true, { many, manySent })
  const manyGot = await received(manyRow.body, 'Pat to receive the multiple-choice card')
  p.check('over the hub, the multiple-choice card arrives with multiple: true', manyGot.meta?.question?.multiple === true &&
    same(manyGot.meta.question.options, ['Monday', 'Tuesday', 'Wednesday']), manyGot)

  const plain = await payload('question', 'Anything else for the release notes?')
  const notQuestion = await payload('message', list)
  p.check('a question without a list, or a list in an ordinary message, has no meta', !('meta' in plain) && !('meta' in notQuestion), { plain, notQuestion })
  const free = await send({ body: 'Anything else for the release notes?' })
  const freeGot = await received('Anything else for the release notes?', 'Pat to receive the free-response question')
  p.check('over the hub, a question without options arrives as kind question with no meta', free.ok && freeGot.kind === 'question' && !('meta' in freeGot), freeGot)

  const before = last().id
  const refusals = [
    [{ kind: 'message', options: ['Beta', 'Stable'] }, 'options go with kind question'],
    [{ to: 'user', options: ['Beta', 'Stable'] }, 'options are for questions to @net: addresses'],
    [{ options: ['Beta'] }, 'options must be a list of 2 to 10 answers'],
    [{ options: ['Beta', 'beta'] }, 'the options must all be different'],
    [{ options: ['Beta', 'Two\nlines'] }, 'each option is one line of 1 to 100 characters'],
    [{ multiple: true }, 'multiple goes with options'],
    [{ body: ' ', options: ['Beta', 'Stable'] }, 'a question with options needs the question in body'],
  ]
  const results = []
  for (const [args, why] of refusals) {
    const r = await send(args)
    results.push({ args, ok: r.ok, text: r.text })
    p.check(`refused, in plain words: ${why}`, !r.ok && r.text.includes(why), r)
  }
  p.check('nothing refused was queued', last().id === before, results)
  p.note('Agent tool, org-inbox row, payload builder, sender and the hosted hub are real; Pat is a person registered over HTTP and polled directly. Hubchat\'s own handling is its core tests (questions_v2 round trip) and browser proof.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
