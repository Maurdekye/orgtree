// Proof: organization templates carry the org's org-wide settings (docket
// create-organizations-from-agent-layout-templates, user 2026-10-10 19:40Z:
// "and save org wide settings too"; optional part, on by default; never
// secrets or anything of this computer).
//   1. Save as template keeps the settings the org set itself, and none of
//      this computer's (folders, the account for new agents, disabled
//      accounts) nor Quick chat's (its own part); unticked, none;
//   2. an org created from that template has those settings, no folders and
//      no account binding;
//   3. a hand-edited template naming a machine setting is listed with the
//      problem and refused; a bad value is refused at create, leaving no org.
// The desktop modal's "Org-wide settings" box is checked in
// template-quickchat.mjs.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/template-settings.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('template-settings')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const tpDir = path.join(rig.data, 'rig-home', '.orgtree', 'templates')
  const read = (f) => JSON.parse(fs.readFileSync(path.join(tpDir, f), 'utf8'))
  const settingsOf = (slug) => rig.one(`SELECT settings AS s FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`)?.s ?? null
  // jsonb keeps no key order: compare as sorted JSON
  const canon = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)
  const attempt = (f) => f.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  for (let i = 0; i < 120; i++) {
    const tiers = (await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers.map((t) => t.tier)
    if (tiers.includes('opus') && tiers.includes('sol')) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const work = path.join(rig.data, 'qc-work')
  fs.mkdirSync(work, { recursive: true })
  const set = { max_top_grant: 60, default_top_grant: 30, compact_at: 70, default_effort: 'high', permission_mode: 'default',
    default_visibility: 'team', cascade_hire: false, auto_resume: false, account_fallback_default: true,
    default_tools: { bash: true, web: false, edit: true, subagents: false, mcp: [] } }
  const put = await attempt(rig.api('POST', `/api/orgs/${rig.org}/settings`, { ...set, org_dirs: [work], default_account: 'primary',
    quick_chat: { tier: 'opus' } }))
  p.check('0 the seed org takes the settings (and a folder, an account for new agents, Quick chat defaults)', put.ok, put)

  // 1. save
  const s1 = await attempt(rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'Settings layout' }))
  const f1 = s1.ok ? read('settings-layout.json') : null
  const keys = Object.keys(f1?.settings ?? {}).sort()
  p.check('1 Save as template keeps exactly the org-set portable settings',
    s1.ok && JSON.stringify(keys) === JSON.stringify(Object.keys(set).sort())
      && Object.entries(set).every(([k, v]) => canon(f1.settings[k]) === canon(v)), { settings: f1?.settings })
  const raw = s1.ok ? fs.readFileSync(path.join(tpDir, 'settings-layout.json'), 'utf8') : ''
  p.check('1 nothing of this computer: no folders, account for new agents, disabled accounts or hubs anywhere in the file',
    s1.ok && !raw.includes(work.replace(/\\/g, '\\\\')) && !/"dirs"|default_account|disabled_accounts|net_hub/.test(raw), { len: raw.length })
  p.check('1 Quick chat stays its own part, not inside settings', s1.ok && !('quick_chat' in (f1.settings ?? {})), f1?.settings)
  const s2 = await attempt(rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'No settings', include: { settings: false } }))
  p.check('1 unticked, no settings are saved', s2.ok && !('settings' in read('no-settings.json')), s2.ok ? Object.keys(read('no-settings.json')) : s2)

  // 2. create
  const c = await attempt(rig.api('POST', '/api/orgs', { name: 'From Settings', dirs: [], template: { id: 'settings-layout' } }))
  const got = settingsOf('from-settings')
  p.check('2 the new org has the template settings',
    c.ok && got && Object.entries(set).every(([k, v]) => canon(got[k]) === canon(v)), { c: c.ok ? c.r.slug : c, got })
  p.check('2 and no folders or account binding from the source org',
    c.ok && JSON.stringify(got?.dirs) === '[]' && !('default_account' in (got ?? {})), got)

  // 3. hand-edited templates
  const t = read('settings-layout.json')
  fs.writeFileSync(path.join(tpDir, 'bad-key.json'), JSON.stringify({ ...t, id: 'bad-key', name: 'Bad key', settings: { ...t.settings, dirs: [] } }))
  fs.writeFileSync(path.join(tpDir, 'bad-value.json'), JSON.stringify({ ...t, id: 'bad-value', name: 'Bad value', settings: { compact_at: 10 } }))
  const listed = (await rig.api('GET', '/api/templates')).templates
  const bk = listed.find((x) => x.id === 'bad-key')
  p.check('3 a template naming a machine setting is listed with the problem', bk && bk.problems.some((x) => x.includes("'dirs'")), bk?.problems)
  const ck = await attempt(rig.api('POST', '/api/orgs', { name: 'Bad Key Org', dirs: [], template: { id: 'bad-key' } }))
  p.check('3 and refused at create, no org left', !ck.ok && settingsOf('bad-key-org') === null, ck)
  const cv = await attempt(rig.api('POST', '/api/orgs', { name: 'Bad Value Org', dirs: [], template: { id: 'bad-value' } }))
  p.check('3 a bad value is refused at create (422), no org left',
    !cv.ok && cv.status === 422 && /compact_at/.test(cv.detail) && settingsOf('bad-value-org') === null, cv)
  return p.summary()
}
