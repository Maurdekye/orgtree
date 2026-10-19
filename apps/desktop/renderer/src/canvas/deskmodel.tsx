import { useEffect, useMemo, useState } from 'react'
import { assignAccount, getProviders, saveScope, userGesture } from '../api'
import { useAppFeed, useAppRead } from '../appfeed'
import { historyEnabled, historyUndo } from '../historyregistry'
import { useOrgHireProviders } from '../orghire'
import type { ToastFn } from '../types'
import { SpawnChips } from './cards'
import { TierChip } from './identity'
import { ConfirmModal } from './modals'
import { PickerPopover } from './pickerpopover'
import { staffingOptions, type StaffingOptions, type StaffingTier } from './staffingoptions'
import { ALL_TIER_SEAT, hireOf, MODEL_VERSIONS, providerOf, TIER_LETTER, tierLabel,
  type CanvasNode, type OpFn } from './shared'

/** The hire tokens choose a tier; ordinary switch/account/scope operations apply it. */
export function DeskModelButton({node, slug, op, toast}: {
  node: CanvasNode; slug: string; op: OpFn; toast: ToastFn
}) {
  const providers = useAppRead('providers', getProviders)
  const orgProviders = useOrgHireProviders(slug)
  const {version: feedVersion} = useAppFeed()
  const [availability,setAvailability] = useState<{slug:string;value:StaffingOptions}|null>(null)
  // Warm on mount/feed, never defer the first availability request to a click.
  useEffect(()=>{
    let active=true
    void staffingOptions(slug).then(value=>{if(active)setAvailability({slug,value})}).catch(()=>{})
    return()=>{active=false}
  },[slug,providers,feedVersion])
  const hires=useMemo(()=>{
    const of=(id:string)=>hireOf(providers?.providers.find(p=>p.id===id),
      providers?.checking===false&&['claude','openai','google'].includes(id),orgProviders?.has(id))
    return{claudeHire:of('claude'),codexHire:of('openai'),antigravityHire:of('google'),
      museHire:of('muse'),openrouterHire:of('openrouter'),langserverHire:of('langserver')}
  },[providers,orgProviders])
  const [anchor,setAnchor]=useState<HTMLElement|null>(null)
  const [choice,setChoice]=useState<{tier:string;account:string;version:string}|null>(null)
  const [asking,setAsking]=useState(false),[saving,setSaving]=useState(false)
  const close=()=>{if(!saving){setAnchor(null);setChoice(null);setAsking(false)}}
  useEffect(()=>{setAnchor(null);setChoice(null);setAsking(false)},[slug,node.id,node.generation,node.state])
  const snapshot=availability?.slug===slug?availability.value:null
  const rows:StaffingTier[]=Array.isArray(snapshot?.tiers)?snapshot.tiers.filter(row=>
    row&&typeof row.tier==='string'&&Array.isArray(row.accounts)
    &&(row.default_ok===true||row.accounts.length>0)):[]
  const pick=(tier:string)=>{
    const row=rows.find(r=>r.tier===tier)
    if(!row)return
    const account=row.accounts.some(a=>a.value===node.account)?node.account!:
      row.default_ok?'':row.accounts[0]?.value??''
    setChoice({tier,account,version:tier===node.tier?node.scope?.model_version??'':''})
  }
  const currentRow=rows.find(r=>r.tier===choice?.tier)
  const versions=choice?MODEL_VERSIONS[choice.tier]??[]:[]
  const changedTier=!!choice&&choice.tier!==node.tier
  const crossProvider=changedTier&&providerOf(choice!.tier)!==providerOf(node.tier??'')
  const midTurn=changedTier&&node.busy===true
  const apply=async()=>{
    if(!choice||!currentRow||saving)return
    const validAccount=choice.account?currentRow.accounts.some(a=>a.value===choice.account):currentRow.default_ok
    if(!validAccount)return
    const scope={model_version:versions.includes(choice.version)?choice.version:''}
    const changeVersion=scope.model_version!==(node.scope?.model_version??'')||changedTier
    const changeAccount=!!choice.account&&choice.account!==node.account
    const switchStep={op:'switch_model',node:node.id,tier:choice.tier,
      ...(choice.account?{account:choice.account}:{})}
    setSaving(true)
    try{
      if(historyEnabled(slug)){
        const steps:Record<string,unknown>[]=[]
        if(changedTier)steps.push(switchStep)
        else if(changeAccount)steps.push({op:'account',node:node.id,account:choice.account})
        if(changeVersion)steps.push({op:'scope',node:node.id,...scope})
        if(steps.length){const result=await userGesture(slug,steps,`Model: ${node.id}`);toast([`Model choice saved for ${node.id}`],historyUndo(slug,result))}
      }else{
        if(changedTier)await op(switchStep)
        else if(changeAccount)await assignAccount(slug,node.id,choice.account)
        if(changeVersion)await saveScope(slug,node.id,scope)
        toast([changedTier&&node.busy?`${node.id}: model change queued for next turn`:`Model choice saved for ${node.id}`])
      }
      setAnchor(null);setChoice(null);setAsking(false)
    }catch(error){toast([`error: ${(error as Error).message}`]);setAsking(false)}
    finally{setSaving(false)}
  }
  if(node.state!=='live'||!node.tier)return <TierChip tier={node.tier} agentName={node.id}/>
  return <>
    <button type="button" className={'tier desk-model-button t-'+node.tier}
      aria-label={`Change model for ${node.id}`} title={`Change ${node.id}'s model`}
      aria-haspopup="dialog" aria-expanded={!!anchor} disabled={saving}
      onClick={event=>{event.stopPropagation();if(anchor)close();else setAnchor(event.currentTarget)}}>
      {TIER_LETTER[node.tier]??node.tier.slice(0,1).toUpperCase()}
    </button>
    {anchor&&!asking&&<PickerPopover anchor={anchor} onClose={close} kind="model"
      label="Change agent model" className="desk-model-picker" focusFirst>
      <SpawnChips soleHire selected={choice?.tier??node.tier} seats={{...ALL_TIER_SEAT,...Object.fromEntries(rows.map(row=>[row.tier,row.seat]))}}
        allowedTiers={rows.map(r=>r.tier)} onSpawn={pick} {...hires}/>
      {!rows.length&&<p role="status">{snapshot?.errors?.join('; ')||'No eligible models available'}</p>}
      {choice&&currentRow&&<div className="desk-model-options">
        <label>Account <select aria-label="Model account" value={choice.account}
          onChange={e=>setChoice({...choice,account:e.target.value})}>
          {currentRow.default_ok&&<option value="">default</option>}
          {currentRow.accounts.map(a=><option key={a.value} value={a.value}>{a.label||a.id}</option>)}
        </select></label>
        {versions.length>1&&<label>Version <select aria-label="Model version" value={choice.version}
          onChange={e=>setChoice({...choice,version:e.target.value})}>
          <option value="">latest ({versions[0]})</option>
          {versions.map(v=><option key={v} value={v}>{tierLabel(choice.tier)} {v}</option>)}
        </select></label>}
        <button type="button" aria-label="Apply model change" disabled={saving}
          onClick={()=>{if(crossProvider||midTurn)setAsking(true);else void apply()}}>apply</button>
      </div>}
    </PickerPopover>}
    {asking&&choice&&<ConfirmModal title={midTurn?`queue ${node.id}'s switch to ${tierLabel(choice.tier)}?`:`switch ${node.id} to ${tierLabel(choice.tier)}?`}
      body={(midTurn?'The current turn keeps its model. This change is queued until the turn ends and applies from the next turn. ':'')
        +(crossProvider?'Switching providers resets the conversation. The current generation is archived in lineage; scratch files, breadcrumbs and mail survive.':'')}
      confirmLabel={midTurn?`queue the switch to ${tierLabel(choice.tier)}`:`switch to ${tierLabel(choice.tier)} and reset the conversation`}
      onConfirm={apply} confirmDisabled={saving} close={close}/>}
  </>
}
