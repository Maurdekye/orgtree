// update-rehearsal-main.test.mjs — THE REAL main(), WITH INERT EFFECTS.
//
// Twice, pure guard tests and source-shape assertions both passed while the
// executable composition admitted the very cases they were supposed to stop.
// The bugs were never in the rules; they were in the ORDER things happened —
// what got written before what was checked, what got stopped when nothing had
// been started, which file was believed. Review's verdict was blunt and right:
// the acceptance assertions have to inspect launches, writes, cleanup and
// result evidence from the real entry point.
//
// So every test here calls tools/run-rehearsal.mjs's actual main().
//
// ⚠ NOTHING HERE CAN START A PROCESS OR TOUCH A REAL DIRECTORY. The filesystem
// is an in-memory map, spawn returns a stub, PowerShell is a table of canned
// answers, and the feed server is a promise that resolves to a URL. If any of
// those were real, the test would be the thing it is testing. The only real
// filesystem work is in the few tests that say so, and those use disposable
// temp directories.
//
// Run: node --test tests/update-rehearsal-main.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { main, expectedReceiptFrom, FIXTURE_VERSION } from '../tools/run-rehearsal.mjs'
import { assertRehearsalPaths } from '../tools/run-rehearsal.mjs'
import {
  assertDestinationSafe, compareSnapshots, installedManifest, isolationChecks, overlaps,
  productionDataRoot, protectedRoots, realPath, releaseRehearsal, REHEARSAL_UPDATER_CACHE,
  reserveRehearsal,
} from '../tools/rehearsal-isolation.mjs'

const ENV = {
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
}
const INSTALLED = 'C:\\Program Files\\Orgtree'
const REPO = 'E:\\checkout'
const OUT_DIR = path.join(REPO, 'release-rehearsal')
const UNPACKED = path.join(OUT_DIR, 'win-unpacked')
const REHEARSAL_EXE = path.join(UNPACKED, 'Orgtree Dev.exe')
const FIXTURE_EXE = path.join(REPO, 'dist', 'update-fixture', 'orgtree-update-fixture.exe')
const WORK = path.join(REPO, 'dist', 'rehearsal')
const DATA = path.join(ENV.APPDATA, 'Orgtree v2 Dev')
const CACHE = path.join(ENV.LOCALAPPDATA, REHEARSAL_UPDATER_CACHE)
const UPDATE_LOG = path.join(DATA, 'update-log.json')
const MARKER = 'ORGTREE-UPDATE-FIXTURE-BUILD' + ':enabled'
const TOKEN = 'a1b2c3d4-0000-4000-8000-abcdefabcdef'
const RECEIPT = path.join(DATA, `update-fixture-${TOKEN}.txt`)
const LAUNCH_AT = Date.parse('2026-09-15T12:00:00Z')

const refuses = (fn, pattern) => assert.throws(fn, pattern)

/** An in-memory filesystem with just enough of node:fs for main(). Directories
 *  are implicit; every write and removal is recorded so a test can assert on
 *  what was actually touched rather than on what the code looks like. */
function inertFs(seed = {}) {
  const key = p => path.resolve(String(p)).toLowerCase()
  const files = new Map(Object.entries(seed).map(([k, v]) => [key(k), v]))
  const dirs = new Set()
  for (const f of files.keys()) {
    for (let d = path.dirname(f); d && d !== path.dirname(d); d = path.dirname(d)) dirs.add(d)
  }
  const mtimes = new Map()
  const writes = []
  const removals = []
  return {
    writes, removals, files, mtimes, dirs,
    existsSync: p => files.has(key(p)) || dirs.has(key(p)),
    readFileSync: (p, enc) => {
      if (!files.has(key(p))) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e }
      const value = String(files.get(key(p)))
      return enc ? value : Buffer.from(value, 'latin1')
    },
    writeFileSync: (p, data, options) => {
      if (options?.flag === 'wx' && files.has(key(p))) {
        const e = new Error(`EEXIST: ${p}`); e.code = 'EEXIST'; throw e
      }
      writes.push(path.resolve(String(p)))
      files.set(key(p), String(data))
      for (let d = key(path.dirname(p)); d && d !== path.dirname(d); d = path.dirname(d)) dirs.add(d)
    },
    mkdirSync: (p) => {
      for (let d = key(p); d && d !== path.dirname(d); d = path.dirname(d)) dirs.add(d)
    },
    readdirSync: (p, options) => {
      const prefix = key(p) + path.sep
      const names = new Set()
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(path.sep)[0])
      }
      if (!options?.withFileTypes) return [...names]
      return [...names].map(name => ({
        name,
        isDirectory: () => !files.has(key(path.join(p, name))),
      }))
    },
    statSync: (p) => {
      if (!files.has(key(p))) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e }
      return {
        size: String(files.get(key(p))).length,
        mtimeMs: mtimes.get(key(p)) ?? LAUNCH_AT + 1000,
        isFile: () => true,
      }
    },
    rmSync: (p) => {
      removals.push(path.resolve(String(p)))
      const prefix = key(p) + path.sep
      for (const f of [...files.keys()]) if (f === key(p) || f.startsWith(prefix)) files.delete(f)
      for (const d of [...dirs]) if (d === key(p) || d.startsWith(prefix)) dirs.delete(d)
    },
    realpathSync: { native: p => path.resolve(String(p)) },
  }
}

