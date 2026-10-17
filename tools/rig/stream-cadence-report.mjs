import fs from 'node:fs'
import path from 'node:path'
const dir = process.argv[2]
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'))
const log = fs.readFileSync(path.join(dir, 'engine-cadence.log'), 'utf8')
const observations = log.split(/\r?\n/).filter(Boolean).map(line => {
  const read = key => line.match(new RegExp(`(?:^| )${key}=(?:"([^"]*)"|([^ ]+))`))?.slice(1).find(x => x !== undefined)
  return { stage:read('stage'), agent:read('agent'), kind:read('kind'), at:Number(read('at_us'))/1000, size:Number(read('bytes')) }
})
const distribution = values => {
  const a = values.toSorted((x,y)=>x-y)
  return {count:a.length,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null}
}
const report = []
for (const lane of summary.results) {
  const desktop = JSON.parse(fs.readFileSync(path.join(dir, lane.agent + '.json'), 'utf8')).value
  if (!desktop) throw Error(lane.agent + ': missing renderer result')
  for (const kind of ['thinking', 'delta']) {
    const wire = desktop.wire.filter(x => x.node === lane.agent && x.kind === kind)
    if (!wire.length) { report.push({agent:lane.agent,kind,absent:true}); continue }
    const stages = Object.fromEntries(['stdout','actor','room','socket'].map(stage => [stage,
      observations.filter(o => o.stage===stage && o.kind===kind && o.at>=desktop.started && o.at<=desktop.ended
        && (stage==='stdout' || o.agent===lane.agent))]))
    const counts = Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,v.length]))
    if (Object.values(counts).some(n=>n!==wire.length)) throw Error(`${lane.agent}/${kind} stage denominator mismatch ${JSON.stringify({counts,wire:wire.length})}`)
    for (const rows of Object.values(stages)) if (rows.some((r,i)=>r.size!==wire[i].size)) throw Error(`${lane.agent}/${kind}: byte sizes changed`)
    const field = kind==='delta' ? 'draft' : 'thinking'
    let length = 0
    const paintLags = []
    for (const token of wire) {
      length += token.size
      const painted = desktop.paint.find(p=>p.at>=token.at && p[field]>=length)
      if (painted) paintLags.push(painted.at-token.at)
    }
    report.push({agent:lane.agent,kind,counts,wire:wire.length,wireGap:distribution(wire.slice(1).map((r,i)=>r.at-wire[i].at)),
      stdoutToActor:distribution(stages.actor.map((r,i)=>r.at-stages.stdout[i].at)),
      actorToSocket:distribution(stages.socket.map((r,i)=>r.at-stages.actor[i].at)),
      socketToReceipt:distribution(wire.map((r,i)=>r.at-stages.socket[i].at)),receiptToPaint:distribution(paintLags),
      unpaintedTokens:wire.length-paintLags.length})
  }
}
fs.writeFileSync(path.join(dir,'cadence-report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
