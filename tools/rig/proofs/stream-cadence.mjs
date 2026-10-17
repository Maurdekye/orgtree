import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { RIG_DIR } from '../lib.mjs'
import { runDesktop } from '../desktop.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

const lanes = [['claude', 'sonnet'], ['codex', 'sol'], ['agy', 'argon'], ['muse', 'wonder'], ['opencode', 'or-rig-fake-model']]
const pieces = (label, count) => Array.from({ length: count }, (_, i) => `${label}_${String(i).padStart(4, '0')}`.padEnd(24, '.') + ' ')
const text = name => pieces('CADENCE_' + name, 80).join('') + 'CADENCE_END'
const thought = pieces('THINK', 16).join('')
const cpu = pid => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).CPU`], {encoding:'utf8',windowsHide:true})
  return Number(r.stdout.trim())
}
export async function setup() {
  const keys = await keysSetup()
  return { ...keys, name: 'stream-cadence', streamProbe: true, quietLog: true,
    prepare: async info => {
      await keys.prepare(info)
      fs.mkdirSync(path.join(info.dir,'fakecli'),{recursive:true})
      fs.writeFileSync(path.join(info.dir,'fakecli/agy-models.txt'),'gemini-4-argon\tGemini 4 Argon\n')
    },
    fixture: { org: { name: 'Stream cadence', settings: { default_top_grant: 4 } } } }
}
const distribution = values => {
  const a = values.toSorted((x, y) => x - y)
  return { count: a.length, p50: a[Math.floor(a.length * .5)] ?? null, p95: a[Math.floor(a.length * .95)] ?? null, max: a.at(-1) ?? null }
}
const intervals = rows => distribution(rows.slice(1).map((r, i) => r.at - rows[i].at))
export default async function (rig, { out } = {}) {
  if (!out) throw Error('measurement output required')
  fs.mkdirSync(out, { recursive: true })
  await rig.api('GET', '/api/openrouter?force=true')
  await rig.api('PUT', '/api/openrouter/keys/openrouter-1', { harness: 'opencode' })
  const scenarios = Object.fromEntries(lanes.map(([name]) => [name, { turns: [{ match: 'CADENCE-PROOF', steps: [
    ...(name === 'agy' ? [] : [{ thinking: thought, delay_ms: 20 }]),
    { text: text(name), chunk: 24, delay_ms: 20 }, { sleep_ms: 500 },
  ] }] }]))
  rig.scenario({ agents: scenarios, default: { turns: [{ steps: [{ text: 'Ready.' }] }] } })
  for (const [name, tier] of lanes) {
    await rig.op({ op: 'hire', name, tier, grant: 4, charter: 'Synthetic stream cadence fixture only.' })
  }
  const scratch = rig.one(`SELECT scratch_dir FROM ot.agents WHERE name='opencode'`)?.scratch_dir
  if (!scratch) throw Error('no ACP scratch')
  fs.writeFileSync(path.join(scratch, 'acp-fixture.json'), JSON.stringify({ stream: [
    ...pieces('THINK', 16).map(text => ({kind:'thinking',text,delayMs:20})),
    ...pieces('CADENCE_opencode',80).concat('CADENCE_END').map(text => ({text,delayMs:20})),
  ] }))
  const results = []
  for (const [agent] of lanes) {
    const cpuBefore = cpu(rig.run.enginePid), start = Date.now()
    const desktop = await runDesktop(rig, path.join(RIG_DIR, 'desktop/stream-cadence.cjs'), {
      args: { agent }, preset: '1000x700', out: path.join(out, agent), timeout: 90000,
    })
    const cpuAfter = cpu(rig.run.enginePid)
    fs.writeFileSync(path.join(out, agent + '.json'), JSON.stringify(desktop, null, 2))
    const value = desktop.value
    const summary = { agent, ok:desktop.ok, error:desktop.error, start, end:Date.now(),
      engineCpuSec:cpuAfter - cpuBefore,
      ...(value ? { wire:intervals(value.wire), ingest:intervals(value.ingest), paint:intervals(value.paint),
        wireSizes:distribution(value.wire.map(x => x.size)), publications:value.publish.length,
        mutations:value.mutations,msgRenders:value.msgRenders.length,deskRenders:value.deskRenders,longTasks:value.longTasks,finalMarker:value.final.includes('CADENCE_END'),
        metrics:Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].map(name => [name,
          (value.after.metrics.find(x=>x.name===name)?.value || 0)-(value.before.metrics.find(x=>x.name===name)?.value || 0)])),
      } : {}) }
    results.push(summary)
    console.log(JSON.stringify(summary))
    if (!desktop.ok) throw Error(`${agent}: ${desktop.error}`)
    if (!value.wire.length || value.wire.length !== value.ingest.length || value.paint.length < 2 || !summary.finalMarker)
      throw Error(`${agent}: incomplete wire/ingestion/paint denominator`)
    if (agent !== 'agy' && !value.wire.some(f=>f.kind==='thinking')) throw Error(`${agent}: thought stream did not execute`)
  }
  // Keep only this engine incarnation's log. Later starts must not move a
  // byte-offset window into the middle of a concatenated multi-engine log.
  const engineLog = rig.engineLogFiles().find(file => fs.readFileSync(file,'utf8').includes(`engine starting pid=${rig.run.enginePid} `))
  if (!engineLog) throw Error('cannot identify this engine log')
  const log = fs.readFileSync(engineLog,'utf8')
  fs.writeFileSync(path.join(out, 'engine-cadence.log'),log.split(/\r?\n/).filter(line=>line.includes('rig stream cadence')).join('\n'))
  fs.writeFileSync(path.join(out, 'summary.json'),JSON.stringify({engineSource:rig.run.engineSource,enginePid:rig.run.enginePid,engineLog,results},null,2))
  return results
}