const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex')

/** The layout main() requires before it will consider running at all. */
function seedRepo(extra = {}) {
  const fixtureBytes = 'pretend fixture bytes'
  const nsi = '; fixture script\n'
  return {
    [REHEARSAL_EXE]: 'MZ rehearsal',
    [path.join(UNPACKED, 'resources', 'build-info.json')]: JSON.stringify({
      channel: 'dev', updateFixture: true, version: '2.1.5-dev.gtest', commit: 'abc1234',
    }),
    [path.join(UNPACKED, 'resources', 'app.asar')]: `bundle ${MARKER} end`,
    [path.join(UNPACKED, 'resources', 'app-update.yml')]:
      `provider: generic\nurl: http://127.0.0.1:1/\nupdaterCacheDirName: ${REHEARSAL_UPDATER_CACHE}\n`,
    [FIXTURE_EXE]: fixtureBytes,
    [path.join(REPO, 'dist', 'update-fixture', 'orgtree-update-fixture.provenance.json')]:
      JSON.stringify({ sha256: sha(fixtureBytes), source: 'build/update-fixture.nsi',
        sourceSha256: crypto.createHash('sha256').update(nsi).digest('hex') }),
    [path.join(REPO, 'build', 'update-fixture.nsi')]: nsi,
    [path.join(INSTALLED, 'Orgtree.exe')]: 'MZ installed',
    [path.join(INSTALLED, 'resources', 'build-info.json')]:
      JSON.stringify({ channel: 'release', version: '2.1.5-RC3', commit: 'deadbee' }),
    [path.join(INSTALLED, 'resources', 'app.asar')]: 'installed bundle',
    ...extra,
  }
}

function receiptBody({
  token = TOKEN, instdir = UNPACKED, fixture = FIXTURE_EXE, complete = token,
} = {}) {
  return [
    '[fixture] orgtree update fixture ran; nothing was installed',
    `[fixture-cmdline] ${fixture} --updated /S --force-run /D=${instdir}`,
    `[fixture-instdir] ${instdir}`,
    `[fixture-token] ${token}`,
    '[fixture-silent] yes',
    ...(complete ? [`[fixture-complete] ${complete}`] : []),
  ].join('\r\n')
}

function handoffLog({ at = '2026-09-15T12:00:30Z', receipt = RECEIPT } = {}) {
  return JSON.stringify([
    { stage: 'startup', at: '2026-09-15T12:00:05Z', detail: 'started in the background' },
    { stage: 'attempt', at: '2026-09-15T12:00:25Z', detail: 'automatic idle application' },
    { stage: 'update-fixture-handoff', at,
      detail: `handing off to the update fixture at [${FIXTURE_EXE}] instead of the downloaded `
        + `installer; its receipt for this attempt is [${receipt}]; this is a rehearsal and `
        + 'did not install anything' },
  ])
}

const RELEASE_ENTRY = [{
  PSChildName: '{a}', DisplayName: 'Orgtree 2.1.5-RC3', DisplayVersion: '2.1.5-RC3',
  InstallLocation: INSTALLED,
}]

