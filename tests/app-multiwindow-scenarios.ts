/** Three shipping App windows, isolated canvas state and real socket delivery.
 * The tiny fixture only sends server text frames; it is not an engine or a
 * general WebSocket implementation. HTTP deliberately keeps the old count,
 * so a poll cannot make the live-update assertions pass without the socket. */
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { AppScenarioContext, AppWindow } from './app-composition.probe'

export async function runMultiwindowScenarios(ctx: AppScenarioContext): Promise<void> {
  const orgs = ['studio','other','created']
  const trees = new Map<string, any>()
  for (const org of orgs) {
    const tree = await (await fetch(ctx.origin + '/api/orgs/' + org)).json()
    trees.set(org, {...tree,sync_rev:1,roots:tree.roots.map((n: any) => ({...n,
      mcp_tool_count:0,last_turn_mcp_tool_count:0,
      scope:{...n.scope,tools:{...n.scope.tools,mcp:['fixture-only']}}}))})
  }
  const sockets = new Map<string, Set<Duplex>>()
  const stopApi = ctx.routeApi((req,res,url) => {
    const org = orgs.find(org=>url.pathname === '/api/orgs/' + org)
    if (req.method !== 'GET' || !org) return false
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
    res.end(JSON.stringify(trees.get(org))); return true
  })
  const stopUpgrade = ctx.routeUpgrade((req,socket) => {
    const org = orgs.find(org=>req.url === '/api/orgs/' + org + '/ws')
    const key = req.headers['sec-websocket-key']
    if (!org || typeof key !== 'string') return false
    const accept = createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n')
    const set = sockets.get(org) ?? new Set<Duplex>(); sockets.set(org,set); set.add(socket)
    socket.on('error',()=>{}); socket.on('close',()=>set.delete(socket))
    // Client pings are immaterial to this short-lived send-only fixture.
    socket.on('data',()=>{})
    return true
  })
  const sendCount = (org: string, count: number, rev: number) => {
    const body = Buffer.from(JSON.stringify({type:'node_stream',node:'agent',kind:'mcp_tool_count',
      count,last_turn_count:0,provider:'claude',source:'composition-fixture',rev}))
    const head = body.length < 126 ? Buffer.from([0x81,body.length]) : Buffer.from([0x81,126,body.length >> 8,body.length & 255])
    for (const socket of sockets.get(org) ?? []) socket.write(Buffer.concat([head,body]))
  }
  const windows: AppWindow[] = []
  const js = (r:AppWindow,source:string) => ctx.eval<any>(r,source)
  const ready = async (r:AppWindow,source:string) => {
    if (!await ctx.until(()=>js(r,source),Boolean,10000)) throw Error('Multiwindow prerequisite failed: '+source)
  }
  const mode = async (r:AppWindow,label:string) => {
    await ready(r,`!!document.querySelector('.shell-mode')`)
    await js(r,`Array.from(document.querySelectorAll('.shell-mode')).find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})).click();true`)
    await ready(r,`document.querySelector('.shell-mode[aria-checked="true"]').textContent.trim().startsWith(${JSON.stringify(label)})`)
  }
  const camera = (r:AppWindow) => js(r,`document.querySelector('.canvas-world .space')?.getAttribute('style')`)
  const settleCamera = async (r:AppWindow) => {
    let previous = '', same = 0
    const settled=await ctx.until(async()=>{ const value=await camera(r); same=value && value===previous ? same+1 : 0; previous=value; return same },n=>n>=4,10000)
    if(settled<4) throw Error('Camera did not settle: '+r.id)
    return previous
  }
  const counts = (r:AppWindow) => js(r,`document.querySelector('.attn-desk .mcp-tool-count')?.textContent.trim()`)
  try {
    // The default intro intentionally moves every new Canvas from zoom1.6
    // to its fit target after rAF begins. A quiet 200ms sample can precede
    // that first frame in an offscreen window. Use the existing no-intro
    // setting so MW2 measures an interaction against stationary canvases.
    const seed=await ctx.create('multi-startup-settings')
    await js(seed,`localStorage.setItem('orgtree-start-view','org');localStorage.setItem('orgtree-start-zoom','0');true`)
    ctx.close(seed)
    for (const org of orgs) { const r=await ctx.create('multi-'+org,org); windows.push(r); await mode(r,'Canvas') }
    await ctx.until(async()=>orgs.every(org=>(sockets.get(org)?.size??0)>0),Boolean,10000)
    const identities = await Promise.all(windows.map(r=>js(r,`({path:location.pathname,id:window.orgtreeDesktop.windowIdentity.windowId,org:window.orgtreeDesktop.windowIdentity.org})`)))
    ctx.check('MW1', windows.length===3 && windows.every(r=>!r.window.isDestroyed())
      && new Set(identities.map(x=>x.id)).size===3 && identities.every((x,i)=>x.org===orgs[i]),
      'Three real App windows simultaneously retain distinct native organization identities',identities)
    const before = await Promise.all(windows.map(settleCamera))
    await js(windows[0],`document.querySelector('.zoomhud [title="zoom out"]').click();true`)
    await ctx.until(()=>camera(windows[0]),value=>!!value && value!==before[0],3000)
    const after = await Promise.all(windows.map(settleCamera))
    ctx.check('MW2', !!before[0] && after[0]!==before[0] && before[1]===after[1] && before[2]===after[2],
      'With startup glide disabled, zooming one real Canvas leaves the other two camera transforms unchanged',{before,after})
    await mode(windows[0],'Attention')
    ctx.check('MW3', (await Promise.all(windows.slice(1).map(r=>js(r,`document.querySelector('.shell-mode[aria-checked="true"]').textContent.trim()`)))).every(x=>x==='Canvas'),
      'Changing one organization to Attention leaves the other two in Canvas')
    for (const r of windows) {
      await mode(r,'Attention')
      // Prior Attention tests deliberately left beta selected and pinned in
      // studio. Select the unpinned agent explicitly; the visible-pin rule
      // correctly keeps beta's Desk outside the Attention slot.
      await ready(r,`!!document.querySelector('[data-attn-agent="agent"]')`)
      await js(r,`document.querySelector('[data-attn-agent="agent"]').click();true`)
      await ready(r,`!!document.querySelector('.attn-desk .mcp-tool-count')`)
      r.window.blur()
    }
    const beforeCounts=await Promise.all(windows.map(counts))
    const unfocused=windows.map(r=>!r.window.isFocused())
    const connected=orgs.map(org=>sockets.get(org)?.size??0)
    const expected=[11,22,33]
    orgs.forEach((org,i)=>sendCount(org,expected[i],2))
    const got=await ctx.until(()=>Promise.all(windows.map(counts)),values=>values.every((v,i)=>v==='MCP '+expected[i]),3000)
    ctx.check('MW4', unfocused.every(Boolean) && connected.every(n=>n>0) && got.every((v,i)=>v==='MCP '+expected[i]),
      'Distinct live WebSocket patches reach all three unfocused Apps; unchanged HTTP count cannot supply them',{beforeCounts,got,unfocused,connected})
    await js(windows[0],`document.querySelector('.window-control[aria-label="Close window"]').click();true`)
    await ctx.until(async()=>windows[0].window.isDestroyed(),Boolean,3000)
    sendCount(orgs[1],44,3); sendCount(orgs[2],55,3)
    const survivors=await ctx.until(()=>Promise.all(windows.slice(1).map(counts)),values=>values[0]==='MCP 44' && values[1]==='MCP 55',3000)
    ctx.check('MW5',windows[0].window.isDestroyed() && windows.slice(1).every(r=>!r.window.isDestroyed())
      && survivors[0]==='MCP 44' && survivors[1]==='MCP 55',
      'Closing one App through its native control leaves two Apps and their live update connections working',survivors)
  } finally {
    stopUpgrade(); stopApi()
    for(const r of windows) if(!r.window.isDestroyed()) ctx.close(r)
    for(const set of sockets.values()) for(const socket of set) socket.destroy()
  }
}
