// Synthetic profile; native image decoding only. No window, engine or shell writes.
const {app,nativeImage}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const [bundle,out]=process.argv.slice(2)
app.disableHardwareAcceleration()
app.setPath('userData',path.join(out,'profile'))
const {JumpListIcons,actionPng}=require(bundle)
app.whenReady().then(async()=>{
  let checked=0
  for(const kind of ['home','create']){
    const image=nativeImage.createFromBuffer(actionPng(kind))
    assert.equal(image.isEmpty(),false)
    assert.deepEqual(image.getSize(),{width:64,height:64})
    assert.equal(image.toBitmap()[3],0,'transparent corner survives PNG decode')
    checked++
  }
  const png=nativeImage.createFromBuffer(actionPng('home')).resize({width:512,height:512}).toPNG()
  const record={sha256:crypto.createHash('sha256').update(png).digest('hex'),data:png.toString('base64'),bytes:png.length,width:512,height:512}
  const cache=new JumpListIcons(path.join(out,'icons'),async()=>record,bytes=>{
    const image=nativeImage.createFromBuffer(bytes).resize({width:256,height:256})
    return {png:image.toPNG(),...image.getSize()}
  })
  const org={slug:'synthetic',name:'Synthetic',logo:record.sha256}
  await cache.prepare([org])
  const icons=cache.paths([org])
  const decoded=[]
  for(const [file,size] of [[icons.home,64],[icons.create,64],[icons.orgs.synthetic,256]]){
    assert.ok(file&&fs.existsSync(file))
    const bytes=fs.readFileSync(file)
    assert.equal(bytes.readUInt16LE(2),1)
    assert.equal(bytes.readUInt16LE(4),1)
    assert.equal(bytes[6]||256,size)
    assert.equal(bytes[7]||256,size)
    const offset=bytes.readUInt32LE(18),length=bytes.readUInt32LE(14)
    assert.equal(offset+length,bytes.length)
    const embedded=nativeImage.createFromBuffer(bytes.subarray(offset,offset+length))
    assert.deepEqual(embedded.getSize(),{width:size,height:size})
    const image=nativeImage.createFromPath(file)
    assert.equal(image.isEmpty(),false)
    // The Windows file-icon loader can select a 256px shell representation
    // even for the single 64px image. Verify the actual glyph against the
    // independently decoded embedded PNG at a common resolution instead.
    const dimensions=image.getSize()
    assert.equal(dimensions.width,dimensions.height)
    assert.ok(dimensions.width>=16&&dimensions.width<=256)
    const actual=image.resize({width:64,height:64}).toBitmap()
    const expected=embedded.resize({width:64,height:64}).toBitmap()
    let alphaError=0
    for(let at=3;at<actual.length;at+=4)alphaError+=Math.abs(actual[at]-expected[at])
    alphaError/=64*64*255
    assert.ok(alphaError<0.03,`native ICO shape differs from embedded PNG: ${alphaError}`)
    decoded.push({file,stored:size,native:dimensions.width,alphaError})
    fs.writeFileSync(path.join(out,path.basename(file)+'.native.png'),image.toPNG())
    checked++
  }
  assert.notDeepEqual(fs.readFileSync(icons.home),fs.readFileSync(icons.create));checked++
  console.log(JSON.stringify({checks:checked,passed:true,decoded,scope:'synthetic PNG/ICO native image decode only'}))
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
