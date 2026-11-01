import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import { OrgAccountsTab, useOrgLaneFilter } from '../src/orgaccounts'
import { CurrentOrg } from '../src/popout'
import { forgetModalOpenCache, forgetModalPins, isModalPinned } from '../src/canvas/modalpin'
import { OrgRecordContext } from '../src/recordsession'
import { RecordFeed } from '../src/recordfeed'

const noop = () => {}
const usage = { available: true, limits: [{ kind:'session',group:'session',percent:42,severity:'normal',resets_at:null,is_active:false,model:null }] }
const account = { id:'claude-secondary',provider:'claude',label:'Secondary',ambient:false,enabled:true,
  credential:{kind:'managed'},identity:{},standing:{auth:'authenticated',state:'ready',marks:{}},bound:[] }

for (const placement of ['centred', 'pinned'] as const) {
  test(`${placement} open Usage and account settings follow remote org toggles without reopening`, async t => {
    const globals = globalThis as unknown as Record<string, unknown>
    const saved = {fetch:globals.fetch,WebSocket:globals.WebSocket}
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
    let allowed = true, enabled = true, seq = 1
    const sockets: Socket[] = []
    class Socket {
      onmessage: ((e:{data:string})=>void) | null = null
      onclose: (()=>void) | null = null
      constructor() { sockets.push(this) }
      close() { this.onclose?.() }
      frame(value:unknown) { this.onmessage?.({data:JSON.stringify(value)}) }
    }
    const epoch = `usage-${placement}`
    const values = () => ({providers:{providers:[{id:'claude',hire_enabled:true,status:{installed:true}}]},
      accounts:{accounts:[{...account,enabled}]},usage,
      registered_usage:{'claude-secondary':{...usage,account:'claude-secondary',provider:'claude'}}})
    const snapshot = () => ({type:'app_snapshot',epoch,seq,
      registry:{type:'registry_snapshot',epoch,cursor:{app_uuid:'test',incarnation:epoch,rev:1},records:[]},
      summaries:{},notices:{},runtime:{orgs:{},values:Object.fromEntries(Object.entries(values()).map(([key,value])=>[key,{epoch,seq,value}]))}})
    const lanes = () => ({org:'fixture',accounts:[{id:'claude-secondary',provider:'claude',label:'Secondary',allowed,enabled}]})
    globals.WebSocket = Socket
    globals.fetch = async (url:unknown) => new Response(JSON.stringify(String(url)==='/api/app/records' ? snapshot() : lanes()))
    const feed = new RecordFeed({snapshot:async()=>{throw Error('no extra snapshot')},catchup:async()=>{throw Error('no catchup')},project:r=>r,publish:noop,error:e=>{throw e}})
    const cursor = {org_uuid:'fixture',incarnation:'one',rev:1}
    feed.receive({type:'record_snapshot',cursor,records:[]})
    // The history board uses this same hook; expose its lane verdict alongside
    // the real Usage view so both consumers must react to the same commit.
    function HistoryFilter() { const filter=useOrgLaneFilter('fixture'); return <output data-history>{String(filter.used('claude-secondary'))}</output> }
    const canvas = document.createElement('div'); canvas.dataset.pinOrg='fixture'; document.body.appendChild(canvas)
    const view = await mountView(<CurrentOrg.Provider value="fixture"><OrgRecordContext.Provider value={{slug:'fixture',session:feed}}>
      <UsageModal org="fixture" close={noop} toast={noop}/><OrgAccountsTab slug="fixture" toast={noop}/><HistoryFilter/>
    </OrgRecordContext.Provider></CurrentOrg.Provider>,el=>el)
    t.after(async()=>{await view.unmount();feed.dispose();canvas.remove();forgetModalPins();forgetModalOpenCache();Object.assign(globals,saved)})
    await inAct(async()=>{sockets[0]!.frame(snapshot());await flush(12)})
    if (placement==='pinned') {
      await inAct(async()=>{document.querySelector<HTMLButtonElement>('button[aria-label="pin this to the window"]')!.click();await flush(6)})
      assert.equal(isModalPinned('usage','fixture'),true)
    }
    const panel = document.querySelector('.usage-modal')!
    const present = () => !!panel.querySelector('[data-account="claude-secondary"]')
    assert.equal(present(),true,'positive control: account initially visible')
    const toggle = () => view.el.querySelector<HTMLInputElement>('input[aria-label="Secondary"]')!
    const remoteCommit = async (next:boolean) => inAct(async()=>{
      allowed=next; cursor.rev++
      feed.receive({type:'record_snapshot',cursor:{...cursor},records:[]})
      await flush(12)
    })
    await remoteCommit(false)
    assert.equal(present(),false,'remote org off removes account in the existing panel')
    assert.equal(toggle().checked,false,'other open settings copy follows remote save')
    assert.equal(view.el.querySelector('[data-history]')?.textContent,'false')
    await remoteCommit(true)
    assert.equal(present(),true,'remote org on restores account without remount')
    assert.equal(toggle().checked,true)
    assert.equal(document.querySelector('.usage-modal')===panel,true,'same panel instance')
    // Global provider/account changes are app-feed publications, not org commits.
    await inAct(async()=>{enabled=false;seq++;sockets[0]!.frame(snapshot());await flush(12)})
    assert.equal(present(),false,'global account off also removes its usage')
    await inAct(async()=>{enabled=true;seq++;sockets[0]!.frame(snapshot());await flush(12)})
    assert.equal(present(),true,'global account on restores usage')
  })
}
