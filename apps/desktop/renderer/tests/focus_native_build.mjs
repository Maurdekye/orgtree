import * as esbuild from 'esbuild'
import path from 'node:path'
const root = path.resolve(process.argv[2])
for (const [entry, name] of [['apps/desktop/main/windows.ts', 'native-windows.cjs'],
  ['apps/desktop/preload/index.ts', 'native-preload.cjs']]) {
  await esbuild.build({ entryPoints: [entry], outfile: path.join(root, name), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
}
