import { useFastMode } from './fastmode'
import { SetBlock, SetToggle } from './settingskit'

function TierDefault({ tier, values, onChange }: {
  tier: string; values: Record<string,boolean>; onChange: (v: Record<string,boolean>) => void
}) {
  const supported=useFastMode(tier)
  if (!supported && values[tier] !== true) return null
  const name=tier.charAt(0).toUpperCase()+tier.slice(1)
  return <SetToggle label={`New ${name} hires start in fast mode`}
    checked={values[tier] === true} onChange={enabled=>onChange({...values,[tier]:enabled})} />
}

export function FastHireDefaults({ tiers, values, onChange }: {
  tiers: string[]; values: Record<string,boolean>; onChange: (v: Record<string,boolean>) => void
}) {
  return <SetBlock label="Fast mode" hint="Defaults for new hires and Quick chat. Existing agents keep their speed; an explicit hire choice overrides this default. Faster responses use more of your provider allowance.">
    {tiers.map(tier=><TierDefault key={tier} tier={tier} values={values} onChange={onChange} />)}
  </SetBlock>
}
