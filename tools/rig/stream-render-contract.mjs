import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = process.argv[2]
const results = []
for (const agent of ['claude','codex','agy','muse','opencode']) {
  const value = JSON.parse(fs.readFileSync(path.join(root,agent+'.json'),'utf8')).value
  const counts = new Map()
  for (const row of value.msgRenders) if (row.role === 'user') counts.set(row.id,(counts.get(row.id)||0)+1)
  assert.ok(counts.size, `${agent}: no settled user row measured`)
  const max = Math.max(...counts.values())
  results.push({agent,max,pass:max<=20})
}
console.log(JSON.stringify(results))
assert.ok(results.every(r=>r.pass),'settled user rows must not rerender per streamed token')
