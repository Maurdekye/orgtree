import { useEffect, useMemo, useState } from 'react'
import { getProviders, saveScope } from '../api'
import { userGesture } from '../historyapi'
import { primaryAccount } from '../accountidentity'
import { useAppFeed, useAppRead } from '../appfeed'
import { historyEnabled, historyUndo } from '../historyregistry'
import { useOrgHireProviders } from '../orghire'
import type { ToastFn } from '../types'
import { SpawnChips } from './cards'
import { TierChip } from './identity'
import { ConfirmModal } from './modals'
import { PickerPopover } from './pickerpopover'
import { staffingOptions, type StaffingOptions, type StaffingTier } from './staffingoptions'
import { ALL_TIER_SEAT, hireOf, providerOf, TIER_LETTER, tierLabel,
  type CanvasNode, type OpFn } from './shared'

/** A chip applies default account/latest; detailed choices stay in agent settings. */
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
  const [confirmTier,setConfirmTier]=useState<string|null>(null)
  const [saving,setSaving]=useState(false)
  const close=()=>{if(!saving){setAnchor(null);setConfirmTier(null)}}
  useEffect(()=>{setAnchor(null);setConfirmTier(null)},[slug,node.id,node.generation,node.state])
  const snapshot=availability?.slug===slug?availability.value:null
  const rows:StaffingTier[]=Array.isArray(snapshot?.tiers)?snapshot.tiers.filter(row=>
    row&&typeof row.tier==='string'&&Array.isArray(row.accounts)
    &&((row.default_ok===true&&row.native_ok!==false)||row.tier===node.tier)):[]
  const apply=async(tier:string)=>{
    const changedTier=tier!==node.tier
    const cancelModel=!changedTier&&!!node.pending_switch
    if(saving||!rows.some(row=>row.tier===tier))return
    if(!changedTier&&!cancelModel){close();return}
    const switchStep={op:'switch_model',node:node.id,tier,
      ...(changedTier?{account:primaryAccount(providerOf(tier))}:{})}
    const scope={model_version:''}
    setSaving(true)
    try{
      let queued=node.busy===true
      if(historyEnabled(slug)){
        const steps:Record<string,unknown>[]=[switchStep]
        if(changedTier)steps.push({op:'scope',node:node.id,...scope})
        const result=await userGesture(slug,steps,`Model: ${node.id}`)
        const reported=result.results?.[0]?.queued
        queued=typeof reported==='boolean'?reported:queued
        toast([cancelModel?`${node.id}: model change cancelled`:queued?`${node.id}: model change queued for next turn`:`Model choice saved for ${node.id}`],historyUndo(slug,result))
      }else{
        const result=await op(switchStep)
        queued=typeof result?.queued==='boolean'?result.queued:queued
        if(changedTier)await saveScope(slug,node.id,scope)
        toast([cancelModel?`${node.id}: model change cancelled`:queued?`${node.id}: model change queued for next turn`:`Model choice saved for ${node.id}`])
      }
      setAnchor(null);setConfirmTier(null)
    }catch(error){toast([`error: ${(error as Error).message}`]);setConfirmTier(null)}
    finally{setSaving(false)}
  }
  const pick=(tier:string)=>{
    if(saving||!rows.some(row=>row.tier===tier))return
    if(tier!==node.tier&&providerOf(tier)!==providerOf(node.tier??''))setConfirmTier(tier)
    else void apply(tier)
  }
  if(node.state!=='live'||!node.tier)return <TierChip tier={node.tier} agentName={node.id}/>
  return <>
    <button type="button" className={'tier desk-model-button t-'+node.tier}
      aria-label={`Change model for ${node.id}`} title={`Change ${node.id}'s model`}
      aria-haspopup="dialog" aria-expanded={!!anchor} disabled={saving}
      onClick={event=>{event.stopPropagation();if(anchor)close();else setAnchor(event.currentTarget)}}>
      {TIER_LETTER[node.tier]??node.tier.slice(0,1).toUpperCase()}
    </button>
    {anchor&&!confirmTier&&<PickerPopover anchor={anchor} onClose={close} kind="model"
      label="Change agent model" className="desk-model-picker" focusFirst>
      <SpawnChips soleHire selected={node.pending_switch?.tier??node.tier} seats={{...ALL_TIER_SEAT,...Object.fromEntries(rows.map(row=>[row.tier,row.seat]))}}
        tokenTitle={tier=>`Change model to ${tierLabel(tier)}`}
        allowedTiers={rows.map(r=>r.tier)} onSpawn={pick} {...hires}/>
      {!rows.length&&<p role="status">{snapshot?.errors?.join('; ')||'No eligible models available'}</p>}
    </PickerPopover>}
    {confirmTier&&<ConfirmModal title={`switch ${node.id} to ${tierLabel(confirmTier)}?`}
      body={(node.busy?'The current turn keeps its model. This change is queued until the turn ends and applies from the next turn. ':'')
        +'Switching providers resets the conversation. The current generation is archived in lineage; scratch files, breadcrumbs and mail survive.'}
      confirmLabel={`switch to ${tierLabel(confirmTier)} and reset the conversation`}
      onConfirm={()=>apply(confirmTier)} confirmDisabled={saving} close={close}/>}
  </>
}
