import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import * as esbuild from 'esbuild'
const here=path.dirname(fileURLToPath(import.meta.url)), frontend=path.resolve(here,'..'), out=process.argv[2]
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true})
await esbuild.build({entryPoints:[path.join(here,'gallery-layout-probe.tsx')],outfile:path.join(out,'probe.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',logLevel:'warning',absWorkingDir:frontend})
writeFileSync(path.join(out,'probe.css'),readFileSync(path.join(here,'..','src','styles.css')))
writeFileSync(path.join(out,'probe.html'),'<!doctype html><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script>')
