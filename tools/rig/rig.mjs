#!/usr/bin/env node
// tools/rig/rig.mjs: the safe test rig (docs/rust-engine/test-rig.md).
//
//   node tools/rig/rig.mjs build              debug engine + fake CLI into $CARGO_TARGET_DIR
//   node tools/rig/rig.mjs up [--fixture basic|<file>|none] [--name n] [--ttl min] [--max min]
//                                             [--ui dir] [--engine exe] [--legacy dir] [--initdb]
//   node tools/rig/rig.mjs status|down [--run id] [--keep]
//   node tools/rig/rig.mjs cleanup [--mine|--everyone] [--dry-run]
//   node tools/rig/rig.mjs tool <agent> <orgtree_tool> [json args]
//   node tools/rig/rig.mjs mail <user|agent> <to> <text> [--notice]
//   node tools/rig/rig.mjs api <METHOD> <path> [json body]
//   node tools/rig/rig.mjs sql "<select ...>"
//   node tools/rig/rig.mjs scenario <file.json>
//   node tools/rig/rig.mjs fakelog <agent> [--kind k]
//   node tools/rig/rig.mjs log [--grep regex] [--tail n]
//   node tools/rig/rig.mjs run <script.mjs> [--fixture f] [--keep]   up, run the script's default export, down
//   node tools/rig/rig.mjs desktop <script.cjs> [json args] [--preset short|tall|wide|WxH] [--out dir]
//
// Every command but build/up/cleanup acts on the newest live run unless --run names one.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadFixture, seed } from './fixture.mjs'
import { REPO, Rig, cargoTarget, cleanup, freeRamGB, listRuns, readRun, startRun, stopRun } from './lib.mjs'

function parse(argv) {
  const pos = [], flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2)
      if (inline !== undefined) flags[k] = inline
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else pos.push(a)
  }
  return { pos, flags }
}

const print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const json = s => (s === undefined ? undefined : JSON.parse(s))

async function up(flags) {
  // a later run tidies what earlier ones left (stopped or orphaned runs; never a live one)
  await cleanup().catch(e => console.error('cleanup before up failed:', e.message))
  const rig = await startRun({ name: flags.name, ttlMin: flags.ttl && Number(flags.ttl), maxMin: flags.max && Number(flags.max),
    ui: flags.ui, engine: flags.engine, legacy: flags.legacy && path.resolve(flags.legacy), initdb: !!flags.initdb, prepare: flags.prepare,
    recover: !!flags.recover })
  let made = null
  if (flags.fixture !== 'none') {
    try { made = await seed(rig, loadFixture(flags.fixture === true ? undefined : flags.fixture)) } catch (e) {
      console.error('fixture failed:', e.message)
      if (!flags.keep) await rig.down()
      throw e
    }
  }
  rig.refresh()
  return { run: rig.run.id, dir: rig.dir, url: rig.url, token: rig.token, org: rig.org, pgBin: rig.run.pgBin, ui: rig.run.ui,
    readyMs: rig.run.readyMs, seeded: made, fakecli: rig.fakeDir, ttlMin: rig.run.ttlMin }
}

