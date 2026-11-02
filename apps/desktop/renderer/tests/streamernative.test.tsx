import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { nativeDialogOptions, nativeMenuLabel, protectNativeDialogs, protectNativeMenus, setNativeStreamer, trackStreamerNotice } from '../../main/streamer-native'
import { NativeNotifications } from '../../main/notifications'
import { preferencesPatch } from '../../main/policy'
import { protectOpaqueWindow } from '../../main/streamer-opaque'

test('native screen sinks hide unknown strings, preserve actions and leave OS file pickers untouched', async () => {
  setNativeStreamer(true)
  try {
    assert.deepEqual(preferencesPatch({ streamerMode: true }), { streamerMode: true })
    assert.throws(() => preferencesPatch({ streamerMode: 'yes' }))
    for (const text of ['private@example.test', 'Private Account', '/home/private/file', '@net:reader.test', '192.168.1.2', 'short-secret']) assert.equal(nativeMenuLabel(text), 'Hidden in Streamer mode')
    assert.equal(nativeMenuLabel('Copy'), 'Copy')
    const options = { message:'private@example.test', detail:'secret-value', buttons:['Cancel','Reveal private-account'] }
    const safe = nativeDialogOptions(options)
    assert.equal(safe.message, 'Hidden in Streamer mode'); assert.equal(safe.detail, 'Hidden in Streamer mode')
    assert.deepEqual(safe.buttons, ['Cancel','Action 2']); assert.equal(options.message, 'private@example.test')
    let opened: unknown
    const picker = { showOpenDialog: (o: unknown) => { opened=o; return Promise.resolve({canceled:false,filePaths:['/home/original']}) }, showMessageBox: (o:unknown) => Promise.resolve(o) }
    const protectedDialogs = protectNativeDialogs(picker)
    const chosen = await protectedDialogs.showOpenDialog(options)
    assert.equal(opened, options); assert.equal(chosen.filePaths[0], '/home/original')
    assert.equal((await protectedDialogs.showMessageBox(options) as typeof options).message, 'Hidden in Streamer mode')
    let clicks = 0
    class Menu extends EventEmitter { items = [{ label:'Private Account', click: () => clicks++ }] }
    const menu = protectNativeMenus({buildFromTemplate: () => new Menu()}).buildFromTemplate()
    menu.emit('menu-will-show'); assert.equal(menu.items[0]!.label, 'Hidden in Streamer mode')
    menu.items[0]!.click(); assert.equal(clicks, 1)
    menu.emit('menu-will-close'); assert.equal(menu.items[0]!.label, 'Private Account')
  } finally { setNativeStreamer(false) }
})
test('enabling streamer mode closes existing notifications without modifying their action data', async () => {
  setNativeStreamer(false)
  class Notice extends EventEmitter { closed = 0; close() { this.closed++; this.emit('close') }; show() { this.emit('show') } }
  const notice = new Notice(), data = { id:'a',org:'fixture',kind:'question',title:'Private Account',body:'private@example.test' }
  let opened: unknown
  const manager = new NativeNotifications(() => trackStreamerNotice(notice), value => { opened = value })
  const prefs = { notificationsEnabled:true,notifyQuestions:true,notifyUrgentMail:true,notifyTerminalFailures:true,notifyDocketAttention:true,notifyMentions:true,notifyAllMail:false,notifyDocuments:false,notifyFrozen:false,notifyWhileFocused:false }
  assert.equal(await manager.notify(data, prefs), true)
  notice.emit('click'); assert.equal((opened as typeof data).body, data.body)
  setNativeStreamer(true); manager.configure({ ...prefs, streamerMode:true })
  assert.ok(notice.closed > 0); assert.equal(data.body, 'private@example.test')
  setNativeStreamer(false)
})

test('native HTML viewers receive an opaque cover without replacing their content; dismissal is local and resets', () => {
  class Contents extends EventEmitter {
    closed=false; loaded=''; isDestroyed(){return this.closed} close(){this.closed=true}
    setWindowOpenHandler(){} setAudioMuted(){} loadURL(url:string){this.loaded=url;return Promise.resolve()}
  }
  class Cover { webContents=new Contents(); color=''; bounds={}; setBackgroundColor(c:string){this.color=c} setBounds(b:unknown){this.bounds=b as object} }
  class Window extends EventEmitter {
    covers:Cover[]=[]; contentView={addChildView:(v:Cover)=>this.covers.push(v),removeChildView:(v:Cover)=>{this.covers=this.covers.filter(c=>c!==v)}}
    isDestroyed(){return false} getContentSize(){return [1000,760]}
  }
  setNativeStreamer(true)
  const a=new Window(),b=new Window()
  const stopA=protectOpaqueWindow(a as never,()=>new Cover() as never),stopB=protectOpaqueWindow(b as never,()=>new Cover() as never)
  try {
    assert.equal(a.covers.length,1);assert.equal(b.covers.length,1);assert.equal(a.covers[0]!.color,'#292929')
    assert.match(decodeURIComponent(a.covers[0]!.webContents.loaded),/Hidden in Streamer mode/)
    let prevented=false
    a.covers[0]!.webContents.emit('will-navigate',{preventDefault(){prevented=true}},'https://streamer-dismiss.invalid/')
    assert.equal(prevented,true);assert.equal(a.covers.length,0);assert.equal(b.covers.length,1)
    setNativeStreamer(false);setNativeStreamer(true)
    assert.equal(a.covers.length,1);assert.equal(b.covers.length,1)
  } finally {stopA();stopB();setNativeStreamer(false)}
})
