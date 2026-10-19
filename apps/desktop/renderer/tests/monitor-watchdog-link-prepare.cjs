const fs = require('node:fs')
const path = require('node:path')

const root = process.env.MONITOR_WATCHDOG_LINK_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]agent-tooltip-luna[\\/]monitor-watchdog-link$/i.test(root || '')) {
  throw new Error('Expected assigned monitor watchdog capture output directory')
}
const sharedModules = 'E:/Libraries/Desktop/orgtree/node_modules'
const { buildSync } = require(path.join(sharedModules, 'esbuild'))
const repo = process.cwd()
buildSync({
  entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/monitor-watchdog-link-visual.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: path.join(root, 'fixture.js'),
  nodePaths: [sharedModules],
  logLevel: 'info',
})
fs.copyFileSync(path.join(repo, 'apps/desktop/renderer/src/styles.css'), path.join(root, 'styles.css'))
fs.writeFileSync(path.join(root, 'fixture.html'),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>' +
  '<body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>')
