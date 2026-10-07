// tools/rig/proof.mjs: a tiny pass/fail recorder for rig scripts. Checks
// and notes go to <rig home>\evidence\<name>-<time>\result.json together
// with whatever files the script saves there (fake CLI logs, engine log
// excerpts, screenshots), so the evidence outlives the run.

import fs from 'node:fs'
import path from 'node:path'

import { rigHome } from './lib.mjs'

export class Proof {
  constructor(name) {
    this.name = name
    this.started = new Date().toISOString()
    this.dir = path.join(rigHome(), 'evidence', `${name}-${this.started.replace(/[-:]/g, '').replace(/\..*/, '')}`)
    fs.mkdirSync(this.dir, { recursive: true })
    this.checks = []
    this.notes = []
  }

  check(what, ok, detail) {
    this.checks.push({ what, ok: !!ok, detail })
    console.error(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`)
    this.save()
    return !!ok
  }

  note(text, detail) {
    this.notes.push({ at: new Date().toISOString(), text, detail })
    console.error(`note  ${text}`)
    this.save()
  }

  file(name, content) {
    const p = path.join(this.dir, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2))
    return p
  }

  /** The run's fake CLI logs and the engine log lines matching `grep`. */
  keep(rig, { agents = [], grep } = {}) {
    for (const a of agents) this.file(`fakecli-${a}.jsonl`, rig.fakeLog(a).map(l => JSON.stringify(l)).join('\n'))
    if (grep) this.file('engine-excerpt.log', rig.engineLog().split(/\r?\n/).filter(l => grep.test(l)).join('\n'))
  }

  get passed() { return this.checks.length > 0 && this.checks.every(c => c.ok) }

  save() {
    fs.writeFileSync(path.join(this.dir, 'result.json'), JSON.stringify({
      proof: this.name, started: this.started, passed: this.passed, checks: this.checks, notes: this.notes,
    }, null, 2))
  }

  summary() {
    this.save()
    return { proof: this.name, passed: this.passed, failed: this.checks.filter(c => !c.ok).map(c => c.what), evidence: this.dir }
  }
}
