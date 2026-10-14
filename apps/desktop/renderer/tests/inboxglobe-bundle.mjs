// Verification-owner only: outputs belong in its authorized C build scope.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { beforeInboxGlobe } from './faroverview-baseline.mjs'
const [sourceRoot, outputDir, dependencies] = process.argv.slice(2)
if (!sourceRoot || !outputDir || !dependencies) throw new Error('sourceRoot C-output dependencies required')
const root = path.resolve(sourceRoot), output = path.resolve(outputDir), deps = path.resolve(dependencies)
if (!/^C:[\\/]orgtree-build[\\/]/i.test(output)) throw new Error('output must use authorized C build scope')
const require = createRequire(path.join(deps, '../package.json'))
const esbuild = require('esbuild')
fs.mkdirSync(output, { recursive: true })
for (const phase of ['before', 'after']) {
  await esbuild.build({ entryPoints: [root + '/apps/desktop/renderer/tests/faroverview-fixture.tsx'],
    outfile: output + '/' + phase + '.js', bundle: true, format: 'iife', platform: 'browser',
    jsx: 'automatic', nodePaths: [deps], define: { 'process.env.NODE_ENV': '"development"' },
    plugins: phase === 'before' ? [{ name: 'inbox-globe-narrow-red', setup(build) {
      build.onLoad({ filter: /[\\/]canvas[\\/]OrgCanvas\.tsx$/ }, args => ({
        contents: beforeInboxGlobe(fs.readFileSync(args.path, 'utf8')), loader: 'tsx',
      }))
    } }] : [],
  })
}
esbuild.stop()
