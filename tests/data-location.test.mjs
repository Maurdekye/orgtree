// Data location contract, preflight, copy/verify/rollback, NTFS ACL, preload,
// and Windows installer/boot-task PowerShell tests.
//
// Run: node tests/run.mjs tests/data-location.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const windows = process.platform === 'win32'
const tempBase = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orgtree-data-loc-'))
test.after(() => {
  fs.rmSync(tempBase, { recursive: true, force: true })
})

function loadEsbuild() {
  try {
    return createRequire(import.meta.url)('esbuild')
  } catch (err) {
    if (process.env.ORGTREE_TEST_DEPS) {
      return createRequire(path.resolve(process.env.ORGTREE_TEST_DEPS))('esbuild')
    }
    throw err
  }
}

let cachedModules = null
async function loadDataLocationModules() {
  if (cachedModules) return cachedModules
  const { build } = loadEsbuild()
  const hasDatalocation = fs.existsSync(path.resolve('apps/desktop/main/datalocation.ts'))
  const outFile = path.join(tempBase, 'datalocation-bundle.cjs')
  await build({
    stdin: {
      contents: hasDatalocation
        ? `
          export * as policy from './apps/desktop/main/policy.ts'
          export * as datalocation from './apps/desktop/main/datalocation.ts'
        `
        : `
          export * as policy from './apps/desktop/main/policy.ts'
          export const datalocation = null
        `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    outfile: outFile,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  cachedModules = createRequire(import.meta.url)(outFile)
  return cachedModules
}

function requireDatalocation(datalocation) {
  assert.ok(datalocation, 'apps/desktop/main/datalocation.ts is not implemented yet')
  return datalocation
}

let caseSeq = 0
function makeSandbox() {
  caseSeq += 1
  const dir = path.join(tempBase, `case-${caseSeq}`)
  const userData = path.join(dir, 'AppData', 'Orgtree v2')
  const defaultData = path.join(userData, 'data')
  const forbidden = path.join(dir, 'v1-orgtree')
  const installDir = path.join(dir, 'Program Files', 'Orgtree')
  fs.mkdirSync(defaultData, { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })
  return { dir, userData, defaultData, forbidden, installDir }
}

test('resolveDataRoot obeys ORGTREE_V2_DATA > data-location.json > <userData>/data and preserves 3.0.0-alpha.0 rule', async () => {
  const { policy, datalocation } = await loadDataLocationModules()
  const { userData, defaultData, dir } = makeSandbox()
  const customRoot = path.join(dir, 'CustomData')

  assert.equal(policy.resolveDataRoot(undefined, userData, { ownDataRootOnly: false }), defaultData)
  if (typeof policy.isDataRootFromEnv === 'function') {
    assert.equal(policy.isDataRootFromEnv(), false)
  }

  if (datalocation) {
    await datalocation.writeDataLocationConfig(userData, {
      version: 1,
      dataRoot: customRoot,
      previousRoot: defaultData,
      movedAt: '2026-11-14T09:00:00Z',
    })
  } else {
    fs.writeFileSync(
      path.join(userData, 'data-location.json'),
      JSON.stringify({
        version: 1,
        dataRoot: customRoot,
        previousRoot: defaultData,
        movedAt: '2026-11-14T09:00:00Z',
      }),
    )
  }
  assert.equal(policy.resolveDataRoot(undefined, userData, { ownDataRootOnly: false }), path.normalize(customRoot))
  assert.equal(typeof policy.isDataRootFromEnv, 'function')
  assert.equal(policy.isDataRootFromEnv(), false)

  const envRoot = path.join(dir, 'EnvOverride')
  assert.equal(policy.resolveDataRoot(envRoot, userData, { ownDataRootOnly: false }), envRoot)
  assert.equal(policy.isDataRootFromEnv(), true)
  assert.equal(policy.resolveDataRoot('', userData, { ownDataRootOnly: false }), '')

  // 3.0.0-alpha.0 still uses only <userData>/data even if data-location.json exists.
  assert.equal(policy.resolveDataRoot(undefined, userData, { ownDataRootOnly: true }), defaultData)
})

test('preflightDataLocation uses empty folders directly, appends "Orgtree data" for non-empty folders, and refuses overlaps/junctions/unsafe ancestors/low disk', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden, installDir } = makeSandbox()
  fs.writeFileSync(path.join(defaultData, 'sample.bin'), Buffer.alloc(4096, 7))

  const okTrust = async () => ({ ok: true, detail: 'trusted' })

  // 1. Empty folder -> used directly.
  const emptyPick = path.join(dir, 'EmptyTarget')
  fs.mkdirSync(emptyPick, { recursive: true })
  const rEmpty = await datalocation.preflightDataLocation({
    pickedPath: emptyPick,
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    activeAgents: 2,
    trustCheck: okTrust,
  })
  assert.equal(rEmpty.ok, true)
  assert.equal(rEmpty.usedSubfolder, false)
  assert.equal(rEmpty.resolvedRoot, emptyPick)
  assert.equal(rEmpty.activeAgents, 2)
  assert.equal(fs.readdirSync(emptyPick).length, 0, 'preflight must leave existing empty folder clean')

  // 2. Non-empty folder -> automatically resolves to <picked>/Orgtree data and cleans probe folder.
  const nonEmptyPick = path.join(dir, 'DriveRootLike')
  fs.mkdirSync(nonEmptyPick, { recursive: true })
  fs.writeFileSync(path.join(nonEmptyPick, 'notes.txt'), 'existing user file')
  const rSub = await datalocation.preflightDataLocation({
    pickedPath: nonEmptyPick,
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    trustCheck: okTrust,
  })
  assert.equal(rSub.ok, true)
  assert.equal(rSub.usedSubfolder, true)
  assert.equal(rSub.resolvedRoot, path.join(nonEmptyPick, 'Orgtree data'))
  assert.equal(fs.existsSync(rSub.resolvedRoot), false, 'preflight must remove temporary non-existent folder after probing')

  // 3. Overlap refusals: current folder, child of current, install folder, forbidden v1 folder, userData itself.
  for (const badPick of [
    defaultData,
    path.join(defaultData, 'nested'),
    installDir,
    path.join( forbidden, 'sub' ),
    userData,
  ]) {
    const res = await datalocation.preflightDataLocation({
      pickedPath: badPick,
      currentRoot: defaultData,
      userData,
      forbiddenRoot: forbidden,
      installDirectory: installDir,
      trustCheck: okTrust,
    })
    assert.equal(res.ok, false, `expected refusal for ${badPick}`)
  }

  // 4. Unsafe ancestor ACL refusal before engine stops.
  const unsafePick = path.join(dir, 'SharedTeam', 'Data')
  const rUnsafe = await datalocation.preflightDataLocation({
    pickedPath: unsafePick,
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    trustCheck: async () => ({
      ok: false,
      detail: 'path replaceable via ancestor',
      unsafeFolder: path.join(dir, 'SharedTeam'),
      unsafeBy: 'S-1-5-32-545',
      unsafeAbove: true,
    }),
  })
  assert.equal(rUnsafe.ok, false)
  assert.match(rUnsafe.error ?? '', /SharedTeam/)
  assert.equal(fs.existsSync(path.join(dir, 'SharedTeam')), false, 'temporary ancestor cleaned after failed probe')

  // 5. NTFS junction / symlink refusal.
  const realTarget = path.join(dir, 'RealDir')
  const linkDir = path.join(dir, 'JunctionDir')
  fs.mkdirSync(realTarget, { recursive: true })
  if (windows) {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkDir, realTarget], { stdio: 'ignore' })
  } else {
    fs.symlinkSync(realTarget, linkDir, 'dir')
  }
  assert.equal(datalocation.findReparseAncestor(path.join(linkDir, 'child')), linkDir)
  const rJunction = await datalocation.preflightDataLocation({
    pickedPath: path.join(linkDir, 'child'),
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
  })
  assert.equal(rJunction.ok, false)
  assert.match(rJunction.error ?? '', /symbolic link or junction/i)

  // 6. Low disk space refusal (mocking statfsSync temporarily).
  const origStatfs = fs.statfsSync
  fs.statfsSync = () => ({ bavail: 1024, bsize: 1024 }) // 1 MiB free (< 2 GiB headroom)
  try {
    const rLow = await datalocation.preflightDataLocation({
      pickedPath: path.join(dir, 'LowSpaceTarget'),
      currentRoot: defaultData,
      userData,
      forbiddenRoot: forbidden,
      trustCheck: okTrust,
    })
    assert.equal(rLow.ok, false)
    assert.match(rLow.error ?? '', /Not enough free disk space/i)
  } finally {
    fs.statfsSync = origStatfs
  }
})

