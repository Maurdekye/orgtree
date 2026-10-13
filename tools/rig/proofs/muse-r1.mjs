// Proof: the Muse lane's R1 findings 1 and 2 (independent review 2026-10-13),
// on the fake `muse serve`, which keeps workspace roots sticky per session as
// MSP does (session/start sets them, a resume restores the stored set,
// turn/start's workspaceRoots replaces it, its absence keeps it) and decides a
// `native_write` as Muse's own root rules would (inside a root: unasked;
// outside: an approval request the engine answers from the scope).
//   rho (finding 1): granted A and B read/write, a first turn writes both
//     natively. B made read-only: after the resume her turn carries the
//     current roots, A stays writable and a write to B is no longer native
//     (it asks, and the engine denies it). C added: it is a native root at
//     once. Unchanged: the same set again. C revoked: no longer a root.
//   sid (finding 2): granted two registry MCP servers whose environment,
//     header and argument values are synthetic sentinels. Through a session
//     start and a resume the host receives them (positive control) while the
//     engine log never holds them; the log names each request's method and
//     outcome. Run it twice: verbose (the rig's default) and `--quiet-log`.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-r1.mjs [--quiet-log]

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const fold = (p) => String(p ?? '').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const same = (a, b) => fold(a) === fold(b)
const has = (roots, dir) => (roots ?? []).some((r) => same(r, dir))

