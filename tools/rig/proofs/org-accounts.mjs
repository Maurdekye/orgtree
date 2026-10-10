// Proof: the per-org account list (docket
// per-org-account-allowlist-restrict-an-org-to-a-s, user 2026-10-10).
// Two Claude logins (the default sign-in and B) and two Codex logins (the
// default and D), canned readings with room.
//   1. GET /api/orgs/{slug}/accounts-allowed lists every lane, all allowed.
//   2. Untick B: a hire on B is refused naming the allowed accounts, by the
//      ops route and the agent tool; continue-on to B is refused (the fallback
//      candidates are the same filter); B is gone from the account choices.
//   3. An agent bound to B moves at its next turn (to the default sign-in),
//      and that turn's [PROVIDER USAGE] board does not list B.
//   4. Untick the Claude default too: an explicit `primary` is refused, a hire
//      with no account is refused (none left), and an agent on the default
//      sign-in freezes saying the org allows no Claude account; re-ticking
//      the default releases it and it runs.
//   5. Untick only the default: a hire with no account is placed on B
//      (ruling 2026-10-10 Q1).
//   6. With --ui: Usage and Usage history from the org window hide B, with
//      no "Show all accounts" toggle (user ruling 2026-10-10 14:56Z).
//   7. With --ui: the default sign-in saved as the org's account for NEW
//      agents, then unticked: the picker does not offer it, and the saved
//      value reads "not used by this org" as a muted choice (screenshots).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-accounts.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const later = h => new Date(Date.now() + h * 3600e3).toISOString()
const reading = (session, weekly, email) => ({ available: true, email, observed_at: new Date().toISOString(), limits: [
  { kind: 'session', group: 'session', percent: session, resets_at: later(3), is_active: false, model: null, label: 'Current session' },
  { kind: 'weekly_all', group: 'weekly_all', percent: weekly, resets_at: later(72), is_active: true, model: null, label: 'Current week (all models)' },
] })

function claudeHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return dir
}

