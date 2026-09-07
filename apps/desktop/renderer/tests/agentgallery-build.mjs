import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
const revert = process.argv.includes('--revert')
const plugins = revert ? [{ name: 'revert-agent-gallery-callback', setup(build) {
  build.onLoad({ filter: /cards\.tsx$/ }, ({ path }) => ({
    contents: readFileSync(path, 'utf8').replace('onOpenAgentGallery(node.id)', 'undefined'), loader: 'tsx' }))
} }] : []
await esbuild.build({ entryPoints: ['tests/agentgallery-fixture.tsx'], bundle: true, format: 'esm', jsx: 'automatic', outfile: 'node_modules/.agentgallery-fixture.js', plugins, define: { 'process.env.NODE_ENV': '"production"' } })