function build() {
  const target = cargoTarget()
  const free = freeRamGB()
  if (free < 6) throw new Error(`only ${free.toFixed(1)} GB RAM free; team rule: start a cargo build only with at least 6 GB free`)
  const env = { ...process.env, CARGO_TARGET_DIR: target }
  for (const [what, cwd, args] of [
    ['engine', path.join(REPO, 'engine', 'rs'), ['build', '-j', '2', '-p', 'orgtree-engine']],
    ['fake CLI', path.join(REPO, 'tools', 'rig', 'fakecli'), ['build', '-j', '2']],
  ]) {
    console.error(`building the ${what} into ${target} ...`)
    const r = spawnSync('cargo', args, { cwd, env, stdio: 'inherit', windowsHide: true })
    if (r.status !== 0) throw new Error(`cargo build of the ${what} failed`)
  }
  return { engine: path.join(target, 'debug', 'orgtree-engine.exe'), fakecli: path.join(target, 'debug', 'orgtree-fakecli.exe') }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parse(rest)
  const rig = () => Rig.attach(flags.run)
  switch (cmd) {
    case 'build': return print(build())
    case 'up': return print(await up(flags))
    case 'status': {
      if (flags.run) return print(readRun(rig().dir))
      return print(listRuns().map(({ dir, run }) => ({ id: path.basename(dir), status: run?.status, by: run?.by, url: run?.url, org: run?.org, created: run?.created })))
    }
    case 'down': return print(await stopRun(rig().dir, { keep: !!flags.keep }))
    case 'cleanup': return print(await cleanup({ mine: !!flags.mine, everyone: !!flags.everyone, dryRun: !!flags['dry-run'] }))
    case 'tool': return print(await rig().tool(pos[0], pos[1], json(pos[2]) ?? {}))
    case 'mail': {
      const r = rig()
      const [from, to, ...words] = pos
      const text = words.join(' ')
      if (from === 'user') return print(await r.userMail(to, text, { notice: !!flags.notice }))
      return print(await r.tool(from, 'orgtree_message', { to, body: text, notice: !!flags.notice }))
    }
    case 'api': {
      // Git Bash rewrites a leading /api/... into C:/Program Files/Git/api/...: undo that
      const route = '/' + pos[1].replace(/^[A-Za-z]:\/.*?\/(api\/)/, '$1').replace(/^\/+/, '')
      return print(await rig().api(pos[0].toUpperCase(), route, json(pos[2])))
    }
    case 'sql': return print(rig().sql(pos[0]))
    case 'scenario': { const r = rig(); r.scenario(JSON.parse(fs.readFileSync(pos[0], 'utf8'))); return print({ scenario: path.join(r.fakeDir, 'scenario.json') }) }
    case 'fakelog': return print(rig().fakeLog(pos[0]).filter(l => !flags.kind || l.kind === flags.kind))
    case 'log': {
      let lines = rig().engineLog().split(/\r?\n/)
      if (flags.grep) { const re = new RegExp(flags.grep, 'i'); lines = lines.filter(l => re.test(l)) }
      return print(lines.slice(-(Number(flags.tail) || 200)).join('\n'))
    }
    case 'run': {
      const script = path.resolve(pos[0])
      const mod = await import(pathToFileURL(script).href)
      // a script may shape its own run: `export async function setup(flags)`
      // returns up options (e.g. { legacy: <dir>, fixture: 'none' })
      const info = await up({ ...flags, ...(mod.setup ? await mod.setup(flags) : {}) })
      const r = Rig.attach(info.run)
      let failed = false
      const stop = async () => {
        // a failed script keeps its run's files (its processes still stop) for inspection
        const keep = !!flags.keep || failed
        const res = await r.down({ keep })
        if (keep) console.error(`run kept for inspection: ${res.dir} (rig cleanup removes it)`)
      }
      process.once('SIGINT', () => { console.error('interrupted: stopping the run'); stop().finally(() => process.exit(130)) })
      try {
        const out = await mod.default(r, { flags, args: pos.slice(1) })
        print(out ?? { ok: true })
        if (out && out.passed === false) { failed = true; process.exitCode = 1 }
      } catch (e) { failed = true; throw e } finally { await stop() }
      return
    }
    case 'desktop': {
      const { runDesktop } = await import('./desktop.mjs')
      return print(await runDesktop(rig(), pos[0], { preset: flags.preset, out: flags.out, timeout: flags.timeout && Number(flags.timeout), args: json(pos[1]) }))
    }
    default:
      console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 20).join('\n'))
      process.exitCode = 2
  }
}

main().catch(e => { console.error('rig:', e.message); process.exitCode = 1 })
