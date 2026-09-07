import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
for (const file of ['engine/launch.py', 'engine/backend/orgtree/api.py', 'engine/runtime/python.exe', 'engine/runtime/python313.zip', 'engine/runtime/runtime-manifest.json', 'dist/renderer/index.html']) {
  if (!fs.existsSync(file)) throw new Error('Package is incomplete: ' + file + '. Provision the runtime and integrate the real engine first.')
}
console.log('Standalone engine/runtime/UI inputs present')

const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
if (!info.commit || info.dirty !== false || info.commit !== execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    || execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()) {
  throw new Error('Release packaging requires a clean committed source tree matching the build')
}
for (const [file, expected] of Object.entries(info.sha256)) {
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error('Build input changed: ' + file)
}
console.log('Release source and build hashes verified:', info.commit)
