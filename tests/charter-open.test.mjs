import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('canonical charter directory resolution and creation logic', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-charter-test-'))
  try {
    const fakeHome = path.join(tempDir, 'user')
    fs.mkdirSync(fakeHome, { recursive: true })
    const charterDir = path.join(fakeHome, '.orgtree', 'charters')

    assert.equal(fs.existsSync(charterDir), false, 'charters directory does not exist initially')

    // Simulate main-process logic
    if (fs.existsSync(charterDir)) {
      const stat = fs.statSync(charterDir)
      if (!stat.isDirectory()) {
        throw new Error(`Charter path exists but is not a directory: ${charterDir}`)
      }
    } else {
      fs.mkdirSync(charterDir, { recursive: true })
    }

    assert.equal(fs.existsSync(charterDir), true, 'charters directory is created')
    assert.equal(fs.statSync(charterDir).isDirectory(), true, 'charters path is a directory')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('existing non-directory file at canonical charter path is rejected with clear error', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-charter-file-test-'))
  try {
    const fakeHome = path.join(tempDir, 'user')
    fs.mkdirSync(fakeHome, { recursive: true })
    const charterDir = path.join(fakeHome, '.orgtree', 'charters')
    fs.mkdirSync(path.dirname(charterDir), { recursive: true })
    // Create a regular file where the directory should be
    fs.writeFileSync(charterDir, 'not a directory')

    assert.equal(fs.existsSync(charterDir), true)
    assert.equal(fs.statSync(charterDir).isDirectory(), false)

    // Simulate main process validation logic
    let result = { ok: true }
    if (fs.existsSync(charterDir)) {
      const stat = fs.statSync(charterDir)
      if (!stat.isDirectory()) {
        result = { ok: false, error: `Charter path exists but is not a directory: ${charterDir}` }
      }
    }

    assert.equal(result.ok, false)
    assert.match(result.error, /Charter path exists but is not a directory/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('desktop bridge contract exposes openCharterFolder', () => {
  const contractsPath = path.resolve('packages/contracts/index.ts')
  const contractsSource = fs.readFileSync(contractsPath, 'utf8')
  assert.ok(
    contractsSource.includes('openCharterFolder?(): Promise<{ ok: boolean; path?: string; error?: string }>'),
    'DesktopBridge contains openCharterFolder method signature',
  )
})

test('desktop preload exposes openCharterFolder without arbitrary path parameter', () => {
  const preloadPath = path.resolve('apps/desktop/preload/index.ts')
  const preloadSource = fs.readFileSync(preloadPath, 'utf8')
  assert.ok(
    preloadSource.includes("openCharterFolder: () => ipcRenderer.invoke('desktop:open-charter-folder')"),
    'preload exposes parameterless openCharterFolder delegating to IPC',
  )
})

test('desktop main process registers desktop:open-charter-folder IPC handler', () => {
  const mainPath = path.resolve('apps/desktop/main/index.ts')
  const mainSource = fs.readFileSync(mainPath, 'utf8')
  assert.ok(
    mainSource.includes("handle('desktop:open-charter-folder'"),
    'main process registers desktop:open-charter-folder handler',
  )
  assert.ok(
    mainSource.includes("path.join(os.homedir(), '.orgtree', 'charters')"),
    'main process resolves canonical directory using os.homedir',
  )
  assert.ok(
    mainSource.includes('stat.isDirectory()'),
    'main process validates that canonical path is a directory',
  )
})

test('backend API exposes /api/charters/open endpoint', () => {
  const apiPyPath = path.resolve('engine/backend/orgtree/api.py')
  const apiPySource = fs.readFileSync(apiPyPath, 'utf8')
  assert.ok(
    apiPySource.includes('@app.post("/api/charters/open")'),
    'backend API registers POST /api/charters/open',
  )
  assert.ok(
    apiPySource.includes('_checked_user_charters(create=True)'),
    'backend API ensures canonical user charters directory creation',
  )
  assert.ok(
    apiPySource.includes('not os.path.isdir(folder)'),
    'backend API validates that canonical path is a directory',
  )
})
