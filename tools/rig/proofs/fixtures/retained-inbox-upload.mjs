// Seed only the former human composer's persisted upload shape. This is a
// supported scratch-rig database fixture, not a replacement production API.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
export function retainedInboxUpload(rig, org, name, body) {
  const id = 'retained-' + crypto.randomUUID()
  const file = path.join(rig.data, 'uploads', org, '@org-inbox', id + '-' + name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug=${quote(org)}`).id
  rig.exec(`INSERT INTO ot.uploads(id,org_id,agent_id,name,path,bytes)
    VALUES(${quote(id)},${orgId},NULL,${quote(name)},${quote(file)},${Buffer.byteLength(body)})`)
  return { id, path: file, name, bytes: Buffer.byteLength(body) }
}
export async function externalFixtureSender(rig, org, to, body) {
  await rig.op({ op: 'hire', name: 'sender', tier: 'luna', grant: 4 }, { org })
  await rig.op({ op: 'halt', nodes: ['sender'] }, { org })
  const result = await rig.tool('sender', 'orgtree_message', { to, body }, { org })
  if (!result.ok) throw new Error(result.text)
  return result
}
