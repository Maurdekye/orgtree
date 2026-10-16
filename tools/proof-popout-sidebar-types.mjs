// Compare the installed native TypeScript compiler on two clean worktrees.
// The baseline is a separate owned checkout: no source mutation or copying.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
const root = process.cwd(), base = process.env.POPOUT_SIDEBAR_BASE_ROOT
const out = process.env.POPOUT_SIDEBAR_OUT, deps = process.env.BATCH_NODE_MODULES
if (!base || !out || !/^C:[\\/]orgtree-build[\\/]/i.test(out) || !deps) throw Error('Owned baseline worktree, C output and real dependencies required')
const expected = execFileSync('git', ['rev-parse', '705a12b'], { cwd: root, encoding: 'utf8' }).trim()
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim()
if (expected !== actual || execFileSync('git', ['status', '--porcelain'], { cwd: base, encoding: 'utf8' }).trim()) throw Error('Baseline must be clean at 705a12b')
const ours = ['apps/desktop/renderer/src/canvas/narrowlist.tsx', 'apps/desktop/renderer/tests/narrowlistowner.test.tsx', 'apps/desktop/renderer/tests/narrowlist-popout-fixture.tsx']
fs.mkdirSync(out, { recursive: true })
function diagnostics(repo, which, label) {
  const config = path.join(out, `${which}-${label}.json`)
  fs.writeFileSync(config, JSON.stringify({ extends: path.join(repo, 'apps/desktop/renderer', which === 'tests' ? 'tests/tsconfig.json' : 'tsconfig.json'),
    compilerOptions: { paths: { '*': [deps + '/*', deps + '/@types/*'], react: [deps + '/@types/react/index.d.ts'],
      'react/*': [deps + '/@types/react/*'], 'react-dom': [deps + '/@types/react-dom/index.d.ts'],
      'react-dom/*': [deps + '/@types/react-dom/*'] }, typeRoots: [deps + '/@types'], types: ['node', deps + '/vite/client'] },
    ...(which === 'tests' ? { include: [repo + '/apps/desktop/renderer/src', repo + '/apps/desktop/renderer/tests'], exclude: [] } : {}) }, null, 2))
  const run = spawnSync(process.execPath, [deps + '/typescript/bin/tsc', '-p', config, '--pretty', 'false', '--noEmit'],
    { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 32 * 1024 * 1024 })
  if (run.error || run.signal || ![0, 1, 2].includes(run.status)) throw Error(String(run.error || run.stderr || run.signal))
  fs.writeFileSync(path.join(out, `${which}-${label}.log`), (run.stdout || '') + (run.stderr || ''))
  const normalize = text => text.replaceAll('\\', '/').replaceAll(repo.replaceAll('\\', '/'), '<repo>')
  const lines = (run.stdout || '').split(/\r?\n/).filter(Boolean).map(normalize).sort()
  const errors = lines.filter(line => /error TS\d+/.test(line))
  return { lines, errors, exit: run.status }
}
const summaries = []
for (const which of ['renderer', 'tests']) {
  const before = diagnostics(base, which, 'baseline'), after = diagnostics(root, which, 'candidate')
  const same = JSON.stringify(before.lines) === JSON.stringify(after.lines)
  const ownErrors = after.errors.filter(line => ours.some(file => line.includes(file)))
  fs.writeFileSync(path.join(out, which + '.json'), JSON.stringify({ before, after, same, ownErrors }, null, 2))
  const summary = { which, baselineErrors: before.errors.length, candidateErrors: after.errors.length, identical: same, ownErrors: ownErrors.length }
  summaries.push(summary); console.log(JSON.stringify(summary))
}
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summaries, null, 2))
process.exitCode = summaries.some(s => !s.identical || s.ownErrors) ? 1 : 0
