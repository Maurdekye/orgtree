// Data location contract, preflight, copy/verify/rollback, NTFS ACL, preload,
// and Windows installer/boot-task PowerShell tests.
//
// Run: node tests/run.mjs tests/data-location.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
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
          export * as engineMod from './apps/desktop/main/engine.ts'
        `
        : `
          export * as policy from './apps/desktop/main/policy.ts'
          export const datalocation = null
          export * as engineMod from './apps/desktop/main/engine.ts'
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

test('real NTFS owner-only DACL + canonical verifyDescriptorTrust and verifyDataFolderTrust pass on trusted base', { skip: !windows }, async () => {
  const { policy, datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const candidates = [
    process.env.ORGTREE_TEST_ACL_BASE,
    tempBase,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'orgtree-test-acl') : null,
  ].filter(Boolean)

  let aclBase = null
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true })
      const probeDir = fs.mkdtempSync(path.join(base, 'orgtree-acl-probe-'))
      await datalocation.lockOwnerOnlyAcl(probeDir, true)
      const probeFile = path.join(probeDir, 'probe.json')
      fs.writeFileSync(probeFile, '{}')
      await datalocation.lockOwnerOnlyAcl(probeFile, false)
      const verdict = await policy.verifyDescriptorTrust(probeFile)
      fs.rmSync(probeDir, { recursive: true, force: true })
      if (verdict.ok) {
        aclBase = base
        break
      }
    } catch {
      // Try next candidate base.
    }
  }
  assert.ok(aclBase, 'expected at least one local directory with trusted ancestor ACLs')

  const workDir = fs.mkdtempSync(path.join(aclBase, 'orgtree-real-acl-'))
  try {
    await datalocation.lockOwnerOnlyAcl(workDir, true)
    const userData = path.join(workDir, 'AppData', 'Orgtree v2')
    const defaultData = path.join(userData, 'data')
    const forbidden = path.join(workDir, 'v1-orgtree')
    fs.mkdirSync(defaultData, { recursive: true })
    const candidate = path.join(workDir, 'RealAclTarget')
    const res = await datalocation.preflightDataLocation({
      pickedPath: candidate,
      currentRoot: defaultData,
      userData,
      forbiddenRoot: forbidden,
    })
    assert.equal(res.ok, true, res.error)

    assert.equal(typeof policy.verifyDataFolderTrust, 'function')
    fs.mkdirSync(candidate, { recursive: true })
    await datalocation.lockOwnerOnlyAcl(candidate, true)
    const dirTrust = await policy.verifyDataFolderTrust(candidate)
    assert.equal(dirTrust.ok, true, dirTrust.detail)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
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

test('move progress window shows a step meter (label, done / total, bar) for the post-copy check', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const base = { filesCopied: 10, totalFiles: 10, bytesCopied: 1000, totalBytes: 1000, cancellable: true }
  const html = datalocation.dataMoveProgressHtml({
    ...base, phase: 'verifying', stepLabel: 'Checking for changes', stepDone: 3, stepTotal: 10,
  })
  assert.match(html, /width:30%/)
  assert.match(html, /Checking for changes/)
  assert.match(html, /3 \/ 10/)
  const indeterminate = datalocation.dataMoveProgressHtml({
    ...base, phase: 'verifying', stepLabel: 'Copying latest versions', stepDone: 0, stepTotal: 0,
  })
  assert.doesNotMatch(indeterminate, /width:100%/)
  assert.match(indeterminate, /Copying latest versions/)
  const preparing = datalocation.dataMoveProgressHtml({
    ...base, phase: 'preparing', stepLabel: 'Watching for changes', stepDone: 5, stepTotal: 20,
  })
  assert.match(preparing, /width:25%/)
  assert.match(preparing, /Watching for changes/)
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

test('F-1: Session 0 boot move skips core-manual-quit ephemerals, uses coreLifecycle.transition(true) instead of cancelRecovery, and strips --background/--core-recovered on relaunch', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden } = makeSandbox()

  // 1. Ephemeral core-recovery / manual-quit root files must NEVER be copied into newRoot.
  fs.mkdirSync(path.join(defaultData, 'pg', 'cluster', 'data'), { recursive: true })
  fs.writeFileSync(path.join(defaultData, 'pg', 'cluster', 'data', 'PG_VERSION'), '18\n')
  fs.writeFileSync(path.join(defaultData, 'core-manual-quit.json'), '{"sessions":[1]}')
  fs.writeFileSync(path.join(defaultData, 'core-stop-4.json'), '{"stopped":true}')
  fs.writeFileSync(path.join(defaultData, 'core-recovery-2-budget.json'), '{}')
  fs.writeFileSync(path.join(defaultData, 'core-recovery-2-claim'), '1')
  fs.writeFileSync(path.join(defaultData, '.core-999.tmp'), 'tmp')

  const copyDst = path.join(dir, 'CopyNoCoreQuit')
  await datalocation.copyDataRootWithVerify(defaultData, copyDst)
  for (const forbiddenEphemeral of [
    'core-manual-quit.json',
    'core-stop-4.json',
    'core-recovery-2-budget.json',
    'core-recovery-2-claim',
    '.core-999.tmp',
  ]) {
    assert.equal(
      fs.existsSync(path.join(copyDst, forbiddenEphemeral)),
      false,
      `copyDataRootWithVerify must skip ${forbiddenEphemeral}`,
    )
  }

  // 2. Interactive relaunch strips --background and --core-recovered.
  assert.equal(typeof datalocation.interactiveRelaunchArgs, 'function')
  assert.deepEqual(
    datalocation.interactiveRelaunchArgs(
      ['--background', '--core-recovered', '--orgtree-taskbar=abc', 'orgtree://org/x', '--inspect=0'],
      arg => arg.startsWith('orgtree://'),
    ),
    ['--inspect=0'],
  )

  // 3. Boot-mode desktop orchestration uses transition(true) + complete() on rollback, never cancelRecovery().
  assert.equal(typeof datalocation.orchestrateDesktopDataMove, 'function')
  const okTrust = async () => ({ ok: true, detail: 'trusted' })
  const lcCalls = []
  const fakeLifecycle = {
    transition: async (planned) => { lcCalls.push(`transition:${planned}`) },
    complete: async () => { lcCalls.push('complete') },
    start: () => { lcCalls.push('start') },
    stop: () => { lcCalls.push('stop') },
    cancelRecovery: async () => { lcCalls.push('cancelRecovery') },
  }

  const rollbackTarget = path.join(dir, 'BootRollbackTarget')
  let reopenedRollback = 0
  const rbRes = await datalocation.orchestrateDesktopDataMove({
    options: { targetPath: rollbackTarget, deletePrevious: false },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    resolveMoveTopology: async () => 'boot',
    coreLifecycle: fakeLifecycle,
    prepareUiForMove: async () => ({ closeMoveWindow: () => {} }),
    stopEngineForMove: async () => true,
    startAndVerifyNewEngine: async (_newRoot, topology) => {
      assert.equal(topology, 'boot')
      throw new Error('simulated Session 0 attach timeout')
    },
    restartOldEngineOnRollback: async (_oldRoot, topology) => {
      assert.equal(topology, 'boot')
    },
    finishSuccessfulMove: () => {
      assert.fail('should not finish success on rollback')
    },
    restoreAfterFailedOrCancelledMove: async () => {
      reopenedRollback += 1
    },
  })
  assert.equal(rbRes.ok, false)
  assert.equal(lcCalls.includes('cancelRecovery'), false, 'boot move must NEVER call coreLifecycle.cancelRecovery()')
  assert.deepEqual(lcCalls, ['transition:true', 'stop', 'complete', 'start'])
  assert.equal(reopenedRollback, 1)

  // 4. Boot-mode success uses transition(true) + stop() + interactive relaunch.
  lcCalls.length = 0
  let relaunchedInteractive = 0
  const okTarget = path.join(dir, 'BootSuccessTarget')
  const okRes = await datalocation.orchestrateDesktopDataMove({
    options: { targetPath: okTarget, deletePrevious: false },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    resolveMoveTopology: async () => 'boot',
    coreLifecycle: fakeLifecycle,
    prepareUiForMove: async () => ({ closeMoveWindow: () => {} }),
    stopEngineForMove: async () => true,
    startAndVerifyNewEngine: async newRoot => {
      fs.unlinkSync(path.join(newRoot, '.data-location-moved.json'))
    },
    restartOldEngineOnRollback: async () => {},
    finishSuccessfulMove: () => {
      relaunchedInteractive += 1
    },
    restoreAfterFailedOrCancelledMove: async () => {
      assert.fail('should not restore failed UI on success')
    },
  })
  assert.equal(okRes.ok, true)
  assert.equal(lcCalls.includes('cancelRecovery'), false)
  assert.deepEqual(lcCalls, ['transition:true', 'stop', 'stop'])
  assert.equal(relaunchedInteractive, 1)
})

