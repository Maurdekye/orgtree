// Proof: each OpenRouter key has its own harness (docket
// openrouter-choose-the-harness-claude-code-codex-p; user 2026-10-13),
// through the real engine, the fake CLI and canned key checks only:
//   1. the registry (GET /api/harnesses) and the per-key harness: the
//      original key is seeded, an added key takes the harness it is given;
//   2. per-key launch: a seat runs on its key's harness; a hire's explicit
//      harness pins the seat;
//   3. turn boundary: a key's harness change reaches its unpinned seats at
//      their next turn, never mid-turn (a running turn finishes on its CLI),
//      as a fresh session; a pinned seat is skipped;
//   4. removal: a removed key's seat moves to the original key and runs on
//      that key's harness from its next turn;
//   5. installed only: with Codex gone, choosing it (key or hire) is refused,
//      staffing (hire menus, templates, Quick chat) stops offering its keys,
//      and a seat whose saved harness is Codex refuses to launch saying so,
//      never substituting Claude Code;
//   6. migration: a key stored without a harness takes the old global value
//      at the next start; a seat whose stamp differs from its key's is pinned.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/openrouter-harness-per-key.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

const TIER = 'or-rig-fake-model'

export async function setup() {
  const s = await keysSetup()
  return { ...s, name: 'openrouter-harness-per-key' }
}

const refused = (p) => p.then(() => null, (e) => e.status ?? -1)

