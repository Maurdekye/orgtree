const fs = require('node:fs')
const path = require('node:path')
const out = process.env.WORK_TOOL_TICKET_ROOT
if (!/^C:[\\/]orgtree-build[\\/]agent-tooltip-luna[\\/]work-tool-ticket$/i.test(out || '')) throw Error('Assigned output root required')
const chips = JSON.parse(fs.readFileSync(path.join(out, 'chips.json'), 'utf8'))
if (chips.length !== 3 || chips.some(chip => !chip.refs.some(ref => ref.kind === 'ticket'))) throw Error('Missing engine-produced ticket refs')
require('E:/Libraries/Desktop/orgtree/node_modules/esbuild').buildSync({
  entryPoints: [path.join(process.cwd(), 'apps/desktop/renderer/tests/work-tool-ticket-visual.tsx')],
  outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
  nodePaths: ['E:/Libraries/Desktop/orgtree/node_modules'],
  define: { __WORK_TOOL_CHIPS__: JSON.stringify(chips) },
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]',
})
fs.writeFileSync(path.join(out, 'fixture.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
