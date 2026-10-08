import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { TOKEN_HEADER } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Attachment limits' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('attachment-limits')
  const MiB = 1024 * 1024
  const route = `/api/orgs/${rig.org}/org_inbox`
  const advertise = bytes => fs.writeFileSync(path.join(rig.data, 'rig-hub-limits.json'), JSON.stringify({
    '@net:peer': { max_attachment_bytes: bytes },
  }))
  const limit = to => rig.api('GET', `${route}/upload_limit?to=${encodeURIComponent(to)}`)
  const upload = async (bytes, to = '@net:peer') => {
    async function* chunks() {
      const chunk = Buffer.alloc(Math.min(65536, bytes), 65)
      for (let sent = 0; sent < bytes; sent += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, bytes - sent))
    }
    const response = await fetch(`${rig.url}${route}/upload?name=stream.bin&to=${encodeURIComponent(to)}`, {
      method: 'POST', headers: { [TOKEN_HEADER]: rig.token }, body: chunks(), duplex: 'half',
      signal: AbortSignal.timeout(120000),
    })
    return { status: response.status, body: await response.json() }
  }
  const hosted = await rig.api('GET', '/api/desktop/hub')
  p.check('hosted default is 1 GiB', hosted.max_attachment_bytes === 1024 * MiB, hosted.max_attachment_bytes)
  await rig.api('PUT', '/api/desktop/hub', { max_attachment_bytes: 64 * MiB })
  const saved = JSON.parse(fs.readFileSync(path.join(rig.data, 'mailhub-hosting.json')))
  const live = JSON.parse(fs.readFileSync(path.join(rig.data, 'mailhub-upload-limit.json')))
  p.check('limit-only setting updates persistent and runtime configuration', saved.max_attachment_bytes === 64 * MiB && live.max_attachment_bytes === 64 * MiB)
  const rejected = await rig.api('PUT', '/api/desktop/hub', { max_attachment_bytes: 0 }).then(() => false, () => true)
  p.check('zero limit refused without changing saved setting', rejected && (await rig.api('GET', '/api/desktop/hub')).max_attachment_bytes === 64 * MiB)
  const legacy = await limit('@net:old')
  p.check('old hub has 25 MiB fallback with explicit explanation', legacy.max_attachment_bytes === 25 * MiB && legacy.legacy && legacy.too_large.includes("this hub doesn't state its limit; using 25 MB"), legacy)
  advertise(64 * MiB)
  p.check('advertised limit reaches client preflight', (await limit('@net:peer')).max_attachment_bytes === 64 * MiB)
  const large = await upload(32 * MiB)
  const staged = large.body.id && rig.one(`SELECT path,bytes FROM ot.uploads WHERE id='${large.body.id}'`)
  p.check('32 MiB raw stream passes old 25 MiB cap and is staged exactly', large.status === 200 && staged?.bytes === 32 * MiB && fs.statSync(staged.path).size === 32 * MiB, large)
  advertise(256)
  const folder = path.join(rig.data, 'uploads', rig.org, '@org-inbox')
  const before = fs.readdirSync(folder)
  const over = await upload(257)
  p.check('subsequent upload sees changed limit and cleans rejected partial', over.status === 413 && fs.readdirSync(folder).length === before.length, over)
  const exact = await upload(256)
  p.check('exact advertised boundary accepted', exact.status === 200 && exact.body.bytes === 256, exact)
  const scratch = path.join(rig.data, 'scratch', rig.org, 'rhea')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'too-large.bin'), Buffer.alloc(257))
  const agent = await rig.tool('rhea', 'orgtree_message', { to: '@net:peer', body: 'File', attachments: ['too-large.bin'] })
  p.check('agent tool rejects oversized attachment before queuing', !agent.ok && agent.text.includes('256 bytes'), agent.text)
  p.note('Canned health documents replace only hub discovery in debug rig mode. HTTP staging, persistent settings and agent tool path are real. Standalone hub streaming/live-limit tests cover the Python side; no hub listener, real identity or end-to-end network delivery is used. Actual 1 GiB transfer is not measured.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
