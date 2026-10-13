// Bounded synthetic proof. Invoke under renderer/tests/joblimit.ps1; no engine or live data.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { withBuildLock } from './rig/lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire('E:/Libraries/Desktop/orgtree/package.json')
const esbuild = req('esbuild'), electron = req('electron')
const output = process.env.USAGE_EXPORT_BUILD, state = process.env.USAGE_EXPORT_STATE
if (!output?.startsWith('C:\\orgtree-build\\hubchat-dm-sol\\') || !state?.startsWith('D:\\orgtree-work\\rig\\hubchat-dm-sol\\')) throw Error('Invalid owned scope')
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(state, { recursive: true })
const dependencies = 'E:/Libraries/Desktop/orgtree/node_modules'
const common = { bundle: true, nodePaths: [dependencies], logLevel: 'warning' }

if (process.argv.includes('--bundle')) {
  for (const base of [true, false]) {
    for (const test of base ? ['usagehistory'] : ['usagehistory', 'usagehistoryexport']) {
      await esbuild.build({ ...common, entryPoints: [path.join(root, `apps/desktop/renderer/tests/${test}.test.${test === 'usagehistory' ? 'tsx' : 'ts'}`)],
        outfile: path.join(output, (base ? 'base-' : '') + test + '.mjs'), platform: 'node', format: 'esm', jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(path.join(root, 'apps/desktop/renderer/src')) },
        plugins: [{ name: 'existing-dependencies-and-base', setup(build) {
          build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(req.resolve('jsdom')).href, external: true }))
          if (base) build.onLoad({ filter: /[/\\]usagehistory\.tsx$/ }, args => {
            const result = spawnSync('git', ['show', '62f39ad:apps/desktop/renderer/src/usagehistory.tsx'], { cwd: root, encoding: 'utf8', windowsHide: true })
            if (result.status !== 0) throw Error(result.stderr)
            return { contents: result.stdout, loader: 'tsx', resolveDir: path.dirname(args.path) }
          })
        } }],
      })
      await esbuild.stop()
    }
  }
  esbuild.buildSync({ ...common, entryPoints: [path.join(root, 'tests/usage-export.fixture.tsx')], outfile: path.join(output, 'renderer.js'),
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  esbuild.buildSync({ ...common, entryPoints: [path.join(root, 'tests/usage-export.probe.ts')], outfile: path.join(output, 'main.cjs'), platform: 'node', format: 'cjs', external: ['electron'] })
  fs.copyFileSync(path.join(root, 'apps/desktop/renderer/src/styles.css'), path.join(output, 'styles.css'))
} else {
  const result = withBuildLock('usage export focused tests/typecheck/native renderer proof', () => {
    const run = (name, exe, args, env = process.env) => {
      const p = spawnSync(exe, args, { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 70000, maxBuffer: 4 * 1024 * 1024 })
      fs.writeFileSync(path.join(output, name + '.log'), (p.stdout || '') + (p.stderr || '') + (p.error ? String(p.error) : ''))
      console.log(name + ': exit ' + p.status + '\n' + ((p.stdout || '') + (p.stderr || '')).slice(-1800))
      return p.status ?? 1
    }
    const results = {}
    if (!process.argv.includes('--remaining')) {
      results.bundle = run('bundle', process.execPath, [fileURLToPath(import.meta.url), '--bundle'])
      if (results.bundle) return { results, exit: 1 }
      const flags = ['--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=10000']
      results.base = run('base-tests', process.execPath, [...flags, path.join(output, 'base-usagehistory.mjs')])
      results.green = run('green-tests', process.execPath, [...flags, path.join(output, 'usagehistory.mjs'), path.join(output, 'usagehistoryexport.mjs')])
    }
    const config = { extends: path.join(root, 'tsconfig.json'), compilerOptions: {
      typeRoots: [dependencies + '/@types'], types: ['node', dependencies + '/vite/client'],
      paths: { react: [dependencies + '/@types/react'], 'react/*': [dependencies + '/@types/react/*'],
        'react-dom': [dependencies + '/@types/react-dom'], 'react-dom/*': [dependencies + '/@types/react-dom/*'], '*': [dependencies + '/*'] },
    } }
    const configFile = path.join(output, 'typecheck.json'); fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
    results.typecheck = run('typecheck', process.execPath, [path.join(dependencies, 'typescript/bin/tsc'), '-p', configFile, '--noEmit'])
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    results.renderer = run('renderer', electron, [path.join(output, 'main.cjs')], env)
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ base: '62f39ad', head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), results }, null, 2))
    return { results, exit: Object.values(results).some(v => v !== 0) ? 1 : 0 }
  })
  console.log(JSON.stringify(result)); process.exitCode = result.result.exit
}
