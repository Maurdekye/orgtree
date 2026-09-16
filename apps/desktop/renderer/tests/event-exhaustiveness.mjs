import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(path.join(os.tmpdir(), 'orgtree-event-exhaustive-'))
// ⚠ RESOLVED, NOT JOINED. `frontend/node_modules` happens to exist in the main
// checkout and does not exist in a linked worktree, which carries only tracked
// files and resolves bare specifiers UPWARD to the shared tree at the repo
// root. Joining the path finds nothing there; resolving walks the same chain
// Node itself walks and works in both places. Anchored on package.json — the
// one subpath every package exports — because `typescript/bin/tsc` is not in
// TypeScript's own `exports` map and resolving it directly throws
// ERR_PACKAGE_PATH_NOT_EXPORTED. Same idiom run.mjs uses for esbuild.
const tsc = path.join(
  path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc')
function compile() {
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', temp], { encoding: 'utf8', timeout: 60000 })
  if (run.error) throw run.error
  assert.notEqual(run.status, null, 'compiler must run to completion')
  return { status: run.status, output: run.stdout + run.stderr }
}
try {
  mkdirSync(path.join(temp, 'events'))
  mkdirSync(path.join(temp, 'generated'))
  for (const file of ['events/project.ts', 'events/value.ts', 'events/decode.ts', 'generated/events.ts', 'generated/events.schema.json'])
    copyFileSync(path.join(frontend, 'src', file), path.join(temp, file))
  writeFileSync(path.join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noUncheckedIndexedAccess: true, module: 'ESNext', target: 'ESNext',
    moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [] }, include: ['**/*.ts'] }))
  const positive = compile()
  assert.equal(positive.status, 0, 'unmodified projection must compile: ' + positive.output)
  const generated = path.join(temp, 'generated/events.ts')
  const original = readFileSync(generated, 'utf8')
  assert.ok(original.includes('export type Event ='), 'generated union anchor must exist')
  writeFileSync(generated, original.replace('export type Event =', 'export type Event = ExhaustivenessProbe ')
    + '\ninterface ExhaustivenessProbe { v: 1; variant: "test.unhandled"; actor: Actor; engine_authored: boolean; object: null }\n')
  const negative = compile()
  assert.notEqual(negative.status, 0, 'an unhandled new variant must fail compilation')
  assert.match(negative.output, /TS2345[^\n]*never/, 'the never-argument guard must fire: ' + negative.output)
  console.log('PASS: unchanged projection compiles; added canonical leaf triggers TS2345 never diagnostic')
} finally {
  // Exact mkdtemp-created child of OS temp; no repository or shared node_modules cleanup.
  const resolved = path.resolve(temp)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('orgtree-event-exhaustive-'))
  rmSync(resolved, { recursive: true, force: true })
}


