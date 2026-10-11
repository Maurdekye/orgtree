// Hubchat question cards from an agent (docket
// hubchat-question-messages-carry-preset-answers-y; Hubchat's
// docs/question-cards.md): orgtree_message options become a numbered list in
// the body, which every client reads, and Hubchat's meta in the hub payload.
// Real agent tool path and payload builder; no hub listener or identity.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/question-options.mjs
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Question options' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('question-options')
  const question = 'Which channel should rc4 go to?'
  const send = args => rig.tool('rhea', 'orgtree_message', { to: '@net:peer.rig', body: question, kind: 'question', ...args })
  const last = () => rig.one(`SELECT id, body, kind FROM ot.org_inbox WHERE dir='out' ORDER BY id DESC LIMIT 1`)
  const payload = (kind, body) => rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op: 'outgoing', kind, body })

  const one = await send({ options: [' Beta ', 'Stable', 'Hold it back'] })
  const row = last()
  const list = `${question}\n\nPick one:\n1. Beta\n2. Stable\n3. Hold it back`
  p.check('the agent tool queues the question with its options as a numbered list', one.ok && row?.kind === 'question' && row.body === list, { one, row })
  const sent = await payload('question', row.body)
  p.check('the hub payload carries the options as meta, with the list as the plain-text part',
    JSON.stringify(sent.meta?.question) === JSON.stringify({ options: ['Beta', 'Stable', 'Hold it back'], multiple: false }) &&
    sent.meta.fallback[0] === question.length && sent.meta.fallback[1] === Buffer.byteLength(list) && sent.body === list, sent)

  const many = await send({ options: ['Monday', 'Tuesday', 'Wednesday'], multiple: true, body: 'Which days work?' })
  const manyRow = last()
  const manySent = await payload('question', manyRow.body)
  p.check('multiple: "Pick one or more", and meta says so', many.ok && manyRow.body.includes('\n\nPick one or more:\n1. Monday') && manySent.meta?.question?.multiple === true, { many, manySent })

  const plain = await payload('question', 'Anything else for the release notes?')
  const notQuestion = await payload('message', list)
  p.check('a question without a list, or a list in an ordinary message, has no meta', !('meta' in plain) && !('meta' in notQuestion), { plain, notQuestion })

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
  p.note('Agent tool path, org-inbox row and hub payload builder are real. No hub listener: the hub side is the mail hub\'s tests/message_meta.rs, and Hubchat\'s handling is its own core tests and browser proof.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
