import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { assertMailhubSubmodule, assertNoUpdateFixture, assertPackageInputsPresent, assertReleaseProvenance } from './preflight-lib.mjs'
import { assertPostgresRuntime, assertVcRuntimeMinimum } from './postgres-layout.mjs'

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
// The sign-in credential broker (src/credential_broker.rs) ships beside it; the
// installer's boot lifecycle registers its logon task (tools/boot-engine-task.ps1).
{
  const broker = 'engine/rs/target/release/orgtree-credential-broker.exe'
  if (!fs.existsSync(broker)) throw new Error('Package is incomplete: ' + broker + '. cargo build --release builds it with the engine.')
  console.log('Credential broker present:', broker)
}
// The post-Setup relaunch helper (engine/rs/orgtree-installer-relaunch) ships
// beside it; build/installer.nsh refuses to skip Finish without it.
{
  const relaunch = 'engine/rs/target/release/orgtree-installer-relaunch.exe'
  if (!fs.existsSync(relaunch)) throw new Error('Package is incomplete: ' + relaunch + '. cargo build --release builds it with the engine.')
  console.log('Relaunch helper present:', relaunch)
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
// The PostgreSQL payload byte for byte against its manifest, not just file
// existence. (Since 4.6.1 there is no embedded Python runtime to check.)
assertPostgresRuntime('engine', { sourceRoot: process.cwd() })
// Setup's Visual C++ runtime minimum (tools/vc-runtime.ps1) must cover the toolset that built this payload.
console.log('PostgreSQL payload within Setup\'s Visual C++ runtime minimum:', JSON.stringify(assertVcRuntimeMinimum('engine')))
console.log('Standalone engine, relaunch helper, mail hub, PostgreSQL and UI inputs present; PostgreSQL payload verified')

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
