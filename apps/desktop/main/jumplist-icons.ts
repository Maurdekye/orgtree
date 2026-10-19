import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { icoFromPng } from './taskbar'
import type { TaskbarIcons, TaskbarOrg } from './jumplist'

type Point = readonly [number, number]
// The same 24-unit silhouettes as icons.ts: MUI HomeOutlined and Add.
// Only straight segments occur in these glyphs. Even/odd fill preserves the
// outlined home's cutout. Supersampling produces a platform-independent PNG.
type ActionIcon = 'home' | 'create' | 'mail' | 'ticket' | 'mention'
const circle = (x: number, y: number, r: number, start = 0, end = Math.PI * 2): Point[] =>
  Array.from({ length: 65 }, (_, i) => { const a = start + (end - start) * i / 64; return [x + r * Math.cos(a), y + r * Math.sin(a)] })
const GLYPHS: Record<ActionIcon, readonly (readonly Point[])[]> = {
  home: [
    [[12,5.69],[17,10.19],[17,18],[15,18],[15,12],[9,12],[9,18],[7,18],[7,10.19]],
    [[12,3],[2,12],[5,12],[5,20],[11,20],[11,14],[13,14],[13,20],[19,20],[19,12],[22,12]],
  ],
  create: [[[19,13],[13,13],[13,19],[11,19],[11,13],[5,13],[5,11],[11,11],[11,5],[13,5],[13,11],[19,11]]],
  mail: [
    [[2,4],[22,4],[22,20],[2,20]],
    [[4,6],[12,11],[20,6]],
    [[4,8],[12,13],[20,8],[20,18],[4,18]],
  ],
  ticket: [
    [[2,4],[22,4],[22,10],[20,10],[20,14],[22,14],[22,20],[2,20],[2,14],[4,14],[4,10],[2,10]],
    [[4,6],[20,6],[20,8],[18,10],[18,14],[20,16],[20,18],[4,18],[4,16],[6,14],[6,10],[4,8]],
    [[11,7],[13,7],[13,9],[11,9]], [[11,11],[13,11],[13,13],[11,13]], [[11,15],[13,15],[13,17],[11,17]],
  ],
  // Alternate-email's ring, inner counter and hooked right stem, flattened
  // to the same 24-unit outline weight as the app's MUI silhouettes.
  mention: [
    [...circle(12,12,10,Math.PI/2,Math.PI*2),[22,13.5],[20,13.5],[20,12],...circle(12,12,8,Math.PI*2,Math.PI/2),[17,20],[17,22]],
    circle(12,12,5),circle(12,12,3),
    [[15,11],[17,11],[17,14],[18,15],[19,15],[20,14],[22,14],[21,16],[19,17],[17,17],[15,15]],
  ],
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function chunk(kind: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(kind), data])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4), sum = Buffer.alloc(4)
  size.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, payload, sum])
}

export function actionPng(kind: ActionIcon): Buffer {
  const size = 64, samples = 4, rows = Buffer.alloc(size * (1 + size * 4))
  const inside = (x: number, y: number) => {
    let fill = false
    for (const polygon of GLYPHS[kind]) {
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [ax, ay] = polygon[i], [bx, by] = polygon[j]
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) fill = !fill
      }
    }
    return fill
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++)
      if (inside((x + (sx + 0.5) / samples) * 24 / size, (y + (sy + 0.5) / samples) * 24 / size)) coverage++
    const at = y * (1 + size * 4) + 1 + x * 4
    rows[at] = rows[at + 1] = rows[at + 2] = 128
    rows[at + 3] = Math.round(255 * coverage / (samples * samples))
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',header), chunk('IDAT',deflateSync(rows)), chunk('IEND',Buffer.alloc(0))])
}

/** Only normalized, currently requested PNG bytes may become a local shell icon. */
export function picturePng(record: unknown, expected: string): Buffer | undefined {
  if (!validHash(expected) || !record || typeof record !== 'object') return
  const r = record as Record<string, unknown>
  if (r.sha256 !== expected || typeof r.data !== 'string' || r.data.length > 349528
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data) || r.data.length % 4 !== 0) return
  const png = Buffer.from(r.data,'base64')
  if (png.length < 33 || png.length > 256 * 1024 || png.length !== r.bytes || hash(png) !== expected
      || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii',12,16) !== 'IHDR') return
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  if (width < 1 || width > 512 || width !== height || width !== r.width || height !== r.height) return
  return png
}

/** Immutable paths make picture changes visible to Explorer's icon cache.
 * Fetch/decode failures retain the executable fallback; only future feed events
 * retry, at most once per hash per 30 seconds. Requests are serialized. */
export class JumpListIcons {
  private fixed: TaskbarIcons = {}
  private logos = new Map<string, string>()
  private retry = new Map<string, number>()
  private pending: readonly TaskbarOrg[] | undefined
  private running: Promise<boolean> | undefined
  constructor(private directory: string,
    private load: (org: TaskbarOrg) => Promise<unknown>,
    private normalize: (png: Buffer) => { png: Buffer; width: number; height: number }) {}

  paths(orgs: readonly TaskbarOrg[]): TaskbarIcons {
    return { ...this.fixed, orgs: Object.fromEntries(orgs.flatMap(org => {
      const icon = org.logo && this.logos.get(org.logo)
      return icon ? [[org.slug, icon]] : []
    })) }
  }

  private async write(key: string, png: Buffer, width: number, height: number): Promise<string> {
    await fs.promises.mkdir(this.directory, { recursive: true })
    const target = path.join(this.directory, key + '.ico')
    if (fs.existsSync(target)) return target
    const temporary = target + '.' + randomUUID() + '.part'
    try {
      await fs.promises.writeFile(temporary, icoFromPng(png,width,height), { flag: 'wx' })
      await fs.promises.rename(temporary,target)
    } finally { await fs.promises.unlink(temporary).catch(() => {}) }
    return target
  }

  prepare(orgs: readonly TaskbarOrg[]): Promise<boolean> {
    this.pending = orgs
    if (this.running) return this.running
    this.running = this.drain().finally(() => { this.running = undefined })
    return this.running
  }

  private async drain(): Promise<boolean> {
    let changed = false
    for (const kind of ['home','create','mail','ticket','mention'] as const) if (!this.fixed[kind]) {
      try {
        const png = actionPng(kind)
        this.fixed[kind] = await this.write(kind + '-' + hash(png),png,64,64)
        changed = true
      } catch { /* app icon until this app-owned folder becomes writable */ }
    }
    while (this.pending) {
      const orgs = this.pending; this.pending = undefined
      const active = new Set(orgs.map(org => org.logo).filter(validHash))
      for (const map of [this.logos, this.retry]) for (const key of map.keys()) if (!active.has(key)) map.delete(key)
      for (const org of orgs) {
        const logo = org.logo
        if (!validHash(logo) || this.logos.has(logo) || (this.retry.get(logo) ?? 0) > Date.now()) continue
        this.retry.set(logo,Date.now() + 30000)
        try {
          const target = path.join(this.directory,'logo-v1-' + logo + '.ico')
          if (fs.existsSync(target)) { this.logos.set(logo,target); changed = true; continue }
          const png = picturePng(await this.load(org),logo)
          if (!png) continue
          const image = this.normalize(png)
          if (image.width < 1 || image.width > 256 || image.height !== image.width) continue
          this.logos.set(logo,await this.write('logo-v1-' + logo,image.png,image.width,image.height))
          changed = true
        } catch { /* missing/corrupt/stale pictures keep the app icon */ }
      }
    }
    return changed
  }
}
