import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { assertMailhubSubmodule, assertNoUpdateFixture, assertPackageInputsPresent, assertReleaseProvenance } from './preflight-lib.mjs'
import { assertRuntimeLayout } from './runtime-layout.mjs'
import { assertPostgresRuntime } from './postgres-layout.mjs'

assertPackageInputsPresent()
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
