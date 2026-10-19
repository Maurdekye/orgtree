import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(process.env.ORGTREE_TEST_DEPS||import.meta.url),{buildSync}=require('esbuild')
const scope=process.env.ORGTREE_BADGE_TEST_ROOT
assert.match(scope||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
fs.mkdirSync(scope,{recursive:true});const temp=fs.mkdtempSync(path.join(scope,'art-'))
buildSync({entryPoints:['apps/desktop/main/taskbar-badge.ts'],outdir:temp,outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs'})
const {taskbarDotBitmap,taskbarDotImage}=require(path.join(temp,'taskbar-badge.cjs'))
test.after(()=>{assert.ok(fs.realpathSync(temp).toLowerCase().startsWith(fs.realpathSync(scope).toLowerCase()+path.sep));fs.rmSync(temp,{recursive:true,force:true})})

test('the overlay contains only red premultiplied pixels with no white or grey rim',()=>{
 const bitmap=taskbarDotBitmap()
 let partial=0
 for(let at=0;at<bitmap.length;at+=4){
  const alpha=bitmap[at+3]
  assert.deepEqual([...bitmap.subarray(at,at+3)],[0x4d,0x48,0xe5].map(c=>Math.round(c*alpha/255)))
  if(alpha>0&&alpha<255)partial++
 }
 assert.ok(partial>0,'the circle has true alpha coverage at its edge')
})

test('100 125 150 and 200 percent overlay rasters have their own physical resolution',()=>{
 for(const size of [16,20,24,32]){
  const bitmap=taskbarDotBitmap(size)
  assert.equal(bitmap.length,size*size*4)
  assert.equal(bitmap[((size/2)*size+size/2)*4+3],255)
 }
})

test('the circle stays centered with a transparent margin at each DPI',()=>{
 for(const size of [16,20,24,32]){
  const bitmap=taskbarDotBitmap(size)
  assert.equal(bitmap.length,size*size*4)
  const alpha=(x,y)=>bitmap[(y*size+x)*4+3]
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   assert.equal(alpha(x,y),alpha(size-1-x,y),'horizontal symmetry')
   assert.equal(alpha(x,y),alpha(x,size-1-y),'vertical symmetry')
   if(x===0||y===0||x===size-1||y===size-1)assert.equal(alpha(x,y),0,'no clipping at the icon boundary')
  }
 }
})

test('the native image factory supplies PNG alpha representations instead of stretching a 16px bitmap',()=>{
 assert.equal(typeof taskbarDotImage,'function')
 const reps=[],image={addRepresentation:options=>reps.push(options)}
 const result=taskbarDotImage({createFromBuffer:(buffer,options)=>{reps.push({...options,buffer});return image}})
 assert.equal(result,image)
 assert.deepEqual(reps.map(r=>r.scaleFactor),[1,1.25,1.5,1.75,2,2.5,3,4])
 for(const rep of reps){
  const png=rep.buffer??Buffer.from(rep.dataURL.split(',')[1],'base64')
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16),16*rep.scaleFactor)
  assert.equal(png.readUInt32BE(20),16*rep.scaleFactor)
  assert.equal(png[25],6,'PNG RGBA, not an opaque ICO mask')
 }
})
