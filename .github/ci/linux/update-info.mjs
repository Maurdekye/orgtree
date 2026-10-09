// The Linux update feed (latest-linux.yml; alpha-/beta-linux.yml for a prerelease), checked
// the way the AppImage updater (electron-updater's AppImageUpdater) will read it. Used by
// check-update-feed.mjs in the build and by ../releasing/verify-published.mjs after publishing.
// Node built-ins only: the verify-release job runs without npm ci.
import crypto from 'node:crypto'
import zlib from 'node:zlib'

/** latest-linux.yml for a stable version, alpha-/beta-linux.yml for a prerelease
 *  (electron-builder names the channel after the version's first prerelease label). */
export function linuxChannelFile(version) {
  const label = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(version)?.[1]
  return `${label ?? 'latest'}-linux.yml`
}

/** electron-builder's update info: top-level scalars plus the `files:` list of maps. */
export function parseUpdateInfo(text) {
  const scalar = value => {
    const v = value.trim()
    return /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : /^".*"$/.test(v) ? JSON.parse(v) : v
  }
  const info = { files: [] }
  let inFiles = false
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) continue
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (top) {
      inFiles = top[1] === 'files' && top[2] === ''
      if (!inFiles) info[top[1]] = scalar(top[2])
      continue
    }
    const item = /^\s+(-\s+)?([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!inFiles || !item) throw new Error(`unexpected line in the update info: ${line}`)
    if (item[1]) info.files.push({})
    const entry = info.files.at(-1)
    if (!entry) throw new Error(`a files entry without a leading '-': ${line}`)
    entry[item[2]] = scalar(item[3])
  }
  return info
}

/** The blockmap electron-builder appends to an AppImage: deflate-raw JSON, then its
 *  length as a big-endian uint32. The updater reads the OLD copy's from the running
 *  file and the NEW one's by a range request sized from blockMapSize. */
export function embeddedBlockMap(bytes) {
  const length = bytes.readUInt32BE(bytes.length - 4)
  const map = JSON.parse(zlib.inflateRawSync(bytes.subarray(bytes.length - 4 - length, bytes.length - 4)).toString('utf8'))
  const file = map.files?.[0]
  const covered = file ? (file.offset ?? 0) + file.sizes.reduce((sum, size) => sum + size, 0) : 0
  return { length, version: map.version, blocks: file?.sizes.length ?? 0, covered, content: bytes.length - 4 - length }
}

/** Checks `text` (the channel file) against the assets it names. `asset(name)` returns
 *  that file's bytes or undefined; `check(ok, message)` records one result. */
export function checkLinuxUpdateInfo({ text, version, asset, check }) {
  const name = linuxChannelFile(version)
  const appImage = `Orgtree-${version}.AppImage`
  let info
  try { info = parseUpdateInfo(text) } catch (error) { check(false, `${name} parses: ${error.message}`); return }
  check(info.version === version, `${name} version ${info.version}`)
  check(info.path === appImage, `${name} path ${info.path}`)
  const entry = info.files.find(file => file.url === appImage)
  check(!!entry, `${name} lists ${appImage} (files: ${info.files.map(file => file.url).join(', ')})`)
  for (const file of info.files) {
    const bytes = asset(file.url)
    if (!bytes) { check(false, `${name} names ${file.url}, which is not an asset`); continue }
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
    check(file.sha512 === sha512, `${name} sha512 is ${file.url}'s`)
    check(Number(file.size) === bytes.length, `${name} size is ${file.url}'s (${bytes.length})`)
  }
  const bytes = asset(appImage)
  if (!entry || !bytes) return
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
  check(info.sha512 === sha512, `${name} top-level sha512 is the AppImage's`)
  let map
  try { map = embeddedBlockMap(bytes) } catch (error) { check(false, `${appImage} carries an embedded blockmap: ${error.message}`); return }
  check(Number(entry.blockMapSize) === map.length, `${name} blockMapSize ${entry.blockMapSize} = the AppImage's embedded blockmap (${map.length} bytes)`)
  check(map.blocks > 0 && map.covered === map.content,
    `the embedded blockmap (v${map.version}, ${map.blocks} blocks) covers the AppImage's ${map.content} bytes before it (covers ${map.covered})`)
}
