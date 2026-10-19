// User 2026-10-19: white to lime over 0-3s; six equal log intervals end at24h.
const colours = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#df4b28', '#32140f', '#000000'] as const
const start = 3, end = 24 * 60 * 60
const logStep = Math.log(end / start) / (colours.length - 1)
const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => parseInt(value, 16))

/** Logarithmic interpolation in RGB, applied directly to text (user 19:24-19:26Z). */
export function slotTimeStyle(seconds: number): { color: string } {
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
  return { color }
}

// Semantic red checkpoint for the new independent ended-age scale.
export const slotEndedTimeStyle = slotTimeStyle