test('real NTFS owner-only DACL + canonical verifyDescriptorTrust passes on C: temp', { skip: !windows }, async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden } = makeSandbox()
  // Only run real verifyDescriptorTrust when tempBase is on C:\ (formatted data drives without drive-root target have stock ACLs above temp if temp is redirected).
  if (!dir.toUpperCase().startsWith('C:\\')) return
  const candidate = path.join(dir, 'RealAclTarget')
  const res = await datalocation.preflightDataLocation({
    pickedPath: candidate,
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
  })
  assert.equal(res.ok, true, res.error)
})

test('executeDataLocationMove copies & verifies (skipping ephemerals), stamps relocation variants, supports mid-copy Cancel & post-switch failure rollback, and handles previous-folder cleanup', async () => {
  const { policy, datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden } = makeSandbox()

  // Populate realistic source root with PG_VERSION, secrets, scratch, and ephemerals that must be skipped.
  fs.mkdirSync(path.join(defaultData, 'pg', 'cluster', 'data'), { recursive: true })
  fs.mkdirSync(path.join(defaultData, 'secrets'), { recursive: true })
  fs.mkdirSync(path.join(defaultData, 'scratch', 'orgtree', 'agent-a'), { recursive: true })
  fs.writeFileSync(path.join(defaultData, 'pg', 'cluster', 'data', 'PG_VERSION'), '18\n')
  fs.writeFileSync(path.join(defaultData, 'pg', 'cluster', 'data', 'postmaster.pid'), '99999\n')
  fs.writeFileSync(path.join(defaultData, 'secrets', 'master.key'), 'secret-bytes-1234')
  fs.writeFileSync(path.join(defaultData, 'scratch', 'orgtree', 'agent-a', 'breadcrumbs.md'), '# hello\n')
  fs.writeFileSync(path.join(defaultData, 'engine-attach.json'), '{"type":"attach"}')
  fs.writeFileSync(path.join(defaultData, '.desktop-engine.lock'), '0')

  const okTrust = async () => ({ ok: true, detail: 'trusted' })

  // A. Cancel mid-copy -> cleans partial target, leaves source intact, restores config, restarts old engine.
  const cancelTarget = path.join(dir, 'CancelledTarget')
  const abortCtrl = new AbortController()
  let oldRestarted = 0
  const cancelRes = await datalocation.executeDataLocationMove({
    options: { targetPath: cancelTarget, deletePrevious: true },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    signal: abortCtrl.signal,
    trustCheck: okTrust,
    onProgress: p => {
      if (p.phase === 'copying') abortCtrl.abort()
    },
    stopOldEngine: async () => true,
    startAndVerifyNewEngine: async () => {
      assert.fail('should not start new engine after cancel')
    },
    restartOldEngineOnRollback: async root => {
      assert.equal(root, defaultData)
      oldRestarted += 1
    },
  })
  assert.equal(cancelRes.ok, false)
  assert.equal(cancelRes.cancelled, true)
  assert.equal(oldRestarted, 1)
  assert.equal(fs.existsSync(cancelTarget), false, 'partial target removed on cancel')
  assert.equal(fs.existsSync(path.join(defaultData, 'secrets', 'master.key')), true, 'oldRoot untouched')
  assert.equal(policy.readDataLocationConfig(userData), null)

  // B. Post-switch engine startup failure -> rolls back data-location.json, deletes partial target, keeps oldRoot untouched.
  const failTarget = path.join(dir, 'FailStartTarget')
  const failRes = await datalocation.executeDataLocationMove({
    options: { targetPath: failTarget, deletePrevious: true },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    stopOldEngine: async () => true,
    startAndVerifyNewEngine: async newRoot => {
      // At this moment data-location.json points at newRoot and .data-location-moved.json exists.
      assert.equal(policy.readDataLocationConfig(userData)?.dataRoot, path.normalize(newRoot))
      assert.equal(fs.existsSync(path.join(newRoot, '.data-location-moved.json')), true)
      throw new Error('simulated PostgreSQL startup error on target')
    },
    restartOldEngineOnRollback: async () => {
      oldRestarted += 1
    },
  })
  assert.equal(failRes.ok, false)
  assert.match(failRes.error ?? '', /simulated PostgreSQL startup error/)
  assert.equal(oldRestarted, 2)
  assert.equal(policy.readDataLocationConfig(userData), null, 'config rolled back')
  assert.equal(fs.existsSync(failTarget), false, 'failed target cleaned up')
  assert.equal(fs.existsSync(path.join(defaultData, 'pg', 'cluster', 'data', 'PG_VERSION')), true)

  // C. Happy path with deletePrevious: false -> stamps marker, switches config, keeps previousRoot for Settings button.
  const happyTarget = path.join(dir, 'HappyTarget')
  let stampedMarker = null
  const happyRes = await datalocation.executeDataLocationMove({
    options: { targetPath: happyTarget, deletePrevious: false },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    stopOldEngine: async () => true,
    startAndVerifyNewEngine: async newRoot => {
      const rawStamp = fs.readFileSync(path.join(newRoot, '.data-location-moved.json'), 'utf8')
      stampedMarker = JSON.parse(rawStamp)
      // Simulate engine consuming the relocation stamp after rewriting DB + profiles.
      fs.unlinkSync(path.join(newRoot, '.data-location-moved.json'))
    },
    restartOldEngineOnRollback: async () => {
      assert.fail('should not rollback on success')
    },
  })
  assert.equal(happyRes.ok, true)
  assert.equal(happyRes.relaunching, true)
  assert.equal(stampedMarker?.version, 1)
  assert.ok(Array.isArray(stampedMarker?.fromRootVariants) && stampedMarker.fromRootVariants.length >= 1)
  assert.equal(fs.existsSync(path.join(happyTarget, 'engine-attach.json')), false, 'ephemeral attach skipped')
  assert.equal(fs.existsSync(path.join(happyTarget, '.desktop-engine.lock')), false, 'ephemeral lock skipped')
  assert.equal(fs.existsSync(path.join(happyTarget, 'pg', 'cluster', 'data', 'postmaster.pid')), false, 'postmaster.pid skipped')
  assert.equal(fs.readFileSync(path.join(happyTarget, 'secrets', 'master.key'), 'utf8'), 'secret-bytes-1234')
  assert.equal(fs.existsSync(defaultData), true, 'old folder kept when deletePrevious is false')

  const stateBeforeDelete = await datalocation.readDataLocationState({
    currentRoot: happyTarget,
    userData,
    envOverride: false,
    moving: false,
  })
  assert.equal(stateBeforeDelete.isCustom, true)
  assert.equal(stateBeforeDelete.previousRoot, path.normalize(defaultData))
  assert.ok((stateBeforeDelete.previousBytes ?? 0) > 0)

  // Deleting previous folder via Settings button removes defaultData and clears previousRoot.
  const delRes = await datalocation.deletePreviousDataLocationFolder({
    userData,
    currentRoot: happyTarget,
  })
  assert.equal(delRes.ok, true, delRes.error)
  assert.equal(fs.existsSync(defaultData), false)
  assert.equal(policy.readDataLocationConfig(userData)?.previousRoot, undefined)

  // D. Happy path moving back to defaultData with deletePrevious: true -> removes happyTarget AND clears data-location.json.
  const backRes = await datalocation.executeDataLocationMove({
    options: { targetPath: defaultData, deletePrevious: true },
    currentRoot: happyTarget,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    stopOldEngine: async () => true,
    startAndVerifyNewEngine: async newRoot => {
      fs.unlinkSync(path.join(newRoot, '.data-location-moved.json'))
    },
    restartOldEngineOnRollback: async () => {
      assert.fail('should not rollback')
    },
  })
  assert.equal(backRes.ok, true)
  assert.equal(fs.existsSync(happyTarget), false, 'previous custom folder deleted when deletePrevious is true')
  assert.equal(fs.existsSync(path.join(defaultData, 'secrets', 'master.key')), true)
  assert.equal(policy.readDataLocationConfig(userData), null, 'returning to default with no previousRoot removes data-location.json')
})

