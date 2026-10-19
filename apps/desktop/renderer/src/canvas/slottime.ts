// User 2026-10-19: white to lime over 0-3s; six equal log intervals end at24h.
const colours = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#df4b28', '#32140f', '#000000'] as const
const start = 3, end = 24 * 60 * 60
const logStep = Math.log(end / start) / (colours.length - 1)
const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => parseInt(value, 16))

export interface SlotTimeTextStyle { color: string; textShadow: string }

function outlinedTime(color: string): SlotTimeTextStyle {
  const c = rgb(color).map(v => v / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  const luminance = c[0] * .2126 + c[1] * .7152 + c[2] * .0722
  const outline = luminance >= .179 ? '#000000' : '#ffffff'
  return { color, textShadow: `-0.5px 0 ${outline}, 0.5px 0 ${outline}, 0 -0.5px ${outline}, 0 0.5px ${outline}` }
}

/** Logarithmic interpolation in RGB, applied directly to text (user 19:24-19:26Z). */
export function slotTimeStyle(seconds: number): SlotTimeTextStyle {
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
  return outlinedTime(color)
}

/** Ended ages stay white through3s, then fade on the same log axis to dark grey. */
export function slotEndedTimeStyle(seconds: number): SlotTimeTextStyle {
  const at = Number.isNaN(seconds) ? 0 : Math.max(0, seconds)
  const blend = at <= start ? 0 : at >= end ? 1 : Math.log(at / start) / Math.log(end / start)
  const grey = Math.round(255 + (0x3a - 255) * blend + 1e-10).toString(16).padStart(2, '0')
  return outlinedTime('#' + grey.repeat(3))
}