test('F-2: UNC/device/reparse/oversized data-location.json refusal, pre-spawn Engine.start custom-root trust & junction check, and missing-drive startup dialog validation & stamping', async () => {
  const { policy, datalocation: dl, engineMod } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden, installDir } = makeSandbox()
  const okTrust = async () => ({ ok: true, detail: 'trusted' })

  // 1. UNC, verbatim UNC, device paths, '..', oversized (>16 KiB), and symlinked data-location.json are rejected.
  const cfgPath = path.join(userData, 'data-location.json')
  for (const badRoot of [
    '\\\\127.0.0.1\\share\\Orgtree data',
    '\\\\?\\UNC\\127.0.0.1\\share\\Orgtree data',
    `\\\\.\\${path.join(dir, 'DeviceDir')}`,
    `${path.join(dir, 'Sub')}${path.sep}..${path.sep}Escape`,
  ]) {
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, dataRoot: badRoot }))
    assert.equal(policy.readDataLocationConfig(userData), null, `readDataLocationConfig must reject ${badRoot}`)
    const pf = await datalocation.preflightDataLocation({
      pickedPath: badRoot,
      currentRoot: defaultData,
      userData,
      forbiddenRoot: forbidden,
      trustCheck: okTrust,
    })
    assert.equal(pf.ok, false, `preflightDataLocation must reject ${badRoot}`)
  }

  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ version: 1, dataRoot: path.join(dir, 'ValidButHuge'), pad: 'x'.repeat(20000) }),
  )
  assert.equal(policy.readDataLocationConfig(userData), null, 'oversized >16 KiB data-location.json must return null')
  fs.unlinkSync(cfgPath)

  const symTargetFile = path.join(dir, 'outside-config.json')
  fs.writeFileSync(symTargetFile, JSON.stringify({ version: 1, dataRoot: path.join(dir, 'SymRoot') }))
  let createdCfgLink = false
  try {
    fs.symlinkSync(symTargetFile, cfgPath)
    createdCfgLink = true
  } catch {
    // Windows without Developer Mode may disallow file symlinks when unprivileged.
  }
  if (createdCfgLink) {
    assert.equal(policy.readDataLocationConfig(userData), null, 'symlinked data-location.json must return null')
    fs.unlinkSync(cfgPath)
  }

  // 2. Engine.start({ ..., customDataRoot: true }) refuses junctioned and untrusted custom roots BEFORE launchBackground/spawn.
  const fakeBin = path.join(dir, windows ? 'fake-engine.exe' : 'fake-engine')
  fs.writeFileSync(fakeBin, 'stub')
  const realEngineDir = path.join(dir, 'RealEngineTarget')
  const juncEngineDir = path.join(dir, 'JunctionEngineTarget')
  fs.mkdirSync(realEngineDir, { recursive: true })
  if (windows) {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', juncEngineDir, realEngineDir], { stdio: 'ignore' })
  } else {
    fs.symlinkSync(realEngineDir, juncEngineDir, 'dir')
  }

  let launchedBg = 0
  const engJunc = new engineMod.Engine()
  engJunc.trustCheck = okTrust
  await assert.rejects(
    engJunc.start({
      python: '',
      directory: dir,
      binary: fakeBin,
      dataRoot: juncEngineDir,
      customDataRoot: true,
      forbiddenRoot: forbidden,
      uiDirectory: dir,
      launchBackground: async () => {
        launchedBg += 1
        return 'boot'
      },
    }),
    /symbolic link|junction/i,
  )
  assert.equal(launchedBg, 0, 'Engine.start must refuse junctioned custom dataRoot before launchBackground')

  const untrustedCustom = path.join(dir, 'UntrustedCustomEngineRoot')
  fs.mkdirSync(untrustedCustom, { recursive: true })
  const engUntrusted = new engineMod.Engine()
  engUntrusted.trustCheck = async () => ({
    ok: false,
    detail: 'descriptor directory writable by S-1-1-0',
    unsafeFolder: untrustedCustom,
    unsafeBy: 'S-1-1-0',
    unsafeAbove: false,
  })
  await assert.rejects(
    engUntrusted.start({
      python: '',
      directory: dir,
      binary: fakeBin,
      dataRoot: untrustedCustom,
      customDataRoot: true,
      forbiddenRoot: forbidden,
      uiDirectory: dir,
      launchBackground: async () => {
        launchedBg += 1
        return 'boot'
      },
    }),
    /Everyone|writable|will not connect/i,
  )
  assert.equal(launchedBg, 0, 'Engine.start must refuse untrusted custom dataRoot before launchBackground')

  // 3. Missing-drive startup dialog helper (`resolveMissingDataLocationChoice`):
  //    - rejects UNC, junctions, overlaps, and untrusted folders;
  //    - auto-selects `<picked>/Orgtree data` when `<picked>/Orgtree data/pg/cluster/data/PG_VERSION` exists;
  //    - stamps `.data-location-moved.json` when remounted path differs from oldConfiguredRoot;
  //    - asks `confirmBlankFolder` when `PG_VERSION` is absent;
  //    - omits `previousRoot` when `"Use default location"` returns to `defaultData`.
  assert.equal(typeof datalocation.resolveMissingDataLocationChoice, 'function')
  const oldMissingRoot = path.join(dir, 'OldUnmountedDrive', 'Orgtree data')
  await datalocation.writeDataLocationConfig(userData, {
    version: 1,
    dataRoot: oldMissingRoot,
    previousRoot: defaultData,
    movedAt: '2026-11-14T08:00:00Z',
  })

  // Bad picks rejected in startup dialog:
  for (const badPick of ['\\\\127.0.0.1\\share\\Data', juncEngineDir, userData, installDir, forbidden]) {
    const r = await datalocation.resolveMissingDataLocationChoice({
      action: 'choose',
      pickedPath: badPick,
      configuredRoot: oldMissingRoot,
      defaultDataFolder: defaultData,
      userData,
      forbiddenRoot: forbidden,
      installDirectory: installDir,
      trustCheck: okTrust,
      confirmBlankFolder: async () => true,
    })
    assert.equal(r.ok, false, `startup dialog must reject ${badPick}`)
  }

  // Blank folder declined -> stays unchosen, config unchanged:
  const emptyPicked = path.join(dir, 'BlankPickedFolder')
  fs.mkdirSync(emptyPicked, { recursive: true })
  const declinedBlank = await datalocation.resolveMissingDataLocationChoice({
    action: 'choose',
    pickedPath: emptyPicked,
    configuredRoot: oldMissingRoot,
    defaultDataFolder: defaultData,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    trustCheck: okTrust,
    confirmBlankFolder: async () => false,
  })
  assert.equal(declinedBlank.ok, false)
  assert.equal(declinedBlank.cancelled, true)
  assert.equal(policy.readDataLocationConfig(userData)?.dataRoot, path.normalize(oldMissingRoot))

  // Remounted drive root containing `Orgtree data/pg/cluster/data/PG_VERSION` -> auto-selects subfolder + stamps `.data-location-moved.json`!
  const remountedDrive = path.join(dir, 'RemountedDriveE')
  const remountedSub = path.join(remountedDrive, 'Orgtree data')
  fs.mkdirSync(path.join(remountedSub, 'pg', 'cluster', 'data'), { recursive: true })
  fs.writeFileSync(path.join(remountedSub, 'pg', 'cluster', 'data', 'PG_VERSION'), '18\n')
  const remountRes = await datalocation.resolveMissingDataLocationChoice({
    action: 'choose',
    pickedPath: remountedDrive,
    configuredRoot: oldMissingRoot,
    defaultDataFolder: defaultData,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    trustCheck: okTrust,
    confirmBlankFolder: async () => {
      assert.fail('must not prompt blank-folder warning when <picked>/Orgtree data has PG_VERSION')
    },
  })
  assert.equal(remountRes.ok, true, remountRes.error)
  assert.equal(remountRes.dataRoot, remountedSub)
  assert.equal(remountRes.stampedRelocation, true)
  const stamp = JSON.parse(fs.readFileSync(path.join(remountedSub, '.data-location-moved.json'), 'utf8'))
  assert.equal(stamp.fromRoot, path.resolve(oldMissingRoot))

  // "Use default location" when previousRoot === defaultData -> omits previousRoot and clears data-location.json!
  fs.mkdirSync(path.join(defaultData, 'pg', 'cluster', 'data'), { recursive: true })
  fs.writeFileSync(path.join(defaultData, 'pg', 'cluster', 'data', 'PG_VERSION'), '18\n')
  const useDefRes = await datalocation.resolveMissingDataLocationChoice({
    action: 'default',
    configuredRoot: remountedSub,
    defaultDataFolder: defaultData,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    trustCheck: okTrust,
    confirmBlankFolder: async () => true,
  })
  assert.equal(useDefRes.ok, true)
  assert.equal(useDefRes.dataRoot, defaultData)
  assert.equal(policy.readDataLocationConfig(userData), null, 'switching back to defaultData when previousRoot was defaultData clears data-location.json')
})

test('F-3: deletePreviousDataLocationFolder and post-move cleanup refuse junctions, realpath overlaps, bare drive roots, and userData/install/forbidden trees, and unlink inner junctions safely', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden, installDir } = makeSandbox()

  const activeCustom = path.join(dir, 'ActiveCustom')
  const externalKeep = path.join(dir, 'ExternalKeep')
  fs.mkdirSync(activeCustom, { recursive: true })
  fs.mkdirSync(externalKeep, { recursive: true })
  fs.writeFileSync(path.join(activeCustom, 'live.txt'), 'live-data')
  fs.writeFileSync(path.join(externalKeep, 'precious.txt'), 'do-not-delete')

  // 1. Junction/symlink previousRoot pointing to activeCustom or externalKeep is refused and hidden in readDataLocationState.
  const prevLinkToActive = path.join(dir, 'PrevLinkToActive')
  const prevLinkToExternal = path.join(dir, 'PrevLinkToExternal')
  if (windows) {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', prevLinkToActive, activeCustom], { stdio: 'ignore' })
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', prevLinkToExternal, externalKeep], { stdio: 'ignore' })
  } else {
    fs.symlinkSync(activeCustom, prevLinkToActive, 'dir')
    fs.symlinkSync(externalKeep, prevLinkToExternal, 'dir')
  }

  const driveRoot = path.parse(dir).root
  const crashpadInUserData = path.join(userData, 'Crashpad')
  fs.mkdirSync(crashpadInUserData, { recursive: true })
  fs.writeFileSync(path.join(crashpadInUserData, 'dump.dmp'), 'keep')

  for (const unsafePrev of [
    prevLinkToActive,
    prevLinkToExternal,
    path.join(prevLinkToExternal, 'nested'),
    userData,
    path.dirname(userData),
    crashpadInUserData,
    installDir,
    forbidden,
    driveRoot,
  ]) {
    fs.writeFileSync(
      path.join(userData, 'data-location.json'),
      JSON.stringify({ version: 1, dataRoot: activeCustom, previousRoot: unsafePrev }),
    )
    const state = await datalocation.readDataLocationState({
      currentRoot: activeCustom,
      userData,
      envOverride: false,
      moving: false,
      forbiddenRoot: forbidden,
      installDirectory: installDir,
    })
    assert.equal(state.previousRoot, null, `readDataLocationState must hide unsafe previousRoot ${unsafePrev}`)

    const del = await datalocation.deletePreviousDataLocationFolder({
      userData,
      currentRoot: activeCustom,
      forbiddenRoot: forbidden,
      installDirectory: installDir,
    })
    assert.equal(del.ok, false, `deletePreviousDataLocationFolder must refuse ${unsafePrev}`)
  }

  assert.equal(fs.existsSync(path.join(activeCustom, 'live.txt')), true)
  assert.equal(fs.existsSync(path.join(externalKeep, 'precious.txt')), true)
  assert.equal(fs.existsSync(path.join(crashpadInUserData, 'dump.dmp')), true)

  // 2. Legitimate old folder containing an inner NTFS junction / symlink to externalKeep:
  //    deleting old folder unlinks ONLY the inner junction without deleting externalKeep/precious.txt!
  const oldWithInnerJunction = path.join(dir, 'OldWithInnerJunction')
  fs.mkdirSync(path.join(oldWithInnerJunction, 'profiles'), { recursive: true })
  fs.writeFileSync(path.join(oldWithInnerJunction, 'old.db'), 'old-bytes')
  const innerJunc = path.join(oldWithInnerJunction, 'profiles', 'linked-ext')
  if (windows) {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', innerJunc, externalKeep], { stdio: 'ignore' })
  } else {
    fs.symlinkSync(externalKeep, innerJunc, 'dir')
  }

  await datalocation.writeDataLocationConfig(userData, {
    version: 1,
    dataRoot: activeCustom,
    previousRoot: oldWithInnerJunction,
  })
  const safeDel = await datalocation.deletePreviousDataLocationFolder({
    userData,
    currentRoot: activeCustom,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
  })
  assert.equal(safeDel.ok, true, safeDel.error)
  assert.equal(fs.existsSync(oldWithInnerJunction), false, 'old folder removed')
  assert.equal(
    fs.readFileSync(path.join(externalKeep, 'precious.txt'), 'utf8'),
    'do-not-delete',
    'inner junction target files must NEVER be deleted',
  )
})