export default async function (rig) {
  const p = new Proof('org-accounts')
  const page = fileURLToPath(new URL('../desktop/org-accounts.cjs', import.meta.url))
  const picker = fileURLToPath(new URL('../desktop/org-accounts-picker.cjs', import.meta.url))
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usageDir, { recursive: true })
  const put = (name, r) => fs.writeFileSync(path.join(usageDir, `${name}.json`), JSON.stringify(r))
  put('claude', reading(10, 30, 'rig-primary@example.invalid'))
  put('claude@claude-b', reading(5, 20, 'rig-b@example.invalid'))
  put('openai', reading(10, 30, 'rig-codex@example.invalid'))
  put('openai@codex-d', reading(5, 20, 'rig-codex-d@example.invalid'))
  const B = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-b'), 'rig-b@example.invalid') })).id
  const homeD = path.join(rig.data, 'rig-home', 'codex-d')
  fs.mkdirSync(homeD, { recursive: true })
  const D = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported', path: homeD })).id
  // the readings, read (and recorded) once so the usage surfaces have them
  for (const r of ['/api/usage?force=true', '/api/codex/usage?force=true', `/api/accounts/${B}/usage?force=true`, `/api/accounts/${D}/usage?force=true`]) {
    await rig.api('GET', r).catch(() => null)
  }
  const settings = ids => rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ids })
  const hire = body => rig.op({ op: 'hire', title: 'Account list agent', ...body }).then(r => ({ ok: true, r }), e => ({ ok: false, e: e.message }))
  const agent = name => rig.one(`SELECT a.account, a.frozen FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${rig.org}' AND o.state = 'active' AND a.name = '${name}' AND a.state = 'live'`)
  const lastPrompt = name => rig.fakeLog(name).filter(l => l.kind === 'turn').at(-1)?.prompt ?? ''

  // ---------------------------------------------------------------- 1. the list
  const all = await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)
  const ids = all.accounts.map(l => l.id)
  p.check('accounts-allowed lists the default sign-ins and both logins, all allowed',
    ['claude/primary', B, 'openai/primary', D, 'google/primary'].every(i => ids.includes(i)) && all.accounts.every(l => l.allowed), all)

  // two agents before any change: one on B, one on the default sign-in
  const onB = await hire({ name: 'bea', tier: 'haiku', account: B })
  const onP = await hire({ name: 'pia', tier: 'haiku', parent: 'boss' })
  p.check('before: hires on B and on the default sign-in are accepted', onB.ok && onP.ok, { onB, onP })
  await rig.userMail('bea', 'first turn on B')
  await rig.waitTurns('bea', 1)
  p.check("before: bea's board lists B", lastPrompt('bea').includes(B), lastPrompt('bea').slice(0, 600))

  // ---------------------------------------------------------------- 2. untick B
  await settings([B])
  const again = await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)
  p.check('accounts-allowed now says B is not allowed', again.accounts.find(l => l.id === B)?.allowed === false, again)
  const refused = await hire({ name: 'zed', tier: 'haiku', account: B })
  p.check('a hire on B is refused, naming the allowed Claude accounts',
    !refused.ok && /not used by the org/.test(refused.e) && /claude\/primary/.test(refused.e), refused)
  const tool = await rig.tool('boss', 'orgtree_hire', { name: 'zed', tier: 'haiku', account: B, grant: 0, charter: 'x',
    add_dirs: [], tools: { bash: false, web: false, edit: false, subagents: false, mcp: [] }, org_visibility: 'self' })
  p.check('the agent tool refuses it too', !tool.ok && /not used by the org/.test(tool.text ?? ''), tool)
  const choices = await rig.api('GET', `/api/accounts?org=${rig.org}`)
  p.check("B is not among the org's account choices", !choices.accounts.some(a => a.id === B), choices.accounts.map(a => a.id))
  const cont = await rig.tool('boss', 'orgtree_continue_on', { node: 'pia', account: B })
  p.check('continue-on (and so the fallback) will not use B', !cont.ok && /not used by the org/.test(cont.text ?? ''), cont)

  // ---------------------------------------------------------------- 3. bea moves at its next turn
  await rig.userMail('bea', 'second turn, after B was unticked')
  const moved = await rig.waitFor(() => { const a = agent('bea'); return a && a.account !== B ? a : null },
    { what: 'bea to leave B', timeout: 60000 })
  p.check('bea moved off B at its next turn (to the default sign-in)', moved.account === null && !moved.frozen, moved)
  await rig.waitTurns('bea', 2, { timeout: 90000 })
  const board = lastPrompt('bea')
  p.check("bea's next board lists the default sign-in and not B", board.includes('claude/primary') && !board.includes(B),
    board.slice(0, 900))
  const sw = rig.one(`SELECT detail FROM ot.events WHERE op = 'account_switch' AND detail ->> 'account' = 'primary' ORDER BY id DESC LIMIT 1`)
  p.check('the move is in the org log', !!sw, sw)

  // ---------------------------------------------------------------- 4. no Claude account left
  await settings([B, 'claude/primary'])
  const explicitPrimary = await hire({ name: 'zed', tier: 'haiku', account: 'primary' })
  p.check('an explicit primary is refused when it is unticked', !explicitPrimary.ok && /not used by the org/.test(explicitPrimary.e), explicitPrimary)
  const none = await hire({ name: 'zed', tier: 'haiku' })
  p.check('a hire with no account is refused: the org allows no Claude account', !none.ok && /allows no Claude account/.test(none.e), none)
  await rig.userMail('pia', 'a turn with nothing left')
  const frozen = await rig.waitFor(() => { const a = agent('pia'); return a?.frozen ? a : null }, { what: 'pia to freeze', timeout: 60000 })
  p.check('pia freezes, saying the org allows no other Claude account', frozen.frozen.cause === 'org_accounts'
    && /allows no other Claude account/.test(frozen.frozen.error), frozen.frozen)
  p.check('pia ran no turn on it', rig.turns('pia').length === 0, rig.turns('pia'))
  await settings([B])
  const thawed = await rig.waitFor(() => { const a = agent('pia'); return a && !a.frozen ? a : null }, { what: 'pia to be released', timeout: 30000 })
  p.check('re-ticking the default releases pia', !!thawed, thawed)
  await rig.waitTurns('pia', 1, { timeout: 90000 })
  p.check('and pia runs its turn', rig.turns('pia').length >= 1)

  // ---------------------------------------------------------------- 5. auto-placement
  await settings(['claude/primary'])
  const auto = await hire({ name: 'ava', tier: 'haiku' })
  p.check('with only the default unticked, a hire with no account is placed on B', auto.ok && agent('ava')?.account === B,
    { auto, row: agent('ava') })

  // ---------------------------------------------------------------- 6. the panels
  await settings([B])
  if (rig.run.ui) {
    const ui = await runDesktop(rig, page, { preset: 'wide', out: path.join(p.dir, 'desktop') })
    const v = ui.value ?? {}
    p.check('Usage from the org window hides B, with no toggle', ui.ok && !v.usage?.toggle
      && !v.usage.text.includes('rig-b@') && v.usage.text.includes('rig-primary@'), v.usage)
    p.check('Usage history from the org window hides B, with no toggle', !!v.history && !v.history.toggle
      && !v.history.text.includes('rig-b@'), v.history)
    const errors = (v.consoleErrors ?? []).filter(e => !/Electron Security Warning/.test(e))
    p.check('no console errors', errors.length === 0, errors)
    p.note('screenshots', ui.out)

    // 7. the account-for-NEW-agents picker: the default sign-in saved there,
    // then unticked: it is not offered, and the saved value says why
    await settings([])
    await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: 'claude/primary' })
    await settings(['claude/primary'])
    const pk = await runDesktop(rig, picker, { preset: 'wide', out: path.join(p.dir, 'picker'), args: { org: rig.org } })
    const k = pk.value ?? {}
    const offered = (k.options ?? []).filter(o => !o.disabled).map(o => o.value)
    p.check('the new-agent picker does not offer the unticked default sign-in, and offers B', pk.ok
      && !offered.includes('claude/primary') && offered.includes(B), k)
    p.check('the saved default reads "not used by this org", muted', k.value === 'claude/primary'
      && /not used by this org/.test(k.shown ?? '') && (k.options ?? []).some(o => o.value === 'claude/primary' && o.disabled), k)
    const perrors = (k.consoleErrors ?? []).filter(e => !/Electron Security Warning/.test(e))
    p.check('no console errors (picker)', perrors.length === 0, perrors)
    p.note('picker screenshots', pk.out)
  }
  p.note('Not proved here: the automatic fallback after a real usage-limit freeze (it picks from the same filtered candidates continue-on uses) and the Home view (no org: every account).')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
