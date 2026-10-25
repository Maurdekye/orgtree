import { inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FILE_DOWNLOAD_MAX, readDownloadBlob } from '../src/canvas/filedownload'

test('Files refuses an oversized declared response before buffering it',async()=>{
  let cancelled=false,reads=0
  const response=new Response(new ReadableStream({pull(){++reads},cancel(){cancelled=true}}),{headers:{'Content-Length':String(FILE_DOWNLOAD_MAX+1)}})
  await assert.rejects(readDownloadBlob(response),/256 MiB/)
  assert.ok(cancelled);assert.ok(reads<=1,'no download body is consumed')
})

test('Files cancels a response whose actual chunks exceed its budget even with a false length',async()=>{
  let cancelled=false
  const chunks=[new Uint8Array([1,2,3]),new Uint8Array([4,5,6])]
  const response=new Response(new ReadableStream({pull(controller){const value=chunks.shift();if(value)controller.enqueue(value);else controller.close()},cancel(){cancelled=true}}),{headers:{'Content-Length':'1'}})
  await assert.rejects(readDownloadBlob(response,5),/256 MiB/)
  assert.ok(cancelled)
  const exact=await readDownloadBlob(new Response('12345'),5)
  assert.equal(await exact.text(),'12345','an exact-size body remains downloadable')
})
