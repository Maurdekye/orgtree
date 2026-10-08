// Proof: the requests a 3.2 store still has open when the engine first
// starts on it (the first-start import), seeded with tools/rig/legacy32.mjs:
//   dev:  one open question in the older single-question shape (options and
//         a docket link only in their own tables);
//   lead: an open batch (two question tabs, the second linked to the item)
//         plus a pending credit request and a pending scope request, which
//         3.x kept in their own tables (one submit resolved all three).
// Each agent's requests arrive as its one open card, the docket item shows
// the linked questions, a new ask adds to the imported card, and the user
// can answer them the way the desk does: the answers, the credits and the
// access reach the agents.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/questions-import.mjs

import { SLUG32, prepare32 } from '../legacy32.mjs'
import { Proof } from '../proof.mjs'

const at = m => `'${new Date(Date.parse('2026-09-20T12:00:00Z') + m * 60000).toISOString()}'`
const OPEN = [`
  INSERT INTO orgtree.asks (id, ord, public_id, node, kind, question, questions, header, at, status, rev) OVERRIDING SYSTEM VALUE
    VALUES (2, 1, 'q32-lead', 'lead', 'question', 'LEGACY32 batch one?',
            '[{"question":"LEGACY32 batch one?","header":"One","options":[{"label":"Alpha"},{"label":"Beta"}]},
              {"question":"LEGACY32 batch two?","work_item":"legacy32-item"}]', 'One', ${at(1)}, 'open', 2);
  INSERT INTO orgtree.ask_options (asks_id, pos, label) VALUES (2, 0, 'Alpha'), (2, 1, 'Beta');
  INSERT INTO orgtree.ask_work_items (asks_id, pos, value) VALUES (2, 0, 'legacy32-item');
  INSERT INTO orgtree.credit_requests (ord, public_id, node, old, new, reason, at, rev, status)
    VALUES (0, 'c32-lead', 'lead', 10, 14, 'LEGACY32 more credits', ${at(2)}, 1, 'pending');
  INSERT INTO orgtree.scope_requests (id, ord, public_id, node, items_is, reason, at, rev, status) OVERRIDING SYSTEM VALUE
    VALUES (1, 0, 's32-lead', 'lead', 'l', 'LEGACY32 access', ${at(3)}, 1, 'pending');
  INSERT INTO orgtree.scope_request_items (scope_requests_id, pos, kind, server) VALUES (1, 0, 'mcp', 'LEGACY32-mcp');
  INSERT INTO orgtree.scope_request_items (scope_requests_id, pos, kind, path, mode) VALUES (1, 1, 'dir', 'E:/work/legacy32/data', 'ro');`]

export async function setup() {
  return { fixture: 'none', name: 'questions3x', prepare: ctx => prepare32({ ...ctx, damage: OPEN }) }
}

const ORG = `(SELECT id FROM ot.orgs WHERE slug = '${SLUG32}' AND state = 'active')`

