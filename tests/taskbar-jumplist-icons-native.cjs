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
  for(const [file,size] of [[icons.home,64],[icons.create,64],[icons.orgs.synthetic,256]]){
    assert.ok(file&&fs.existsSync(file))
    const image=nativeImage.createFromPath(file)
    assert.equal(image.isEmpty(),false)
    assert.deepEqual(image.getSize(),{width:size,height:size})
    checked++
  }
  assert.notDeepEqual(fs.readFileSync(icons.home),fs.readFileSync(icons.create));checked++
  console.log(JSON.stringify({checks:checked,passed:true,scope:'synthetic PNG/ICO native image decode only'}))
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