test('F-4: orchestrateDesktopDataMove runs preflight and Windows task-route check BEFORE closing windows or stopping poll, and reopens windows on unexpected outer error', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden } = makeSandbox()
  const okTrust = async () => ({ ok: true, detail: 'trusted' })

  // 1. Preflight failure (e.g. target overlaps currentRoot) must return BEFORE prepareUiForMove closes windows!
  let uiPrepared = 0
  const pfFail = await datalocation.orchestrateDesktopDataMove({
    options: { targetPath: defaultData, deletePrevious: false },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    resolveMoveTopology: async () => 'managed',
    prepareUiForMove: async () => {
      uiPrepared += 1
      return { closeMoveWindow: () => {} }
    },
    stopEngineForMove: async () => true,
    startAndVerifyNewEngine: async () => {},
    restartOldEngineOnRollback: async () => {},
    finishSuccessfulMove: () => {},
    restoreAfterFailedOrCancelledMove: async () => {},
  })
  assert.equal(pfFail.ok, false)
  assert.equal(uiPrepared, 0, 'windows/poll must NOT be torn down when preflight fails')

  // 2. Unreadable Windows startup tasks ('unknown' topology) must return BEFORE prepareUiForMove closes windows!
  const validDest = path.join(dir, 'ValidDestF4')
  const topoFail = await datalocation.orchestrateDesktopDataMove({
    options: { targetPath: validDest, deletePrevious: false },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    resolveMoveTopology: async () => 'unknown',
    unreadableTasksMessage: 'Scheduled tasks could not be verified.',
    prepareUiForMove: async () => {
      uiPrepared += 1
      return { closeMoveWindow: () => {} }
    },
    stopEngineForMove: async () => true,
    startAndVerifyNewEngine: async () => {},
    restartOldEngineOnRollback: async () => {},
    finishSuccessfulMove: () => {},
    restoreAfterFailedOrCancelledMove: async () => {},
  })
  assert.equal(topoFail.ok, false)
  assert.match(topoFail.error ?? '', /Scheduled tasks/i)
  assert.equal(uiPrepared, 0, 'windows/poll must NOT be torn down when moveTopology is unknown')

  // 3. Unexpected exception after prepareUiForMove still closes moveWindow and calls restoreAfterFailedOrCancelledMove!
  let moveWinClosed = 0
  let windowsRestored = 0
  const unexpectedRes = await datalocation.orchestrateDesktopDataMove({
    options: { targetPath: validDest, deletePrevious: false },
    currentRoot: defaultData,
    userData,
    forbiddenRoot: forbidden,
    trustCheck: okTrust,
    resolveMoveTopology: async () => 'managed',
    prepareUiForMove: async () => {
      uiPrepared += 1
      return {
        closeMoveWindow: () => { moveWinClosed += 1 },
        onProgress: () => { throw new Error('unexpected progress render boom') },
      }
    },
    stopEngineForMove: async () => true,
    startAndVerifyNewEngine: async () => {},
    restartOldEngineOnRollback: async () => {},
    finishSuccessfulMove: () => {},
    restoreAfterFailedOrCancelledMove: async () => {
      windowsRestored += 1
    },
  })
  assert.equal(unexpectedRes.ok, false)
  assert.equal(uiPrepared, 1)
  assert.equal(moveWinClosed, 1)
  assert.equal(windowsRestored, 1, 'outer catch must restore saved windows so app is never left windowless')
})

test('F-5: .data-move-in-progress.json records created + startedAtMs, expires old or recycled-PID markers across TS & PS, and index.ts clears stale markers on startup', async () => {
  const { policy, datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData } = makeSandbox()
  const nextTarget = path.join(dir, 'MoveMarkerTarget')

  // 1. writeMoveInProgressMarker writes startedAtMs (and created on Windows).
  datalocation.writeMoveInProgressMarker(userData, defaultData, nextTarget)
  const markerFile = path.join(userData, '.data-move-in-progress.json')
  const markerDoc = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  assert.equal(markerDoc.version, 1)
  assert.equal(markerDoc.pid, process.pid)
  assert.equal(typeof markerDoc.startedAtMs, 'number')
  if (windows) {
    assert.equal(typeof markerDoc.created, 'string')
    assert.ok(markerDoc.created.length > 5, 'Windows marker must record FILETIME creation stamp')
  }
  assert.equal(datalocation.hasActiveMoveInProgressMarker(userData), true)

  // Expired startedAtMs (> 6h) is ignored.
  assert.equal(
    datalocation.hasActiveMoveInProgressMarker(userData, markerDoc.startedAtMs + 7 * 3600 * 1000),
    false,
    'expired move marker must be ignored',
  )

  // Mismatched `created` stamp (simulating PID reuse) is ignored on Windows.
  if (windows) {
    fs.writeFileSync(
      markerFile,
      JSON.stringify({ version: 1, pid: process.pid, created: '1', startedAtMs: Date.now() }),
    )
    assert.equal(
      datalocation.hasActiveMoveInProgressMarker(userData),
      false,
      'recycled PID with mismatched created stamp must be ignored',
    )
  }

  // 2. apps/desktop/main/index.ts clears stale .data-move-in-progress.json on primary single-instance startup.
  const indexSrc = fs.readFileSync(path.resolve('apps/desktop/main/index.ts'), 'utf8')
  assert.match(
    indexSrc,
    /clearMoveInProgressMarker\(app\.getPath\('userData'\)\)/,
    'index.ts must clear stale .data-move-in-progress.json on single-instance startup',
  )

  // 3. Windows PowerShell boot-engine-task.ps1 & installer-upgrade.ps1 reject UNC/device/oversized configs and ignore recycled/expired move markers.
  if (windows) {
    const bootScript = path.resolve('tools/boot-engine-task.ps1').replace(/'/g, "''")
    const uncCfgFile = path.join(dir, 'unc-data-location.json')
    fs.writeFileSync(uncCfgFile, JSON.stringify({ version: 1, dataRoot: '\\\\127.0.0.1\\share\\Data' }))
    const bootUncOut = execFileSync(
      policy.WINDOWS_POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `. '${bootScript}'; $r = Read-DataLocationChoice '${uncCfgFile.replace(/'/g, "''")}'; if ($null -eq $r) { 'NULL' } else { $r }`,
      ],
      { encoding: 'utf8', env: policy.windowsPowerShellEnv() },
    ).trim()
    assert.equal(bootUncOut, 'NULL', 'boot-engine-task.ps1 Read-DataLocationChoice must reject UNC paths')

    const upgradeSrc = fs.readFileSync(path.resolve('tools/installer-upgrade.ps1'), 'utf8')
    const fnStart = upgradeSrc.indexOf('function Read-ConfiguredDataRoot')
    const fnEnd = upgradeSrc.indexOf('function Get-DescriptorDistrust')
    assert.ok(fnStart > 0 && fnEnd > fnStart)
    const extractedFns = upgradeSrc.slice(fnStart, fnEnd)
    const psHarnessFile = path.join(dir, 'test-installer-dataloc.ps1')
    const fakeRoaming = path.join(dir, 'PsRoaming')
    const fakeUd = path.join(fakeRoaming, 'Orgtree v2')
    fs.mkdirSync(fakeUd, { recursive: true })

    fs.writeFileSync(
      psHarnessFile,
      `
      $DataRoot = ''
      function Test-Blank([string]$s) { return [string]::IsNullOrWhiteSpace($s) }
      function Get-CanonicalPath([string]$p) { return [IO.Path]::GetFullPath($p).TrimEnd('\\') }
      function Test-TargetAlive([int]$id) { return $true }
      ${extractedFns}
      $env:ORGTREE_V2_DATA = ''
      $env:APPDATA = '${fakeRoaming.replace(/'/g, "''")}'
      Set-Content -LiteralPath '${path.join(fakeUd, 'data-location.json').replace(/'/g, "''")}' -Value '{"version":1,"dataRoot":"\\\\\\\\127.0.0.1\\\\share\\\\Data"}' -Encoding UTF8
      $uncRoot = Read-ConfiguredDataRoot '${fakeUd.replace(/'/g, "''")}'
      if ($null -ne $uncRoot) { throw "UNC was not rejected: $uncRoot" }

      # Recycled PID (created mismatch) must NOT throw!
      Set-Content -LiteralPath '${path.join(fakeUd, '.data-move-in-progress.json').replace(/'/g, "''")}' -Value ('{"version":1,"pid":' + $PID + ',"created":"1","startedAtMs":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}') -Encoding UTF8
      Assert-NoDataMoveInProgress

      # Expired startedAtMs must NOT throw!
      Set-Content -LiteralPath '${path.join(fakeUd, '.data-move-in-progress.json').replace(/'/g, "''")}' -Value ('{"version":1,"pid":' + $PID + ',"startedAtMs":1000}') -Encoding UTF8
      Assert-NoDataMoveInProgress

      Write-Output 'PS_OK'
      `,
      'utf8',
    )
    const psOut = execFileSync(
      policy.WINDOWS_POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-File', psHarnessFile],
      { encoding: 'utf8', env: policy.windowsPowerShellEnv() },
    ).trim()
    assert.equal(psOut, 'PS_OK')
  }
})

