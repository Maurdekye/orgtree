// tools/test-baseline-reporter.mjs — a per-test recorder for suites whose
// runner only reports an exit code.
//
// WHY. The renderer suite is run by apps/desktop/renderer/tests/run.mjs, which
// spawns node's test runner with `stdio: 'inherit'` and the human-readable spec
// reporter, in several batches, inside a Job Object that bounds memory and time
// (see the D-177 note in that file — an unbounded hung test once took the whole
// machine down). None of that should change just to get machine-readable
// results out, and re-implementing the containment to get them would trade a
// reporting problem for a much worse one.
//
// So this rides along instead. Node accepts `--test-reporter` through
// NODE_OPTIONS, which reaches every node process in the tree without the runner
// knowing anything about it. Each test process appends NDJSON to its own file
// under ORGTREE_BASELINE_NDJSON_DIR — its own, because the batches are separate
// processes and a shared destination would truncate.
//
// Set two environment variables and run the suite normally:
//
//   ORGTREE_BASELINE_NDJSON_DIR=<dir>
//   NODE_OPTIONS=--test-reporter=file:///.../test-baseline-reporter.mjs --test-reporter-destination=stdout
//
// This reporter yields no output of its own, so whatever the runner prints is
// unchanged apart from the spec reporter being replaced.

import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env.ORGTREE_BASELINE_NDJSON_DIR

export default async function* baselineReporter(source) {
  if (!DIR) {
    // No directory means nobody asked for a recording. Stay silent rather than
    // failing the run: this reporter is injected process-tree-wide and lands in
    // node processes that are not running tests at all.
    for await (const _event of source) { /* discard */ }
    return
  }
  fs.mkdirSync(DIR, { recursive: true })
  const target = path.join(DIR, `${process.pid}.ndjson`)
  // The ancestors of the currently running test, by nesting depth. Node reports
  // a test's own name and its depth but not its parents, so the full path has
  // to be rebuilt from the enclosing names seen so far.
  const stack = []
  const lines = []

  for await (const event of source) {
    const data = event.data
    if (event.type === 'test:start') {
      stack[data.nesting ?? 0] = data.name
      continue
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const nesting = data.nesting ?? 0
    lines.push(JSON.stringify({
      file: data.file ?? null,
      name: [...stack.slice(0, nesting), data.name].join(' > '),
      nesting,
      passed: event.type === 'test:pass',
      skip: !!data.skip,
      todo: !!data.todo,
      failure_type: data.details?.error?.failureType ?? null,
      error: data.details?.error?.message ?? null,
      duration_ms: data.details?.duration_ms ?? null,
    }))
    // Flush in blocks. A test process killed by the Job Object's memory or time
    // limit still leaves everything it had already recorded on disk, which is
    // exactly the run you most want a record of.
    if (lines.length >= 50) {
      fs.appendFileSync(target, lines.join('\n') + '\n')
      lines.length = 0
    }
  }
  if (lines.length) fs.appendFileSync(target, lines.join('\n') + '\n')
}