export default async function (rig) {
  const p = new Proof('muse-r1')
  const base = path.join(rig.data, 'r1-folders')
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => path.join(base, n))
  for (const d of [A, B, C, D]) fs.mkdirSync(d, { recursive: true })
  const write = (file) => ({ tool: 'write_file', args: { path: file, content: 'x' }, native_write: true, result: 'written' })
  rig.scenario({ agents: {
    rho: { turns: [
      { name: 'r1', match: 'PROOF-R1', once: true, steps: [write(path.join(A, 'a1.txt')), write(path.join(B, 'b1.txt')), { text: 'Both written.' }] },
      { name: 'r2', match: 'PROOF-R2', once: true, steps: [write(path.join(A, 'a2.txt')), write(path.join(B, 'b2.txt')), { text: 'Tried both.' }] },
      { name: 'r3', match: 'PROOF-R3', once: true, steps: [write(path.join(C, 'c3.txt')), { text: 'Wrote C.' }] },
      { name: 'r4', match: 'PROOF-R4', once: true, steps: [write(path.join(C, 'c4.txt')), { text: 'Wrote C again.' }] },
      { name: 'r5', match: 'PROOF-R5', once: true, steps: [write(path.join(C, 'c5.txt')), { text: 'Tried C.' }] },
    ] },
  }, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const scope = (name, dirs) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { add_dirs: dirs })
  /** mail `name`, wait for that turn, and return what the host logged since */
  const turn = async (name, text, n) => {
    const before = log(name).length
    await rig.userMail(name, text)
    await rig.waitTurns(name, n, { timeout: 60000 })
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}' AND t.ended_at IS NULL`).length === 0,
      { what: `${name}'s turn ${n} to end`, timeout: 60000 })
    return log(name).slice(before)
  }
  const pick = (lines, kind, pred = () => true) => lines.filter((l) => l.kind === kind && pred(l))
  const wrote = (lines, dir) => pick(lines, 'native_write', (l) => fold(l.path).startsWith(fold(dir) + '\\'))[0]

  // ---------------------------------------------------------------- finding 1: sticky roots
  await rig.op({ op: 'hire', name: 'rho', parent: 'boss', tier: 'wonder', title: 'Muse roots agent' })
  await scope('rho', [{ path: A, mode: 'rw' }, { path: B, mode: 'rw' }])
  const t1 = await turn('rho', 'PROOF-R1: write in A and B.', 1)
  const start = log('rho', 'session').find((l) => l.action === 'start')
  const ts1 = pick(t1, 'turn_start')[0]
  p.check('rho: her first turn runs with her folder, A and B as roots and writes both natively',
    has(ts1?.roots, A) && has(ts1?.roots, B) && wrote(t1, A)?.in_root === true && wrote(t1, B)?.in_root === true,
    { start: start?.roots, turn: ts1?.roots, a: wrote(t1, A), b: wrote(t1, B) })

  await scope('rho', [{ path: A, mode: 'rw' }, { path: B, mode: 'ro' }])
  const t2 = await turn('rho', 'PROOF-R2: write in A and B again.', 2)
  const resume = pick(t2, 'session', (l) => l.action === 'resume')[0]
  const ts2 = pick(t2, 'turn_start')[0]
  const deny2 = pick(t2, 'approval')[0]
  p.check('rho: B made read-only, the host is relaunched and her session resumed with the roots it had (A and B)',
    !!resume && resume.session === start?.session && has(resume.roots, B), { resume })
  p.check('rho: that turn carries the current roots, A and not B',
    ts2?.roots_sent === true && has(ts2.roots, A) && !has(ts2.roots, B), ts2)
  p.check('rho: A is still written natively; B is no longer a root, the write asks and the engine denies it',
    wrote(t2, A)?.in_root === true && wrote(t2, B)?.in_root === false && /^deny/.test(deny2?.choice ?? ''),
    { a: wrote(t2, A), b: wrote(t2, B), approval: deny2 })

  await scope('rho', [{ path: A, mode: 'rw' }, { path: B, mode: 'ro' }, { path: C, mode: 'rw' }])
  const t3 = await turn('rho', 'PROOF-R3: write in C.', 3)
  const ts3 = pick(t3, 'turn_start')[0]
  p.check('rho: C added read/write is a native root at the next turn',
    ts3?.roots_sent === true && has(ts3.roots, A) && has(ts3.roots, C) && !has(ts3.roots, B) && wrote(t3, C)?.in_root === true,
    { turn: ts3, c: wrote(t3, C) })

  const t4 = await turn('rho', 'PROOF-R4: write in C again.', 4)
  const ts4 = pick(t4, 'turn_start')[0]
  p.check('rho: with nothing changed the next turn carries the same roots',
    ts4?.roots_sent === true && JSON.stringify((ts4.roots ?? []).map(fold)) === JSON.stringify((ts3?.roots ?? []).map(fold))
      && wrote(t4, C)?.in_root === true, { before: ts3?.roots, after: ts4?.roots })

  await scope('rho', [{ path: A, mode: 'rw' }])
  const t5 = await turn('rho', 'PROOF-R5: write in C once more.', 5)
  const ts5 = pick(t5, 'turn_start')[0]
  p.check('rho: C revoked is no longer a root; the write asks and is denied',
    ts5?.roots_sent === true && !has(ts5.roots, C) && wrote(t5, C)?.in_root === false
      && /^deny/.test(pick(t5, 'approval')[0]?.choice ?? ''),
    { turn: ts5, c: wrote(t5, C), approval: pick(t5, 'approval')[0] })

  // ---------------------------------------------------------------- finding 2: sentinels
  const tag = crypto.randomBytes(6).toString('hex')
  const SENT = { env: `SENTINEL-ENV-${tag}`, header: `SENTINEL-HDR-${tag}`, arg: `SENTINEL-ARG-${tag}` }
  const home = path.join(rig.data, 'rig-home')
  const cfgFile = path.join(home, '.claude.json')
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {}
  // short names sort first, so a preview could not cut them off
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}),
    'aa-sentinel': { command: 'rig-sentinel-mcp', args: ['--auth', SENT.arg], env: { SERVICE_CREDENTIAL: SENT.env } },
    'ab-sentinel': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Service-Key': SENT.header } } }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const settings = await rig.api('GET', '/api/app-settings/runtime').catch(() => ({}))
  const verbose = settings?.verbose_logging === true
  p.note('engine log mode', { verbose, pinned: settings?.verbose_logging_pinned })
  // a hire's grants are clamped to its parent's: boss holds the two servers first
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/scope`, { tools: { mcp: ['aa-sentinel', 'ab-sentinel'] } })
  await rig.op({ op: 'hire', name: 'sid', parent: 'boss', tier: 'wonder', title: 'Muse MCP agent',
    tools: { mcp: ['aa-sentinel', 'ab-sentinel'] } })
  const granted = rig.one(`SELECT scope -> 'tools' -> 'mcp' AS mcp FROM ot.agents WHERE name = 'sid' AND state = 'live'`)?.mcp
  p.check('sid: holds both registry servers', JSON.stringify(granted ?? []).includes('aa-sentinel') && JSON.stringify(granted ?? []).includes('ab-sentinel'), granted)
  const s1 = await turn('sid', 'PROOF-S1: hello.', 1)
  await scope('sid', [{ path: D, mode: 'rw' }])
  const s2 = await turn('sid', 'PROOF-S2: hello again.', 2)
  const sstart = pick(s1, 'session', (l) => l.action === 'start')[0]
  const sresume = pick(s2, 'session', (l) => l.action === 'resume')[0]
  const carries = (l) => !!l && Object.values(SENT).every((v) => JSON.stringify(l.server_config ?? {}).includes(v))
  p.check('sid: the host received every sentinel at session start and again at the resume (positive control)',
    carries(sstart) && carries(sresume), { start: !!sstart, resume: !!sresume, startCarries: carries(sstart), resumeCarries: carries(sresume) })
  const text = rig.engineLog()
  const leaked = Object.entries(SENT).filter(([, v]) => text.includes(v)).map(([k]) => k)
  p.check('sid: the engine log holds none of them (environment, header or argument)', leaked.length === 0, { leaked })
  const lines = text.split(/\r?\n/)
  const msp = (method) => lines.filter((l) => l.includes('MSP request') && l.includes(method))
  p.check('sid: the log names the session start and the resume and how they ended, with no values',
    msp('session/start').length > 0 && msp('session/resume').length > 0
      && [...msp('session/start'), ...msp('session/resume')].every((l) => /outcome/.test(l) && !/mcpServers|SENTINEL/.test(l)),
    { start: msp('session/start').slice(-1), resume: msp('session/resume').slice(-1) })
  const frames = lines.filter((l) => /runtime\.muse\.MuseProc\.(open|posture)\(/.test(l))
  p.check(verbose ? 'sid: verbose call lines were written for the host (the scan saw a verbose trace)'
    : 'sid: no verbose call lines were written (a quiet log), yet the safe request lines were',
    verbose ? frames.length > 0 : frames.length === 0 && msp('session/start').length > 0, { verbose, frames: frames.length })

  p.keep(rig, { agents: ['rho', 'sid'], grep: /MSP request|MSP turn start|muse/i })
  return p.summary()
}
