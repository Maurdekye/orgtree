// Compare the strict renderer/test configs without mutating a worktree.
// Both sides include final test fixtures; only the production hook is overlaid
// in memory from the baseline. Any diagnostic in an added/changed file fails.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const root = process.cwd(), out = process.env.POPOUT_SIDEBAR_OUT, deps = process.env.BATCH_NODE_MODULES
if (!out || !/^C:[\\/]orgtree-build[\\/]/i.test(out) || !deps) throw Error('Assigned C output and real dependencies required')
const ts = createRequire(path.join(deps, '../package.json'))('typescript')
const changed = 'apps/desktop/renderer/src/canvas/narrowlist.tsx'
const baseline = execFileSync('git', ['show', '705a12b:' + changed], { cwd: root, encoding: 'utf8' })
const normal = p => p.replaceAll('\\', '/').toLowerCase()
const ours = [changed, 'apps/desktop/renderer/tests/narrowlistowner.test.tsx', 'apps/desktop/renderer/tests/narrowlist-popout-fixture.tsx']
fs.mkdirSync(out, { recursive: true })
function diagnostics(which, old) {
  const config = path.join(root, 'apps/desktop/renderer', which === 'tests' ? 'tests/tsconfig.json' : 'tsconfig.json')
  const options = { paths: { '*': [deps + '/*', deps + '/@types/*'], react: [deps + '/@types/react/index.d.ts'],
    'react/*': [deps + '/@types/react/*'], 'react-dom': [deps + '/@types/react-dom/index.d.ts'],
    'react-dom/*': [deps + '/@types/react-dom/*'] }, typeRoots: [deps + '/@types'], types: ['node', deps + '/vite/client'] }
  const read = ts.readConfigFile(config, ts.sys.readFile)
  if (read.error) throw Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const source = { ...read.config, ...(which === 'tests' ? { exclude: [] } : {}) }
  const parsed = ts.parseJsonConfigFileContent(source, ts.sys, path.dirname(config), options, config)
  if (parsed.errors.length) throw Error(JSON.stringify(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))))
  const host = ts.createCompilerHost(parsed.options), original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, ...args) => old && normal(file) === normal(path.join(root, changed))
    ? ts.createSourceFile(file, baseline, language, true, ts.ScriptKind.TSX) : original(file, language, ...args)
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  return ts.getPreEmitDiagnostics(program).map(d => ({ file: d.file ? path.relative(root, d.file.fileName).replaceAll('\\', '/') : '',
    start: d.start, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
const summaries = []
for (const which of ['renderer', 'tests']) {
  const before = diagnostics(which, true), after = diagnostics(which, false)
  const same = JSON.stringify(before) === JSON.stringify(after)
  const ownErrors = after.filter(d => ours.includes(d.file))
  fs.writeFileSync(path.join(out, which + '.json'), JSON.stringify({ before, after, same, ownErrors }, null, 2))
  const summary = { which, baselineErrors: before.length, candidateErrors: after.length, identical: same, ownErrors: ownErrors.length }
  summaries.push(summary); console.log(JSON.stringify(summary))
}
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summaries, null, 2))
process.exitCode = summaries.some(s => !s.identical || s.ownErrors) ? 1 : 0
