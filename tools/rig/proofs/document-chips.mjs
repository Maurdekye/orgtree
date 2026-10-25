import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Document chip order' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('document-chips')
  try {
    await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
      { what: 'seed turn complete', timeout: SEED_SETTLE_TIMEOUT })
    const scratch = path.join(rig.data, 'scratch', rig.org, 'rhea')
    fs.mkdirSync(scratch, { recursive: true })
    const sentFiles = []
    for (let n = 1; n <= 6; n++) {
      const result = await rig.tool('rhea', 'orgtree_present', {
        title: `Report ${n}`, body: `# Report ${n}\n\nUnique report body ${n}.`,
      })
      if (!result.ok) throw Error(result.text)
      if (n === 2 || n === 6) {
        const name = `delivery-${n}.txt`
        fs.writeFileSync(path.join(scratch, name), `Delivered file ${n}`)
        const sent = await rig.tool('rhea', 'orgtree_send_file', { path: name })
        if (!sent.ok) throw Error(sent.text)
        sentFiles.push(name)
      }
    }
    const docs = rig.sql("SELECT title FROM ot.documents WHERE node_name='rhea' ORDER BY at DESC,id DESC")
    p.check('six presentations seeded newest first',
      JSON.stringify(docs.map(d => d.title)) === JSON.stringify([6, 5, 4, 3, 2, 1].map(n => `Report ${n}`)), docs)
    p.check('two sent files interleaved with presentations', sentFiles.length === 2, sentFiles)
    const expected = docs.slice(0, 4).map(d => d.title)
    const result = await runDesktop(rig,
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/document-chips.cjs'),
      { out: path.join(p.dir, 'desktop'), args: { expected }, timeout: 60000 })
    p.file('desktop-result.json', result)
    p.check('desktop document-chip driver completed', result.ok === true && result.exit === 0, result.error)
    const value = result.value ?? {}
    for (const surface of ['header', 'node']) {
      const titles = value[surface]
      p.check(`${surface} shows newest four with exact shared document titles`,
        JSON.stringify(titles) === JSON.stringify(expected), { actual: titles, expected })
      p.check(`${surface} excludes sent files`, Array.isArray(titles) && titles.length === 4 &&
        titles.every(title => docs.some(d => d.title === title) && !sentFiles.includes(title)), titles)
    }
    p.check('header opens Report 6', value.headerOpenedReport6 === true)
    p.check('canvas opens Report 6', value.canvasOpenedReport6 === true)
    return { ...value, ...p.summary() }
  } catch (error) {
    p.check('document-chip proof completed without an exception', false, String(error))
    return p.summary()
  }
}
