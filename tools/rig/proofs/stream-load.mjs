import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { RIG_DIR } from '../lib.mjs'
import { runDesktop } from '../desktop.mjs'

function cpu(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).CPU`], {encoding:'utf8',windowsHide:true})
  if (r.status !== 0 || !r.stdout.trim()) throw Error('no engine CPU measurement')
  return Number(r.stdout.trim())
}
export default async function(rig, { out, count = 10 } = {}) {
  if (rig.run.streamProbe) throw Error('CPU comparison must disable per-token probe logs')
  fs.mkdirSync(out, {recursive:true})
  const agents = Array.from({length:count},(_,i)=>'load'+i)
  const prose = 'CADENCE_STREAM smooth real token text. '.repeat(250) + 'CADENCE_END'
  rig.scenario({default:{turns:[{match:'CADENCE-PROOF',steps:[{text:prose,chunk:24,delay_ms:12},{sleep_ms:500}]},
    {steps:[{text:'Ready.'}]}]}})
  for (const name of agents) await rig.op({op:'hire',name,tier:'sonnet',grant:2,charter:'Synthetic concurrent streaming cost fixture.'})
  const before = cpu(rig.run.enginePid), start = Date.now()
  const desktop = await runDesktop(rig,path.join(RIG_DIR,'desktop/stream-cadence.cjs'),{
    args:{agent:agents[0],agents},preset:'1000x700',out:path.join(out,'desktop'),timeout:90000,
  })
  if (!desktop.ok) throw Error(desktop.error)
  await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'all concurrent stream turns settle',timeout:30000})
  const result = {count,elapsedMs:Date.now()-start,engineCpuSec:cpu(rig.run.enginePid)-before,desktop,
    allCompleted:agents.every(name=>rig.turns(name).some(t=>t.ended_at&&!t.error)),
    unobservedFrames:desktop.value.wire.filter(f=>f.node!==agents[0]).length,
    durableRows:rig.sql("SELECT count(*) AS n FROM ot.convo WHERE body->>'text' LIKE '%CADENCE_END%'")[0]?.n,
  }
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2))
  if (!result.allCompleted || result.unobservedFrames || Number(result.durableRows)!==count) throw Error('concurrent fixture denominator/room isolation failed')
  console.log(JSON.stringify({count,engineCpuSec:result.engineCpuSec,elapsedMs:result.elapsedMs,unobservedFrames:result.unobservedFrames,durableRows:result.durableRows}))
  return result
}
