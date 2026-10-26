// tests/fixtures/run-bounds/baseline-run.mjs - run-bounds.test.mjs §3's stand-in
// for tools/test-baseline.mjs's in-process root run. It calls node:test's run()
// with the options that tool passes, on probe.test.mjs, and prints the probe's
// report. Not a test file: run-bounds launches it as its own process, because
// run() inside a test file skips every file.
//
//   node baseline-run.mjs bounded   the tool's bounds: testProcessBounds()'s
//                                   execArgv, after its free-memory floor
//   node baseline-run.mjs bare      no execArgv (the control: what a child
//                                   reports when nothing bounds it)
import { run } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertFreeMemory, testProcessBounds } from '../../../tools/test-process-bounds.mjs'

const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.test.mjs')
const bounded = process.argv[2] === 'bounded'
let execArgv = []
if (bounded) {
  const bounds = testProcessBounds()
  assertFreeMemory(bounds.minFreeMb, 'probe run')
  execArgv = bounds.execArgv
}
const stream = run({ files: [probe], concurrency: 4, timeout: 120_000, forceExit: false, execArgv,
  testNamePatterns: ['reports its bounds'] })
stream.on('test:stdout', (data) => process.stdout.write(data.message))
stream.on('test:fail', (data) => console.log(`[fail] ${data.name}`))
stream.on('data', () => {})
await new Promise((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject) })
