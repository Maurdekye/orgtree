import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { assertPackageInputsPresent, assertReleaseProvenance } from './preflight-lib.mjs'

assertPackageInputsPresent()
console.log('Standalone engine/runtime/UI inputs present')

const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
assertReleaseProvenance(info,
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }))
console.log('Release source and build hashes verified:', info.commit)
