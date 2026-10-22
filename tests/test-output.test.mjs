import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testOutput } from './helpers/test-output.mjs'

const fixture=testOutput('UNUSED_TEST_OUTPUT','output-controls-',{})
const root=fixture.directory
test.after(()=>fixture.cleanup())
const owner=process.env.ORGTREE_AGENT
// The C-only override controls apply on Windows; ordinary defaults work on any OS.
const windows={skip:process.platform!=='win32' || !owner || !root.toLowerCase().startsWith(path.resolve('C:/orgtree-build',owner || 'unset').toLowerCase()+path.sep)}

test('ordinary invocation without output variables gets isolated fresh temp leaves',()=>{
  const a=testOutput('OUTPUT','default-',{}),b=testOutput('OUTPUT','default-',{})
  assert.equal(path.dirname(a.directory),fs.realpathSync(os.tmpdir()))
  assert.notEqual(a.directory,b.directory)
  fs.writeFileSync(path.join(a.directory,'receipt.txt'),'first')
  assert.deepEqual(fs.readdirSync(b.directory),[])
  a.cleanup();a.cleanup();b.cleanup()
  assert.equal(fs.existsSync(a.directory),false)
  assert.equal(fs.existsSync(b.directory),false)
})

test('explicit owner output preserves prior receipts and concurrent runs get distinct leaves',windows,()=>{
  const parent=path.join(root,'explicit');fs.mkdirSync(parent)
  fs.writeFileSync(path.join(parent,'receipt.txt'),'preserve')
  const env={ORGTREE_AGENT:owner,OUTPUT:parent}
  const a=testOutput('OUTPUT','repeat-',env),b=testOutput('OUTPUT','repeat-',env)
  assert.notEqual(a.directory,b.directory)
  assert.equal(path.dirname(a.directory),fs.realpathSync(parent))
  a.cleanup();b.cleanup()
  assert.deepEqual(fs.readdirSync(parent),['receipt.txt'])
  assert.equal(fs.readFileSync(path.join(parent,'receipt.txt'),'utf8'),'preserve')
})

test('missing or invalid owner and empty or relative overrides refuse before creating a path',()=>{
  const absent=path.join(root,'not-created')
  for(const env of [{OUTPUT:absent},{OUTPUT:absent,ORGTREE_AGENT:'../peer'},
    {OUTPUT:'',ORGTREE_AGENT:owner},{OUTPUT:'relative-output',ORGTREE_AGENT:owner}]) {
    assert.throws(()=>testOutput('OUTPUT','invalid-',env))
  }
  assert.equal(fs.existsSync(absent),false)
})

test('owner root, sibling scopes, prefix collisions and traversal cannot become output parents',windows,()=>{
  const own=path.resolve('C:/orgtree-build',owner)
  for(const output of [own,path.resolve(own,'..','fictional-peer','new-leaf'),
    own+'-peer/new-leaf',own+'/nested/../new-leaf']) {
    assert.throws(()=>testOutput('OUTPUT','escape-',{ORGTREE_AGENT:owner,OUTPUT:output}))
  }
})

test('a junction ancestor refuses before making a child through the link',windows,()=>{
  const outside=path.join(root,'outside'),link=path.join(root,'junction')
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'receipt.txt'),'keep')
  fs.symlinkSync(outside,link,'junction')
  assert.throws(()=>testOutput('OUTPUT','linked-',{ORGTREE_AGENT:owner,OUTPUT:path.join(link,'uncreated','deep')}))
  assert.deepEqual(fs.readdirSync(outside),['receipt.txt'])
  fs.unlinkSync(link)
})

test('a regular file ancestor refuses before creating output',windows,()=>{
  const file=path.join(root,'plain-file');fs.writeFileSync(file,'keep')
  assert.throws(()=>testOutput('OUTPUT','file-',{ORGTREE_AGENT:owner,OUTPUT:path.join(file,'child')}))
  assert.equal(fs.readFileSync(file,'utf8'),'keep')
})

test('cleanup refuses a replaced directory and leaves replacement receipts intact',()=>{
  const output=testOutput('OUTPUT','replaced-',{}),saved=output.directory+'-saved'
  fs.renameSync(output.directory,saved);fs.mkdirSync(output.directory)
  fs.writeFileSync(path.join(output.directory,'receipt.txt'),'keep')
  try {
    assert.throws(()=>output.cleanup(),/replaced/)
    assert.equal(fs.readFileSync(path.join(output.directory,'receipt.txt'),'utf8'),'keep')
  } finally {
    fs.unlinkSync(path.join(output.directory,'receipt.txt'));fs.rmdirSync(output.directory)
    fs.renameSync(saved,output.directory);output.cleanup()
  }
})

test('cleanup refuses a junction replacement without touching its target',windows,()=>{
  const output=testOutput('OUTPUT','cleanup-link-',{}),saved=output.directory+'-saved'
  const outside=path.join(root,'cleanup-outside');fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside,'receipt.txt'),'keep')
  fs.renameSync(output.directory,saved);fs.symlinkSync(outside,output.directory,'junction')
  try {
    assert.throws(()=>output.cleanup(),/linked/)
    assert.equal(fs.readFileSync(path.join(outside,'receipt.txt'),'utf8'),'keep')
  } finally {
    fs.unlinkSync(output.directory);fs.renameSync(saved,output.directory);output.cleanup()
  }
})