test('readDataLocationState returns paths immediately without walking directories, while measureDataLocationSizes deduplicates in-flight walks, caches per session, skips junctions, and supports preflight cancellation', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, userData, defaultData, forbidden, installDir } = makeSandbox()

  const customRoot = path.join(dir, 'LargeCustomRoot')
  fs.mkdirSync(customRoot, { recursive: true })
  fs.writeFileSync(path.join(customRoot, 'a.bin'), Buffer.alloc(4096, 1))
  fs.writeFileSync(path.join(defaultData, 'b.bin'), Buffer.alloc(8192, 2))

  await datalocation.writeDataLocationConfig(userData, {
    version: 1,
    dataRoot: customRoot,
    previousRoot: defaultData,
    movedAt: '2026-11-14T17:00:00Z',
  })

  // 1. Even if fs.promises.readdir and measureDirectory never resolve, readDataLocationState
  //    MUST return currentRoot/defaultRoot/previousRoot immediately with null byte counts.
  const origReaddir = fs.promises.readdir
  const blockedRoots = new Set([path.resolve(customRoot), path.resolve(defaultData)])
  let readdirWalkAttempts = 0
  fs.promises.readdir = async (targetDir, ...rest) => {
    if (blockedRoots.has(path.resolve(String(targetDir)))) {
      readdirWalkAttempts += 1
      return new Promise(() => {})
    }
    return origReaddir.call(fs.promises, targetDir, ...rest)
  }
  let stubMeasureAttempts = 0
  const freshCache =
    typeof datalocation.DataLocationSizeCache === 'function'
      ? new datalocation.DataLocationSizeCache()
      : undefined
  let timer = null
  try {
    const stateOrTimeout = await Promise.race([
      datalocation.readDataLocationState({
        currentRoot: customRoot,
        userData,
        envOverride: false,
        moving: false,
        forbiddenRoot: forbidden,
        installDirectory: installDir,
        sizeCache: freshCache,
        measureDirectory: () => {
          stubMeasureAttempts += 1
          return new Promise(() => {})
        },
      }),
      new Promise(resolve => {
        timer = setTimeout(() => resolve('TIMED_OUT'), 200)
      }),
    ])
    assert.notEqual(
      stateOrTimeout,
      'TIMED_OUT',
      'readDataLocationState blocked on a directory walk instead of returning paths immediately',
    )
    assert.equal(readdirWalkAttempts, 0, 'readDataLocationState must not call readdir on data roots')
    assert.equal(stubMeasureAttempts, 0, 'readDataLocationState must not invoke measureDirectory')
    assert.equal(stateOrTimeout.currentRoot, path.resolve(customRoot))
    assert.equal(stateOrTimeout.defaultRoot, path.resolve(defaultData))
    assert.equal(stateOrTimeout.previousRoot, customRoot === defaultData ? null : defaultData)
    assert.equal(stateOrTimeout.isCustom, true)
    assert.equal(stateOrTimeout.currentBytes, null)
    assert.equal(stateOrTimeout.previousBytes, null)
  } finally {
    if (timer) clearTimeout(timer)
    fs.promises.readdir = origReaddir
  }

  // 2. Separate background size measurement deduplicates concurrent walks (at most 1 in flight per root),
  //    caches results for the session, and invalidates deleted previous folders.
  assert.equal(typeof datalocation.DataLocationSizeCache, 'function')
  assert.equal(typeof datalocation.measureDataLocationSizes, 'function')
  const cache = new datalocation.DataLocationSizeCache()
  const walkCalls = []
  const resolvers = new Map()
  const controlledMeasurer = targetRoot => {
    const norm = path.resolve(targetRoot)
    walkCalls.push(norm)
    return new Promise(resolve => {
      resolvers.set(norm, resolve)
    })
  }

  const p1 = datalocation.measureDataLocationSizes({
    currentRoot: customRoot,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    sizeCache: cache,
    measureDirectory: controlledMeasurer,
  })
  const p2 = datalocation.measureDataLocationSizes({
    currentRoot: customRoot,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    sizeCache: cache,
    measureDirectory: controlledMeasurer,
  })

  // Flush microtasks so both calls reach sizeCache.measure.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    walkCalls.filter(r => r === path.resolve(customRoot)).length,
    1,
    'at most one directory walk may be in flight for currentRoot',
  )
  assert.equal(
    walkCalls.filter(r => r === path.resolve(defaultData)).length,
    1,
    'at most one directory walk may be in flight for previousRoot',
  )

  // State remains immediate (null bytes) while background walk is still running.
  const midState = await datalocation.readDataLocationState({
    currentRoot: customRoot,
    userData,
    envOverride: false,
    moving: false,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    sizeCache: cache,
  })
  assert.equal(midState.currentBytes, null)
  assert.equal(midState.previousBytes, null)

  resolvers.get(path.resolve(customRoot))({ totalBytes: 4096, totalFiles: 1 })
  resolvers.get(path.resolve(defaultData))({ totalBytes: 8192, totalFiles: 1 })
  const [m1, m2] = await Promise.all([p1, p2])
  assert.equal(m1.currentBytes, 4096)
  assert.equal(m1.previousBytes, 8192)
  assert.deepEqual(m2, m1)

  // Subsequent state & measure calls read the session cache with zero extra walks.
  const cachedState = await datalocation.readDataLocationState({
    currentRoot: customRoot,
    userData,
    envOverride: false,
    moving: false,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    sizeCache: cache,
  })
  assert.equal(cachedState.currentBytes, 4096)
  assert.equal(cachedState.previousBytes, 8192)
  const m3 = await datalocation.measureDataLocationSizes({
    currentRoot: customRoot,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    sizeCache: cache,
    measureDirectory: controlledMeasurer,
  })
  assert.equal(m3.currentBytes, 4096)
  assert.equal(walkCalls.length, 2, 'cached roots must not be re-walked in the same session')

  // Deleting previousRoot invalidates its session cache entry.
  const delPrev = await datalocation.deletePreviousDataLocationFolder({
    userData,
    currentRoot: customRoot,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    sizeCache: cache,
  })
  assert.equal(delPrev.ok, true, delPrev.error)
  assert.equal(cache.getCachedBytes(defaultData), null)

  // 3. Real measureDirectoryBytes skips NTFS junctions / symlinks and ephemerals, and supports AbortSignal + progress.
  const scanRoot = path.join(dir, 'ScanWithJunction')
  const extDir = path.join(dir, 'ExternalHugeTarget')
  fs.mkdirSync(path.join(scanRoot, 'nested'), { recursive: true })
  fs.mkdirSync(extDir, { recursive: true })
  fs.writeFileSync(path.join(scanRoot, 'nested', 'keep.dat'), Buffer.alloc(5000, 3))
  fs.writeFileSync(path.join(scanRoot, 'engine-attach.json'), '{"ephemeral":true}')
  fs.writeFileSync(path.join(extDir, 'outside.bin'), Buffer.alloc(100000, 9))
  const juncInside = path.join(scanRoot, 'nested', 'junction-out')
  if (windows) {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', juncInside, extDir], { stdio: 'ignore' })
  } else {
    fs.symlinkSync(extDir, juncInside, 'dir')
  }
  const realMeasured = await datalocation.measureDirectoryBytes(scanRoot)
  assert.equal(realMeasured.totalBytes, 5000, 'junction target and ephemerals must be excluded from byte count')
  assert.equal(realMeasured.totalFiles, 1)

  // 4. Preflight reports scan progress and aborts promptly when its AbortSignal cancels.
  const preflightCache = new datalocation.DataLocationSizeCache()
  const preflightAbort = new AbortController()
  const progressSeen = []
  const preflightTarget = path.join(dir, 'CancelablePreflightTarget')
  const pfPromise = datalocation.preflightDataLocation({
    pickedPath: preflightTarget,
    currentRoot: scanRoot,
    userData,
    forbiddenRoot: forbidden,
    installDirectory: installDir,
    trustCheck: async () => ({ ok: true, detail: 'trusted' }),
    sizeCache: preflightCache,
    signal: preflightAbort.signal,
    onScanProgress: info => {
      progressSeen.push(info)
      preflightAbort.abort()
    },
    measureDirectory: (_root, opts) =>
      new Promise((_resolve, reject) => {
        opts?.onProgress?.({ totalBytes: 1024 * 1024, totalFiles: 42 })
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  })
  const pfCancelled = await pfPromise
  assert.equal(pfCancelled.ok, false)
  assert.equal(pfCancelled.cancelled, true)
  assert.equal(progressSeen.length, 1)
  assert.equal(progressSeen[0].totalFiles, 42)

  // 5. Preload exposes measureDataLocationSizes and cancelDataLocationPreflight on orgtreeDesktop.
  const { build } = loadEsbuild()
  const preloadBuild = await build({
    entryPoints: ['apps/desktop/preload/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  let exposedBridge = null
  const invoked = []
  vm.runInNewContext(preloadBuild.outputFiles[0].text, {
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
          contextBridge: { exposeInMainWorld(_n, api) { exposedBridge = api } },
          ipcRenderer: {
            sendSync: () => ({ token: 'tok' }),
            invoke: async (ch, ...args) => { invoked.push([ch, args]); return { ok: true } },
            send() {},
            on() {},
            removeListener() {},
          },
        }
      }
      throw new Error(`Unexpected require: ${specifier}`)
    },
  })
  assert.equal(typeof exposedBridge?.measureDataLocationSizes, 'function')
  assert.equal(typeof exposedBridge?.cancelDataLocationPreflight, 'function')
  await exposedBridge.measureDataLocationSizes()
  assert.deepEqual(invoked.at(-1), ['desktop:data-location-measure', []])
  await exposedBridge.cancelDataLocationPreflight()
  assert.deepEqual(invoked.at(-1), ['desktop:data-location-preflight-cancel', []])
})

