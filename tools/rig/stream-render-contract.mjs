import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// A durable mail carrier can expand into several Msg components, all with the
// same row_id. Count mounted components rather than summing unrelated segments.
export function maxSettledRenders(value) {
  const counts = new Map()
  for (const row of value.msgRenders) if (row.role === 'user') {
    assert.ok(Number.isSafeInteger(row.instance), 'missing mounted Msg identity')
    counts.set(row.instance, (counts.get(row.instance) || 0) + 1)
  }
  assert.ok(counts.size, 'no settled user component measured')
  return { components: counts.size, max: Math.max(...counts.values()) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const root = process.argv[2]
const results = []
for (const agent of ['claude','codex','agy','muse','opencode']) {
  const value = JSON.parse(fs.readFileSync(path.join(root,agent+'.json'),'utf8')).value
  const { components, max } = maxSettledRenders(value)
  results.push({agent,components,max,pass:max<=20})
}
console.log(JSON.stringify(results))
assert.ok(results.every(r=>r.pass),'settled user rows must not rerender per streamed token')
}
