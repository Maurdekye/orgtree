// Global user notes are startup context, independent of an agent's harness.
// Run against the unchanged base before the fix, then the exact candidate.
// Uses ONLY rig-home fixtures; neither imports nor edits the real user profile.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const occurrences = (text, needle) => text.split(needle).length - 1

export default async function (rig) {
  const p = new Proof('global-instructions')
  const home = path.join(rig.data, 'rig-home')
  const fixtures = new Map([
    ['.claude/CLAUDE.md', 'NATIVE_CLAUDE_GLOBAL_SENTINEL\n'],
    ['.codex/AGENTS.md', 'FOREIGN_CODEX_GLOBAL_SENTINEL\n'],
    ['.gemini/GEMINI.md', 'FOREIGN_GEMINI_GLOBAL_v1\n'],
    ['.config/opencode/AGENTS.md', 'FOREIGN_OPENCODE_GLOBAL_SENTINEL\n'],
    ['.claude/rules/empty.md', ' \r\n'],
  ])
  const write = (relative, text) => {
    const file = path.join(home, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  for (const [file, text] of fixtures) write(file, text)
  rig.scenario({
    agents: { globalnotes: { turns: [{ name: 'long', match: 'GLOBAL-LONG', once: true,
      steps: [{ text: 'Working.' }, { sleep_ms: 32000 }, { text: 'Done.' }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settled', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'globalnotes', parent: 'boss', tier: 'haiku', title: 'Global instruction proof' })
  const starts = () => rig.fakeLog('globalnotes').filter(row => row.kind === 'start')
  const turn = async text => {
    const done = rig.turns('globalnotes').filter(row => row.ended_at).length
    await rig.userMail('globalnotes', text)
    await rig.waitTurns('globalnotes', done + 1)
  }
  const prefix = () => {
    const args = starts().at(-1)?.args ?? []
    const index = args.indexOf('--append-system-prompt-file')
    return index >= 0 ? fs.readFileSync(args[index + 1], 'utf8') : ''
  }
  await turn('First global notes turn.')
  const first = prefix(), count = starts().length
  p.check('positive control: Claude launched with a nonempty engine identity', first.length > 100 && count > 0)
  for (const marker of ['FOREIGN_CODEX_GLOBAL_SENTINEL', 'FOREIGN_GEMINI_GLOBAL_v1', 'FOREIGN_OPENCODE_GLOBAL_SENTINEL']) {
    p.check(`foreign global file delivered exactly once: ${marker}`, occurrences(first, marker) === 1)
  }
  p.check('native Claude global file is not mirrored', !first.includes('NATIVE_CLAUDE_GLOBAL_SENTINEL'))
  p.check('empty global rule is not emitted as a labelled block', !first.includes('rules/empty.md') && !first.includes('rules\\empty.md'))
  await turn('No file changed.')
  p.check('unchanged inputs preserve byte-identical prefix and warm process', prefix() === first && starts().length === count)

  const sid = rig.agentRow('globalnotes')?.session_id
  await rig.userMail('globalnotes', 'GLOBAL-LONG: keep this turn running.')
  await rig.waitFor(() => rig.fakeLog('globalnotes').some(row => row.kind === 'step' && row.step?.sleep_ms),
    { what: 'active long turn', timeout: 30000 })
  write('.gemini/GEMINI.md', 'FOREIGN_GEMINI_GLOBAL_v2\n')
  const refresh = await rig.api('POST', '/api/global-instructions/refresh', {}).catch(() => null)
  p.check('Refresh succeeds with metadata only', refresh?.refreshed === true && Number.isInteger(refresh?.files)
    && Object.keys(refresh).every(key => ['refreshed', 'files'].includes(key)))
  await pause(23000) // beyond the startup recheck, while the same turn is active
  p.check('refresh and edit never replace or rewrite an active turn',
    starts().length === count && prefix() === first && rig.turns('globalnotes').some(row => !row.ended_at))
  await rig.waitFor(() => rig.turns('globalnotes').every(row => row.ended_at), { what: 'long turn ends', timeout: 30000 })
  const forecast = await rig.waitFor(async () => {
    const records = await rig.api('GET', `/api/orgs/${rig.org}/records`)
    const value = records?.runtime?.agents?.[String(rig.agentRow('globalnotes')?.id)]?.cache_forecast
    return value?.changed_inputs?.includes('startup') ? value : null
  }, { what: 'global edit reported as startup change', timeout: 26000 }).catch(() => null)
  p.check('cache forecast attributes global edit to startup', !!forecast)
  await turn('Next boundary after the global edit.')
  const last = starts().at(-1), args = last?.args ?? [], resume = args.indexOf('--resume')
  p.check('next start receives new bytes once and resumes the same session',
    starts().length === count + 1 && occurrences(prefix(), 'FOREIGN_GEMINI_GLOBAL_v2') === 1
    && !prefix().includes('FOREIGN_GEMINI_GLOBAL_v1') && resume >= 0 && args[resume + 1] === sid
    && rig.agentRow('globalnotes')?.session_id === sid)
  p.check('discovery never modifies original global files', [...fixtures].every(([file, text]) =>
    fs.readFileSync(path.join(home, file), 'utf8') === (file === '.gemini/GEMINI.md' ? 'FOREIGN_GEMINI_GLOBAL_v2\n' : text)))
  const log = rig.engineLog()
  p.check('private global instruction text is absent from verbose engine logs',
    log.length > 0 && prefix().includes('FOREIGN_GEMINI_GLOBAL_v2')
    && !log.includes('FOREIGN_GEMINI_GLOBAL_') && !log.includes('FOREIGN_CODEX_GLOBAL_SENTINEL'))
  const bad = '.gemini/config/rules/unreadable.md'
  write(bad, '')
  fs.writeFileSync(path.join(home, bad), Buffer.from([0xff, 0xfe, 0x00]))
  let failure = ''
  try { await rig.api('POST', '/api/global-instructions/refresh', {}) }
  catch (error) { failure = String(error) }
  p.check('an existing unreadable file makes Refresh fail without exposing its path or contents',
    failure.includes('Global instructions could not be fully refreshed') && !failure.includes('unreadable.md')
    && !failure.includes(home) && !failure.includes('GLOBAL_SENTINEL'))
  fs.unlinkSync(path.join(home, bad))
  p.keep(rig, { agents: ['globalnotes'] })
  return p.summary()
}