/** Build a complete effects object. Anything not overridden is inert. */
function effectsFor({
  fileSystem, processes = [], elevated = 'False', uninstall = RELEASE_ENTRY,
  isAlive = () => false, onTick = null, spawnFails = null, launches = [], stopped = [],
  clock = { value: LAUNCH_AT }, child,
} = {}) {
  let ticks = 0
  const theChild = child ?? {
    pid: 4242, handlers: {}, unref() {},
    on(event, handler) { this.handlers[event] = handler; return this },
  }
  return {
    fileSystem,
    env: { ...ENV },
    repoRoot: REPO,
    out: () => {}, err: () => {},
    now: () => clock.value,
    sleep: async () => {
      clock.value += 3000
      ticks += 1
      if (spawnFails && ticks === 1) theChild.handlers.error?.(spawnFails)
      onTick?.({ tick: ticks, fileSystem, clock: clock.value })
    },
    isAlive,
    spawnProcess: (file, args, options) => {
      launches.push({ file, args, options })
      return theChild
    },
    stopProcess: (id) => { stopped.push(id) },
    runPowerShell: (script) => {
      if (script.includes('IsInRole')) return elevated
      if (script.includes('Uninstall')) return JSON.stringify(uninstall)
      if (script.includes('Get-Process')) return JSON.stringify(processes)
      return ''
    },
    writeFeed: ({ directory, artifact }) => {
      fileSystem.mkdirSync(directory, { recursive: true })
      fileSystem.writeFileSync(path.join(directory, 'latest.yml'), 'version: 9.9.9-fixture\n')
      return { directory, file: path.basename(artifact), size: 42, version: FIXTURE_VERSION }
    },
    serveFeed: async () => ({
      url: 'http://127.0.0.1:50000/', port: 50000, close: async () => {},
    }),
  }
}

async function runMain(argv, options = {}) {
  const fileSystem = options.fileSystem ?? inertFs(options.seed ?? seedRepo())
  for (const [file, value] of Object.entries(options.mtimes ?? {})) {
    fileSystem.mtimes.set(path.resolve(file).toLowerCase(), value)
  }
  const launches = []
  const stopped = []
  const code = await main(argv, effectsFor({ ...options, fileSystem, launches, stopped }))
  const raw = fileSystem.files.get(path.join(WORK, 'evidence.json').toLowerCase())
  return {
    code, launches, stopped, fileSystem,
    writes: fileSystem.writes, removals: fileSystem.removals,
    evidence: raw ? JSON.parse(raw) : null,
  }
}

const why = (result) => JSON.stringify(result.evidence?.steps ?? 'no evidence', null, 1)

/** Removals other than this run's own reservation file, which it creates and
 *  releases as a matter of course. Everything else deleted is a real effect. */
const RESERVATION = path.join(OUT_DIR, '.rehearsal-run.json').toLowerCase()
const residue = (result) =>
  result.removals.filter(r => r.toLowerCase() !== RESERVATION)
const releasedReservation = (result) =>
  result.removals.some(r => r.toLowerCase() === RESERVATION)

// ---------------------------------------------------------------- the happy path

test('§1 ⚠ REAL main(): a correctly correlated run succeeds, and reports what it did', async () => {
  const result = await runMain(['--budget', '60'], {
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody())
    },
  })
  assert.equal(result.code, 0, why(result))
  assert.equal(result.evidence.applied, true)
  assert.equal(result.launches.length, 1, 'exactly one launch')
  assert.equal(result.launches[0].file, REHEARSAL_EXE)
  assert.deepEqual(result.launches[0].args, ['--background'])
  assert.equal(result.launches[0].options.env.ORGTREE_UPDATE_FEED, 'http://127.0.0.1:50000/')
  assert.equal(result.launches[0].options.env.ORGTREE_UPDATE_FIXTURE, FIXTURE_EXE)
  assert.equal(result.evidence.capture.receipt.name, path.basename(RECEIPT))
  assert.ok(result.evidence.comparison.every(r => r.ok),
    JSON.stringify(result.evidence.comparison, null, 1))
})

// ------------------------------------------------- R2: the receipt must be THIS attempt's

