// Compile actual bundled electron-builder installer/uninstaller templates with
// a synthetic payload. The resulting installer is NEVER executed or installed.
// electron-builder executes only its BUILD_UNINSTALLER emitter (writes a file).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const moduleRoot = process.env.BOOT_TEST_NODE_MODULES;
assert(moduleRoot, 'Set BOOT_TEST_NODE_MODULES to existing locked dependencies');
const { build, Platform, Arch } = require(path.join(moduleRoot, 'electron-builder'));
const { NsisTarget } = require(path.join(moduleRoot, 'app-builder-lib/out/targets/nsis/NsisTarget.js'));
const { nsisEscapeString } = require(path.join(moduleRoot, 'app-builder-lib/out/targets/nsis/nsisScriptGenerator.js'));
const source = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-nsis-compile-'));
const payload = path.join(out, 'payload');
fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
fs.writeFileSync(path.join(payload, 'Orgtree.exe'), 'INERT TEST PAYLOAD - DO NOT INSTALL');
const original = NsisTarget.prototype.executeMakensis;
let calls = 0;
NsisTarget.prototype.executeMakensis = async function(defines, commands, script) {
  fs.writeFileSync(path.join(out, `template-${++calls}.nsi`), script);
  fs.writeFileSync(path.join(out, `defines-${calls}.json`), JSON.stringify({ defines, commands }, null, 2));
  await original.call(this, defines, commands, script);
  const args = ['-V4', '-INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([k,v]) => `-D${k}${v == null ? '' : '='+nsisEscapeString(String(v))}`)];
  for (const [name, value] of Object.entries(commands)) for (const v of Array.isArray(value) ? value : [value]) args.push(`-X${name} ${v}`);
  args.push('-');
  const expanded = spawnSync(path.join(process.env.ELECTRON_BUILDER_NSIS_DIR, 'Bin/makensis.exe'), args,
    { input: script, encoding: 'utf8', maxBuffer: 16*1024*1024, env: {...process.env, NSISDIR: process.env.ELECTRON_BUILDER_NSIS_DIR}, cwd: path.join(moduleRoot, 'app-builder-lib/templates/nsis') });
  assert.equal(expanded.status, 0, expanded.stderr);
  fs.writeFileSync(path.join(out, `compile-trace-${calls}.txt`), expanded.stdout);
  if (!('BUILD_UNINSTALLER' in defines)) {
    const pre = expanded.stdout.indexOf('Section: "-Orgtree boot preflight"');
    const install = expanded.stdout.indexOf('Section: "install"');
    assert(pre >= 0 && install > pre, 'Preflight must precede bundled install section');
    const stop = expanded.stdout.indexOf('-Action Prepare');
    assert(stop > pre && stop < install, 'Prepare must run before old uninstall and copy');
  } else {
    const un = expanded.stdout.indexOf('Section: "un.');
    const stop = expanded.stdout.indexOf('unregister-boot-engine.ps1" -Action', un);
    const rm = expanded.stdout.indexOf('Call "un.atomicRMDir"', un);
    assert(un >= 0 && stop > un && rm > stop, 'Verified stop must precede bundled removal');
  }
};
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
build({ projectDir: source, prepackaged: payload, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never',
  config: { directories: { output: path.join(out, 'output') },
    win: { signAndEditExecutable: false, signExecutable: false },
    nsis: { include: path.join(source, 'build/installer.nsh'), runAfterFinish: false } }
}).then(artifacts => {
  assert(calls >= 2, 'Installer and uninstaller must both compile');
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ calls, artifacts, installed: false }, null, 2));
  console.log(`PASS actual NSIS templates compiled; no install: ${out}`);
}).catch(error => { console.error(error); process.exit(1); });
