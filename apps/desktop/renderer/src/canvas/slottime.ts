// User 2026-10-19: white to lime over 0-3s; six equal log intervals end at24h.
const colours = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#df4b28', '#32140f', '#000000'] as const
const start = 3, end = 24 * 60 * 60
const logStep = Math.log(end / start) / (colours.length - 1)
const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => parseInt(value, 16))
export type TimeReadability = 'glow' | 'dot' | 'underline'
export const TIME_READABILITY: TimeReadability = 'glow'

export interface SlotTimeTextStyle {
  color: string; textShadow: string; display?: 'inline-block';
  backgroundImage?: string; backgroundPosition?: string; backgroundSize?: string;
  backgroundRepeat?: string; paddingLeft?: string; paddingBottom?: string;
}

function luminance(color: string): number {
  const c = rgb(color).map(v => v / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722
}

function readableTint(color: string, light: boolean): string {
  const background = luminance(light ? '#fafafa' : '#1f1f1f')
  const contrast = (hex: string) => {
    const text = luminance(hex)
    return (Math.max(text, background) + .05) / (Math.min(text, background) + .05)
  }
  if (contrast(color) >= 4.5) return color
  const channels = rgb(color), toward = light ? 0 : 255
  const mix = (amount: number) => '#' + channels.map(value => Math.round(value + (toward-value)*amount)
    .toString(16).padStart(2,'0')).join('')
  let lo=0, hi=1
  for(let i=0;i<16;i++) { const at=(lo+hi)/2; if(contrast(mix(at))>=4.5)hi=at;else lo=at }
  return mix(hi)
}

function readableTime(color: string, appearance: TimeReadability): SlotTimeTextStyle {
  if (appearance === 'glow') {
    const glow = luminance(color) >= .179 ? '0, 0, 0' : '255, 255, 255'
    return {color,textShadow:`0 0 3px rgba(${glow}, .9), 0 0 6px rgba(${glow}, .55)`}
  }
  const text = `light-dark(${readableTint(color,true)}, ${readableTint(color,false)})`
  if (appearance === 'dot') return {color:text,textShadow:'none',display:'inline-block',paddingLeft:'9px',
    backgroundImage:`radial-gradient(circle, ${color} 0 2px, #999999 2px 3px, transparent 3px)`,
    backgroundPosition:'left center',backgroundSize:'6px 6px',backgroundRepeat:'no-repeat'}
  return {color:text,textShadow:'none',display:'inline-block',paddingBottom:'5px',
    backgroundImage:`linear-gradient(${color}, ${color}), linear-gradient(#999999, #999999)`,
    backgroundPosition:'left calc(100% - 1px), left bottom',backgroundSize:'100% 2px, 100% 4px',backgroundRepeat:'no-repeat'}
}

/** Logarithmic interpolation in RGB, applied directly to text (user 19:24-19:26Z). */
export function slotTimeStyle(seconds: number, appearance: TimeReadability = TIME_READABILITY): SlotTimeTextStyle {
  const at = Number.isNaN(seconds) ? 0 : Math.max(0, seconds)
  let color: string = colours[0]
  if (at < start) color = '#' + rgb(colours[0]).map(value =>
    Math.round(255 + (value - 255) * at / start).toString(16).padStart(2, '0')).join('')
  if (at >= end) color = colours.at(-1)!
  else if (at > start) {
    const position = Math.log(at / start) / logStep
    const index = Math.min(Math.floor(position), colours.length - 2)
    const blend = position - index
    const x = rgb(colours[index]), y = rgb(colours[index + 1])
    color = '#' + x.map((value, i) => Math.round(value + (y[i] - value) * blend + 1e-10)
      .toString(16).padStart(2, '0')).join('')
  }
  return readableTime(color, appearance)
}

/** Ended ages stay white through3s, then fade on the same log axis to dark grey. */
export function slotEndedTimeStyle(seconds: number, appearance: TimeReadability = TIME_READABILITY): SlotTimeTextStyle {
  const at = Number.isNaN(seconds) ? 0 : Math.max(0, seconds)
  const blend = at <= start ? 0 : at >= end ? 1 : Math.log(at / start) / Math.log(end / start)
  const grey = Math.round(255 + (0x3a - 255) * blend + 1e-10).toString(16).padStart(2, '0')
  return readableTime('#' + grey.repeat(3), appearance)
}