test('§2 ⚠ AN UNPUBLISHED .txt.partial IS NOT COMPLETION', async () => {
  // The exact case review drove through the old runner to exit 0. The fixture
  // writes its complete line into the partial BEFORE the error check and the
  // rename, so a full-looking partial can exist for a run that then failed and
  // deleted it. Announcing success for a receipt the fixture never published is
  // precisely what the atomic-publication boundary exists to prevent.
  const result = await runMain(['--budget', '30'], {
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(`${RECEIPT}.partial`, receiptBody())
    },
  })
  assert.equal(result.code, 3, 'a partial must never be read as completion')
  assert.equal(result.evidence.applied, false)
  assert.equal(result.evidence.handedOff, true, 'the handoff itself was seen')
})

test('§3 ⚠ AN UNRELATED RECENT RECEIPT IS NOT THIS ATTEMPT', async () => {
  const other = path.join(DATA, 'update-fixture-unrelated-token.txt')
  const result = await runMain(['--budget', '30'], {
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(other, receiptBody({ token: 'unrelated-token' }))
    },
  })
  assert.equal(result.code, 3)
  assert.equal(result.evidence.applied, false)
  assert.equal(result.evidence.expectedReceipt.toLowerCase(), RECEIPT.toLowerCase(),
    'the run knew, in advance, which file would have proved it')
})

test('§4 ⚠ A RECEIPT FROM BEFORE THE LAUNCH IS REFUSED', async () => {
  // --adopt, because seeding an old receipt means the dev data root already
  // exists — and that is a DIFFERENT refusal (§12). This test is about the
  // freshness rule, so the ownership one is taken out of the way deliberately.
  const result = await runMain(['--budget', '30', '--adopt'], {
    seed: seedRepo({ [RECEIPT]: receiptBody() }),
    mtimes: { [RECEIPT]: LAUNCH_AT - 60000 },
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
    },
  })
  assert.equal(result.code, 3)
  assert.match(result.evidence.receiptRejected, /predates this run/)
})

test('§5 ⚠ A RECEIPT NAMING ANOTHER RUN\'S DIRECTORIES IS REFUSED', async () => {
  const result = await runMain(['--budget', '30'], {
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) {
        fileSystem.writeFileSync(RECEIPT, receiptBody({ instdir: 'E:\\other\\win-unpacked' }))
      }
    },
  })
  assert.equal(result.code, 3)
  assert.match(result.evidence.receiptRejected, /not this run's/)
})

test('§6 a truncated receipt — the fixture died before its terminal record', async () => {
  const result = await runMain(['--budget', '30'], {
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody({ complete: null }))
    },
  })
  assert.equal(result.code, 3)
  assert.match(result.evidence.receiptRejected, /terminal \[fixture-complete\]/)
})

test('§7 the year-2000 handoff still cannot succeed, receipt or not', async () => {
  const result = await runMain(['--budget', '30'], {
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) {
        fileSystem.writeFileSync(UPDATE_LOG, handoffLog({ at: '2000-01-01T00:00:00Z' }))
        fileSystem.writeFileSync(RECEIPT, receiptBody())
      }
    },
  })
  assert.equal(result.code, 3)
  assert.equal(result.evidence.handedOff, false, 'a year-2000 entry is not this run\'s handoff')
})

test('§8 an async spawn failure fails the run even when a valid receipt exists', async () => {
  const result = await runMain(['--budget', '30'], {
    spawnFails: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) {
        fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
        fileSystem.writeFileSync(RECEIPT, receiptBody())
      }
    },
  })
  assert.equal(result.code, 3)
  assert.equal(result.evidence.applied, false)
  assert.match(result.evidence.spawnError, /ENOENT/)
})

// -------------------------------------------- R1: destinations, ownership, cleanup

