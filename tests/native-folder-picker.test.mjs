// Native OS folder-picker IPC & preload contract tests
// (USER 2026-11-13 m365cee9110b5, m98bc74e8a3c7).
//
// Run: node tests/run.mjs tests/native-folder-picker.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

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

test('preload exposes narrow pickFolder(defaultPath, popoutName) returning string | null and propagating remote refusals', async () => {
  const { build } = loadEsbuild()
  const result = await build({
    entryPoints: ['apps/desktop/preload/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  const code = result.outputFiles[0].text

  const invokeCalls = []
  let nextReply = async () => null
  let exposedName = null
  let exposedBridge = null

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
            exposeInMainWorld(name, api) {
              exposedName = name
              exposedBridge = api
            },
          },
          ipcRenderer: {
            sendSync(channel) {
              if (channel === 'desktop:window-identity-sync') {
                return { identity: { windowId: 'win-1', kind: 'org', org: 'local-org' }, token: 'tok-1' }
              }
              return null
            },
            invoke(channel, ...args) {
              invokeCalls.push({ channel, args })
              return nextReply(channel, ...args)
            },
            on() {},
            send() {},
            removeListener() {},
          },
        }
      }
      return createRequire(import.meta.url)(specifier)
    },
  }

  vm.runInNewContext(code, sandbox, { filename: 'preload.cjs' })
  assert.equal(exposedName, 'orgtreeDesktop')
  assert.equal(typeof exposedBridge?.pickFolder, 'function', 'preload exposes pickFolder on orgtreeDesktop')

  nextReply = async () => 'S:\\chosen\\dir'
  const picked = await exposedBridge.pickFolder('S:\\current\\dir', 'orgtree-popout-3')
  assert.equal(picked, 'S:\\chosen\\dir')
  assert.deepEqual(invokeCalls[0], {
    channel: 'desktop:pick-folder',
    args: ['S:\\current\\dir', 'orgtree-popout-3'],
  })

  nextReply = async () => null
  const cancelled = await exposedBridge.pickFolder()
  assert.equal(cancelled, null)
  assert.deepEqual(invokeCalls[1], {
    channel: 'desktop:pick-folder',
    args: [null, null],
  })

  // Non-string unexpected values resolve to null, while main's remoteRefusal rejects with { remote: true }.
  nextReply = async () => ''
  assert.equal(await exposedBridge.pickFolder(''), null)

  nextReply = async () => ({ ok: false, error: 'Remote engine refusal', remote: true })
  await assert.rejects(
    () => exposedBridge.pickFolder('S:\\any'),
    (err) => err && err.remote === true,
  )
})

test('pickNativeFolder opens dialog.showOpenDialog modal to the asking main or popout window, seeds defaultPath only when an existing directory, and returns chosen path or null', async (t) => {
  assert.equal(fs.existsSync('apps/desktop/main/folder-picker.ts'), true, 'apps/desktop/main/folder-picker.ts exists')
  const { pickNativeFolder } = await import('../apps/desktop/main/folder-picker.ts')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-picker-test-'))
  const existingSubdir = path.join(tmpDir, 'existing-folder')
  const existingFile = path.join(tmpDir, 'not-a-folder.txt')
  fs.mkdirSync(existingSubdir)
  fs.writeFileSync(existingFile, 'hello', 'utf8')
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const calls = []
  let dialogResult = { canceled: false, filePaths: [existingSubdir] }
  const fakeDialog = {
    async showOpenDialog(win, options) {
      calls.push({ win, options })
      return dialogResult
    },
  }

  const mainWin = { id: 'main', isDestroyed: () => false }
  const popoutWin = { id: 'popout', isDestroyed: () => false }
  const deadWin = { id: 'dead', isDestroyed: () => true }

  // 1. Existing directory -> modal to mainWin, openDirectory+createDirectory, defaultPath normalized.
  const first = await pickNativeFolder(fakeDialog, mainWin, undefined, `  ${existingSubdir}  `)
  assert.equal(first, existingSubdir)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].win, mainWin)
  assert.deepEqual(calls[0].options, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.normalize(existingSubdir),
  })

  // 2. Live popout window -> modal to popoutWin rather than mainWin.
  const second = await pickNativeFolder(fakeDialog, mainWin, popoutWin, null)
  assert.equal(second, existingSubdir)
  assert.equal(calls[1].win, popoutWin)
  assert.deepEqual(calls[1].options, {
    properties: ['openDirectory', 'createDirectory'],
  })

  // 3. Destroyed popout falls back to live mainWin; both destroyed opens nothing and returns null.
  await pickNativeFolder(fakeDialog, mainWin, deadWin, undefined)
  assert.equal(calls[2].win, mainWin)
  const deadCountBefore = calls.length
  const noneWhenDead = await pickNativeFolder(fakeDialog, deadWin, deadWin, existingSubdir)
  assert.equal(noneWhenDead, null)
  assert.equal(calls.length, deadCountBefore, 'destroyed windows must never open an unparented OS dialog')

  // 4. Nonexistent path, file path, blank path, and relative path all omit defaultPath.
  for (const invalid of ['', '   ', 'relative/subpath', path.join(tmpDir, 'missing'), existingFile]) {
    await pickNativeFolder(fakeDialog, mainWin, undefined, invalid)
    assert.equal(
      Object.hasOwn(calls.at(-1).options, 'defaultPath'),
      false,
      `defaultPath must be omitted for ${JSON.stringify(invalid)}`,
    )
    assert.deepEqual(calls.at(-1).options.properties, ['openDirectory', 'createDirectory'])
  }

  // 5. Cancel or empty filePaths returns null.
  dialogResult = { canceled: true, filePaths: [existingSubdir] }
  assert.equal(await pickNativeFolder(fakeDialog, mainWin, undefined, existingSubdir), null)
  dialogResult = { canceled: false, filePaths: [] }
  assert.equal(await pickNativeFolder(fakeDialog, mainWin, undefined, existingSubdir), null)
})
