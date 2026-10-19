// User 2026-10-19: plain theme-aware colours, bright red from24h, no treatments.
const dark = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#e25a3b', '#ff4040']
const light = ['#1b6b2a', '#2b8136', '#966900', '#bc5100', '#d60000']
const start = 3, end = 24 * 60 * 60
const rgb = (hex:string) => hex.slice(1).match(/../g)!.map(value=>parseInt(value,16))
const secondsOf = (seconds:number) => Number.isNaN(seconds)?0:Math.max(0,seconds)
export type TimeTheme = 'auto' | 'dark' | 'light'
export interface SlotTimeTextStyle { color:string }

function blend(a:string,b:string,amount:number):string {
  const x=rgb(a),y=rgb(b)
  return '#'+x.map((v,i)=>Math.round(v+(y[i]-v)*amount+1e-10).toString(16).padStart(2,'0')).join('')
}

function duration(seconds:number,colours:string[],zero:string):string {
  const at=secondsOf(seconds)
  if(at<=start)return blend(zero,colours[0],at/start)
  if(at>=end)return colours.at(-1)!
  const position=Math.log(at/start)/Math.log(end/start)*(colours.length-1)
  const index=Math.min(Math.floor(position),colours.length-2)
  return blend(colours[index],colours[index+1],position-index)
}

function themed(lightColour:string,darkColour:string,theme:TimeTheme):SlotTimeTextStyle {
  return {color:theme==='light'?lightColour:theme==='dark'?darkColour:`light-dark(${lightColour}, ${darkColour})`}
}

/** CSS colour-scheme switches both shared surfaces immediately, including popouts. */
export function slotTimeStyle(seconds:number,theme:TimeTheme='auto'):SlotTimeTextStyle {
  return themed(duration(seconds,light,'#1a1a1a'),duration(seconds,dark,'#ffffff'),theme)
}

/** Ended ages fade logarithmically to a readable mid grey, mirrored by theme. */
export function slotEndedTimeStyle(seconds:number,theme:TimeTheme='auto'):SlotTimeTextStyle {
  const at=secondsOf(seconds)
  const amount=at<=start?0:at>=end?1:Math.log(at/start)/Math.log(end/start)
  return themed(blend('#1a1a1a','#717171',amount),blend('#ffffff','#999999',amount),theme)
}