export default async function (rig) {
  const p = new Proof('openrouter-harness-per-key')
  rig.scenario({
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
    agents: { onone: { turns: [
      { name: 'long', match: 'PROOF-LONG', once: true, steps: [{ text: 'Starting a long job.' }, { sleep_ms: 4000 }, { text: 'LONG-DONE' }] },
    ] } },
  })
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  const starts = (a) => rig.fakeLog(a).filter((l) => l.kind === 'start')
  const codexStart = (l) => l?.mode === 'codex'
  const settle = async (a, text) => {
    const n = rig.turns(a).filter((t) => t.ended_at).length
    await rig.userMail(a, text)
    await rig.waitTurns(a, n + 1)
  }
  const idle = () => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'turns to settle', timeout: 60000 })
  const extra = (name) => rig.agentRow(name)?.extra ?? {}
  const keyDoc = async (id) => ((await rig.api('GET', '/api/openrouter')).keys ?? []).find((k) => k.id === id)
  const sessionsEnded = (name, why) => rig.sql(`SELECT s.end_reason FROM ot.agent_sessions s JOIN ot.agents a ON a.id = s.agent_id
                                                WHERE a.name = '${name}' AND s.end_reason = '${why}'`).length
  await rig.waitFor(async () => JSON.stringify((await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers ?? []).includes(TIER),
    { what: 'the favorite to be a tier', timeout: 30000 })

  // ------------------------------------------------ 1. registry and per-key harness
  const reg = (await rig.api('GET', '/api/harnesses')).harnesses ?? []
  const byId = Object.fromEntries(reg.map((h) => [h.id, h]))
  p.check('the registry lists every harness with what it is, its providers and how to install it',
    ['claude-code', 'codex-cli', 'antigravity', 'muse'].every((id) => byId[id]?.name && byId[id]?.what && byId[id]?.install && byId[id]?.providers?.length),
    reg.map((h) => ({ id: h.id, installed: h.installed, providers: h.providers?.map((x) => x.id) })))
  p.check('control: Claude Code and Codex are installed in this rig (its fake CLI)', byId['claude-code']?.installed && byId['codex-cli']?.installed)
  p.check('the OpenRouter rows of the registry are Claude Code and Codex',
    reg.filter((h) => h.selectable && h.providers.some((x) => x.id === 'openrouter')).map((h) => h.id).join() === 'claude-code,codex-cli')
  p.check('the original key carries its own harness, seeded Claude Code', (await keyDoc('openrouter-key'))?.harness === 'claude-code',
    await keyDoc('openrouter-key'))
  p.check('the global harness endpoint is gone', (await refused(rig.api('PUT', '/api/openrouter/harness', { harness: 'codex-cli' }))) !== null)
  await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222', label: 'team', harness: 'codex-cli' })
  p.check('an added key takes the harness it is given', (await keyDoc('openrouter-2'))?.harness === 'codex-cli', await keyDoc('openrouter-2'))
  p.check('no secret is in the harness storage', !JSON.stringify(rig.sql("SELECT extra::text AS e FROM ot.accounts WHERE provider = 'openrouter'")).includes('not-a-real-key'))

  // ------------------------------------------------ 2. per-key launch, pins
  await rig.op({ op: 'hire', name: 'onone', parent: 'boss', tier: TIER, grant: 1, title: 'on the original key' })
  await rig.op({ op: 'hire', name: 'ontwo', parent: 'boss', tier: TIER, grant: 1, title: 'on key two', account: 'openrouter-2' })
  await rig.op({ op: 'hire', name: 'pinned', parent: 'boss', tier: TIER, grant: 1, title: 'pinned to Claude Code', harness: 'claude-code' })
  await idle()
  p.check('stamps follow the keys; only the explicit hire is pinned',
    extra('onone').harness === 'claude-code' && !extra('onone').harness_pin
    && extra('ontwo').harness === 'codex-cli' && !extra('ontwo').harness_pin
    && extra('pinned').harness === 'claude-code' && extra('pinned').harness_pin === true,
    { onone: extra('onone'), ontwo: extra('ontwo'), pinned: extra('pinned') })
  for (const a of ['onone', 'ontwo', 'pinned']) await settle(a, `PROOF-H: first ${a}.`)
  p.check('a seat on the original key runs Claude Code', starts('onone').length >= 1 && !codexStart(starts('onone').at(-1)), starts('onone').at(-1)?.mode)
  p.check('a seat on key two runs Codex (an app-server on key two)', codexStart(starts('ontwo').at(-1))
    && JSON.stringify(starts('ontwo').at(-1)?.args ?? '').includes('app-server'), starts('ontwo').at(-1))
  p.check('control: the pinned seat runs Claude Code', !codexStart(starts('pinned').at(-1)))
  p.check('the original key counts one pinned seat', (await keyDoc('openrouter-key'))?.pinned_seats === 1, (await keyDoc('openrouter-key'))?.pinned_seats)
  p.check('a hire naming a harness OpenRouter cannot use is refused',
    (await refused(rig.op({ op: 'hire', name: 'badh', parent: 'boss', tier: TIER, grant: 1, title: 'x', harness: 'antigravity' }))) !== null)

  // ------------------------------------------------ 3. turn boundary, never mid-turn
  const o0 = starts('onone').length
  const p0 = starts('pinned').length
  const sess0 = extra('onone') && rig.agentRow('onone')?.session_id
  const nLong = rig.turns('onone').filter((t) => t.ended_at).length
  await rig.userMail('onone', 'PROOF-LONG: a long turn.')
  await rig.waitFor(() => rig.fakeLog('onone').some((l) => l.step?.sleep_ms), { what: 'onone to be mid-turn' })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-key', { harness: 'codex-cli' })
  p.check('control: the original key now runs Codex', (await keyDoc('openrouter-key'))?.harness === 'codex-cli')
  await rig.waitTurns('onone', nLong + 1)
  const longTurn = rig.turns('onone').at(-1)
  p.check('the running turn finished on its own CLI: no new start, no kill, its text complete',
    starts('onone').length === o0 && !longTurn.killed && !longTurn.error
    && JSON.stringify(rig.fakeLog('onone')).includes('LONG-DONE'), { starts: starts('onone').length, o0, longTurn })
  p.check('control: the stamp still names the harness the session ran on', extra('onone').harness === 'claude-code')
  await settle('onone', 'PROOF-H: after the key change.')
  p.check('the next turn runs a new Codex CLI', starts('onone').length === o0 + 1 && codexStart(starts('onone').at(-1)),
    { starts: starts('onone').length, mode: starts('onone').at(-1)?.mode })
  p.check('it is a fresh session: the old one ended as a harness switch, the stamp moved',
    sessionsEnded('onone', 'harness switch') === 1 && extra('onone').harness === 'codex-cli' && rig.agentRow('onone')?.session_id !== sess0,
    { ended: sessionsEnded('onone', 'harness switch'), extra: extra('onone') })
  p.check('the fresh session starts with a summary saying why',
    JSON.stringify(rig.fakeLog('onone').filter((l) => l.kind === 'turn').at(-1)?.prompt ?? '').includes('OpenRouter key now runs on Codex'))
  p.check('the switch is logged at the turn boundary', /OpenRouter harness switch at the turn boundary/.test(rig.engineLog()))
  await settle('pinned', 'PROOF-H: pinned after the key change.')
  p.check('the pinned seat is skipped: same CLI, still Claude Code, still pinned',
    starts('pinned').length === p0 && !codexStart(starts('pinned').at(-1)) && extra('pinned').harness === 'claude-code' && extra('pinned').harness_pin === true,
    { starts: starts('pinned').length, p0, extra: extra('pinned') })
  await settle('onone', 'PROOF-H: steady on Codex.')
  p.check('control: after the switch, a turn with nothing changed reuses the Codex CLI', starts('onone').length === o0 + 1)

  // ------------------------------------------------ 4. removal moves a seat onto the destination key's harness
  await rig.api('PUT', '/api/openrouter/keys/openrouter-key', { harness: 'claude-code' })
  const t0 = starts('ontwo').length
  await rig.api('DELETE', '/api/openrouter/keys/openrouter-2')
  await idle()
  const moved = rig.one("SELECT account FROM ot.agents WHERE name = 'ontwo' AND state = 'live'")
  p.check('control: the removed key\'s seat moved to the original key', moved && (moved.account == null || moved.account === 'primary'), moved)
  await settle('ontwo', 'PROOF-H: after its key was removed.')
  p.check('its next turn runs the original key\'s harness (Claude Code) on a fresh session',
    starts('ontwo').length === t0 + 1 && !codexStart(starts('ontwo').at(-1)) && sessionsEnded('ontwo', 'harness switch') === 1
    && extra('ontwo').harness === 'claude-code', { starts: starts('ontwo').length, t0, extra: extra('ontwo') })

  // ------------------------------------------------ 5. installed only
  await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-THREE3', label: 'three', harness: 'codex-cli' })
  await rig.op({ op: 'hire', name: 'onthree', parent: 'boss', tier: TIER, grant: 1, title: 'on key three', account: 'openrouter-3' })
  await idle()
  await settle('onthree', 'PROOF-H: first on three.')
  p.check('control: onthree runs Codex', codexStart(starts('onthree').at(-1)))
  // the staffing offers every hire surface reads (hire menus, templates,
  // Quick chat): a key is offered only while its harness is installed
  const offer = async () => (await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers?.find((t) => t.tier === TIER)
  const offered = (o) => (o?.accounts ?? []).map((a) => a.id)
  p.check('control: with Codex installed, key three is offered for hire', offered(await offer()).includes('openrouter-3'), await offer())
  // taking it away: Windows renames a running image (parked Codex CLIs keep
  // theirs); the engine's next look finds no file
  const codexBin = path.join(rig.dir, 'bin', 'codex.exe')
  const gone = codexBin + '.gone'
  let movedBin = false
  for (let i = 0; i < 20 && !movedBin; i++) {
    try { fs.renameSync(codexBin, gone); movedBin = true } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  p.check('control: the Codex CLI was taken away', movedBin && !fs.existsSync(codexBin))
  try {
    const reg2 = Object.fromEntries(((await rig.api('GET', '/api/harnesses')).harnesses ?? []).map((h) => [h.id, h]))
    p.check('the registry now says Codex is not installed (nothing spawned to find out)', reg2['codex-cli']?.installed === false)
    const doc = await rig.api('GET', '/api/openrouter')
    p.check('the key whose harness is Codex says it is not installed', doc.keys.find((k) => k.id === 'openrouter-3')?.harness_installed === false
      && doc.keys.find((k) => k.id === 'openrouter-3')?.harness === 'codex-cli', doc.keys.find((k) => k.id === 'openrouter-3'))
    const o2 = await offer()
    const want = doc.keys.filter((k) => !k.original && k.harness_installed).map((k) => k.id).sort()
    p.check('staffing offers only the keys whose harness is installed (key three is not)',
      !offered(o2).includes('openrouter-3') && JSON.stringify(offered(o2).sort()) === JSON.stringify(want), { offered: offered(o2), want })
    const orig = doc.keys.find((k) => k.original)
    p.check('a hire naming no key is offered only while the original key’s harness is installed',
      (o2?.default_ok ?? false) === (orig.harness_installed && orig.enabled), { default_ok: o2?.default_ok, orig: { harness: orig.harness, installed: orig.harness_installed } })
    p.check('choosing Codex for a key is refused', (await refused(rig.api('PUT', '/api/openrouter/keys/openrouter-key', { harness: 'codex-cli' }))) === 400)
    p.check('adding a key on Codex is refused', (await refused(rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-FOUR44', harness: 'codex-cli' }))) === 400)
    p.check('a hire pinned to Codex is refused',
      (await refused(rig.op({ op: 'hire', name: 'nocodex', parent: 'boss', tier: TIER, grant: 1, title: 'x', harness: 'codex-cli' }))) !== null)
    const th0 = starts('onthree').length
    const from = rig.engineLog().length
    await rig.userMail('onthree', 'PROOF-H: Codex is gone.')
    await rig.waitFor(() => /Codex is not installed on this computer/.test(rig.engineLog().slice(from))
      || rig.agentRow('onthree')?.last_error, { what: 'onthree\'s launch to be refused', timeout: 60000 })
    const why = `${rig.agentRow('onthree')?.last_error ?? ''} ${rig.engineLog().slice(from)}`
    p.check('a seat whose harness is no longer installed refuses to launch, saying so', /Codex is not installed on this computer/.test(why),
      { last_error: rig.agentRow('onthree')?.last_error })
    p.check('nothing switched silently: no CLI started for it, its stamp is still Codex',
      starts('onthree').length === th0 && extra('onthree').harness === 'codex-cli', { starts: starts('onthree').length, th0, extra: extra('onthree') })
  } finally {
    if (movedBin) fs.renameSync(gone, codexBin)
  }

  // ------------------------------------------------ 6. migration at the next start
  await idle()
  rig.exec(`UPDATE ot.kv SET value = jsonb_set(value, '{openrouter,harness}', '"codex-cli"') WHERE key = 'app_settings';
            UPDATE ot.accounts SET extra = extra - 'harness' WHERE id = 'openrouter-key';
            UPDATE ot.agents SET extra = extra - 'harness_pin' || '{"harness":"claude-code"}' WHERE name = 'onone';
            UPDATE ot.agents SET extra = extra - 'harness_pin' || '{"harness":"codex-cli"}' WHERE name = 'pinned';
            DELETE FROM ot.meta WHERE key = 'openrouter_harness_per_key_v1';`)
  await rig.restart()
  await rig.waitFor(async () => (await keyDoc('openrouter-key'))?.harness, { what: 'the keys after the restart', timeout: 60000 })
  p.check('a key stored without a harness takes the old global value', (await keyDoc('openrouter-key'))?.harness === 'codex-cli')
  p.check('a seat whose stamp differs from its key\'s is pinned to it (the upgrade moves no seat)',
    extra('onone').harness === 'claude-code' && extra('onone').harness_pin === true, extra('onone'))
  p.check('a seat whose stamp matches its key\'s is left to follow it', extra('pinned').harness === 'codex-cli' && !extra('pinned').harness_pin, extra('pinned'))
  p.check('the migration ran once and recorded it', rig.sql("SELECT 1 FROM ot.meta WHERE key = 'openrouter_harness_per_key_v1'").length === 1)
  p.check('control: the migration is logged', /OpenRouter keys carry their own harness seeded=1/.test(rig.engineLog()))

  p.keep(rig, { agents: ['onone', 'ontwo', 'pinned', 'onthree'], grep: /harness|openrouter|panic/i })
  return p.summary()
}