function queryCurrentWindowsSidForTest() {
  if (!windows) return null
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return execFileSync(
    ps,
    ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
}

const testCurrentSid = queryCurrentWindowsSidForTest()
const icaclsExe = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe') : ''

function makeDirectoryUnreadable(targetDir) {
  if (windows) {
    execFileSync(
      icaclsExe,
      [targetDir, '/inheritance:r', '/grant:r', `*${testCurrentSid}:(WDAC,RC)`],
      { stdio: 'ignore', windowsHide: true },
    )
  } else {
    fs.chmodSync(targetDir, 0o000)
  }
}

function restoreDirectoryReadable(targetDir) {
  if (!fs.existsSync(path.dirname(targetDir))) return
  if (windows) {
    try {
      execFileSync(
        icaclsExe,
        [targetDir, '/grant:r', `*${testCurrentSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'],
        { stdio: 'ignore', windowsHide: true },
      )
      execFileSync(icaclsExe, [targetDir, '/reset', '/T', '/C'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Directory may already have been deleted after unlocking.
    }
  } else {
    try { fs.chmodSync(targetDir, 0o700) } catch { /* already gone */ }
  }
}

test('unreadable entries: preflight lists all by path/count, Move without them skips them and verifies readable set, unlisted mid-copy EPERM rolls back, selective deletion keeps only undeletable entries and parents, and durable move log + report persist in userData', async t => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const okTrust = async () => ({ ok: true, detail: 'trusted' })
  const lockedDirs = new Set()
  const lockDir = p => {
    lockedDirs.add(p)
    makeDirectoryUnreadable(p)
    assert.throws(() => fs.readdirSync(p), /EPERM|EACCES/, `Expected ${p} to be unreadable`)
  }
  const unlockDir = p => {
    restoreDirectoryReadable(p)
    lockedDirs.delete(p)
  }
  t.after(() => {
    for (const p of [...lockedDirs]) {
      restoreDirectoryReadable(p)
    }
  })

  // --- Part 1: Preflight finds every unreadable entry, and re-probes cached unreadable entries ---
  const sb1 = makeSandbox()
  const pgDir1 = path.join(sb1.defaultData, 'pg', 'cluster', 'data')
  const activeAgentDir = path.join(sb1.defaultData, 'scratch', 'orgtree', 'active-agent')
  const astraSiblingDir = path.join(sb1.defaultData, 'scratch', 'orgtree', 'arch-review-astra', 'a2-review', 'temporary')
  const badDir1 = path.join(astraSiblingDir, 'orgtree-agent-halt-b498bmpa')
  const badDir2 = path.join(sb1.defaultData, 'scratch', 'orgtree', 'data-arch-astra', 'orgtree-migration-test-1')
  const badDir3 = path.join(sb1.defaultData, 'scratch', 'orgtree', 'foundation-review-astra', 'orgtree-migration-test-2')
  fs.mkdirSync(pgDir1, { recursive: true })
  fs.mkdirSync(activeAgentDir, { recursive: true })
  fs.mkdirSync(badDir1, { recursive: true })
  fs.mkdirSync(badDir2, { recursive: true })
  fs.mkdirSync(badDir3, { recursive: true })

  fs.writeFileSync(path.join(pgDir1, 'PG_VERSION'), '17\n')
  fs.writeFileSync(path.join(activeAgentDir, 'notes.md'), 'readable-notes-12345')
  fs.writeFileSync(path.join(astraSiblingDir, 'keep-sibling.txt'), 'readable-sibling')
  fs.writeFileSync(path.join(badDir1, 'secret-1.txt'), 'stays-behind-1')
  fs.writeFileSync(path.join(badDir2, 'unlocked-later.txt'), 'ten-bytes!')
  fs.writeFileSync(path.join(badDir3, 'secret-3.txt'), 'stays-behind-3')

  lockDir(badDir1)
  lockDir(badDir2)
  lockDir(badDir3)

  const measured1 = await datalocation.measureDirectoryBytes(sb1.defaultData)
  assert.ok(Array.isArray(measured1.unreadableEntries), 'measureDirectoryBytes must return unreadableEntries')
  assert.equal(measured1.unreadableEntries.length, 3, 'all 3 unreadable directories must be reported')
  assert.deepEqual(
    measured1.unreadableEntries.map(e => path.resolve(e.path)).sort(),
    [badDir1, badDir2, badDir3].map(p => path.resolve(p)).sort(),
  )

  const cache1 = new datalocation.DataLocationSizeCache()
  const target1 = path.join(sb1.dir, 'TargetMove1')
  const pf1 = await datalocation.preflightDataLocation({
    pickedPath: target1,
    currentRoot: sb1.defaultData,
    userData: sb1.userData,
    forbiddenRoot: sb1.forbidden,
    installDirectory: sb1.installDir,
    trustCheck: okTrust,
    sizeCache: cache1,
  })
  assert.equal(pf1.ok, true, pf1.error)
  assert.equal(pf1.unreadableEntries?.length, 3)

  // Unlocking badDir2 updates preflight via cached unreadable re-probe without stale unreadable list.
  unlockDir(badDir2)
  const pf1AfterUnlock = await datalocation.preflightDataLocation({
    pickedPath: target1,
    currentRoot: sb1.defaultData,
    userData: sb1.userData,
    forbiddenRoot: sb1.forbidden,
    installDirectory: sb1.installDir,
    trustCheck: okTrust,
    sizeCache: cache1,
  })
  assert.equal(pf1AfterUnlock.ok, true, pf1AfterUnlock.error)
  assert.equal(pf1AfterUnlock.unreadableEntries?.length, 2)
  assert.equal(pf1AfterUnlock.sourceBytes, pf1.sourceBytes + 10)

  // --- Part 2: Refuses without skipUnreadablePaths; succeeds with "Move without them" (skipUnreadablePaths) ---
  let stoppedWithoutApproval = 0
  const unapprovedMove = await datalocation.executeDataLocationMove({
    options: { targetPath: target1, deletePrevious: false },
    currentRoot: sb1.defaultData,
    userData: sb1.userData,
    forbiddenRoot: sb1.forbidden,
    installDirectory: sb1.installDir,
    trustCheck: okTrust,
    stopOldEngine: async () => { stoppedWithoutApproval += 1; return true },
    startAndVerifyNewEngine: async () => {},
    restartOldEngineOnRollback: async () => {},
  })
  assert.equal(unapprovedMove.ok, false, 'Move must refuse when unreadableEntries were not approved in skipUnreadablePaths')
  assert.equal(stoppedWithoutApproval, 0, 'Engine must NOT stop when unreadableEntries were not approved')

  const approvedSkipPaths = pf1AfterUnlock.unreadableEntries.map(e => e.path)
  const approvedMove = await datalocation.executeDataLocationMove({
    options: {
      targetPath: target1,
      deletePrevious: false,
      skipUnreadablePaths: approvedSkipPaths,
    },
    currentRoot: sb1.defaultData,
    userData: sb1.userData,
    forbiddenRoot: sb1.forbidden,
    installDirectory: sb1.installDir,
    trustCheck: okTrust,
    stopOldEngine: async () => true,
    startAndVerifyNewEngine: async newRoot => {
      try { fs.unlinkSync(path.join(newRoot, datalocation.DATA_LOCATION_MOVED_STAMP)) } catch { /* ok */ }
    },
    restartOldEngineOnRollback: async () => {
      throw new Error('Rollback should not run on approved skip move')
    },
  })
  assert.equal(approvedMove.ok, true, approvedMove.error)
  assert.equal(approvedMove.relaunching, true)

  // Readable files + unlocked badDir2 were copied and verified; skipped badDir1 & badDir3 have NOTHING partial in target1.
  assert.equal(fs.readFileSync(path.join(target1, 'pg', 'cluster', 'data', 'PG_VERSION'), 'utf8'), '17\n')
  assert.equal(fs.readFileSync(path.join(target1, 'scratch', 'orgtree', 'active-agent', 'notes.md'), 'utf8'), 'readable-notes-12345')
  assert.equal(
    fs.readFileSync(path.join(target1, 'scratch', 'orgtree', 'arch-review-astra', 'a2-review', 'temporary', 'keep-sibling.txt'), 'utf8'),
    'readable-sibling',
  )
  assert.equal(
    fs.readFileSync(path.join(target1, 'scratch', 'orgtree', 'data-arch-astra', 'orgtree-migration-test-1', 'unlocked-later.txt'), 'utf8'),
    'ten-bytes!',
  )
  assert.equal(
    fs.existsSync(path.join(target1, 'scratch', 'orgtree', 'arch-review-astra', 'a2-review', 'temporary', 'orgtree-agent-halt-b498bmpa')),
    false,
    'Skipped unreadable directory must NOT exist (even empty) in destination',
  )
  assert.equal(
    fs.existsSync(path.join(target1, 'scratch', 'orgtree', 'foundation-review-astra', 'orgtree-migration-test-2')),
    false,
    'Second skipped unreadable directory must NOT exist in destination',
  )

  // Durable move log in <userData>/data-location-move.log + one-shot restart notice + persistent state report.
  assert.equal(typeof datalocation.DATA_MOVE_LOG_FILE, 'string')
  const logPath1 = path.join(sb1.userData, datalocation.DATA_MOVE_LOG_FILE)
  assert.equal(fs.existsSync(logPath1), true, 'Durable move log must exist in userData')
  const logText1 = fs.readFileSync(logPath1, 'utf8')
  assert.ok(logText1.includes(badDir1), 'Move log must name skipped directory 1')
  assert.ok(logText1.includes(badDir3), 'Move log must name skipped directory 3')

  const noticeOnce = datalocation.consumePendingMoveRestartNotice(sb1.userData, target1)
  assert.ok(noticeOnce, 'consumePendingMoveRestartNotice must return the post-restart report once')
  assert.equal(noticeOnce.skippedEntries.length, 2)
  assert.equal(datalocation.consumePendingMoveRestartNotice(sb1.userData, target1), null, 'Second call must return null')

  const postMoveState1 = await datalocation.readDataLocationState({
    currentRoot: target1,
    userData: sb1.userData,
    envOverride: false,
    moving: false,
    forbiddenRoot: sb1.forbidden,
    installDirectory: sb1.installDir,
  })
  assert.equal(postMoveState1.moveLogExists, true)
  assert.ok(postMoveState1.lastMoveReport, 'readDataLocationState must expose lastMoveReport while fromRoot exists')
  assert.equal(postMoveState1.lastMoveReport.skippedEntries.length, 2)
  assert.ok(
    fs.statSync(path.join(sb1.userData, 'data-location.json')).size < 4096,
    'data-location.json must remain tiny (< 16 KiB engine/policy cap)',
  )

  // --- Part 3: Entry becoming unreadable MID-COPY (not listed in skipUnreadablePaths) MUST fail & roll back ---
  const sb2 = makeSandbox()
  const midApproved = path.join(sb2.defaultData, 'scratch', 'approved-skip')
  const midSurprise = path.join(sb2.defaultData, 'scratch', 'surprise-midcopy-unreadable')
  fs.mkdirSync(midApproved, { recursive: true })
  fs.mkdirSync(midSurprise, { recursive: true })
  fs.writeFileSync(path.join(sb2.defaultData, 'keep.txt'), 'keep')
  fs.writeFileSync(path.join(midSurprise, 'file.txt'), 'surprise')
  lockDir(midApproved)

  const target2 = path.join(sb2.dir, 'TargetMove2')
  const pf2 = await datalocation.preflightDataLocation({
    pickedPath: target2,
    currentRoot: sb2.defaultData,
    userData: sb2.userData,
    forbiddenRoot: sb2.forbidden,
    installDirectory: sb2.installDir,
    trustCheck: okTrust,
  })
  assert.equal(pf2.ok, true)
  assert.equal(pf2.unreadableEntries?.length, 1)

  let rolledBack2 = 0
  const midFailMove = await datalocation.executeDataLocationMove({
    options: {
      targetPath: target2,
      deletePrevious: false,
      skipUnreadablePaths: [midApproved],
    },
    currentRoot: sb2.defaultData,
    userData: sb2.userData,
    forbiddenRoot: sb2.forbidden,
    installDirectory: sb2.installDir,
    trustCheck: okTrust,
    prevalidatedPreflight: pf2,
    stopOldEngine: async () => {
      // Becomes unreadable AFTER preflight, right before copy!
      lockDir(midSurprise)
      return true
    },
    startAndVerifyNewEngine: async () => {
      throw new Error('Should never start new engine when unlisted entry fails mid-copy')
    },
    restartOldEngineOnRollback: async () => {
      rolledBack2 += 1
    },
  })
  assert.equal(midFailMove.ok, false, 'Unlisted mid-copy unreadable entry must still fail the move')
  assert.equal(rolledBack2, 1, 'Rollback must restart old engine')
  assert.equal(fs.existsSync(target2), false, 'Partial destination must be cleaned on rollback')
  assert.equal(fs.existsSync(path.join(sb2.userData, 'data-location.json')), false)
  const logText2 = fs.readFileSync(path.join(sb2.userData, datalocation.DATA_MOVE_LOG_FILE), 'utf8')
  assert.match(logText2, /rollback/i, 'Move log must record rollback on mid-copy failure')

  // --- Part 4: Selective old-folder deletion (both post-move deletePrevious:true AND Delete previous folder button) ---
  const sb3 = makeSandbox()
  const pgDir3 = path.join(sb3.defaultData, 'pg', 'cluster', 'data')
  const cleanDir3 = path.join(sb3.defaultData, 'orgs', 'clean-org')
  const parentA = path.join(sb3.defaultData, 'scratch', 'orgtree', 'arch-review-astra', 'temp')
  const skipNonEmpty = path.join(parentA, 'unreadable-with-file')
  const parentB = path.join(sb3.defaultData, 'scratch', 'orgtree', 'foundation-review-astra')
  const skipEmptyDir = path.join(parentB, 'unreadable-empty-dir')
  fs.mkdirSync(pgDir3, { recursive: true })
  fs.mkdirSync(cleanDir3, { recursive: true })
  fs.mkdirSync(skipNonEmpty, { recursive: true })
  fs.mkdirSync(skipEmptyDir, { recursive: true })

  fs.writeFileSync(path.join(pgDir3, 'PG_VERSION'), '17\n')
  fs.writeFileSync(path.join(cleanDir3, 'state.json'), '{"ok":true}')
  fs.writeFileSync(path.join(parentA, 'deletable-sibling.txt'), 'delete-me')
  fs.writeFileSync(path.join(skipNonEmpty, 'kept.txt'), 'never-lost')

  lockDir(skipNonEmpty)
  lockDir(skipEmptyDir) // Even an empty unreadable folder must NOT be removed via parent FILE_DELETE_CHILD!

  const target3 = path.join(sb3.dir, 'TargetMove3')
  const moveWithDelete = await datalocation.executeDataLocationMove({
    options: {
      targetPath: target3,
      deletePrevious: true,
      skipUnreadablePaths: [skipNonEmpty, skipEmptyDir],
    },
    currentRoot: sb3.defaultData,
    userData: sb3.userData,
    forbiddenRoot: sb3.forbidden,
    installDirectory: sb3.installDir,
    trustCheck: okTrust,
    stopOldEngine: async () => true,
    startAndVerifyNewEngine: async newRoot => {
      try { fs.unlinkSync(path.join(newRoot, datalocation.DATA_LOCATION_MOVED_STAMP)) } catch { /* ok */ }
    },
    restartOldEngineOnRollback: async () => {},
  })
  assert.equal(moveWithDelete.ok, true, moveWithDelete.error)

  // Everything readable in sb3.defaultData was deleted, while skipNonEmpty, skipEmptyDir, and their parent folders stayed!
  assert.equal(fs.existsSync(path.join(sb3.defaultData, 'pg')), false, 'pg tree deleted from old folder')
  assert.equal(fs.existsSync(path.join(sb3.defaultData, 'orgs')), false, 'orgs tree deleted from old folder')
  assert.equal(fs.existsSync(path.join(parentA, 'deletable-sibling.txt')), false, 'readable sibling deleted from parent folder')
  assert.equal(fs.existsSync(parentA), true, 'parent folder holding skipNonEmpty stayed')
  assert.equal(fs.existsSync(parentB), true, 'parent folder holding skipEmptyDir stayed')

  const postMoveState3 = await datalocation.readDataLocationState({
    currentRoot: target3,
    userData: sb3.userData,
    envOverride: false,
    moving: false,
    forbiddenRoot: sb3.forbidden,
    installDirectory: sb3.installDir,
  })
  assert.equal(
    path.resolve(postMoveState3.previousRoot),
    path.resolve(sb3.defaultData),
    'previousRoot must remain recorded while undeleted skipped folders stay in oldRoot',
  )
  assert.equal(postMoveState3.lastMoveReport?.oldFolderDeleted, false)
  assert.deepEqual(
    postMoveState3.lastMoveReport?.remainingPaths.map(p => path.resolve(p)).sort(),
    [skipNonEmpty, skipEmptyDir].map(p => path.resolve(p)).sort(),
  )

  // Unlock skipNonEmpty, keep skipEmptyDir unreadable, then run Delete previous folder button:
  unlockDir(skipNonEmpty)
  assert.equal(fs.readFileSync(path.join(skipNonEmpty, 'kept.txt'), 'utf8'), 'never-lost')

  const partialBtnDel = await datalocation.deletePreviousDataLocationFolder({
    userData: sb3.userData,
    currentRoot: target3,
    forbiddenRoot: sb3.forbidden,
    installDirectory: sb3.installDir,
  })
  assert.equal(partialBtnDel.ok, true, partialBtnDel.error)
  assert.equal(partialBtnDel.deletedAll, false)
  assert.deepEqual(
    partialBtnDel.remainingPaths.map(p => path.resolve(p)),
    [path.resolve(skipEmptyDir)],
    'Delete previous folder must delete unlocked skipNonEmpty + its parent branch while keeping still-unreadable skipEmptyDir',
  )
  assert.equal(fs.existsSync(parentA), false, 'now-empty parentA branch removed')
  assert.equal(fs.existsSync(parentB), true, 'parentB holding skipEmptyDir still present')

  // Unlock skipEmptyDir and click Delete previous folder one final time -> deletes everything cleanly!
  unlockDir(skipEmptyDir)
  assert.equal(fs.existsSync(skipEmptyDir), true, 'skipEmptyDir survived until unlocked')
  const fullBtnDel = await datalocation.deletePreviousDataLocationFolder({
    userData: sb3.userData,
    currentRoot: target3,
    forbiddenRoot: sb3.forbidden,
    installDirectory: sb3.installDir,
  })
  assert.equal(fullBtnDel.ok, true, fullBtnDel.error)
  assert.equal(fullBtnDel.deletedAll, true)
  assert.deepEqual(fullBtnDel.remainingPaths, [])
  assert.equal(fs.existsSync(sb3.defaultData), false, 'old folder completely deleted once last unreadable folder unlocked')

  const finalState3 = await datalocation.readDataLocationState({
    currentRoot: target3,
    userData: sb3.userData,
    envOverride: false,
    moving: false,
    forbiddenRoot: sb3.forbidden,
    installDirectory: sb3.installDir,
  })
  assert.equal(finalState3.previousRoot, null)
  assert.equal(finalState3.lastMoveReport ?? null, null)

  // --- Part 5: Preload bridge exposes openDataLocationMoveLog and takeDataLocationMoveResult and forwards skipUnreadablePaths ---
  const { build } = loadEsbuild()
  const preloadBuild = await build({
    entryPoints: ['apps/desktop/preload/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  let exposedBridge = null
  const invoked = []
  vm.runInNewContext(preloadBuild.outputFiles[0].text, {
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
          contextBridge: { exposeInMainWorld(_n, api) { exposedBridge = api } },
          ipcRenderer: {
            sendSync: () => ({ token: 'tok' }),
            invoke: async (ch, ...args) => { invoked.push([ch, args]); return { ok: true } },
            send() {},
            on() {},
            removeListener() {},
          },
        }
      }
      throw new Error(`Unexpected require: ${specifier}`)
    },
  })
  assert.equal(typeof exposedBridge?.openDataLocationMoveLog, 'function')
  assert.equal(typeof exposedBridge?.takeDataLocationMoveResult, 'function')
  await exposedBridge.openDataLocationMoveLog()
  assert.deepEqual(invoked.at(-1), ['desktop:data-location-open-log', []])
  await exposedBridge.takeDataLocationMoveResult()
  assert.deepEqual(invoked.at(-1), ['desktop:data-location-take-result', []])
  await exposedBridge.moveDataLocation({
    targetPath: 'D:\\Orgtree data',
    deletePrevious: true,
    skipUnreadablePaths: ['C:\\Old\\unreadable-1'],
  })
  assert.deepEqual(invoked.at(-1), [
    'desktop:data-location-move',
    [{ targetPath: 'D:\\Orgtree data', deletePrevious: true, skipUnreadablePaths: ['C:\\Old\\unreadable-1'] }],
  ])
})

// R6 (4.6.0-alpha.5): a 243 GB move copied for five hours, then failed verification with
// "size mismatch for credential-broker.log (expected 123641, got 123863)". The sign-in helper
// was still writing into the old folder. The move must wait for every writer of the old folder to
// exit before it scans, recopy a file that still changed during the bulk copy, keep verifying
// every file strictly, and keep its marker alive past six hours.
test('R6: a move waits for the old folder\'s writers, recopies files that changed during the copy, verifies strictly, and keeps its marker alive past six hours', async () => {
  const { policy, datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const okTrust = async () => ({ ok: true, detail: 'trusted' })

  // 1. A straggler write after the bulk copy measured the file is recopied, never fatal; the
  //    writers' exit is awaited before anything is copied, and the move log names the recopy.
  {
    const { dir, userData, defaultData, forbidden } = makeSandbox()
    fs.mkdirSync(path.join(defaultData, 'pg', 'cluster', 'data'), { recursive: true })
    fs.writeFileSync(path.join(defaultData, 'pg', 'cluster', 'data', 'PG_VERSION'), '18\n')
    const brokerLog = path.join(defaultData, 'credential-broker.log')
    fs.writeFileSync(brokerLog, 'x'.repeat(123641))
    const target = path.join(dir, 'R6Target')
    const order = []
    let straggled = false
    const res = await datalocation.executeDataLocationMove({
      options: { targetPath: target, deletePrevious: false },
      currentRoot: defaultData,
      userData,
      forbiddenRoot: forbidden,
      trustCheck: okTrust,
      onProgress: p => {
        if (p.phase === 'copying' && !straggled && p.totalFiles > 0) {
          straggled = true
          order.push('straggler')
          // The alpha.5 broker's three exit lines: +222 bytes after the scan measured the file.
          fs.appendFileSync(brokerLog, 'y'.repeat(222))
        }
      },
      stopOldEngine: async () => { order.push('stop'); return true },
      waitForWritersToExit: async oldRoot => {
        assert.equal(path.resolve(oldRoot), path.resolve(defaultData))
        assert.equal(fs.existsSync(target), false, 'nothing is copied before the writers exited')
        order.push('writers')
        return 'all writers exited after 0 ms'
      },
      startAndVerifyNewEngine: async () => { order.push('start') },
      restartOldEngineOnRollback: async () => { order.push('rollback') },
    })
    assert.equal(res.ok, true, `move succeeds after recopying the straggler: ${res.error ?? ''}`)
    assert.deepEqual(order, ['stop', 'writers', 'straggler', 'start'])
    assert.equal(fs.statSync(path.join(target, 'credential-broker.log')).size, 123863)
    const log = fs.readFileSync(path.join(userData, 'data-location-move.log'), 'utf8')
    assert.match(log, /writers stopped/)
    assert.match(log, /recopied changed files/)
    assert.match(log, /recopied credential-broker\.log/)
  }

  // 2. A writer that never stops no longer fails the move (R7, USER m15f87ac2b667): after the
  //    bounded catch-up passes its latest bytes are copied once more and it is named;
  //    a target file damaged while its source stayed unchanged still fails strict verification.
  {
    const { dir, defaultData } = makeSandbox()
    const rogue = path.join(defaultData, 'credential-broker.log')
    fs.writeFileSync(rogue, 'start\n')
    fs.writeFileSync(path.join(defaultData, 'steady.txt'), 'steady\n')
    let passes = 0
    const rogueTarget = path.join(dir, 'RogueTarget')
    const kept = await datalocation.copyDataRootWithVerify(defaultData, rogueTarget, {
      beforeRescan: () => { passes += 1; fs.appendFileSync(rogue, `line ${passes}\n`) },
    })
    assert.equal(passes, datalocation.MAX_RECOPY_PASSES)
    assert.deepEqual(kept.changedDuringMove, ['credential-broker.log'])
    assert.equal(fs.readFileSync(path.join(rogueTarget, 'credential-broker.log'), 'utf8'), fs.readFileSync(rogue, 'utf8'))

    const damagedTarget = path.join(dir, 'DamagedTarget')
    await assert.rejects(
      datalocation.copyDataRootWithVerify(defaultData, damagedTarget, {
        beforeRescan: () => { fs.writeFileSync(path.join(damagedTarget, 'steady.txt'), 'x') },
      }),
      /size mismatch for steady\.txt/,
      'no log or other file is waived: a damaged copy of an unchanged file fails',
    )
  }

  // 3. The writers' wait judges the engine's quiesce answer and gives up with names.
  {
    let calls = 0
    const quiet = await datalocation.waitForDataRootWritersToExit({
      probe: async () => (++calls < 3 ? { quiet: false, members: [{ role: 'broker', life: 'alive' }] } : { quiet: true, members: [] }),
      sleep: async () => {},
    })
    assert.equal(calls, 3)
    assert.match(quiet, /all writers exited/)
    let clock = 0
    await assert.rejects(
      datalocation.waitForDataRootWritersToExit({
        probe: async () => ({ quiet: false, members: [{ role: 'broker', life: 'alive' }, { role: 'watcher', life: 'unknown' }] }),
        timeoutMs: 60000,
        now: () => clock,
        sleep: async ms => { clock += ms },
      }),
      /did not stop within 60 s: broker \(alive\), watcher \(unknown\)/,
    )
    await assert.rejects(
      datalocation.waitForDataRootWritersToExit({
        probe: async () => { throw new Error('no binary') },
        timeoutMs: 1000,
        now: () => clock,
        sleep: async ms => { clock += ms },
      }),
      /could not confirm that its other processes stopped/,
      'an unanswered probe is never taken as quiet',
    )
  }

  // 4. The move marker stays active past six hours while its desktop keeps beating.
  {
    const { dir, userData, defaultData } = makeSandbox()
    datalocation.writeMoveInProgressMarker(userData, defaultData, path.join(dir, 'LongMove'))
    const markerFile = path.join(userData, '.data-move-in-progress.json')
    const doc = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.equal(typeof doc.heartbeatAtMs, 'number')
    const later = doc.startedAtMs + 7 * 3600 * 1000
    assert.equal(datalocation.hasActiveMoveInProgressMarker(userData, later), false, 'no heartbeat for 7 h: stale')
    assert.equal(datalocation.refreshMoveInProgressMarker(userData, later - 60 * 1000), true)
    assert.equal(datalocation.hasActiveMoveInProgressMarker(userData, later), true, 'a recent heartbeat keeps a 7-hour move guarded')
    const refreshed = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.equal(refreshed.startedAtMs, doc.startedAtMs, 'the start stays recorded')

    if (windows) {
      const upgradeSrc = fs.readFileSync(path.resolve('tools/installer-upgrade.ps1'), 'utf8')
      const fnStart = upgradeSrc.indexOf('function Assert-NoDataMoveInProgress')
      const fnEnd = upgradeSrc.indexOf('function Get-EngineDataRoot')
      assert.ok(fnStart > 0 && fnEnd > fnStart)
      const fakeRoaming = path.join(dir, 'PsRoamingR6')
      const fakeUd = path.join(fakeRoaming, 'Orgtree v2')
      fs.mkdirSync(fakeUd, { recursive: true })
      const harness = path.join(dir, 'test-installer-heartbeat.ps1')
      const marker = path.join(fakeUd, '.data-move-in-progress.json').replace(/'/g, "''")
      fs.writeFileSync(
        harness,
        `
        $DataRoot = ''
        function Test-Blank([string]$s) { return [string]::IsNullOrWhiteSpace($s) }
        function Test-TargetAlive([int]$id) { return $true }
        ${upgradeSrc.slice(fnStart, fnEnd)}
        $env:ORGTREE_V2_DATA = ''
        $env:APPDATA = '${fakeRoaming.replace(/'/g, "''")}'
        Set-Content -LiteralPath '${marker}' -Value ('{"version":1,"pid":' + $PID + ',"startedAtMs":1000,"heartbeatAtMs":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}') -Encoding UTF8
        $guarded = $false
        try { Assert-NoDataMoveInProgress } catch { $guarded = $true }
        if (-not $guarded) { throw 'a beating 7-hour move was not guarded' }
        Set-Content -LiteralPath '${marker}' -Value ('{"version":1,"pid":' + $PID + ',"startedAtMs":1000,"heartbeatAtMs":2000}') -Encoding UTF8
        Assert-NoDataMoveInProgress
        Write-Output 'PS_OK'
        `,
        'utf8',
      )
      const out = execFileSync(policy.WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', harness], {
        encoding: 'utf8',
        env: policy.windowsPowerShellEnv(),
      }).trim()
      assert.equal(out, 'PS_OK')
    }
  }

  // 5. Main wires it: the native quiesce probe before the copy, no diagnostics into the old folder
  //    while the move runs, and the sign-in helper's task restarted after success and rollback.
  const indexSrc = fs.readFileSync(path.resolve('apps/desktop/main/index.ts'), 'utf8')
  assert.match(indexSrc, /waitForWritersToExit: async oldRoot =>/)
  assert.match(indexSrc, /\['core-control', 'quiesce', oldRoot\]/)
  assert.match(indexSrc, /new WindowEventLog\(\(\) =>\s*engineRestartOptions\?\.dataRoot && !dataMoveInFlight/)
  assert.match(indexSrc, /file: \(\) => engineRestartOptions\?\.dataRoot && !dataMoveInFlight \? path\.join\(engineRestartOptions\.dataRoot, STALL_LOG\)/)
  assert.match(indexSrc, /if \(!dataMoveInFlight\) recordCoreControlFailure\(engineOptions\.dataRoot, failure\)/)
  assert.equal((indexSrc.match(/await startHelperTask\(\)/g) ?? []).length, 2, 'helper restarted after success and after rollback')
  const startupSrc = fs.readFileSync(path.resolve('apps/desktop/main/runonstartup.ts'), 'utf8')
  assert.match(startupSrc, /export function startHelperTask\([^)]*\): Promise<void> \{\s*return startTask\(target\.helper, runner\)/)
})

// R6-R2 (@idle-limit-sol review of 32249b2): a file that left the source during the copy must
// also leave the new folder. A target delete that fails (here a read-only copy, EPERM on Windows)
// was swallowed and the move succeeded with the obsolete file in place.
test('R6-R2: a file that left the source during the copy is removed from the new folder, or the copy fails', async () => {
  const { policy, datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, defaultData } = makeSandbox()
  fs.writeFileSync(path.join(defaultData, 'keep.txt'), 'keep\n')

  // A vanished file is removed from the target and the copy settles.
  const leaving = path.join(defaultData, 'leaving.txt')
  fs.writeFileSync(leaving, 'temporary\n')
  const okTarget = path.join(dir, 'VanishTarget')
  const ok = await datalocation.copyDataRootWithVerify(defaultData, okTarget, {
    beforeRescan: pass => { if (pass === 1) fs.rmSync(leaving) },
  })
  assert.equal(fs.existsSync(path.join(okTarget, 'leaving.txt')), false)
  assert.equal(fs.existsSync(path.join(okTarget, 'keep.txt')), true)
  assert.equal(ok.filesCopied, 2)

  // A copy that cannot be removed fails the copy instead of leaving an obsolete file behind.
  // Windows: a child of this test holds the copy open without sharing (Node's own unlink clears
  // a read-only attribute, so that is no obstacle); elsewhere the folder is made read-only.
  fs.writeFileSync(leaving, 'temporary\n')
  const stuckTarget = path.join(dir, 'StuckTarget')
  const stuck = path.join(stuckTarget, 'leaving.txt')
  let holder = null
  const release = async () => {
    if (!holder) return
    const exited = new Promise(resolve => holder.once('exit', resolve))
    holder.stdin.end()
    await exited
    holder = null
  }
  try {
    await assert.rejects(
      datalocation.copyDataRootWithVerify(defaultData, stuckTarget, {
        beforeRescan: async pass => {
          if (pass !== 1) return
          fs.rmSync(leaving)
          if (!windows) { fs.chmodSync(stuckTarget, 0o555); return }
          const quoted = stuck.replace(/'/g, "''")
          holder = spawn(
            policy.WINDOWS_POWERSHELL,
            ['-NoProfile', '-NonInteractive', '-Command',
              `$f = [IO.File]::Open('${quoted}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()`],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: policy.windowsPowerShellEnv() },
          )
          await new Promise((resolve, reject) => {
            let out = ''
            holder.stdout.on('data', chunk => { out += chunk; if (out.includes('HELD')) resolve() })
            holder.once('exit', code => reject(new Error(`file holder exited early (${code})`)))
          })
        },
      }),
      /could not remove leaving\.txt from the new folder/,
    )
  } finally {
    await release()
    try { fs.chmodSync(stuckTarget, 0o755) } catch { /* best effort */ }
  }
})