export default async function (rig) {
  const p = new Proof('questions-import')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const agent = name => rig.one(`SELECT id, grant_credits::float8 AS grant, scope FROM ot.agents WHERE org_id = ${ORG} AND name = '${name}'`)
  const asks = name => rig.sql(`SELECT uid, status, kind, rev, body FROM ot.asks WHERE agent_id = ${agent(name).id} AND status = 'open'`)
  const decision = name => rig.sql(`SELECT body, ev, state FROM ot.mail WHERE recipient_agent_id = ${agent(name).id}
    AND sender = '@user' AND kind = 'decision' ORDER BY id`).at(-1)
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))
  const card = async name => ((await rig.api('GET', `/api/orgs/${SLUG32}`)).asks ?? []).find(a => a.node === name && a.status === 'open')
  const tabs = c => (c?.tabs ?? []).map(t => t.kind === 'question' ? `question:${t.question}` : t.kind === 'credits' ? `credits:${t.old}->${t.new}` : `scope:${t.label}`)
  // the desk's submit: the batch route for a composed card, else the older single-question form
  const submit = (c, { answers, credits, scope, picks }) => c?.kind === 'batch' && c.tabs?.length
    ? tryApi('POST', `/api/orgs/${SLUG32}/nodes/${c.node}/batch`, { revs: c.revs ?? {}, answers, ...(credits ? { credits } : {}), ...(scope ? { scope } : {}) })
    : tryApi('POST', `/api/orgs/${SLUG32}/asks/${c?.id}/answer`, { selected: picks, rev: c?.rev })
  await rig.waitFor(() => rig.one(`SELECT 1 AS ok FROM ot.orgs WHERE slug = '${SLUG32}' AND state = 'active'`), { what: 'the 3.2 org to import', timeout: 60000 })

  // ---------------------------------------------------------------- what arrived
  const devCard = await rig.waitFor(() => card('dev'), { what: 'dev\'s card', timeout: 15000 }).catch(() => null)
  p.check('dev: his open question arrives as his one open card, with its options', asks('dev').length === 1
    && devCard?.kind === 'batch' && tabs(devCard).join('|') === 'question:LEGACY32 open question?'
    && devCard.tabs[0].options?.map(o => o.label).join(',') === 'Yes,No', devCard && { kind: devCard.kind, tabs: devCard.tabs, question: devCard.question })
  const leadCard = await card('lead')
  p.check('lead: his open batch, credit request and scope request arrive together as his one open card', asks('lead').length === 1
    && tabs(leadCard).join('|') === 'question:LEGACY32 batch one?|question:LEGACY32 batch two?|credits:10->14|scope:MCP server LEGACY32-mcp|scope:folder E:/work/legacy32/data (ro)',
    { open: asks('lead').length, kind: leadCard?.kind, tabs: tabs(leadCard) })
  const item = (await rig.api('GET', `/api/orgs/${SLUG32}/work-items/legacy32-item`)).item ?? {}
  const linked = (item.questions ?? []).flatMap(q => (q.tabs ?? []).map(t => `${q.node}:${t.question}`))
  p.check('the docket item shows both linked questions (dev\'s, and lead\'s second tab)', linked.includes('dev:LEGACY32 open question?')
    && linked.includes('lead:LEGACY32 batch two?') && !linked.includes('lead:LEGACY32 batch one?'), { linked, sources: item.attention_sources })

  // ---------------------------------------------------------------- lead asks again
  const more = await rig.tool('lead', 'orgtree_ask', { question: 'LEGACY32 follow-up?' }, { org: SLUG32 })
  const lead2 = await rig.waitFor(async () => { const c = await card('lead'); return tabs(c).includes('question:LEGACY32 follow-up?') ? c : null },
    { what: 'lead\'s amended card', timeout: 15000 }).catch(() => card('lead'))
  p.check('lead: asking again adds to the imported card instead of replacing it', more.ok && asks('lead').length === 1
    && tabs(lead2).slice(0, 3).join('|') === 'question:LEGACY32 batch one?|question:LEGACY32 batch two?|question:LEGACY32 follow-up?',
    { text: more.text?.slice(0, 160), tabs: tabs(lead2) })

  // ---------------------------------------------------------------- the user answers
  const da = await submit(devCard, { answers: ['Yes'], picks: ['Yes'] })
  const dm = decision('dev')
  p.check('dev: the user\'s answer reaches him with the question and the answer', da.ok && /LEGACY32 open question\?/.test(dm?.body ?? '')
    && /Yes/.test(dm?.body ?? '') && JSON.stringify(dm?.ev ?? {}).includes('LEGACY32 open question?'), { submit: da, body: dm?.body })
  const la = await submit(lead2, { answers: ['Beta', 'LEGACY32 typed answer', 'Later'], credits: { granted: 14 }, scope: ['approve', 'approve'] })
  const lm = decision('lead')
  const lead = agent('lead')
  p.check('lead: one submit answers every question and he is told', la.ok && /LEGACY32 batch one\?\nA: Beta/.test(lm?.body ?? '')
    && /LEGACY32 batch two\?\nA: LEGACY32 typed answer/.test(lm?.body ?? '') && /LEGACY32 follow-up\?\nA: Later/.test(lm?.body ?? ''),
  { submit: la, body: lm?.body })
  p.check('lead: the same submit grants the credits he asked for', la.ok && lead.grant === 14 && /Credits: granted/.test(lm?.body ?? ''), { grant: lead.grant })
  p.check('lead: and the access', la.ok && (lead.scope?.tools?.mcp ?? []).includes('LEGACY32-mcp')
    && (lead.scope?.add_dirs ?? []).some(d => d.path === 'E:/work/legacy32/data' && d.mode === 'ro'), lead.scope)
  p.check('no card is left open', asks('dev').length === 0 && asks('lead').length === 0, { dev: asks('dev').length, lead: asks('lead').length })

  p.keep(rig, { agents: ['dev', 'lead'], grep: /ask|question|request|import/i })
  return p.summary()
}
