import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { assertMailhubSubmodule, assertNoUpdateFixture, assertPackageInputsPresent, assertReleaseProvenance } from './preflight-lib.mjs'
import { assertRuntimeLayout } from './runtime-layout.mjs'
import { assertPostgresRuntime } from './postgres-layout.mjs'

assertPackageInputsPresent()
// Orgtree 4: the Rust engine ships as resources/engine/orgtree-engine.exe. A
// development build of it defaults verbose logging ON (decision 35), so the
// package takes only one compiled with ORGTREE_RELEASE_BUILD set.
{
  const engine = 'engine/rs/target/release/orgtree-engine.exe'
  if (!fs.existsSync(engine)) throw new Error('Package is incomplete: ' + engine + '. Build it with ORGTREE_RELEASE_BUILD=1 cargo build --release.')
  const version = execFileSync(engine, ['--version'], { encoding: 'utf8' }).trim()
  if (version.includes('(dev)')) throw new Error(`The Rust engine is a development build (${version}); rebuild it with ORGTREE_RELEASE_BUILD=1`)
  console.log('Rust engine present:', version)
}
// Mail hub v2 ships as resources/engine/orgtree-mailhub.exe beside the
// engine (src/mailhub.rs `hub_binary`): the pinned submodule's release build.
{
  const hub = 'engine/mailhub/target/release/orgtree-mailhub.exe'
  if (!fs.existsSync(hub)) throw new Error('Package is incomplete: ' + hub + '. Build it with cargo build --release in engine/mailhub.')
  const version = execFileSync(hub, ['--version'], { encoding: 'utf8' }).trim()
  if (!/^orgtree-mailhub \d/.test(version)) throw new Error(`${hub} is not the mail hub binary (${version})`)
  console.log('Mail hub present:', version)
}
// The complete package layout, not just file existence: 2.1.4-RC4 passed the
// input list with its site-packages staged one level above where the
// interpreter's ._pth looks, and shipped an app that could not start.
assertRuntimeLayout('engine/runtime', { label: 'engine/runtime' })
assertPostgresRuntime('engine', { sourceRoot: process.cwd() })
console.log('Standalone engine/runtime/UI inputs present; runtime package layout verified')

const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
// Before provenance, because this one is about what the artifact CAN DO rather
// than about whether it matches its source: a fixture build with perfectly
// clean provenance is still one that must never be published.
assertNoUpdateFixture(info)
console.log('No update-fixture substitution is compiled into this build')
assertReleaseProvenance(info,
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }))
console.log('Release source and build hashes verified:', info.commit)
assertMailhubSubmodule(info,
  execFileSync('git', ['submodule', 'status', '--', 'engine/mailhub'], { encoding: 'utf8' }),
  execFileSync('git', ['-C', 'engine/mailhub', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
console.log('orgtree-mailhub submodule present, clean, and pinned:', info.mailhubCommit)