test('§9 ⚠ A REFUSED OUTPUT WRITES, LAUNCHES, STOPS AND REMOVES NOTHING', async () => {
  // Measured by review: a plan refused for naming an installation still reached
  // Stop-Process with that same rejected directory.
  const result = await runMain(['--out', INSTALLED], {
    seed: seedRepo({
      [path.join(INSTALLED, 'win-unpacked', 'Orgtree Dev.exe')]: 'MZ',
      [path.join(INSTALLED, 'win-unpacked', 'resources', 'build-info.json')]:
        JSON.stringify({ channel: 'dev', updateFixture: true, version: 'x' }),
    }),
    processes: [{ Id: 777, ProcessName: 'Orgtree', Path: path.join(INSTALLED, 'Orgtree.exe') }],
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.launches, [], 'nothing launched')
  assert.deepEqual(result.stopped, [], 'NOTHING STOPPED — the measured hole')
  assert.deepEqual(residue(result), [], 'nothing removed')
  assert.deepEqual(result.writes, [], 'and nothing written at all')
})

test('§10 ⚠ --work under production data writes nothing before refusing', async () => {
  const result = await runMain(['--work', path.join(productionDataRoot(ENV), 'rehearsal')])
  assert.equal(result.code, 1)
  assert.deepEqual(result.writes, [],
    'the feed used to be written into whatever --work named, before the refusal')
  assert.deepEqual(result.launches, [])
})

test('§11 ⚠ --out AT THE PRODUCTION DATA DIRECTORY IS REFUSED', async () => {
  // The installation guard never covered production DATA, so packaged files
  // could be written into the user's own data without any privilege at all.
  const dataOut = productionDataRoot(ENV)
  const result = await runMain(['--out', dataOut], {
    seed: seedRepo({
      [path.join(dataOut, 'win-unpacked', 'Orgtree Dev.exe')]: 'MZ',
      [path.join(dataOut, 'win-unpacked', 'resources', 'build-info.json')]:
        JSON.stringify({ channel: 'dev', updateFixture: true, version: 'x' }),
    }),
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.writes, [])
  assert.deepEqual(result.launches, [])
})

test('§12 ⚠ PRE-EXISTING DEV DATA IS NOT RUN ON — it refuses', async () => {
  // Preserving it during cleanup was only half the problem: the rehearsal would
  // still have USED somebody else's dev storage.
  const result = await runMain(['--budget', '30'], {
    seed: seedRepo({ [path.join(DATA, 'preferences.json')]: '{}' }),
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.launches, [], 'it must not run on storage it does not own')
  assert.deepEqual(residue(result), [], 'and it must certainly not delete it')
  assert.match(why(result), /already exist and are not this run's/)
})

test('§13 --adopt runs on existing dev storage and deletes none of it', async () => {
  const result = await runMain(['--budget', '30', '--adopt'], {
    seed: seedRepo({
      [path.join(DATA, 'preferences.json')]: '{}',
      [path.join(CACHE, 'pending', 'old.exe')]: 'x',
    }),
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody())
    },
  })
  assert.equal(result.code, 0, why(result))
  assert.equal(result.launches.length, 1)
  assert.deepEqual(residue(result), [], 'adopted storage is never deleted')
  assert.ok(result.fileSystem.existsSync(path.join(DATA, 'preferences.json')),
    'somebody else\'s dev preferences must survive')
})

test('§14 ⚠ A SECOND CONCURRENT REHEARSAL IS REFUSED BY THE RESERVATION', async () => {
  // A snapshot of running processes cannot see a run that is about to start.
  // Two runs sharing an output directory would each stop the other's app and
  // each believe it was tidying up after itself.
  const held = path.join(OUT_DIR, '.rehearsal-run.json')
  const live = await runMain(['--budget', '30'], {
    seed: seedRepo({ [held]: JSON.stringify({ pid: 999, at: '2026-09-15T11:59:00Z' }) }),
    isAlive: () => true,
  })
  assert.equal(live.code, 1, 'a live reservation holder must refuse the second run')
  assert.deepEqual(live.launches, [], 'and nothing may be launched')
  assert.deepEqual(live.stopped, [])

  // A claim whose owner is gone is stale, and this run takes it over.
  const stale = await runMain(['--budget', '30'], {
    seed: seedRepo({ [held]: JSON.stringify({ pid: 999, at: '2026-09-15T11:59:00Z' }) }),
    isAlive: () => false,
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody())
    },
  })
  assert.equal(stale.code, 0, why(stale))
})