test('preload exposes narrow data-location bridge methods and offline progress HTML stays script-free', async () => {
  const { build } = loadEsbuild()
  const result = await build({
    entryPoints: ['apps/desktop/preload/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  let exposedBridge = null
  const invoked = []
  const sandbox = {
    module: { exports: {} },
    exports: {},
    process: {
      argv: ['--orgtree-ui-origin=http://127.0.0.1:47829', '--orgtree-stallwatch=0'],
      isMainFrame: true,
    },
    location: {
      origin: 'http://127.0.0.1:47829',
      pathname: '/o/local-org',
      protocol: 'http:',
    },
    require(specifier) {
      if (specifier === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld(_name, api) {
              exposedBridge = api
            },
          },
          ipcRenderer: {
            sendSync: () => ({ token: 'tok' }),
            invoke: async (channel, ...args) => {
              invoked.push([channel, args])
              return { ok: true }
            },
            send() {},
            on() {},
            removeListener() {},
          },
        }
      }
      throw new Error(`Unexpected require: ${specifier}`)
    },
  }
  vm.runInNewContext(result.outputFiles[0].text, sandbox)
  assert.equal(typeof exposedBridge?.getDataLocationState, 'function')
  assert.equal(typeof exposedBridge?.chooseDataLocation, 'function')
  assert.equal(typeof exposedBridge?.preflightDataLocation, 'function')
  assert.equal(typeof exposedBridge?.moveDataLocation, 'function')
  assert.equal(typeof exposedBridge?.cancelDataLocationMove, 'function')
  assert.equal(typeof exposedBridge?.deletePreviousDataLocation, 'function')
  assert.equal(typeof exposedBridge?.openDataLocationFolder, 'function')

  await exposedBridge.openDataLocationFolder('current')
  assert.deepEqual(invoked.at(-1), ['desktop:data-location-open', ['current']])

  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const html = datalocation.dataMoveProgressHtml({
    phase: 'copying',
    filesCopied: 5,
    totalFiles: 10,
    bytesCopied: 500,
    totalBytes: 1000,
    cancellable: true,
    detail: '500 B of 1000 B',
  })
  assert.equal(/<script/i.test(html), false)
  assert.equal(html.includes(datalocation.DATA_MOVE_CANCEL_URL), true)

  const postSwitchHtml = datalocation.dataMoveProgressHtml({
    phase: 'starting',
    filesCopied: 10,
    totalFiles: 10,
    bytesCopied: 1000,
    totalBytes: 1000,
    cancellable: false,
    detail: 'Starting engine',
  })
  assert.equal(postSwitchHtml.includes(datalocation.DATA_MOVE_CANCEL_URL), false)
})

test('Windows PowerShell 5.1 installer-upgrade.ps1 and boot-engine-task.ps1 honor data-location.json and active move markers', { skip: !windows }, async () => {
  const { policy } = await loadDataLocationModules()
  const { dir } = makeSandbox()
  const fakeInstall = path.join(dir, 'Install')
  const fakeExe = path.join(fakeInstall, 'Orgtree.exe')
  const fakeAppData = path.join(dir, 'Roaming')
  const fakeUserData = path.join(fakeAppData, 'Orgtree v2')
  const customRoot = path.join(dir, 'CustomEngineData')
  fs.mkdirSync(fakeInstall, { recursive: true })
  fs.mkdirSync(fakeUserData, { recursive: true })
  fs.writeFileSync(fakeExe, 'stub')
  fs.writeFileSync(
    path.join(fakeUserData, 'data-location.json'),
    JSON.stringify({ version: 1, dataRoot: customRoot }),
  )

  // 1. boot-engine-task.ps1 Get-OperatorDataRoot reads data-location.json when ORGTREE_V2_DATA is unset.
  const bootScript = path.resolve('tools/boot-engine-task.ps1').replace(/'/g, "''")
  const fakeProfile = path.join(dir, 'OperatorProfile')
  const opUserData = path.join(fakeProfile, 'AppData', 'Roaming', 'Orgtree v2')
  fs.mkdirSync(opUserData, { recursive: true })
  fs.writeFileSync(path.join(opUserData, 'data-location.json'), JSON.stringify({ version: 1, dataRoot: customRoot }))

  const bootOut = execFileSync(
    policy.WINDOWS_POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `. '${bootScript}'; function Get-OperatorProfile([string]$Sid){ return '${fakeProfile.replace(/'/g, "''")}' }; Write-Output (Get-OperatorDataRoot 'S-1-5-21-0-0-0-999999')`,
    ],
    { encoding: 'utf8', env: policy.windowsPowerShellEnv() },
  ).trim()
  assert.equal(bootOut.toLowerCase(), path.resolve(customRoot).toLowerCase())

  // 2. installer-upgrade.ps1 refuses with Retry message while .data-move-in-progress.json names a live process.
  const upgradeScript = path.resolve('tools/installer-upgrade.ps1')
  const markerPath = path.join(fakeUserData, '.data-move-in-progress.json')
  fs.writeFileSync(markerPath, JSON.stringify({ version: 1, pid: process.pid }))

  const runUpgrade = await new Promise(resolve => {
    const env = { ...policy.windowsPowerShellEnv(), APPDATA: fakeAppData }
    delete env.ORGTREE_V2_DATA
    const child = spawn(
      policy.WINDOWS_POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        upgradeScript,
        '-InstallDir',
        fakeInstall,
        '-ExecutablePath',
        fakeExe,
        '-TimeoutSeconds',
        '10',
      ],
      { env, windowsHide: true },
    )
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', d => { stdout += String(d) })
    child.stderr.on('data', d => { stderr += String(d) })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  assert.notEqual(runUpgrade.code, 0)
  assert.match(runUpgrade.stderr + runUpgrade.stdout, /currently moving its data folder/i)
})