// R7 (USER 2026-11-15 15:04:06Z m15f87ac2b667 "how about you dont revert the ENTIRE DAMN 5 HOUR MOVE
// if ONE FILE CHANGES"): the alpha.6 move rolled back after 5 h because a foreign process (the
// stream bridge) rewrote stream-manager/stats.json every 30 s. A completed bulk copy is never
// thrown away for files that keep changing: their latest bytes are copied at switch time and they
// are named. Catch-up passes look only at what a watcher saw change, not a full rescan.
test('R7: files that never stop changing are copied at their latest version and named, real copy errors still roll back, and a pre-check lists changing files', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const okTrust = async () => ({ ok: true, detail: 'trusted' })
  const startWriter = (file, everyMs = 40) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let n = 0
    fs.writeFileSync(file, JSON.stringify({ n }))
    const timer = setInterval(() => { n += 1; fs.writeFileSync(file, JSON.stringify({ n, pad: 'x'.repeat(n % 7) })) }, everyMs)
    return () => clearInterval(timer)
  }

  // 1. A whole move completes while a foreign writer never stops; result report and move log name it.
  {
    const { dir, userData, defaultData, forbidden } = makeSandbox()
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(defaultData, `steady-${i}.txt`), `steady ${i}\n`)
    const stats = path.join(defaultData, 'scratch', 'orgtree', 'stream-manager', 'stats.json')
    const stop = startWriter(stats)
    const target = path.join(dir, 'R7Target')
    const steps = []
    const passModes = []
    let res
    try {
      res = await datalocation.executeDataLocationMove({
        options: { targetPath: target, deletePrevious: false },
        currentRoot: defaultData,
        userData,
        forbiddenRoot: forbidden,
        trustCheck: okTrust,
        onProgress: p => { if (p.phase === 'verifying' && p.stepLabel) steps.push(p) },
        onCatchUpPass: (pass, mode) => { passModes.push(mode) },
        stopOldEngine: async () => true,
        startAndVerifyNewEngine: async () => {},
        restartOldEngineOnRollback: async () => { throw new Error('must not roll back') },
      })
    } finally {
      stop()
    }
    assert.equal(res.ok, true, `the move completes although stats.json kept changing: ${res.error ?? ''}`)
    assert.equal(fs.readFileSync(path.join(target, 'steady-7.txt'), 'utf8'), 'steady 7\n')
    JSON.parse(fs.readFileSync(path.join(target, 'scratch', 'orgtree', 'stream-manager', 'stats.json'), 'utf8'))
    const report = datalocation.readDataLocationMoveReport(userData)
    assert.ok(report, 'a move with changing files leaves a result report')
    assert.deepEqual(report.changedDuringMove, ['scratch/orgtree/stream-manager/stats.json'])
    assert.equal(report.pendingRestartNotice, true)
    const log = fs.readFileSync(path.join(userData, 'data-location-move.log'), 'utf8')
    assert.match(log, /changed during the move; latest version copied/)
    assert.match(log, /scratch\/orgtree\/stream-manager\/stats\.json/)
    assert.doesNotMatch(log, /rollback complete/)
    // Catch-up passes use the watcher, never a full rescan, while the watcher works.
    assert.ok(passModes.length > 0 && passModes.every(m => m === 'watch'), `catch-up modes: ${passModes.join(',')}`)
    // Each post-copy step reports simple {stepLabel, stepDone, stepTotal} and ends done == total.
    const labels = [...new Set(steps.map(p => p.stepLabel))]
    assert.ok(labels.includes('Checking for changes') && labels.includes('Verifying copied files'), labels.join(', '))
    for (const label of labels) {
      const last = steps.filter(p => p.stepLabel === label).at(-1)
      assert.equal(last.stepDone, last.stepTotal, `${label} ends done == total`)
    }
  }

  // 2. A real copy error during the final copy still fails the copy (and so rolls back).
  {
    const { dir, defaultData } = makeSandbox()
    const rogue = path.join(defaultData, 'busy.log')
    fs.writeFileSync(rogue, 'start\n')
    const target = path.join(dir, 'R7ErrTarget')
    await assert.rejects(
      datalocation.copyDataRootWithVerify(defaultData, target, {
        beforeRescan: pass => {
          fs.appendFileSync(rogue, `line ${pass}\n`)
          if (pass === datalocation.MAX_RECOPY_PASSES) {
            // The new folder's copy turns into something that cannot be written: a real error.
            fs.rmSync(path.join(target, 'busy.log'))
            fs.mkdirSync(path.join(target, 'busy.log', 'blocker'), { recursive: true })
          }
        },
      }),
      err => !/kept changing/.test(String(err?.message)),
    )
  }

  // 3. The pre-check watches the quiet source briefly and lists files still changing (never the
  //    runtime ephemerals); the move asks, and Cancel stops it before anything is copied.
  {
    const { dir, userData, defaultData, forbidden } = makeSandbox()
    fs.writeFileSync(path.join(defaultData, 'steady.txt'), 'steady\n')
    const stats = path.join(defaultData, 'stream-manager', 'stats.json')
    const stop = startWriter(stats)
    const stopPort = startWriter(path.join(defaultData, '.port'))
    try {
      const changing = await datalocation.watchSourceForChanges(defaultData, { durationMs: 600 })
      assert.deepEqual(changing, ['stream-manager/stats.json'])

      const target = path.join(dir, 'R7PrecheckTarget')
      let asked = null
      let restarted = false
      const precheck = []
      const cancelled = await datalocation.executeDataLocationMove({
        options: { targetPath: target, deletePrevious: false },
        currentRoot: defaultData,
        userData,
        forbiddenRoot: forbidden,
        trustCheck: okTrust,
        changeWatchMs: 600,
        onProgress: p => { if (p.phase === 'preparing') precheck.push(p) },
        confirmChangingFiles: async files => { asked = files; return false },
        stopOldEngine: async () => true,
        startAndVerifyNewEngine: async () => { throw new Error('must not start') },
        restartOldEngineOnRollback: async () => { restarted = true },
      })
      assert.deepEqual(asked, ['stream-manager/stats.json'])
      assert.equal(cancelled.ok, false)
      assert.equal(cancelled.cancelled, true)
      assert.equal(restarted, true)
      assert.equal(fs.existsSync(path.join(target, 'steady.txt')), false, 'nothing copied after Cancel')
      assert.ok(precheck.length > 0 && precheck.at(-1).stepDone === precheck.at(-1).stepTotal)
      assert.equal(precheck[0].stepLabel, 'Watching for changes')
      const log = fs.readFileSync(path.join(userData, 'data-location-move.log'), 'utf8')
      assert.match(log, /still changing before the copy/)

      const goTarget = path.join(dir, 'R7ContinueTarget')
      const cont = await datalocation.executeDataLocationMove({
        options: { targetPath: goTarget, deletePrevious: false },
        currentRoot: defaultData,
        userData,
        forbiddenRoot: forbidden,
        trustCheck: okTrust,
        changeWatchMs: 600,
        confirmChangingFiles: async () => true,
        stopOldEngine: async () => true,
        startAndVerifyNewEngine: async () => {},
        restartOldEngineOnRollback: async () => { throw new Error('must not roll back') },
      })
      assert.equal(cont.ok, true, `Continue anyway completes: ${cont.error ?? ''}`)
    } finally {
      stop()
      stopPort()
    }
  }

  // 4. Main wires the pre-check dialog; the result screen names the changed files.
  const indexSrc = fs.readFileSync(path.resolve('apps/desktop/main/index.ts'), 'utf8')
  assert.match(indexSrc, /changeWatchMs: DATA_MOVE_CHANGE_WATCH_MS/)
  assert.match(indexSrc, /confirmChangingFiles: async files =>/)
  assert.match(indexSrc, /'Continue anyway'/)
  const settingsSrc = fs.readFileSync(path.resolve('apps/desktop/renderer/src/canvas/desktopsettings.tsx'), 'utf8')
  assert.match(settingsSrc, /changed during the move; latest version copied/)
})

