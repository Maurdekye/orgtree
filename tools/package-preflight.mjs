import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { assertPackageInputsPresent, assertReleaseProvenance } from './preflight-lib.mjs'
import { assertRuntimeLayout } from './runtime-layout.mjs'

assertPackageInputsPresent()
// The complete package layout, not just file existence: 2.1.4-RC4 passed the
// input list with its site-packages staged one level above where the
// interpreter's ._pth looks, and shipped an app that could not start.
assertRuntimeLayout('engine/runtime', { label: 'engine/runtime' })
console.log('Standalone engine/runtime/UI inputs present; runtime package layout verified')

const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
assertReleaseProvenance(info,
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }))
console.log('Release source and build hashes verified:', info.commit)
