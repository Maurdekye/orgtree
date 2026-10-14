// Verification-owner runner: explicit C output, shared dependencies read in place.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const [sourceRoot, outputDir, dependencies, mode, ...suites] = process.argv.slice(2)
if (!sourceRoot || !outputDir || !dependencies || !mode) throw new Error('root output dependencies mode [suites] required')
const root = path.resolve(sourceRoot), output = path.resolve(outputDir), deps = path.resolve(dependencies)
const require = createRequire(path.join(deps, '../package.json'))
fs.mkdirSync(output, { recursive: true })
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim()
const baseline = process.env.UI_APPKEY_BASE
console.log(JSON.stringify({ sourceRoot: root, head, dependencies: deps, base: baseline ?? null }))
if (mode === 'typecheck') {
  const config = path.join(output, 'tsconfig.json')
  fs.writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: {
    paths: { react: [deps + '/@types/react/index.d.ts'], 'react/*': [deps + '/@types/react/*'],
      'react-dom': [deps + '/@types/react-dom/index.d.ts'], 'react-dom/*': [deps + '/@types/react-dom/*'],
      '*': [deps + '/*', deps + '/@types/*'] }, typeRoots: [deps + '/@types'], types: ['node', deps + '/vite/client'],
  } }))
  const result = spawnSync(process.execPath, [deps + '/typescript/bin/tsc', '-p', config, '--pretty', 'false'],
    { stdio: 'inherit', windowsHide: true, timeout: 120000 })
  process.exitCode = result.status ?? 1
} else if (mode === 'tests') {
  if (!suites.length) throw new Error('explicit focused suites required')
  const esbuild = require('esbuild'), bundles = []
  const baseFiles = ['apps/desktop/renderer/src/App.tsx', 'apps/desktop/renderer/src/KillSwitch.tsx',
    'apps/desktop/renderer/src/shell/menu.tsx']
  for (const name of suites) {
    const outfile = path.join(output, name + '.mjs')
    await esbuild.build({ entryPoints: [root + '/apps/desktop/renderer/tests/' + name + '.test.tsx'], outfile,
      bundle: true, format: 'esm', platform: 'node', target: 'node22', jsx: 'automatic', nodePaths: [deps], external: ['node:*'],
      define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(root + '/apps/desktop/renderer/src') },
      plugins: [
        ...(baseline ? [{ name: 'exact-appkey-base', setup(build) {
          build.onLoad({ filter: /[\\/]src[\\/](App|KillSwitch)\.tsx$|[\\/]src[\\/]shell[\\/](menu\.tsx|appshortcuts\.ts)$/ }, args => {
            const candidates = process.env.UI_APPKEY_TABLE_BASE ? [...baseFiles,
              'apps/desktop/renderer/src/shell/appshortcuts.ts'] : baseFiles
            const file = candidates.find(candidate => path.resolve(root, candidate).toLowerCase() === args.path.toLowerCase())
            if (!file) return
            const result = spawnSync('git', ['show', baseline + ':' + file], { cwd: root, encoding: 'utf8', windowsHide: true })
            if (result.status !== 0) throw new Error(result.stderr)
            console.log('EXACT_BASE_SOURCE ' + baseline + ' ' + file)
            return { contents: result.stdout, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' }
          })
        } }] : []),
        { name: 'real-jsdom', setup(build) {
          build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
        } },
      ],
    })
    esbuild.stop(); bundles.push(outfile)
  }
  const result = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=10000', '--test-concurrency=1', ...bundles],
    { stdio: 'inherit', windowsHide: true, timeout: 120000 })
  process.exitCode = result.status ?? 1
} else throw new Error('mode must be typecheck or tests')