test('§15 ⚠ A DRY RUN LAUNCHES, STOPS AND REMOVES NOTHING', async () => {
  const quiet = await runMain(['--dry-run'])
  assert.equal(quiet.code, 0, why(quiet))
  assert.deepEqual(quiet.launches, [])
  assert.deepEqual(quiet.stopped, [], 'a dry run must never stop a process')
  assert.deepEqual(residue(quiet), [], 'and never delete anything')
  assert.equal(releasedReservation(quiet), true,
    'it does release its own reservation, which is the one thing it created')

  // With a process already in the output directory it refuses outright, which
  // is stronger — and still touches nothing.
  const busy = await runMain(['--dry-run'], {
    processes: [{ Id: 555, ProcessName: 'Orgtree Dev', Path: REHEARSAL_EXE }],
  })
  assert.notEqual(busy.code, 0)
  assert.deepEqual(busy.launches, [])
  assert.deepEqual(busy.stopped, [])
  assert.deepEqual(residue(busy), [])
})

test('§16 ⚠ A FAILED COMPARISON TURNS A PASSING DRY RUN INTO EXIT 1', async () => {
  // The dry run used to return 0 before `finally` ran, so a failed comparison
  // was reported as success.
  const fileSystem = inertFs(seedRepo())
  let baselineTaken = false
  const watched = {
    ...fileSystem,
    writeFileSync: (p, data, options) => {
      fileSystem.writeFileSync(p, data, options)
      if (String(p).endsWith('baseline.json')) {
        baselineTaken = true
        fileSystem.writeFileSync(path.join(INSTALLED, 'Orgtree.exe'), 'MZ REPLACED')
      }
    },
  }
  const code = await main(['--dry-run'], effectsFor({ fileSystem: watched }))
  assert.equal(baselineTaken, true, 'the baseline must have been taken for this to mean anything')
  assert.equal(code, 1, 'a changed installation must fail the run, dry or not')
})

test('§17 cleanup after a real run removes only what this run created', async () => {
  const result = await runMain(['--budget', '30'], {
    onTick: ({ tick, fileSystem }) => {
      // The app creates its data root and its updater cache as it runs — both
      // absent at baseline, so both are this run's to remove.
      if (tick === 1) {
        fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
        fileSystem.writeFileSync(path.join(CACHE, 'pending', 'orgtree-update-fixture.exe'), 'x')
      }
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody())
    },
  })
  assert.equal(result.code, 0, why(result))
  const removed = result.removals.map(r => r.toLowerCase())
  assert.ok(removed.includes(DATA.toLowerCase()), 'its own data root goes')
  assert.ok(removed.includes(CACHE.toLowerCase()), 'and its own updater cache')
  for (const kept of [INSTALLED, productionDataRoot(ENV), OUT_DIR, REPO]) {
    assert.ok(!removed.some(r => r === kept.toLowerCase()),
      `${kept} must never be removed`)
  }
})

