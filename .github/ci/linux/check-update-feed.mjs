// Checks the Linux update feed in a folder of release assets before it is staged:
//   node .github/ci/linux/check-update-feed.mjs <dir> <version>
// The channel file must name the AppImage with its exact size and SHA-512, and the
// AppImage must carry the embedded blockmap that differential updates read.
import fs from 'node:fs'
import path from 'node:path'
import { checkLinuxUpdateInfo, linuxChannelFile } from './update-info.mjs'

const [dir, version] = process.argv.slice(2)
if (!dir || !version) { console.error('usage: check-update-feed.mjs <dir> <version>'); process.exit(2) }
const name = linuxChannelFile(version)
const file = path.join(dir, name)
if (!fs.existsSync(file)) { console.log(`::error::${name} is missing from ${dir}`); process.exit(1) }
const problems = []
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) problems.push(message) }
const asset = name => {
  const candidate = path.join(dir, path.basename(name))
  return path.basename(name) === name && fs.existsSync(candidate) ? fs.readFileSync(candidate) : undefined
}
checkLinuxUpdateInfo({ text: fs.readFileSync(file, 'utf8'), version, asset, check })
if (problems.length) { console.log(`::error::${problems.length} problem(s) with ${name}`); process.exit(1) }
console.log(`${name} is a valid update feed for Orgtree ${version}`)