// R7 review (@idle-limit-sol at c60da5a, two HIGH, measured on synthetic controls): (1) a write or
// rename landing after a watcher take, when that take was empty, was lost: the copy returned with
// the old bytes or without the renamed file; (2) a final copy trusted the bytes it read, so a
// source rewritten during that read left an EMPTY or stale copy. With "Delete old folder" ticked
// either loses the latest data. Fix: end only on an empty take after the last copy and after
// verification; count a copy only when the source held still across the read; a file that never
// holds still is "could not be settled" and the old folder is kept with its original.
test('R7 review: writes after a watcher take are not lost, torn reads never replace a good copy, and unsettled files keep the old folder', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const okTrust = async () => ({ ok: true, detail: 'trusted' })

  // 1. A write and a rename that land right after an empty take still reach the new folder.
  {
    const { dir, defaultData } = makeSandbox()
    const steady = path.join(defaultData, 'steady.txt')
    const moveMe = path.join(defaultData, 'move-me.txt')
    fs.writeFileSync(steady, 'old\n')
    fs.writeFileSync(moveMe, 'moving\n')
    const target = path.join(dir, 'TakeRaceTarget')
    let raced = false
    const res = await datalocation.copyDataRootWithVerify(defaultData, target, {
      onCatchUpPass: pass => {
        if (pass !== 1 || raced) return
        raced = true
        fs.writeFileSync(steady, 'new bytes after the take\n')
        fs.renameSync(moveMe, path.join(defaultData, 'moved.txt'))
      },
    })
    assert.equal(raced, true)
    assert.equal(fs.readFileSync(path.join(target, 'steady.txt'), 'utf8'), 'new bytes after the take\n')
    assert.equal(fs.readFileSync(path.join(target, 'moved.txt'), 'utf8'), 'moving\n')
    assert.equal(fs.existsSync(path.join(target, 'move-me.txt')), false)
    assert.deepEqual(res.unsettledPaths, [])
  }

  // 2. A source rewritten while its catch-up copy was read is read again: never an empty or stale copy.
  {
    const { dir, defaultData } = makeSandbox()
    const busy = path.join(defaultData, 'busy.json')
    fs.writeFileSync(busy, JSON.stringify({ v: 1 }))
    const target = path.join(dir, 'TornReadTarget')
    let torn = 0
    const res = await datalocation.copyDataRootWithVerify(defaultData, target, {
      beforeRescan: pass => { if (pass === 1) fs.writeFileSync(busy, JSON.stringify({ v: 2, pad: 'x'.repeat(10) })) },
      afterRecopyRead: (rel, attempt) => {
        if (rel !== 'busy.json' || attempt !== 1 || torn > 0) return
        torn += 1
        fs.writeFileSync(busy, '')
        fs.writeFileSync(busy, JSON.stringify({ v: 3, pad: 'y'.repeat(200) }))
      },
    })
    assert.equal(torn, 1, 'the read was torn once')
    const copied = fs.readFileSync(path.join(target, 'busy.json'), 'utf8')
    assert.equal(copied, fs.readFileSync(busy, 'utf8'))
    assert.equal(JSON.parse(copied).v, 3)
    assert.deepEqual(res.unsettledPaths, [])
  }

  // 3. A file that never holds still keeps a complete earlier copy (never a 0-byte one), is named,
  //    and the old folder is kept with its original although "Delete old folder" was ticked.
  {
    const { dir, userData, defaultData, forbidden } = makeSandbox()
    fs.writeFileSync(path.join(defaultData, 'steady.txt'), 'steady\n')
    const busy = path.join(defaultData, 'busy.json')
    fs.writeFileSync(busy, JSON.stringify({ v: 0 }))
    const target = path.join(dir, 'UnsettledTarget')
    let dirtied = false
    let n = 0
    const res = await datalocation.executeDataLocationMove({
      options: { targetPath: target, deletePrevious: true },
      currentRoot: defaultData,
      userData,
      forbiddenRoot: forbidden,
      trustCheck: okTrust,
      onProgress: p => {
        if (p.phase === 'copying' && !dirtied && p.totalFiles > 0) {
          dirtied = true
          fs.writeFileSync(busy, JSON.stringify({ v: 1, pad: 'z'.repeat(50) }))
        }
      },
      afterRecopyRead: rel => {
        if (rel !== 'busy.json') return
        n += 1
        fs.writeFileSync(busy, '')
        fs.writeFileSync(busy, JSON.stringify({ v: 1 + n, pad: 'q'.repeat(60 + n) }))
      },
      stopOldEngine: async () => true,
      startAndVerifyNewEngine: async () => {},
      restartOldEngineOnRollback: async () => { throw new Error('must not roll back') },
    })
    assert.equal(res.ok, true, `the move completes: ${res.error ?? ''}`)
    assert.ok(n >= 3, `the reads were torn (${n})`)
    const kept = fs.readFileSync(path.join(target, 'busy.json'), 'utf8')
    assert.ok(kept.length > 0, 'never a 0-byte copy of a non-empty file')
    JSON.parse(kept)
    assert.equal(fs.existsSync(busy), true, 'the old folder keeps the original')
    const report = datalocation.readDataLocationMoveReport(userData)
    assert.ok(report)
    assert.deepEqual(report.unsettledDuringMove, [path.join(path.resolve(defaultData), 'busy.json')])
    assert.equal(report.oldFolderDeleted, false)
    assert.ok(!(report.changedDuringMove ?? []).includes('busy.json'))
    const log = fs.readFileSync(path.join(userData, 'data-location-move.log'), 'utf8')
    assert.match(log, /could not be settled; the previous folder was kept/)
    assert.match(log, /old folder kept/)
  }

  const settingsSrc = fs.readFileSync(path.resolve('apps/desktop/renderer/src/canvas/desktopsettings.tsx'), 'utf8')
  assert.match(settingsSrc, /could not be settled/)
})

