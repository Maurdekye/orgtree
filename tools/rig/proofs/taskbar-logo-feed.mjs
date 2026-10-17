// Isolated scratch engine only: normalized picture edits must invalidate the
// app summary without putting image bytes into that feed.
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { Proof } from '../proof.mjs'

export function setup() {
  return { fixture: { org: { name: 'Taskbar logo proof' }, agents: [] } }
}

function chunk(kind, bytes) {
  const payload = Buffer.concat([Buffer.from(kind), bytes])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4), sum = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, payload, sum])
}

function png(red) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6
  const rows = Buffer.alloc(18)
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const at = y * 9 + 1 + x * 4
    rows[at] = red; rows[at + 1] = 60; rows[at + 2] = 120; rows[at + 3] = 255
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

export default async function (rig) {
  const p = new Proof('taskbar-logo-feed')
  const route = `/api/orgs/${rig.org}/profile-picture`
  const { owner } = await rig.api('GET', route)
  const summary = async () => {
    const snapshot = await rig.api('GET', '/api/app/records')
    return snapshot.summaries[String(owner)]?.body
  }
  const current = async expected => rig.waitFor(async () => {
    const body = await summary()
    return body && Object.hasOwn(body, 'logo_sha256') && body.logo_sha256 === expected && body
  }, { timeout: 10000, every: 100, what: `summary logo ${expected ?? 'absent'}` })
  const initial = await current(null)
  p.check('new organization advertises an explicit absent logo', initial.logo_sha256 === null)
  let previous
  for (const [label, red] of [['set', 40], ['replace', 210]]) {
    const saved = await rig.api('POST', route, { owner, data: png(red).toString('base64') })
    const body = await current(saved.sha256)
    p.check(`${label} pushes the normalized content hash`, body.logo_sha256 === saved.sha256 &&
      saved.sha256 === createHash('sha256').update(Buffer.from(saved.data, 'base64')).digest('hex'))
    p.check(`${label} summary omits picture bytes and metadata`, !JSON.stringify(body).includes(saved.data) &&
      !Object.hasOwn(body, 'data') && !Object.hasOwn(body, 'picture') && !Object.hasOwn(body, 'revision'))
    if (previous) p.check('replacement changes the advertised hash', saved.sha256 !== previous)
    previous = saved.sha256
  }
  const removed = await rig.api('POST', route, { owner, data: null })
  const empty = await current(null)
  p.check('removal pushes absent logo while retaining the tombstone', empty.logo_sha256 === null &&
    removed.data === null && removed.sha256 === null && (await rig.api('GET', route)).picture.revision === removed.revision)
  p.keep(rig, { grep: /appfeed|profile_pictures|ERROR/ })
  p.note('Measured real scratch HTTP/store/app-feed invalidation. No live shell, Explorer rendering or installed task handoff.')
  return p.summary()
}