test('§18 a run that launched stops only processes inside its own output directory', async () => {
  const result = await runMain(['--budget', '30'], {
    processes: [
      { Id: 1, ProcessName: 'Orgtree', Path: path.join(INSTALLED, 'Orgtree.exe') },
      { Id: 2, ProcessName: 'Orgtree Dev', Path: REHEARSAL_EXE },
      // The engine: same directory, a name no '*Orgtree*' filter would match.
      { Id: 3, ProcessName: 'python', Path: path.join(UNPACKED, 'resources', 'engine', 'python.exe') },
    ],
    onTick: ({ tick, fileSystem }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody())
    },
  })
  // The pre-flight refuses because something was already running there, which
  // is correct — so drive the stop path with processes that appear only after
  // the launch instead.
  assert.notEqual(result.code, 0)
  assert.deepEqual(result.stopped, [], 'nothing is stopped when nothing was launched')

  let launched = false
  const fileSystem = inertFs(seedRepo())
  const stopped = []
  const launches = []
  const base = effectsFor({
    fileSystem, launches, stopped,
    onTick: ({ tick }) => {
      if (tick === 1) fileSystem.writeFileSync(UPDATE_LOG, handoffLog())
      if (tick === 2) fileSystem.writeFileSync(RECEIPT, receiptBody())
    },
  })
  const code = await main(['--budget', '30'], {
    ...base,
    spawnProcess: (...args) => { launched = true; return base.spawnProcess(...args) },
    runPowerShell: (script) => {
      if (script.includes('Get-Process')) {
        return JSON.stringify(launched ? [
          { Id: 1, ProcessName: 'Orgtree', Path: path.join(INSTALLED, 'Orgtree.exe') },
          { Id: 2, ProcessName: 'Orgtree Dev', Path: REHEARSAL_EXE },
          { Id: 3, ProcessName: 'python',
            Path: path.join(UNPACKED, 'resources', 'engine', 'python.exe') },
        ] : [])
      }
      return base.runPowerShell(script)
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(stopped.sort(), [2, 3],
    'the rehearsal app AND its engine, and nothing installed')
})

// ---------------------------------------------- R3: the comparison must be real

test('§19 ⚠ AN UNREADABLE INSTALLATION FAILS THE RUN — it does not pass empty', async () => {
  // Measured by review: a root that throws on enumeration produced an empty
  // manifest, and two empty manifests compare equal, so the comparison could
  // "pass" without examining the installation it claims to cover.
  const fileSystem = inertFs(seedRepo())
  const blind = {
    ...fileSystem,
    readdirSync: (p, options) => {
      if (path.resolve(String(p)).toLowerCase() === INSTALLED.toLowerCase()) {
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e
      }
      return fileSystem.readdirSync(p, options)
    },
  }
  const code = await main(['--dry-run'], effectsFor({ fileSystem: blind }))
  assert.equal(code, 1, 'an installation that cannot be enumerated is not a verified one')
})

test('§20 the manifest distinguishes unreadable from absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-unreadable-'))
  fs.mkdirSync(path.join(home, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Orgtree.exe'), 'exe')
  fs.writeFileSync(path.join(home, 'resources', 'app.asar'), 'bundle')

  const good = installedManifest(home)
  assert.equal(good.complete, true)
  assert.equal(good.present, true)
  assert.equal(good.problemCount, 0)

  // Absent IS complete — there is nothing there to fail to read.
  const absent = installedManifest(path.join(home, 'nope'))
  assert.equal(absent.present, false)
  assert.equal(absent.complete, true)

  const real = fs.readdirSync
  const broken = {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readdirSync: (p, o) => {
      if (String(p).endsWith('resources')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }
      return real(p, o)
    },
  }
  const partial = installedManifest(home, broken)
  assert.equal(partial.complete, false)
  assert.equal(partial.problemCount, 1)
  assert.match(partial.problems[0], /resources: EACCES/)

  // And the comparison refuses to pass on it, even against itself.
  const base = {
    installedBuildInfo: { sha256: 'a' }, installedExe: { sha256: 'b' },
    uninstall: [], productionDataExists: true,
  }
  const rows = compareSnapshots({ ...base, installedTree: partial },
    { ...base, installedTree: partial })
  const treeRow = rows.find(r => /no file under the installation/.test(r.name))
  assert.equal(treeRow.ok, false, 'two equally-unreadable manifests must not compare as verified')
  assert.match(treeRow.detail, /COULD NOT BE FULLY ENUMERATED/)
  fs.rmSync(home, { recursive: true, force: true })
})

test('§21 the tree row no longer promises content integrity it cannot check', () => {
  const base = {
    installedBuildInfo: { sha256: 'a' }, installedExe: { sha256: 'b' },
    installedTree: { complete: true, present: true, count: 3, sha256: 'd', problems: [] },
    uninstall: [], productionDataExists: true,
  }
  const row = compareSnapshots(base, base).find(r => /no file under the installation/.test(r.name))
  assert.match(row.name, /metadata only — not a content hash/,
    'path/size/mtime cannot see a same-size edit that preserves the timestamp')
  assert.ok(!/rewritten/.test(row.name), 'the word that overclaimed must be gone')
})

// ------------------------------------------------------ physical-path isolation

test('§22 ⚠ A DEV-DATA JUNCTION INTO PRODUCTION IS REFUSED — real reparse points', () => {
  // Disposable directories only. Nothing here goes near a real Orgtree.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-data-alias-'))
  const production = path.join(base, 'Orgtree v2')
  const dev = path.join(base, 'Orgtree v2 Dev')
  fs.mkdirSync(production, { recursive: true })
  const made = spawnSync('cmd', ['/c', 'mklink', '/J', dev, production],
    { encoding: 'utf8', windowsHide: true })
  if (made.status !== 0) {
    console.log(`SKIPPED §22: could not create a junction (${(made.stderr || made.stdout).trim()})`)
    fs.rmSync(base, { recursive: true, force: true })
    return
  }
  try {
    const env = { ...ENV, APPDATA: base }
    assert.equal(overlaps(dev, production), true,
      'realPath must see one physical directory behind two names')

    refuses(() => assertRehearsalPaths({
      outDir: OUT_DIR, exe: REHEARSAL_EXE, fixture: FIXTURE_EXE, workDir: WORK,
      env, installedRoot: INSTALLED,
    }), /same physical directory/)

    const rows = isolationChecks({
      env, installedRoot: INSTALLED, isLoopback: () => true,
      run: (s) => s.includes('IsInRole') ? 'False' : '[]',
    })
    const separate = rows.find(r => /PHYSICALLY separate/.test(r.name))
    assert.equal(separate.ok, false, 'the pre-flight compared spellings and passed this')
    assert.match(separate.detail, /same physical directory/)
  } finally {
    // Link-only removal: the junction goes, the target stays.
    spawnSync('cmd', ['/c', 'rmdir', dev], { encoding: 'utf8', windowsHide: true })
    assert.equal(fs.existsSync(production), true, 'the target must survive link-only removal')
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('§23 an existing path that will not resolve is refused, not accepted lexically', () => {
  const unresolvable = {
    existsSync: () => true,
    realpathSync: { native: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e } },
  }
  refuses(() => realPath('C:\\somewhere', unresolvable), /cannot resolve the real path/)
  // A path that does not exist yet is normal, and resolves to itself.
  const absent = { existsSync: () => false, realpathSync: { native: p => p } }
  assert.equal(realPath('E:\\not\\here\\yet', absent), path.resolve('E:\\not\\here\\yet'))
})

test('§24 one destination policy, covering production data in both directions', () => {
  const where = { env: ENV, installedRoot: INSTALLED }
  refuses(() => assertDestinationSafe('output', productionDataRoot(ENV), where), /protected location/)
  refuses(() => assertDestinationSafe('output', path.join(productionDataRoot(ENV), 'x'), where),
    /protected location/)
  refuses(() => assertDestinationSafe('output', 'C:\\', where), /protected location/)
  refuses(() => assertDestinationSafe('output', INSTALLED, where), /protected location/)
  refuses(() => assertDestinationSafe('output', '', where), /no output was named/)
  assert.equal(assertDestinationSafe('output', OUT_DIR, where), path.resolve(OUT_DIR))
  assert.ok(protectedRoots(ENV, INSTALLED).some(r =>
    r.toLowerCase() === path.resolve(productionDataRoot(ENV)).toLowerCase()),
  'the production data root must be in the protected list at all')
})

test('§25 the reservation is exclusive, and a stale one is taken over', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-reserve-'))
  const fresh = reserveRehearsal(home, { pid: 111, at: 'now', isAlive: () => false })
  assert.equal(fresh.taken, 'fresh')
  assert.ok(fs.existsSync(fresh.file))

  assert.throws(() => reserveRehearsal(home, { pid: 222, isAlive: () => true }),
    /another rehearsal is already using/)

  const taken = reserveRehearsal(home, { pid: 333, at: 'later', isAlive: () => false })
  assert.equal(taken.taken, 'stale')
  assert.equal(JSON.parse(fs.readFileSync(taken.file, 'utf8')).pid, 333)

  releaseRehearsal(taken.file)
  assert.equal(fs.existsSync(taken.file), false)
  fs.rmSync(home, { recursive: true, force: true })
})

test('§26 the app names this attempt\'s receipt in its handoff record', () => {
  // The binding every test above depends on only works because the app says
  // which file would prove the attempt. If that line goes, those tests would
  // still pass against a runner that can no longer bind anything — so pin it
  // at the source.
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  const at = index.indexOf("updateLog.record('update-fixture-handoff'")
  assert.ok(at > 0, 'the handoff record must exist')
  assert.match(index.slice(at, at + 600), /its receipt for this attempt is/,
    'the handoff must name this attempt\'s receipt path')
  assert.equal(
    expectedReceiptFrom('handing off … its receipt for this attempt is [C:\\d\\r.txt]; …'),
    'C:\\d\\r.txt')
  assert.equal(expectedReceiptFrom('an older handoff with no receipt named'), null)
})