// R7-R3 (@idle-limit-sol at c60da5a, LOW): with grouped events for a folder and a child folder
// that became a file, the folder's scan took the child's event and its old copy (a folder) stayed
// in the new folder, so the copy failed with EISDIR and a multi-hour move rolled back. Fixture
// from the review's controls.cjs (parent-folder-file): a stub watch delivers exactly these events.
test('R7-R3: a child folder that became a file is replaced in the new folder when its parent folder changed too', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)
  const { dir, defaultData } = makeSandbox()
  const item = path.join(defaultData, 'parent', 'item')
  fs.mkdirSync(item, { recursive: true })
  fs.writeFileSync(path.join(item, 'child'), 'old')
  const target = path.join(dir, 'GroupedFlipTarget')
  const originalWatch = fs.watch
  let callback = null
  fs.watch = (_root, _opts, cb) => {
    callback = cb
    const watcher = new EventEmitter()
    watcher.close = () => {}
    return watcher
  }
  try {
    const res = await datalocation.copyDataRootWithVerify(defaultData, target, {
      watchSettleMs: 0,
      beforeRescan: pass => {
        if (pass !== 1) return
        fs.unlinkSync(path.join(item, 'child'))
        fs.rmdirSync(item)
        fs.writeFileSync(item, 'new file')
        callback('change', 'parent')
        callback('change', `parent${path.sep}item`)
      },
    })
    assert.equal(fs.statSync(path.join(target, 'parent', 'item')).isFile(), true)
    assert.equal(fs.readFileSync(path.join(target, 'parent', 'item'), 'utf8'), 'new file')
    assert.deepEqual(res.unsettledPaths, [])
  } finally {
    fs.watch = originalWatch
  }
})

// R7 review delta (@idle-limit-sol at e24c70e; @coordinator-opus m18c648fd4c71, final for this item:
// "never succeed SILENTLY"): (1) a write after the post-verification take, and a batch still queued
// when the round bound is hit, returned success with old bytes or a missing file and named nothing;
// (2) a NEW file whose every read tore was written as 0 bytes. Now a last take follows every exit:
// what it holds, and what the last bounded round applied, is named and the old folder is kept; a
// file with no complete read is never written, but named with its original kept.
test('R7 review delta: late writes are never silent, and a file with no complete read is never written', async () => {
  const { datalocation: dl } = await loadDataLocationModules()
  const datalocation = requireDatalocation(dl)

  // 1. A write in the last seam after the post-verification take is copied and named; the old
  //    folder must be kept.
  {
    const { dir, defaultData } = makeSandbox()
    const steady = path.join(defaultData, 'steady.txt')
    fs.writeFileSync(steady, 'old bytes')
    const target = path.join(dir, 'LateSecondTarget')
    const passes = []
    const res = await datalocation.copyDataRootWithVerify(defaultData, target, {
      watchSettleMs: 50,
      onCatchUpPass: pass => {
        passes.push(pass)
        if (pass === 2) fs.writeFileSync(steady, 'LATEST bytes which must survive')
      },
    })
    assert.ok(passes.includes(2), `passes: ${passes.join(',')}`)
    assert.equal(fs.readFileSync(path.join(target, 'steady.txt'), 'utf8'), 'LATEST bytes which must survive')
    assert.deepEqual(res.changedDuringMove, ['steady.txt'])
    assert.equal(res.sourceStillChanging, true)
  }

  // 2. A batch still queued when the bounded rounds run out reaches the new folder and is named.
  {
    const { dir, defaultData } = makeSandbox()
    const rogue = path.join(defaultData, 'rogue.log')
    fs.writeFileSync(rogue, 'start\n')
    const target = path.join(dir, 'BoundTarget')
    const maxRounds = datalocation.MAX_RECOPY_PASSES + datalocation.FINAL_DRAIN_ROUNDS
    let rounds = 0
    const res = await datalocation.copyDataRootWithVerify(defaultData, target, {
      watchSettleMs: 50,
      beforeRescan: pass => { fs.appendFileSync(rogue, `pass ${pass}\n`) },
      onRecopy: round => {
        rounds = round
        if (round < maxRounds) fs.appendFileSync(rogue, `round ${round}\n`)
        else fs.writeFileSync(path.join(defaultData, 'late.txt'), 'late\n')
      },
    })
    assert.ok(rounds >= maxRounds, `rounds: ${rounds}`)
    assert.equal(fs.readFileSync(path.join(target, 'late.txt'), 'utf8'), 'late\n')
    assert.ok(res.changedDuringMove.includes('late.txt') && res.changedDuringMove.includes('rogue.log'), res.changedDuringMove.join(','))
    assert.equal(res.sourceStillChanging, true)
  }

  // 3. A NEW file whose every read tears is not written at all (never 0 bytes) and is unsettled.
  {
    const { dir, defaultData } = makeSandbox()
    fs.writeFileSync(path.join(defaultData, 'steady.txt'), 'steady\n')
    const fresh = path.join(defaultData, 'new.json')
    const target = path.join(dir, 'NewTornTarget')
    let reads = 0
    const res = await datalocation.copyDataRootWithVerify(defaultData, target, {
      watchSettleMs: 50,
      beforeRescan: pass => { if (pass === 1) fs.writeFileSync(fresh, JSON.stringify({ v: 0, pad: 'p'.repeat(40) })) },
      afterRecopyRead: rel => {
        if (rel !== 'new.json') return
        reads += 1
        fs.writeFileSync(fresh, '')
        fs.writeFileSync(fresh, JSON.stringify({ v: reads, pad: 'p'.repeat(40 + reads) }))
      },
    })
    assert.ok(reads >= datalocation.STABLE_COPY_ATTEMPTS, `reads: ${reads}`)
    assert.equal(fs.existsSync(path.join(target, 'new.json')), false, 'no 0-byte or torn copy of a non-empty file')
    assert.deepEqual(res.unsettledPaths, ['new.json'])
    assert.equal(fs.readFileSync(path.join(target, 'steady.txt'), 'utf8'), 'steady\n')
  }

  // 4. The move keeps the old folder when the source was still changing, and says so.
  const src = fs.readFileSync(path.resolve('apps/desktop/main/datalocation.ts'), 'utf8')
  assert.match(src, /still changing when the move finished/)
  const settingsSrc = fs.readFileSync(path.resolve('apps/desktop/renderer/src/canvas/desktopsettings.tsx'), 'utf8')
  assert.match(settingsSrc, /oldFolderKeptBecauseChanging/)
})
