import fs from 'node:fs'
for (const file of ['engine/launch.py', 'engine/backend/orgtree/api.py', 'engine/runtime/python.exe', 'engine/runtime/python313.zip', 'engine/runtime/runtime-manifest.json', 'dist/renderer/index.html']) {
  if (!fs.existsSync(file)) throw new Error('Package is incomplete: ' + file + '. Provision the runtime and integrate the real engine first.')
}
console.log('Standalone engine/runtime/UI inputs present')
